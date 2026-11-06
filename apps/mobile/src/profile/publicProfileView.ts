import type { PublicProfile } from '@nikahmate/domain';

/**
 * Another member's profile, as facts to show (review L4).
 *
 * THE SERVER DECIDES WHAT IS VISIBLE. `GET /profiles/{userId}` leaves out
 * every field this viewer may not see — absent, not null — and this function
 * only ever turns PRESENT values into facts. It never substitutes a default,
 * never renders "Not stated" for an absent field, and never reads a field the
 * schema does not carry. A field that is present but null (the member did not
 * answer) is dropped too: an unanswered question is not information.
 *
 * Free of React and of the reference cache, so it is tested directly; the
 * screen passes a resolver for reference codes.
 */

export type PublicFactKey =
  | 'age'
  | 'country'
  | 'maritalStatus'
  | 'religiousPractice'
  | 'marriageTimeline'
  | 'relocation'
  | 'children'
  | 'languages';

export interface PublicFact {
  key: PublicFactKey;
  /** Already a display string: a label, a number, or a joined list. */
  value: string;
}

/** Resolves a reference code to its label; returns the code when unknown. */
export type LabelOf = (
  type:
    | 'country'
    | 'marital_status'
    | 'religious_practice'
    | 'marriage_timeline'
    | 'relocation_option'
    | 'language',
  code: string,
) => string;

export interface PublicProfileView {
  displayName: string | null;
  facts: PublicFact[];
  aboutMe: string | null;
  /** How many governed fields the server withheld from this viewer. */
  hiddenFieldCount: number;
  relationship: PublicProfile['viewerRelationship'];
}

export function publicProfileView(
  profile: PublicProfile,
  labelOf: LabelOf,
  text: { hasChildren: string; noChildren: string },
): PublicProfileView {
  const facts: PublicFact[] = [];
  const push = (key: PublicFactKey, value: string | null | undefined) => {
    if (typeof value === 'string' && value.trim().length > 0) facts.push({ key, value });
  };

  if (profile.age !== undefined) push('age', String(profile.age));
  if (profile.countryCode !== undefined) push('country', labelOf('country', profile.countryCode));
  if (profile.maritalStatusCode !== undefined) {
    push('maritalStatus', labelOf('marital_status', profile.maritalStatusCode));
  }
  if (profile.religiousPracticeCode !== undefined) {
    push('religiousPractice', labelOf('religious_practice', profile.religiousPracticeCode));
  }
  if (profile.marriageTimelineCode) {
    push('marriageTimeline', labelOf('marriage_timeline', profile.marriageTimelineCode));
  }
  if (profile.relocationWillingnessCode) {
    push('relocation', labelOf('relocation_option', profile.relocationWillingnessCode));
  }
  // Present only when `children_details` is visible to this viewer; null when
  // the member did not answer. Both absent and null say nothing.
  if (profile.hasChildren === true) push('children', text.hasChildren);
  if (profile.hasChildren === false) push('children', text.noChildren);
  if (profile.languages.length > 0) {
    push('languages', profile.languages.map((code) => labelOf('language', code)).join(', '));
  }

  return {
    displayName: profile.displayName ?? null,
    facts,
    aboutMe: profile.aboutMe ?? null,
    hiddenFieldCount: profile.hiddenFieldCount,
    relationship: profile.viewerRelationship,
  };
}
