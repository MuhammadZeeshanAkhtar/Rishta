import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LocaleProvider } from '../src/i18n/LocaleProvider';
import { SessionProvider } from '../src/session/SessionProvider';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { lightTheme } from '../src/theme/theme';

/**
 * Root layout.
 *
 * LocaleProvider wraps everything because direction is a layout concern, not a
 * screen concern: an RTL locale mirrors the whole tree, including navigation.
 *
 * ThemeProvider ships one theme today. It exists so adding a dark theme later
 * is a change in `theme.ts`, not a sweep through every screen.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider theme={lightTheme}>
        <LocaleProvider>
          <SessionProvider>
            <StatusBar style="dark" />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: lightTheme.colors.background },
              }}
            />
          </SessionProvider>
        </LocaleProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
