/**
 * Family invitation links — review B2.
 *
 * Accepting an invitation takes two values: the invitation id and the one-time
 * token (`POST /family/invitations/{id}/respond`). Before this, the inviter was
 * shown the token alone, the id was never shared, and no screen could accept,
 * so no delegate could ever join.
 *
 * A link carries both, as `…/family/join?i=<id>&t=<token>`. The prefix is
 * whatever the platform needs and is built by the app (expo-linking): the web
 * origin on web, `nikahmate://` in a standalone build, `exp://…/--/` in a dev
 * client. The parser accepts all three, and a link pasted with words around
 * it, because the invitee may receive it in any messaging app and paste it.
 *
 * No platform imports: this is shared by the app and the API's tests.
 */

/** The route the link opens, relative to the platform prefix. */
export const FAMILY_JOIN_PATH = 'family/join';

export interface FamilyInviteRef {
  invitationId: string;
  token: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** base64url, within respondToInvitationSchema's 16..128 bounds. */
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/** The query a join link carries. Short keys keep the link short to paste. */
export function familyInviteQueryParams(ref: FamilyInviteRef): { i: string; t: string } {
  return { i: ref.invitationId, t: ref.token };
}

/** A well-formed pair, or null. Never trusts the server to reject junk. */
export function toFamilyInviteRef(invitationId: unknown, token: unknown): FamilyInviteRef | null {
  if (typeof invitationId !== 'string' || typeof token !== 'string') return null;
  const id = invitationId.trim();
  const t = token.trim();
  return UUID.test(id) && TOKEN.test(t) ? { invitationId: id.toLowerCase(), token: t } : null;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/**
 * Finds a join link in `input` and returns what it carries, or null.
 *
 * Parsed by hand rather than with URL/URLSearchParams: React Native's
 * URLSearchParams is incomplete, and a custom scheme (`nikahmate://`) is not
 * something every URL implementation agrees how to split.
 */
export function parseFamilyInviteLink(input: string): FamilyInviteRef | null {
  const match = /family\/join\/?\?([^\s#]+)/i.exec(input);
  if (!match?.[1]) return null;

  const params: Record<string, string> = {};
  for (const pair of match[1].split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    params[decode(pair.slice(0, eq))] = decode(pair.slice(eq + 1));
  }

  // A link pasted at the end of a sentence picks up its full stop. Keep only
  // the token's own alphabet.
  const token = /^[A-Za-z0-9_-]+/.exec(params.t ?? '')?.[0];
  return toFamilyInviteRef(params.i, token);
}
