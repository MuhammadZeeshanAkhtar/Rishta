/**
 * The onboarding route, in order.
 *
 * One list, used by the progress indicator, the next/back buttons and the
 * resume logic. Three copies of this order is three chances for the progress
 * bar to disagree with the buttons.
 */

export const ONBOARDING_STEPS = [
  { key: 'basics', route: '/(onboarding)/basics', titleKey: 'onboarding.basicsTitle' },
  { key: 'religious', route: '/(onboarding)/religious', titleKey: 'onboarding.religiousTitle' },
  { key: 'education', route: '/(onboarding)/education', titleKey: 'onboarding.educationTitle' },
  { key: 'lifestyle', route: '/(onboarding)/lifestyle', titleKey: 'onboarding.lifestyleTitle' },
  {
    key: 'preferences',
    route: '/(onboarding)/preferences',
    titleKey: 'onboarding.preferencesTitle',
  },
  { key: 'preview', route: '/(onboarding)/preview', titleKey: 'onboarding.previewTitle' },
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number]['key'];

/**
 * The literal union of onboarding paths, not `string`.
 *
 * expo-router generates a typed route union into `.expo/types` the first time
 * `expo start` runs, and `router.push()` then accepts only a known path. A
 * helper returning plain `string` type-checks on a fresh clone and fails the
 * moment someone runs the app — the worst kind of break, because CI never sees
 * it (`expo export` does not generate the types) and a new developer hits it
 * on their first afternoon. Narrowing here costs nothing and holds either way.
 */
export type OnboardingRoute = (typeof ONBOARDING_STEPS)[number]['route'];

export const TOTAL_STEPS = ONBOARDING_STEPS.length;

export function stepIndex(key: OnboardingStepKey): number {
  return ONBOARDING_STEPS.findIndex((s) => s.key === key);
}

export function nextRoute(key: OnboardingStepKey): OnboardingRoute | null {
  const index = stepIndex(key);
  return index >= 0 && index < TOTAL_STEPS - 1 ? ONBOARDING_STEPS[index + 1]!.route : null;
}

export function previousRoute(key: OnboardingStepKey): OnboardingRoute | null {
  const index = stepIndex(key);
  return index > 0 ? ONBOARDING_STEPS[index - 1]!.route : null;
}
