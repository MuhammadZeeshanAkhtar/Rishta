import { Redirect, Stack } from 'expo-router';
import { useSession } from '../../src/session/SessionProvider';
import { useTheme } from '../../src/theme/ThemeProvider';

/**
 * Protected group. Anything below this needs a verified, onboarded account.
 *
 * This is convenience, not security: the guard that matters is RLS in Postgres
 * and the authorization service in front of it. A client-side redirect keeps
 * the UI honest; it does not keep data safe.
 *
 * The onboarding redirect is the gate from README §9.1 — an authenticated
 * account is not a usable profile. Someone who abandons onboarding and reopens
 * the app lands back in it rather than in a Discover tab with nothing to show.
 */
export default function AppLayout() {
  const { state } = useSession();
  const theme = useTheme();

  if (state === 'loading') return null;
  if (state === 'signed_out' || state === 'misconfigured') {
    return <Redirect href="/(auth)/welcome" />;
  }
  if (state === 'unverified') return <Redirect href="/(auth)/verify-email" />;
  if (state === 'onboarding') return <Redirect href="/(onboarding)/basics" />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    />
  );
}
