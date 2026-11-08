import { useCallback, useEffect, useRef } from 'react';
import { useFocusEffect } from 'expo-router';

/** Says whether a focus is a return, which is every one after the first. */
export function createReturnGate(): (refresh: () => void) => void {
  let shown = false;
  return (refresh) => {
    if (shown) refresh();
    shown = true;
  };
}

/**
 * Reads a screen's data again each time someone comes back to it.
 *
 * Tabs stay mounted, so a screen that loads when it mounts loads once a session. Messages
 * kept showing the last message from before someone replied, with an out-of-date unread
 * count, and the Family tab kept offering a review its reviewer had just decided.
 *
 * Not for a paged list such as Discover or Notifications: a reload goes back to the first
 * page, which would lose someone's place.
 */
export function useRefreshOnReturn(refresh: () => void): void {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });

  const gate = useRef(createReturnGate());
  useFocusEffect(
    useCallback(() => {
      gate.current(() => latest.current());
    }, []),
  );
}
