import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Banner } from '../../../src/components/Banner';
import { Button } from '../../../src/components/Button';
import { EmptyState } from '../../../src/components/EmptyState';
import { Screen } from '../../../src/components/Screen';
import { SectionCard } from '../../../src/components/SectionCard';
import { StatusBadge } from '../../../src/components/StatusBadge';
import { useFamily } from '../../../src/family/useFamily';
import { useSession } from '../../../src/session/SessionProvider';
import { getClient } from '../../../src/api/client';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { iconSize, radius, spacing, typography } from '../../../src/theme/tokens';

/**
 * Family — the live surface (Phase 6b, ADR 0011, D12).
 *
 * This screen answers two different people with one layout, because one
 * person can be both: the OWNER who decides whether their matches wait for
 * family approval, and the DELEGATE who makes that decision for someone else.
 * Splitting them into two tabs would mean a parent on this product toggling
 * between them to do one errand.
 *
 * THE GATE IS THE OWNER'S. The switch at the top is theirs, reversible by
 * them, and no delegate can touch it. That is the first of R16's four
 * controls, so it sits at the top of the screen rather than inside a settings
 * sub-page where someone under pressure would have to go looking for it.
 *
 * THE WARNING THAT MATTERS: turning review on with nobody who can approve
 * stalls every future match, with no way to release it. `familyReviewersCount`
 * comes back on the account read precisely so this screen can say so AT THE
 * MOMENT the switch is flipped, not after the first match has sat for days.
 */
export default function FamilyScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const { me, refresh } = useSession();
  const { members, managed, reviews, myReviews, loading, error, reload } = useFamily();

  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const gateOn = me?.communicationPolicy === 'family_reviewed';
  const reviewers = me?.familyReviewersCount ?? 0;

  const setGate = useCallback(
    async (next: boolean) => {
      setSaving(true);
      setNotice(null);
      try {
        await getClient().updateSettings({
          communicationPolicy: next ? 'family_reviewed' : 'direct',
        });
        await refresh();
      } catch {
        setNotice(t('family.errorSave'));
      } finally {
        setSaving(false);
      }
    },
    [refresh, t],
  );

  const revoke = useCallback(
    (relationshipId: string, name: string) => {
      Alert.alert(t('family.revoke'), t('family.revokeConfirm').replace('{{name}}', name), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('family.revoke'),
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await getClient().revokeFamilyMember(relationshipId);
                reload();
                await refresh();
              } catch {
                setNotice(t('family.errorSave'));
              }
            })();
          },
        },
      ]);
    },
    [reload, refresh, t],
  );

  return (
    <Screen title={t('tabs.family')} subtitle={t('family.subtitle')}>
      <View style={styles.body}>
        {notice ? <Banner tone="error" message={notice} /> : null}
        {error ? <Banner tone="error" message={t('family.errorLoad')} /> : null}

        {/* --- the owner's own gate ------------------------------------- */}
        <SectionCard title={t('family.gateTitle')} icon="shield-checkmark-outline" index={0}>
          <View style={styles.gateRow}>
            <Text style={[styles.gateState, { color: theme.colors.text }]}>
              {gateOn ? t('family.gateOn') : t('family.gateOff')}
            </Text>
            <Switch
              value={gateOn}
              onValueChange={(next) => void setGate(next)}
              disabled={saving || !me}
              accessibilityLabel={t('family.gateTitle')}
              testID="family-gate-switch"
            />
          </View>

          <Text style={[styles.body2, { color: theme.colors.textMuted }]}>
            {t('family.gateBody')}
          </Text>

          {/* The one thing that turns this feature into a trap if unsaid. */}
          {gateOn && reviewers === 0 ? (
            <View
              style={[
                styles.warn,
                {
                  backgroundColor: theme.colors.dangerSurface,
                  borderColor: theme.colors.danger,
                },
              ]}
            >
              <Ionicons
                name="alert-circle-outline"
                size={iconSize.sm}
                color={theme.colors.danger}
              />
              <Text style={[styles.warnText, { color: theme.colors.danger }]}>
                {t('family.gateNoReviewers')}
              </Text>
            </View>
          ) : null}

          {reviewers > 0 ? (
            <StatusBadge
              label={t('family.gateReviewers').replace('{{count}}', String(reviewers))}
              tone="brand"
            />
          ) : null}
        </SectionCard>

        {/* --- my matches waiting on family ----------------------------- */}
        {myReviews.length > 0 ? (
          <SectionCard title={t('family.myReviewsTitle')} icon="hourglass-outline" index={1}>
            {myReviews.map((review) => (
              <View key={review.matchId} style={styles.row} testID={`my-review-${review.matchId}`}>
                <View style={styles.rowMain}>
                  <Text style={[styles.rowTitle, { color: theme.colors.text }]}>
                    {
                      {
                        pending: t('family.myReviewPending'),
                        approved: t('family.myReviewApproved'),
                        rejected: t('family.myReviewRejected'),
                        more_info_requested: t('family.myReviewMoreInfo'),
                        revoked: t('family.myReviewRevoked'),
                      }[review.decision]
                    }
                  </Text>
                  {review.note ? (
                    <Text style={[styles.rowSub, { color: theme.colors.textMuted }]}>
                      {review.note}
                    </Text>
                  ) : null}
                  {/* The R16 control, said plainly and with both ways out. */}
                  {review.overdue ? (
                    <Text style={[styles.rowSub, { color: theme.colors.danger }]}>
                      {t('family.myReviewStalled')}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </SectionCard>
        ) : null}

        {/* --- waiting for me, as a delegate ---------------------------- */}
        {managed.length > 0 ? (
          <SectionCard
            title={t('family.reviewsTitle')}
            icon="people-outline"
            index={2}
            trailing={
              reviews.length > 0 ? (
                <StatusBadge label={String(reviews.length)} tone="warm" />
              ) : undefined
            }
          >
            {reviews.length === 0 ? (
              <Text style={[styles.body2, { color: theme.colors.textMuted }]}>
                {t('family.reviewsEmpty')}
              </Text>
            ) : (
              reviews.map((review) => (
                <View key={review.matchId} style={styles.row} testID={`review-${review.matchId}`}>
                  <View style={styles.rowMain}>
                    <Text style={[styles.rowTitle, { color: theme.colors.text }]}>
                      {t('family.reviewFor').replace('{{name}}', review.ownerDisplayName ?? '')}
                    </Text>
                    <Text style={[styles.rowSub, { color: theme.colors.textMuted }]}>
                      {review.counterpartDisplayName ?? ''}
                      {review.counterpartAge !== null ? `, ${review.counterpartAge}` : ''}
                    </Text>
                    {review.overdue ? (
                      <StatusBadge label={t('family.reviewOverdue')} tone="warm" />
                    ) : null}
                  </View>
                  <Button
                    label={t('family.reviewOpen')}
                    variant="secondary"
                    onPress={() =>
                      router.push({
                        pathname: '/family/review/[matchId]',
                        params: { matchId: review.matchId },
                      })
                    }
                  />
                </View>
              ))
            )}
          </SectionCard>
        ) : null}

        {/* --- my delegates -------------------------------------------- */}
        <SectionCard title={t('family.membersTitle')} icon="person-add-outline" index={3}>
          {loading ? null : members.length === 0 ? (
            <EmptyState
              icon="person-add-outline"
              title={t('family.membersEmpty')}
              body={t('family.inviteBody')}
            />
          ) : (
            members.map((member) => (
              <View key={member.id} style={styles.row} testID={`family-member-${member.id}`}>
                <View style={styles.rowMain}>
                  <Text style={[styles.rowTitle, { color: theme.colors.text }]}>
                    {member.displayName ?? member.relationshipCode}
                  </Text>
                  {/* The grants they actually hold, never the tier's preset:
                      showing a preset would tell someone they had revoked
                      something they had not. */}
                  <Text style={[styles.rowSub, { color: theme.colors.textMuted }]}>
                    {member.permissions
                      .map((p) => t(`family.perm${p.charAt(0).toUpperCase()}${p.slice(1)}`))
                      .join(' · ')}
                  </Text>
                  {member.status === 'revoked' ? (
                    <StatusBadge label={t('family.revoked')} tone="neutral" />
                  ) : null}
                </View>
                {member.status === 'active' ? (
                  <Button
                    label={t('family.revoke')}
                    variant="secondary"
                    onPress={() => revoke(member.id, member.displayName ?? '')}
                  />
                ) : null}
              </View>
            ))
          )}

          <Button label={t('family.inviteCta')} onPress={() => router.push('/family/invite')} />
        </SectionCard>

        {/* --- the anti-coercion control ------------------------------- */}
        <SectionCard title={t('family.accessLogTitle')} icon="eye-outline" index={4}>
          <Text style={[styles.body2, { color: theme.colors.textMuted }]}>
            {t('family.accessLogNote')}
          </Text>
          <Button
            label={t('family.accessLogCta')}
            variant="secondary"
            onPress={() => router.push('/family/access-log')}
          />
        </SectionCard>

        <View style={[styles.footnote, { borderTopColor: theme.colors.border }]}>
          <Ionicons name="lock-closed-outline" size={iconSize.xs} color={theme.colors.textSubtle} />
          <Text style={[styles.footnoteText, { color: theme.colors.textSubtle }]}>
            {t('family.privacyNote')}
          </Text>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md, marginTop: spacing.lg },
  gateRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  gateState: { ...typography.bodyStrong, flex: 1, flexShrink: 1 },
  body2: { ...typography.body, lineHeight: 23 },
  warn: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  warnText: { ...typography.caption, flex: 1, lineHeight: 19 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  // flexShrink so a long name never pushes the action button off a 320dp
  // screen, which is the width this product targets.
  rowMain: { flex: 1, flexShrink: 1, gap: spacing.xs },
  rowTitle: { ...typography.bodyStrong },
  rowSub: { ...typography.caption, lineHeight: 19 },
  footnote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.lg,
    marginTop: spacing.sm,
  },
  footnoteText: { ...typography.caption, flex: 1, lineHeight: 19 },
});
