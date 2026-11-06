import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_TYPES, type ConversationStage } from '@nikahmate/domain';
import catalog from '../../../packages/i18n/src/locales/en.json';
import { stageRow } from './chat/stage';
import { ACCESS_ACTION_KEYS, accessActionKey, accessPermissionKey } from './family/accessLogText';
import { createReturnGate } from './lib/useRefreshOnReturn';
import { confirmAction } from './lib/confirm';
import { notificationTarget } from './notifications/target';

/**
 * Workflows found broken in the final review of every screen: buttons that did nothing
 * on the web, screens with no way back, stage proposals nobody could answer, and
 * notifications that led nowhere.
 */

const platform = vi.hoisted(() => ({ OS: 'web' }));
const alert = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({ Platform: platform, Alert: { alert } }));
vi.mock('expo-router', () => ({ useFocusEffect: vi.fn() }));

const ROOT = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) return walk(rel);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [rel] : [];
  });
}

const SOURCES = [...walk('app'), ...walk('src')];
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

function has(key: string): boolean {
  let node: unknown = catalog;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' && node.trim().length > 0;
}

const OPTIONS = {
  title: 'Block Sara?',
  message: 'You will not see each other.',
  confirmLabel: 'Block',
  cancelLabel: 'Cancel',
};

describe('confirmAction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    alert.mockClear();
    platform.OS = 'web';
  });

  it('on the web asks, and runs the action when the person agrees', () => {
    const ask = vi.fn(() => true);
    vi.stubGlobal('confirm', ask);
    const onConfirm = vi.fn();
    confirmAction({ ...OPTIONS, onConfirm });
    expect(ask).toHaveBeenCalledWith('Block Sara?\n\nYou will not see each other.');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
  });

  it('on the web does nothing when the person says no', () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );
    const onConfirm = vi.fn();
    confirmAction({ ...OPTIONS, onConfirm });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('on a phone uses the native dialog, with the action marked destructive', () => {
    platform.OS = 'android';
    const onConfirm = vi.fn();
    confirmAction({ ...OPTIONS, onConfirm });
    const [title, message, buttons] = alert.mock.calls[0]!;
    expect(title).toBe('Block Sara?');
    expect(message).toBe('You will not see each other.');
    expect(buttons[0]).toMatchObject({ text: 'Cancel', style: 'cancel' });
    expect(buttons[1]).toMatchObject({ text: 'Block', style: 'destructive' });
    expect(onConfirm).not.toHaveBeenCalled();
    buttons[1].onPress();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('nothing else in the app uses Alert.alert, which does nothing at all on the web', () => {
    const offenders = SOURCES.filter(
      (path) => path !== 'src/lib/confirm.ts' && read(path).includes('Alert.alert'),
    );
    expect(offenders).toEqual([]);
  });
});

describe('every pushed screen has a title and a way back', () => {
  it('none relies on a navigator header the (app) stack hides', () => {
    const offenders = SOURCES.filter(
      (path) => path.startsWith('app/(app)') && read(path).includes('<Stack.Screen options'),
    );
    expect(offenders).toEqual([]);
  });

  it.each([
    'app/(app)/chat/[conversationId].tsx',
    'app/(app)/family/access-log.tsx',
    'app/(app)/family/invite.tsx',
    'app/(app)/family/join.tsx',
    'app/(app)/family/review/[matchId].tsx',
    'app/(app)/account/blocked.tsx',
    'app/(app)/account/saved.tsx',
    'app/(app)/account/reports.tsx',
    'app/(app)/account/notification-settings.tsx',
  ])('%s', (path) => {
    expect(read(path)).toContain('<ScreenHeader');
  });
});

describe('stageRow', () => {
  const stage = (
    currentStage: number,
    proposal: 'mine' | 'theirs' | null = null,
  ): ConversationStage =>
    ({
      conversationId: '00000000-0000-4000-8000-000000000001',
      currentStage,
      pendingProposal: proposal
        ? { toStage: currentStage + 1, proposedByMe: proposal === 'mine' }
        : null,
    }) as ConversationStage;

  it('offers the next stage when nothing is pending', () => {
    expect(stageRow(stage(1), true)).toEqual({ kind: 'propose', toStage: 2 });
  });

  it('shows the proposer they are waiting, rather than offering it again', () => {
    expect(stageRow(stage(2, 'mine'), true)).toEqual({ kind: 'waiting', toStage: 3 });
  });

  it('asks the other person: without this nobody could ever answer', () => {
    expect(stageRow(stage(2, 'theirs'), true)).toEqual({ kind: 'asked', toStage: 3 });
  });

  it('has nothing beyond the last stage', () => {
    expect(stageRow(stage(5), true)).toEqual({ kind: 'final' });
  });

  it('offers nothing on a closed conversation, which the API would refuse anyway', () => {
    expect(stageRow(stage(2), false)).toEqual({ kind: 'none' });
    expect(stageRow(stage(2, 'theirs'), false)).toEqual({ kind: 'none' });
  });

  it('shows nothing before the stage has loaded', () => {
    expect(stageRow(null, true)).toEqual({ kind: 'none' });
  });

  it('the screen wires up every answer', () => {
    const chat = read('app/(app)/chat/[conversationId].tsx');
    expect(chat).toContain('respondToStage(conversationId');
    expect(chat).toContain('chat-stage-accept');
    expect(chat).toContain('chat-stage-decline');
    expect(chat).toContain('chat-stage-waiting');
    expect(chat).toContain('.unmatch(matchId)');
  });
});

describe('notificationTarget', () => {
  const CONVERSATION = 'c1';

  it.each([
    ['new_match', {}, '/(app)/(tabs)/messages'],
    ['new_message', { conversationId: CONVERSATION }, '/(app)/chat/c1'],
    ['new_message', {}, '/(app)/(tabs)/messages'],
    ['stage_advance_proposed', { conversationId: CONVERSATION }, '/(app)/chat/c1'],
    ['interest_received', {}, '/(app)/(tabs)/interests'],
    ['interest_accepted', { actorUserId: 'u1' }, '/(app)/profile/u1'],
    ['interest_accepted', {}, '/(app)/(tabs)/interests'],
    ['photo_request', {}, '/(app)/photo-requests'],
    ['photo_request_answered', {}, '/(app)/photo-requests'],
    ['family_review_requested', { matchId: 'm1' }, '/(app)/family/review/m1'],
    ['family_review_requested', {}, '/(app)/(tabs)/family'],
    ['family_invitation', {}, '/(app)/(tabs)/family'],
    ['family_invitation_answered', {}, '/(app)/(tabs)/family'],
    ['family_review_decided', {}, '/(app)/(tabs)/family'],
    ['family_review_stalled', {}, '/(app)/(tabs)/family'],
    ['report_update', { reportId: 'r1' }, '/(app)/account/reports'],
    ['verification_update', {}, '/(app)/(tabs)/me'],
  ] as const)('%s with %j goes to %s', (type, data, target) => {
    expect(notificationTarget(type, data)).toBe(target);
  });

  it('a security alert is read where it is, and goes nowhere', () => {
    expect(notificationTarget('security_alert', {})).toBeNull();
  });

  it('every type the API can send has a decision: none is missed', () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(() => notificationTarget(type, {})).not.toThrow();
      const target = notificationTarget(type, {});
      expect(type === 'security_alert' ? target === null : typeof target === 'string', type).toBe(
        true,
      );
    }
  });

  it('a value of the wrong type in a payload does not build a broken link', () => {
    expect(notificationTarget('new_message', { conversationId: 42 })).toBe(
      '/(app)/(tabs)/messages',
    );
  });

  it('the inbox uses it', () => {
    expect(read('app/(app)/notifications.tsx')).toContain('notificationTarget(notification.type');
  });

  it('each target exists as a screen', () => {
    const screens = walk('app').map((path) => path.replace(/^app/, '').replace(/\.tsx$/, ''));
    for (const [type, data] of [
      ['report_update', {}],
      ['photo_request', {}],
    ] as const) {
      expect(screens).toContain(notificationTarget(type, data));
    }
    expect(screens).toContain('/(app)/chat/[conversationId]');
    expect(screens).toContain('/(app)/family/review/[matchId]');
  });
});

describe('the screens members could not reach before', () => {
  it.each([
    ['saved profiles', 'me-saved', '/(app)/account/saved'],
    ['notification settings', 'me-notification-settings', '/(app)/account/notification-settings'],
    ['blocked members', 'me-blocked', '/(app)/account/blocked'],
    ['their reports', 'me-reports', '/(app)/account/reports'],
  ])('%s are linked from the Me tab', (_label, testId, route) => {
    const me = read('app/(app)/(tabs)/me.tsx');
    expect(me).toContain(testId);
    expect(me).toContain(route);
  });

  it('deactivating asks first, and uses the same screen to come back from', () => {
    const me = read('app/(app)/(tabs)/me.tsx');
    expect(me).toContain('confirmDeactivate');
    expect(me).toContain('me-deactivate');
  });

  it('family invitations can be cancelled, permissions changed, approvals withdrawn', () => {
    const family = read('app/(app)/(tabs)/family.tsx');
    expect(family).toContain('cancelFamilyInvitation(invitationId)');
    expect(family).toContain('<FamilyPermissionsEditor');
    expect(family).toContain('revokeReview(matchId)');
  });
});

describe('every string the new screens use exists', () => {
  it.each([
    'app/(app)/account/blocked.tsx',
    'app/(app)/account/saved.tsx',
    'app/(app)/account/reports.tsx',
    'app/(app)/account/notification-settings.tsx',
    'app/(app)/chat/[conversationId].tsx',
    'app/(app)/(tabs)/family.tsx',
    'app/(app)/(tabs)/me.tsx',
    'src/family/FamilyPermissionsEditor.tsx',
  ])('%s', (path) => {
    const keys = [...read(path).matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'\s*\)/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !has(key))).toEqual([]);
  });

  it('every report status and notification type has a label', () => {
    for (const status of ['open', 'triaged', 'actioned', 'dismissed']) {
      expect(has(`account.reportStatus.${status}`), status).toBe(true);
    }
    for (const type of NOTIFICATION_TYPES) {
      expect(has(`account.notificationType.${type}`), type).toBe(true);
    }
  });
});

describe('coming back to a screen', () => {
  it('reloads every time after the first, when the screen does its own first load', () => {
    const gate = createReturnGate();
    let reloads = 0;
    gate(() => (reloads += 1));
    expect(reloads).toBe(0);
    gate(() => (reloads += 1));
    gate(() => (reloads += 1));
    expect(reloads).toBe(2);
  });

  it.each([
    ['Messages', 'app/(app)/(tabs)/messages.tsx'],
    ['Interests', 'app/(app)/(tabs)/interests.tsx'],
    ['Family', 'app/(app)/(tabs)/family.tsx'],
  ])('%s does not show what it knew the first time it opened', (_name, file) => {
    expect(readFileSync(join(__dirname, '..', file), 'utf8')).toContain('useRefreshOnReturn(');
  });

  it.each([
    ['Discover', 'app/(app)/(tabs)/discover.tsx'],
    ['Notifications', 'app/(app)/notifications.tsx'],
  ])('%s does not, as reloading a paged list would lose someone’s place', (_name, file) => {
    expect(readFileSync(join(__dirname, '..', file), 'utf8')).not.toContain('useRefreshOnReturn(');
  });
});

describe('the family access log reads as words, not codes', () => {
  const strings = catalog as unknown as { family: Record<string, string> };
  const present = (key: string) => strings.family[key.replace('family.', '')];

  it.each([
    ['review.open', 'Opened a match to review it'],
    ['review.approved', 'Approved a match'],
    ['review.rejected', 'Declined a match'],
    ['review.more_info_requested', 'Asked for more information about a match'],
    ['review.revoked', 'Withdrew an approval'],
  ])('%s', (action, words) => {
    expect(present(accessActionKey(action))).toBe(words);
  });

  it('an action this version does not know still reads as a sentence', () => {
    expect(present(accessActionKey('something.new'))).toBe('Looked at something');
  });

  it('the permission has the label it has everywhere else', () => {
    expect(present(accessPermissionKey('approve_communication'))).toBe(
      'Approve or decline a match',
    );
  });

  it('every label exists', () => {
    for (const key of ACCESS_ACTION_KEYS) expect(present(key), key).toBeTruthy();
  });
});
