import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useSession } from '../src/session/SessionProvider';
import { colors } from '../src/theme/tokens';

/**
 * The three gates from README §6.1, in one place.
 *
 *   not signed in            -> (auth)
 *   signed in, incomplete    -> (app), which will route to onboarding in Phase 3
 *   complete                 -> (app)
 *
 * Routing mirrors the server's decision; it never makes it. The API is what
 * actually enforces that an incomplete profile is not discoverable.
 */
export default function Index() {
  const { state } = useSession();

  if (state === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (state === 'signed_out') return <Redirect href="/(auth)/welcome" />;
  return <Redirect href="/discover" />;
}
