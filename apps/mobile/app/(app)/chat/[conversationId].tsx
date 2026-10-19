import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { MAX_MESSAGE_LENGTH } from '@nikahmate/domain';
import { Banner } from '../../../src/components/Banner';
import { Button } from '../../../src/components/Button';
import { SkeletonList } from '../../../src/components/LoadingSkeleton';
import { StatusBadge } from '../../../src/components/StatusBadge';
import { useThread } from '../../../src/chat/useChat';
import { getClient } from '../../../src/api/client';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { iconSize, radius, spacing, typography } from '../../../src/theme/tokens';

/**
 * One conversation (Phase 7).
 *
 * THE COMPOSER IS NOT ALWAYS THERE, and its absence is explained. When the
 * server says `canWrite` is false the input is replaced by a sentence naming
 * the reason — family review pending, approval withdrawn, a block, an ended
 * match. A composer that accepts text and then fails on send would be the
 * worst version of this: it makes a deliberate safety decision look like a
 * bug, and on a product where the gate protects people, that matters.
 *
 * The history stays readable in every closed state. Hiding it would look like
 * deleted messages.
 */
export default function ChatScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { detail, messages, loading, error, sending, sendError, send, reload } =
    useThread(conversationId);

  const [draft, setDraft] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  // A chat opens at the newest message, and stays there as messages arrive.
  useEffect(() => {
    if (messages.length === 0) return;
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 50);
    return () => clearTimeout(timer);
  }, [messages.length]);

  const submit = useCallback(async () => {
    const body = draft.trim();
    if (body.length === 0) return;
    // Cleared optimistically: retyping a message because the network was slow
    // is a worse failure than an occasional empty box on error, and the error
    // banner keeps the text recoverable by retyping rather than losing it
    // silently.
    const sent = await send(body);
    if (sent) setDraft('');
  }, [draft, send]);

  const advanceStage = useCallback(async () => {
    if (!conversationId) return;
    try {
      await getClient().proposeStage(conversationId);
      reload();
    } catch {
      /* The stage row re-reads on reload; a failed proposal needs no banner. */
    }
  }, [conversationId, reload]);

  const leave = useCallback(() => {
    if (!conversationId) return;
    Alert.alert(t('chat.leave'), t('chat.leaveConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('chat.leave'),
        style: 'destructive',
        onPress: () => {
          void getClient()
            .leaveConversation(conversationId)
            .then(() => router.back())
            .catch(() => undefined);
        },
      },
    ]);
  }, [conversationId, t]);

  const closedReason = detail?.writeBlockedReason ?? null;
  const closedCopy = closedReason
    ? t(`chat.closed${closedReason.charAt(0).toUpperCase()}${closedReason.slice(1)}`)
    : null;

  return (
    <>
      <Stack.Screen options={{ title: detail?.counterpartDisplayName ?? t('chat.title') }} />
      <KeyboardAvoidingView
        style={[styles.root, { backgroundColor: theme.colors.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}
      >
        {/* Stage sits above the thread: it changes what the conversation is
            for, so it belongs where it is read before the messages. */}
        {detail ? (
          <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
            <StatusBadge
              label={t('chat.stage').replace('{{stage}}', String(detail.stage))}
              tone="neutral"
            />
            <View style={styles.headerActions}>
              {detail.canWrite && detail.stage < 5 ? (
                <Pressable onPress={() => void advanceStage()} accessibilityRole="button">
                  <Text style={[styles.headerLink, { color: theme.colors.brand }]}>
                    {t('chat.stageAdvance').replace('{{stage}}', String(detail.stage + 1))}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable onPress={leave} accessibilityRole="button" testID="chat-leave">
                <Ionicons name="exit-outline" size={iconSize.sm} color={theme.colors.textSubtle} />
              </Pressable>
            </View>
          </View>
        ) : null}

        <ScrollView
          ref={scrollRef}
          style={styles.thread}
          contentContainerStyle={styles.threadContent}
          keyboardShouldPersistTaps="handled"
        >
          {error ? <Banner tone="error" message={t('chat.errorLoad')} /> : null}
          {sendError ? <Banner tone="error" message={t('chat.errorSend')} /> : null}

          {loading ? (
            <SkeletonList />
          ) : messages.length === 0 ? (
            <Text style={[styles.empty, { color: theme.colors.textMuted }]}>
              {t('chat.noMessages')}
            </Text>
          ) : (
            messages.map((message) => (
              <View
                key={message.id}
                style={[styles.bubbleRow, message.isMine ? styles.mine : styles.theirs]}
                testID={`message-${message.id}`}
              >
                <View
                  style={[
                    styles.bubble,
                    message.isMine
                      ? { backgroundColor: theme.colors.brand }
                      : {
                          backgroundColor: theme.colors.surface,
                          borderColor: theme.colors.border,
                          borderWidth: StyleSheet.hairlineWidth,
                        },
                  ]}
                >
                  <Text
                    style={[
                      styles.bubbleText,
                      { color: message.isMine ? theme.colors.textOnBrand : theme.colors.text },
                    ]}
                  >
                    {message.body}
                  </Text>
                </View>
              </View>
            ))
          )}
        </ScrollView>

        {closedCopy ? (
          <View
            style={[
              styles.closed,
              { backgroundColor: theme.colors.surfaceSunken, borderTopColor: theme.colors.border },
            ]}
          >
            <Ionicons
              name="lock-closed-outline"
              size={iconSize.sm}
              color={theme.colors.textSubtle}
            />
            <Text style={[styles.closedText, { color: theme.colors.textSubtle }]}>
              {closedCopy}
            </Text>
          </View>
        ) : (
          <View style={[styles.composer, { borderTopColor: theme.colors.border }]}>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.border,
                  color: theme.colors.text,
                },
              ]}
              value={draft}
              onChangeText={setDraft}
              placeholder={t('chat.composerPlaceholder')}
              placeholderTextColor={theme.colors.textSubtle}
              multiline
              maxLength={MAX_MESSAGE_LENGTH}
              testID="chat-composer"
            />
            <Button
              label={t('chat.send')}
              onPress={() => void submit()}
              loading={sending}
              disabled={draft.trim().length === 0}
              testID="chat-send"
            />
          </View>
        )}
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headerLink: { ...typography.caption },
  thread: { flex: 1 },
  threadContent: { padding: spacing.lg, gap: spacing.sm },
  empty: { ...typography.body, textAlign: 'center', marginTop: spacing.xl },
  bubbleRow: { flexDirection: 'row' },
  mine: { justifyContent: 'flex-end' },
  theirs: { justifyContent: 'flex-start' },
  // 78% rather than a fixed width: at 320dp a fixed bubble either wastes the
  // screen or runs off it.
  bubble: {
    maxWidth: '78%',
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bubbleText: { ...typography.body, lineHeight: 22 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...typography.body,
  },
  closed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  closedText: { ...typography.caption, flex: 1, lineHeight: 19 },
});
