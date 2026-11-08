import { useState } from 'react';
import { Redirect, useRouter } from 'expo-router';
import { deletionDetails } from '../src/account/accountDeletion';
import { useLocale } from '../src/i18n/LocaleProvider';
import { describeError } from '../src/lib/errors';
import { RestrictedAccountView } from '../src/session/RestrictedAccountView';
import type { RestrictedAction } from '../src/session/restrictedContent';
import { useSession } from '../src/session/SessionProvider';
import { redirectFor } from '../src/session/sessionState';
import { useTheme } from '../src/theme/ThemeProvider';

/**
 * The restricted-account screen (review N7). Outside the `(app)` and
 * `(onboarding)` groups, because a restricted account belongs in neither: asking
 * a banned member to finish their profile explained nothing and led nowhere.
 *
 * Presentation only. The API refuses a restricted account on every other route,
 * and decides whether a reactivation or cancellation is allowed.
 */
export default function RestrictedScreen() {
  const { state, me, reactivate, cancelDeletion, signOut, deletionRequest } = useSession();
  const router = useRouter();
  const { t } = useLocale();
  const theme = useTheme();
  const [busy, setBusy] = useState<RestrictedAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (state === 'loading') return null;
  const redirect = redirectFor('restricted', state);
  if (redirect) return <Redirect href={redirect as never} />;

  const onAction = async (action: RestrictedAction) => {
    if (action === 'request_deletion') {
      router.push('/delete-account' as never);
      return;
    }
    setBusy(action);
    setError(null);
    try {
      if (action === 'reactivate') await reactivate();
      else if (action === 'cancel_deletion') await cancelDeletion();
      else await signOut();
    } catch (failure) {
      setError(describeError(failure, t).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <RestrictedAccountView
      status={me?.status ?? ''}
      t={t}
      colors={{ text: theme.colors.text, textMuted: theme.colors.textMuted }}
      busy={busy}
      error={error}
      onAction={(action) => void onAction(action)}
      deletion={deletionDetails(deletionRequest)}
    />
  );
}
