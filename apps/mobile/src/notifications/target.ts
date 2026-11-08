import type { NotificationType } from '@nikahmate/domain';

/**
 * Where tapping a notification leads. Free of React so every type can be tested.
 *
 * Derived from the payload's identifiers rather than stored as a URL: a link written
 * when the notification was created would outlive the thing it points at. Before this,
 * a tap on a message, family or report notification only marked it read and went
 * nowhere.
 *
 * Null means there is nothing further to open.
 */
export function notificationTarget(
  type: NotificationType,
  data: Record<string, unknown>,
): string | null {
  const id = (key: string): string | null => {
    const value = data[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  switch (type) {
    case 'new_match':
      return '/(app)/(tabs)/messages';
    case 'new_message':
    case 'stage_advance_proposed': {
      const conversationId = id('conversationId');
      return conversationId ? `/(app)/chat/${conversationId}` : '/(app)/(tabs)/messages';
    }
    case 'interest_received':
      return '/(app)/(tabs)/interests';
    case 'interest_accepted': {
      const actor = id('actorUserId');
      return actor ? `/(app)/profile/${actor}` : '/(app)/(tabs)/interests';
    }
    case 'photo_request':
    case 'photo_request_answered':
      return '/(app)/photo-requests';
    case 'family_review_requested': {
      const matchId = id('matchId');
      return matchId ? `/(app)/family/review/${matchId}` : '/(app)/(tabs)/family';
    }
    case 'family_invitation':
    case 'family_invitation_answered':
    case 'family_review_decided':
    case 'family_review_stalled':
      return '/(app)/(tabs)/family';
    case 'report_update':
      return '/(app)/account/reports';
    case 'verification_update':
      return '/(app)/(tabs)/me';
    case 'security_alert':
      return null;
  }
}
