import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { familyInviteQueryParams, parseFamilyInviteLink } from '@nikahmate/domain';
import { useSession } from '../session/SessionProvider';
import { pendingInvite, usePendingInvite } from './pendingInvite';

/**
 * Keeps a family invitation link through sign-in and onboarding (review B2).
 *
 * Mounted in the root layout beside AuthLinkHandler, for the same reason: the
 * routing gates redirect anyone who is not yet a verified, onboarded member
 * BEFORE the Join screen can mount, and the link's id and token would be lost
 * with the redirect. This saves them, and once the session is ready sends the
 * person to the Join screen — once per invitation, so backing out of it does
 * not trap them in a loop.
 *
 * It never accepts anything. Accepting is the person's own tap on the Join
 * screen.
 */
export function FamilyInviteLinkHandler() {
  const url = Linking.useURL();
  const { state } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const pending = usePendingInvite();

  // The invitation already sent to the Join screen, by token.
  const offered = useRef<string | null>(null);

  // Whatever a previous launch left waiting.
  useEffect(() => {
    void pendingInvite.load();
  }, []);

  useEffect(() => {
    if (!url) return;
    const ref = parseFamilyInviteLink(url);
    if (ref) void pendingInvite.set(ref);
  }, [url]);

  useEffect(() => {
    if (state !== 'ready' || !pending) return;
    if (offered.current === pending.token) return;
    offered.current = pending.token;
    // Already there: the link itself opened the Join screen.
    if (pathname === `/family/join`) return;
    router.push({ pathname: '/family/join', params: familyInviteQueryParams(pending) });
  }, [state, pending, pathname, router]);

  return null;
}
