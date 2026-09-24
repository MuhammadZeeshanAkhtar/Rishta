import { Redirect, Stack } from 'expo-router';
import { useSession } from '../../src/session/SessionProvider';
import { colors } from '../../src/theme/tokens';

/**
 * Protected group. Anything below this is unreachable without a session.
 *
 * This is convenience, not security: the guard that matters is RLS in Postgres
 * and the authorization service in front of it. A client-side redirect keeps
 * the UI honest; it does not keep data safe.
 */
export default function AppLayout() {
  const { state } = useSession();

  if (state === 'loading') return null;
  if (state === 'signed_out') return <Redirect href="/(auth)/welcome" />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    />
  );
}
