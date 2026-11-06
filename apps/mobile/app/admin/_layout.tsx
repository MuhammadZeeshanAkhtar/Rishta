import { ActivityIndicator, View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { AdminGateScreen } from '../../src/admin/AdminChrome';
import { AdminProvider, useAdmin } from '../../src/admin/AdminProvider';
import { useSession } from '../../src/session/SessionProvider';
import { useTheme } from '../../src/theme/ThemeProvider';

/**
 * The staff console (review L1), at `/admin`.
 *
 * Outside the member `(app)` group on purpose: a staff account need not be a
 * completed member profile, so the onboarding redirect must not apply. It
 * still needs a verified, signed-in Supabase session — and then the API's
 * answer to `GET /admin/session`. The redirects and gate screens here are
 * presentation; the API refuses every call that is not allowed.
 */
export default function AdminLayout() {
  const { state } = useSession();
  if (state === 'loading') return null;
  if (state === 'signed_out' || state === 'misconfigured')
    return <Redirect href="/(auth)/sign-in" />;
  if (state === 'unverified') return <Redirect href="/(auth)/verify-email" />;
  return (
    <AdminProvider>
      <Console />
    </AdminProvider>
  );
}

function Console() {
  const { state } = useAdmin();
  const theme = useTheme();
  if (state.status === 'loading') {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.background,
        }}
      >
        <ActivityIndicator color={theme.colors.brand} />
      </View>
    );
  }
  if (state.status === 'gate') return <AdminGateScreen gate={state.gate} />;
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    />
  );
}
