import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LocaleProvider } from '../src/i18n/LocaleProvider';
import { SessionProvider } from '../src/session/SessionProvider';
import { colors } from '../src/theme/tokens';

/**
 * Root layout.
 *
 * LocaleProvider wraps everything because direction is a layout concern, not a
 * screen concern: an RTL locale mirrors the whole tree, including navigation.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <LocaleProvider>
        <SessionProvider>
          <StatusBar style="dark" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
            }}
          />
        </SessionProvider>
      </LocaleProvider>
    </SafeAreaProvider>
  );
}
