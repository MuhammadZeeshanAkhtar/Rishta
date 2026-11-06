import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { isNikahMateError } from '@nikahmate/api-client';
import { parseFamilyInviteLink, toFamilyInviteRef, type FamilyInviteRef } from '@nikahmate/domain';
import { Banner } from '../../../src/components/Banner';
import { Button } from '../../../src/components/Button';
import { SectionCard } from '../../../src/components/SectionCard';
import { TextField } from '../../../src/components/TextField';
import { getClient } from '../../../src/api/client';
import { pendingInvite, usePendingInvite } from '../../../src/family/pendingInvite';
import { describeError } from '../../../src/lib/errors';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { spacing, typography } from '../../../src/theme/tokens';

/**
 * Join a family — the invitee's side of an invitation (review B2).
 *
 * Reached by opening an invitation link (`…/family/join?i=…&t=…`), from the
 * invitation saved while the person signed in or onboarded, or by pasting the
 * link here. Before this screen existed no delegate could ever join, so a
 * member who chose "family reviewed" had matches waiting on review forever.
 *
 * ACCEPTING IS ALWAYS A TAP. Opening a link never accepts on its own: it makes
 * the person a family member of whoever sent it, and the API has no preview of
 * who that is (decision 2026-11-01: keep the contract), so the screen says so
 * plainly and offers Decline beside Accept.
 */
type Outcome = 'accepted' | 'declined';

export default function JoinFamilyScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const params = useLocalSearchParams<{ i?: string; t?: string }>();
  const pending = usePendingInvite();

  const fromLink = useMemo(() => toFamilyInviteRef(params.i, params.t), [params.i, params.t]);
  const [pasted, setPasted] = useState<FamilyInviteRef | null>(null);
  const invite = pasted ?? fromLink ?? pending;

  const [linkText, setLinkText] = useState('');
  const [linkError, setLinkError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Outcome | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const applyPastedLink = useCallback(() => {
    setLinkError(undefined);
    const ref = parseFamilyInviteLink(linkText);
    if (!ref) {
      setLinkError(t('family.joinInvalidLink'));
      return;
    }
    setPasted(ref);
  }, [linkText, t]);

  const respond = useCallback(
    async (accept: boolean) => {
      if (!invite) return;
      setError(null);
      setBusy(accept ? 'accepted' : 'declined');
      try {
        await getClient().respondToFamilyInvitation(invite.invitationId, invite.token, accept);
        // Used: the token is spent and must not be offered again.
        await pendingInvite.set(null);
        setOutcome(accept ? 'accepted' : 'declined');
      } catch (err) {
        if (isNikahMateError(err) && err.kind === 'not_found') {
          // Wrong, used, cancelled or unknown — the API answers all of them
          // alike on purpose, so the screen does too.
          setError(t('family.joinNotFound'));
          await pendingInvite.set(null);
        } else if (isNikahMateError(err) && err.kind === 'conflict') {
          setError(t('family.joinExpired'));
          await pendingInvite.set(null);
        } else if (isNikahMateError(err) && err.kind === 'validation_failed') {
          setError(t('family.joinOwn'));
          await pendingInvite.set(null);
        } else {
          // Network or server: keep the invitation so "try again" works.
          setError(describeError(err, t).message);
        }
      } finally {
        setBusy(null);
      }
    },
    [invite, t],
  );

  const notNow = useCallback(() => {
    void pendingInvite.set(null);
    router.replace('/family');
  }, []);

  return (
    <>
      <Stack.Screen options={{ title: t('family.joinHeading') }} />
      <ScrollView
        style={[styles.root, { backgroundColor: theme.colors.background }]}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {error ? <Banner tone="error" message={error} /> : null}

        {outcome !== null ? (
          <SectionCard
            title={outcome === 'accepted' ? t('family.joinAccepted') : t('family.joinDeclined')}
            icon={outcome === 'accepted' ? 'checkmark-circle-outline' : 'close-circle-outline'}
            index={0}
          >
            <Button
              label={t('family.joinGoToFamily')}
              onPress={() => router.replace('/family')}
              testID="join-done"
            />
          </SectionCard>
        ) : invite ? (
          <SectionCard title={t('family.joinHeading')} icon="people-outline" index={0}>
            <Text style={[styles.body, { color: theme.colors.text }]}>{t('family.joinBody')}</Text>
            <Button
              label={t('family.joinAccept')}
              onPress={() => void respond(true)}
              loading={busy === 'accepted'}
              disabled={busy !== null}
              testID="join-accept"
            />
            <Button
              label={t('family.joinDecline')}
              variant="secondary"
              onPress={() => void respond(false)}
              loading={busy === 'declined'}
              disabled={busy !== null}
              testID="join-decline"
            />
            <Button label={t('family.joinNotNow')} variant="ghost" onPress={notNow} />
          </SectionCard>
        ) : (
          <SectionCard title={t('family.joinHeading')} icon="link-outline" index={0}>
            <Text style={[styles.body, { color: theme.colors.textMuted }]}>
              {t('family.joinPasteBody')}
            </Text>
            <TextField
              label={t('family.joinPasteLabel')}
              value={linkText}
              onChangeText={setLinkText}
              error={linkError}
              autoCapitalize="none"
              multiline
              testID="join-link"
            />
            <Button label={t('common.continue')} onPress={applyPastedLink} testID="join-continue" />
          </SectionCard>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  body: { ...typography.body, lineHeight: 22 },
});
