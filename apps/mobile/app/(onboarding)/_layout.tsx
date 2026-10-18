import { useCallback } from 'react';
import { Redirect, Stack } from 'expo-router';
import { OnboardingDraftProvider } from '../../src/onboarding/OnboardingDraft';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useSession } from '../../src/session/SessionProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { describeError } from '../../src/lib/errors';

/**
 * Onboarding group.
 *
 * Reachable only by a signed-in, email-verified account that has not finished
 * a profile. Someone already complete is sent on rather than walked through it
 * a second time.
 *
 * Like every gate in this app it is routing, not security: the server is what
 * refuses to make an incomplete profile discoverable.
 */
export default function OnboardingLayout() {
  const { state } = useSession();
  const { t } = useLocale();
  const theme = useTheme();

  // Error translation is injected rather than imported by the provider, so the
  // draft store has no opinion about i18n.
  const describe = useCallback(
    (error: unknown) => {
      const described = describeError(error, t);
      return { message: described.message, fields: described.fields };
    },
    [t],
  );

  if (state === 'loading') return null;
  if (state === 'signed_out' || state === 'misconfigured') {
    return <Redirect href="/(auth)/welcome" />;
  }
  if (state === 'unverified') return <Redirect href="/(auth)/verify-email" />;
  if (state === 'ready') return <Redirect href="/discover" />;

  return (
    // The provider wraps the group, not each screen, so moving back and forward
    // between steps keeps what has been loaded.
    <OnboardingDraftProvider describeError={describe}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.background },
          // Onboarding is a sequence, so forward motion should feel like one.
          animation: 'slide_from_right',
        }}
      />
    </OnboardingDraftProvider>
  );
}
