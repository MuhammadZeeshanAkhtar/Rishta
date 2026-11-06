import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_AREA_ROLES,
  ADMIN_ROLES,
  NOTIFICATION_TYPES,
  PHOTO_REJECTION_REASONS,
  PROFILE_REJECTION_REASONS,
  USER_ACTIONS,
  USER_STATUSES,
} from '@nikahmate/domain';
import catalog from '../../../packages/i18n/src/locales/en.json';

/**
 * Every English string the review Phase 5 screens use exists in the catalog
 * (review L1, L3, L4, B6). `t()` returns the KEY when a string is missing,
 * so a gap would ship as `admin.decision.noteHint` on a staff screen or
 * `photoAccess.request` on a member's — visible, and easy to miss in review.
 *
 * Literal keys are read from the source; keys built from a value
 * (`admin.area.${area}`) are checked against every value they can take.
 */

const ROOT = join(__dirname, '..');
const FILES = [
  'app/(app)/profile/[userId].tsx',
  'app/(app)/photo-requests.tsx',
  'app/(app)/dob-correction.tsx',
  'src/photos/ProfilePhotoGallery.tsx',
  'src/account/dobCorrection.ts',
  'src/session/restrictedContent.ts',
  'src/account/AccountDeletionView.tsx',
  'app/delete-account.tsx',
  ...walk('app/admin'),
  ...walk('src/admin'),
];

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) return walk(rel);
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [rel] : [];
  });
}

function has(key: string): boolean {
  let node: unknown = catalog;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' && node.trim().length > 0;
}

describe('Phase 5 strings exist in the English catalog', () => {
  it('every literal key used by the Phase 5 screens', () => {
    const missing: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      const keys = new Set([
        ...[...source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1]!),
        ...[
          ...source.matchAll(
            /'((?:admin|dobCorrection|photoAccess|photoRequests|publicProfile|validation)\.[a-zA-Z0-9_.]+)'/g,
          ),
        ].map((m) => m[1]!),
      ]);
      for (const key of keys) if (!has(key)) missing.push(`${file}: ${key}`);
    }
    expect(FILES.length).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });

  it('every key built from a value', () => {
    const built = [
      ...Object.keys(ADMIN_AREA_ROLES).flatMap((a) => [`admin.area.${a}`, `admin.areaHint.${a}`]),
      ...ADMIN_ROLES.map((r) => `admin.role.${r}`),
      ...USER_ACTIONS.map((a) => `admin.users.action.${a}`),
      ...USER_STATUSES.map((s) => `admin.users.status.${s}`),
      ...['open', 'triaged', 'actioned', 'dismissed'].map((s) => `admin.reports.status.${s}`),
      ...['actioned', 'no_violation', 'insufficient_evidence'].map(
        (o) => `admin.reports.outcomes.${o}`,
      ),
      ...['all', 'user', 'profile', 'photo', 'report'].map((x) => `admin.audit.targets.${x}`),
      ...['approve', 'reject'].map((d) => `admin.decided.${d}`),
      ...['pending', 'approved', 'declined', 'withdrawn'].map((s) => `photoRequests.status.${s}`),
      ...['incoming', 'outgoing'].flatMap((d) => [
        `photoRequests.${d}`,
        `photoRequests.empty.${d}`,
      ]),
      ...['pending', 'approved', 'rejected'].map((s) => `dobCorrection.status.${s}`),
      ...[
        'age',
        'country',
        'maritalStatus',
        'religiousPractice',
        'marriageTimeline',
        'relocation',
        'children',
        'languages',
      ].map((f) => `publicProfile.fact.${f}`),
      ...NOTIFICATION_TYPES.flatMap((n) => [`notifications.${n}.title`, `notifications.${n}.body`]),
      // The rejection reasons a member's app renders.
      ...PHOTO_REJECTION_REASONS,
      ...PROFILE_REJECTION_REASONS,
    ];
    expect(built.filter((key) => !has(key))).toEqual([]);
  });
});
