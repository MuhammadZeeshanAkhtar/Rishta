import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationDetail, ConversationSummary, Message } from '@nikahmate/domain';
import { getClient } from '../api/client';

/**
 * The conversation list.
 *
 * Re-read on every mount rather than cached: an unread badge that is one
 * navigation stale is worse than one that costs a request, and the gate can
 * close between visits — a thread the app still believes is writable would
 * show a composer that fails on send.
 */
export function useConversations(): {
  conversations: ConversationSummary[];
  loading: boolean;
  error: boolean;
  reload: () => void;
} {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    getClient()
      .listConversations()
      .then((page) => {
        if (cancelled) return;
        setConversations(page.items);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { conversations, loading, error, reload };
}

export interface ThreadState {
  detail: ConversationDetail | null;
  messages: Message[];
  loading: boolean;
  error: boolean;
  sending: boolean;
  sendError: string | null;
  send: (body: string) => Promise<boolean>;
  reload: () => void;
}

/**
 * One thread, with live delivery.
 *
 * REALTIME IS A SIGNAL, NOT A PAYLOAD. The subscription fires on every insert
 * the viewer is permitted to see and the hook then re-reads through the API.
 * Rendering the raw row instead would make the client a second decoder of the
 * same data — one that has to compute `isMine`, resolve names and apply the
 * same soft-delete filter the server already applies, and that would drift.
 *
 * RLS applies per subscriber, so this receives nothing for a thread the
 * viewer is not in.
 */
export function useThread(conversationId: string | undefined): ThreadState {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Guards a re-read triggered by Realtime from racing an unmount.
  const alive = useRef(true);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    setLoading(true);
    setError(false);

    const client = getClient();

    void Promise.all([client.getConversation(conversationId), client.listMessages(conversationId)])
      .then(([conversation, page]) => {
        if (cancelled) return;
        setDetail(conversation);
        // The API returns newest first; a thread reads oldest to newest.
        setMessages([...page.items].reverse());
        setLoading(false);

        // Mark read as soon as the thread is on screen. The server takes
        // `greatest()` of the positions, so an out-of-order call cannot move
        // someone backwards and resurrect notifications they have dealt with.
        const newest = page.items[0];
        if (newest) void client.markRead(conversationId, newest.id).catch(() => undefined);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, nonce]);

  useEffect(() => {
    if (!conversationId) return;
    const client = getClient();

    const unsubscribe = client.subscribeToMessages(conversationId, () => {
      if (!alive.current) return;
      void client
        .listMessages(conversationId)
        .then((page) => {
          if (!alive.current) return;
          setMessages([...page.items].reverse());
          const newest = page.items[0];
          if (newest) void client.markRead(conversationId, newest.id).catch(() => undefined);
        })
        .catch(() => undefined);
    });

    // A leaked channel keeps a websocket open per screen visit, which on a
    // phone is a battery bug that looks like nothing until it is many.
    return unsubscribe;
  }, [conversationId]);

  const send = useCallback(
    async (body: string): Promise<boolean> => {
      if (!conversationId) return false;
      setSending(true);
      setSendError(null);
      try {
        const message = await getClient().sendMessage(conversationId, body);
        // Appended locally as well as delivered by Realtime. The sender sees
        // their own message immediately rather than waiting for a round trip
        // through the websocket, and the re-read that follows reconciles.
        setMessages((current) =>
          current.some((m) => m.id === message.id) ? current : [...current, message],
        );
        return true;
      } catch (error) {
        setSendError((error as Error).message);
        return false;
      } finally {
        setSending(false);
      }
    },
    [conversationId],
  );

  return { detail, messages, loading, error, sending, sendError, send, reload };
}
