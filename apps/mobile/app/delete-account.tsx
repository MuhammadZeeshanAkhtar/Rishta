import { useState } from 'react';
import { Redirect, useRouter } from 'expo-router';
import { AccountDeletionView } from '../src/account/AccountDeletionView';
import { deletionConfirmed } from '../src/account/accountDeletion';
import { useLocale } from '../src/i18n/LocaleProvider';
import { describeError } from '../src/lib/errors';
import { useSession } from '../src/session/SessionProvider';
import { redirectFor } from '../src/session/sessionState';
import { useTheme } from '../src/theme/ThemeProvider';

/**
 * Asking to delete an account. Outside the `(app)` and `(onboarding)` groups, because
 * it must be reachable from both, and by a restricted account: Google Play expects
 * anyone who can make an account to be able to ask for its deletion.
 *
 * Presentation only. The API starts the grace period, or places a safety hold, and
 * once it has, the session gates move the person to the pending state on their own.
 */
export default function DeleteAccountScreen() {
  const { state, me, requestDeletion } = useSession();
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state === 'loading') return null;
  const redirect = redirectFor('deletion', state);
  if (redirect) return <Redirect href={redirect as never} />;
  // Already asked: the pending state is where they can see it, and cancel it.
  if (me?.status === 'pending_deletion') return <Redirect href={'/restricted' as never} />;

  const onConfirm = async () => {
    if (!deletionConfirmed(typed)) return;
    setBusy(true);
    setError(null);
    try {
      await requestDeletion();
    } catch (failure) {
      setError(describeError(failure, t).message);
      setBusy(false);
    }
  };

  return (
    <AccountDeletionView
      t={t}
      colors={{ text: theme.colors.text, textMuted: theme.colors.textMuted }}
      typed={typed}
      onChangeTyped={setTyped}
      busy={busy}
      error={error}
      onConfirm={() => void onConfirm()}
      onCancel={() => (router.canGoBack() ? router.back() : router.replace('/'))}
    />
  );
}
