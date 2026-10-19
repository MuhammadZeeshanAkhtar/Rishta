import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { ReviewPacket } from '@nikahmate/domain';
import { Banner } from '../../../../src/components/Banner';
import { Button } from '../../../../src/components/Button';
import { CompatibilityBadge } from '../../../../src/components/CompatibilityBadge';
import { InfoChip } from '../../../../src/components/InfoChip';
import { SkeletonList } from '../../../../src/components/LoadingSkeleton';
import { SectionCard } from '../../../../src/components/SectionCard';
import { TextField } from '../../../../src/components/TextField';
import { getClient } from '../../../../src/api/client';
import { useReference } from '../../../../src/reference/useReference';
import { useLocale } from '../../../../src/i18n/LocaleProvider';
import { useTheme } from '../../../../src/theme/ThemeProvider';
import { iconSize, radius, spacing, typography } from '../../../../src/theme/tokens';

/**
 * The review packet — one match, and the decision.
 *
 * WHAT IS NOT HERE is the design. No contact details, no exact location, no
 * photos beyond what the principal already shares, no message history, and no
 * way to reach any other profile. The server builds this as an enumerated
 * projection rather than a filtered profile read, so a new profile column
 * cannot arrive on this screen by default — and this screen shows exactly what
 * the server sends.
 *
 * THREE OUTCOMES, and the third is not a soft approval. "Ask for more
 * information" notifies the owner and leaves the match waiting: a middle
 * option that quietly behaved like approval would be the worst possible
 * default, so it is labelled as the question it is.
 */
export default function ReviewPacketScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const { matchId } = useLocalSearchParams<{ matchId: string }>();

  // The same reference lists the member's own screens resolve codes against.
  // Translating them on the server would put a second copy of this mapping
  // where it can drift from the one everyone else sees.
  const maritalStatuses = useReference('marital_status').items;
  const educationLevels = useReference('education_level').items;
  const religiousPractices = useReference('religious_practice').items;

  /** A code with no reference row shows as the code: a data problem worth seeing. */
  const labelOf = (
    items: ReadonlyArray<{ code: string; label: string }>,
    code: string | null,
  ): string | null => (code ? (items.find((i) => i.code === code)?.label ?? code) : null);

  const [packet, setPacket] = useState<ReviewPacket | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!matchId) return;
    let cancelled = false;

    getClient()
      .getReviewPacket(matchId)
      .then((result) => {
        if (cancelled) return;
        setPacket(result);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t('family.errorLoad'));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [matchId, t]);

  const decide = useCallback(
    async (action: 'approve' | 'reject' | 'request_more_info') => {
      if (!matchId) return;
      setBusy(true);
      setError(null);
      try {
        await getClient().decideReview(matchId, {
          action,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
        router.back();
      } catch {
        setError(t('family.errorSave'));
        setBusy(false);
      }
    },
    [matchId, note, t],
  );

  const c = packet?.counterpart;

  return (
    <>
      <Stack.Screen options={{ title: t('family.packetTitle') }} />
      <ScrollView
        style={[styles.root, { backgroundColor: theme.colors.background }]}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {error ? <Banner tone="error" message={error} /> : null}

        {loading ? (
          <SkeletonList />
        ) : !packet || !c ? null : (
          <>
            <SectionCard
              title={t('family.reviewFor').replace('{{name}}', packet.ownerDisplayName ?? '')}
              icon="shield-checkmark-outline"
              index={0}
            >
              <Text style={[styles.name, { color: theme.colors.text }]}>
                {c.displayName ?? ''}
                {c.age !== null ? `, ${c.age}` : ''}
              </Text>

              <View style={styles.chips}>
                {c.countryCode ? <InfoChip icon="location-outline" label={c.countryCode} /> : null}
                {c.maritalStatusCode ? (
                  <InfoChip
                    icon="heart-outline"
                    label={labelOf(maritalStatuses, c.maritalStatusCode) ?? ''}
                  />
                ) : null}
                {c.educationLevelCode ? (
                  <InfoChip
                    icon="school-outline"
                    label={labelOf(educationLevels, c.educationLevelCode) ?? ''}
                  />
                ) : null}
                {c.religiousPracticeCode ? (
                  <InfoChip
                    icon="moon-outline"
                    label={labelOf(religiousPractices, c.religiousPracticeCode) ?? ''}
                  />
                ) : null}
                {c.verified ? (
                  <InfoChip icon="checkmark-circle-outline" label={t('profile.verified')} />
                ) : null}
              </View>

              {c.aboutMe ? (
                <Text style={[styles.about, { color: theme.colors.textMuted }]}>{c.aboutMe}</Text>
              ) : null}
            </SectionCard>

            {packet.compatibility ? (
              <SectionCard
                title={t('family.packetCompatibility')}
                icon="analytics-outline"
                index={1}
              >
                <CompatibilityBadge score={packet.compatibility.score} />
                {/* Catalog keys, resolved through the same catalogue the
                    member's own screens use. The engine authors no prose. */}
                <View style={styles.chips}>
                  {packet.compatibility.explanationKeys.slice(0, 4).map((key) => (
                    <InfoChip key={key} icon="sparkles-outline" label={t(`${key}.short`)} />
                  ))}
                </View>
              </SectionCard>
            ) : null}

            <SectionCard title={t('family.packetSignals')} icon="alert-circle-outline" index={2}>
              <Text
                style={[
                  styles.signal,
                  {
                    color: packet.signals.counterpartReported
                      ? theme.colors.danger
                      : theme.colors.textMuted,
                  },
                ]}
              >
                {packet.signals.counterpartReported
                  ? t('family.packetReported')
                  : t('family.packetClean')}
              </Text>
              {packet.signals.blockExists ? (
                <Text style={[styles.signal, { color: theme.colors.danger }]}>
                  {t('family.packetBlocked')}
                </Text>
              ) : null}
            </SectionCard>

            {/* Said once, at the point where someone might wonder why there is
                no phone number on this screen. */}
            <View
              style={[
                styles.privacy,
                { backgroundColor: theme.colors.surfaceSunken, borderColor: theme.colors.border },
              ]}
            >
              <Ionicons
                name="lock-closed-outline"
                size={iconSize.xs}
                color={theme.colors.textSubtle}
              />
              <Text style={[styles.privacyText, { color: theme.colors.textSubtle }]}>
                {t('family.packetNoContact')}
              </Text>
            </View>

            <SectionCard title={t('family.packetTitle')} icon="create-outline" index={3}>
              <TextField
                label={t('family.decideNote')}
                value={note}
                onChangeText={setNote}
                multiline
                testID="review-note"
              />
              <Button
                label={t('family.approve')}
                onPress={() => void decide('approve')}
                loading={busy}
                testID="review-approve"
              />
              <Button
                label={t('family.requestInfo')}
                variant="secondary"
                onPress={() => void decide('request_more_info')}
                disabled={busy}
                testID="review-more-info"
              />
              <Button
                label={t('family.reject')}
                variant="danger"
                onPress={() => void decide('reject')}
                disabled={busy}
                testID="review-reject"
              />
            </SectionCard>
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  name: { ...typography.title },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  about: { ...typography.body, lineHeight: 23 },
  signal: { ...typography.body, lineHeight: 23 },
  privacy: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  privacyText: { ...typography.caption, flex: 1, lineHeight: 19 },
});
