import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LocaleProvider, useLocale } from '../src/i18n/LocaleProvider';
import { SessionProvider } from '../src/session/SessionProvider';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { lightTheme } from '../src/theme/theme';
import { setLocaleReader } from '../src/api/client';
import { AuthLinkHandler } from '../src/auth/AuthLinkHandler';

/**
 * Root layout.
 *
 * LocaleProvider wraps everything so `t()` is reachable from any screen. The
 * app ships in English only; it stays a provider so a second locale is a
 * change here rather than in every component.
 *
 * ThemeProvider ships one theme today. It exists so adding a dark theme later
 * is a change in `theme.ts`, not a sweep through every screen.
 *
 * SessionProvider sits inside LocaleProvider because it reads the locale when
 * bootstrapping an account, and outside the navigator because the routing
 * gates depend on it.
 */

/**
 * Lets the API client send Accept-Language without importing React context.
 *
 * A ref-style handoff rather than passing the locale into every call: the
 * client is a singleton created once, and threading the value through it
 * would mean recreating it — which would drop the Supabase session with it.
 */
function LocaleBridge() {
  const { locale } = useLocale();
  useEffect(() => {
    setLocaleReader(() => locale);
  }, [locale]);
  return null;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider theme={lightTheme}>
        <LocaleProvider>
          <LocaleBridge />
          <SessionProvider>
            {/*
              Inside SessionProvider because it needs the session, and above the
              navigator so an email link is completed wherever the app is.
            */}
            <AuthLinkHandler />
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
