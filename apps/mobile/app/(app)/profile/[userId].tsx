import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { CompatibilityExplanation, CompatibilityScore } from '@nikahmate/domain';
import { Banner } from '../../../src/components/Banner';
import { Button } from '../../../src/components/Button';
import { CompatibilityBadge } from '../../../src/components/CompatibilityBadge';
import { ChipRow, InfoChip } from '../../../src/components/InfoChip';
import { SectionCard } from '../../../src/components/SectionCard';
import { SkeletonBlock } from '../../../src/components/LoadingSkeleton';
import { recallCard } from '../../../src/discovery/cardCache';
import { SafetyMenu } from '../../../src/safety/SafetyMenu';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { ProfileHero } from '../../../src/profile/ProfileHero';
import { ProfileHighlights, type Highlight } from '../../../src/profile/ProfileHighlights';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { getClient } from '../../../src/api/client';
import { describeError } from '../../../src/lib/errors';
import { MIN_TOUCH_TARGET, layout, radius, spacing, typography } from '../../../src/theme/tokens';

/**
 * Someone else's profile.
 *
 * A DIFFERENT SCREEN FROM `/me`, DELIBERATELY. The owner's profile is a
 * portrait plus the things you can change about it; this one is a portrait
 * plus the case for the two of you, and it ends in a decision. Reusing the
 * owner layout here would put "Edit profile" on a stranger's page, and more
 * subtly it would imply the same fields are on show in both directions. They
 * are not.
 *
 * WHAT IT CAN SHOW, AND WHY THAT IS LESS THAN THE OWNER'S OWN PROFILE. There
 * is no public profile-detail endpoint, and that is the privacy model working
 * rather than a gap to route around: the server exposes another member only as
 * a `ProfileCard` built from an enumerated allowlist — name, age, country,
 * city if they chose city precision, photo, verification, compatibility — plus
 * the compatibility pair. Faith, marriage, education and lifestyle are NOT in
 * that allowlist, so there is nothing here to render them from. They are
 * deliberately absent rather than present and empty: four headings over "Not
 * stated" would read as a person who said nothing, when in fact the server
 * declined to say.
 *
 * SO COMPATIBILITY CARRIES THE SUBSTANCE, and it is more than a number. The
 * breakdown names the dimensions the engine actually compared, which is the
 * only honest way to describe someone whose details are withheld: not "she is
 * practising" but "you scored closely on faith and practice".
 *
 * DIFFERENCES ARE SHOWN. The contract is explicit that a one-sided explanation
 * is a sales pitch rather than information, and on a decision this
 * consequential that matters more than looking flattering.
 *
 * THE HERO COMES FROM THE CARD THE LIST ALREADY HELD. Opened cold — a deep
 * link, a restart — there is no card, and the screen degrades to the
 * compatibility it can fetch rather than inventing a name.
 */
export default function ProfileDetailScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { userId } = useLocalSearchParams<{ userId: string }>();

  const [score, setScore] = useState<CompatibilityScore | null>(null);
  const [explanation, setExplanation] = useState<CompatibilityExplanation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  // Whatever the list that brought us here had. Resolved once: a re-read
  // mid-render could swap the name under the reader.
  const card = useMemo(() => recallCard(userId), [userId]);
  const [shortlisted, setShortlisted] = useState(card?.isShortlisted ?? false);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    void (async () => {
      try {
        // Both at once: the breakdown needs them together, and two serial
        // round trips on a slow connection is a visible pause.
        const [nextScore, nextExplanation] = await Promise.all([
          getClient().getCompatibility(userId),
          getClient().getCompatibilityExplanation(userId),
        ]);
        if (cancelled) return;
        setScore(nextScore);
        setExplanation(nextExplanation);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(describeError(err, t).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [t, userId]);

  const expressInterest = useCallback(async () => {
    if (!userId) return;
    setSending(true);
    setError(null);
    try {
      await getClient().sendInterest(userId);
      setSent(true);
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setSending(false);
    }
  }, [t, userId]);

  const toggleShortlist = useCallback(async () => {
    if (!userId) return;
    // Optimistic, and reverted on failure: saving a profile is a low-stakes
    // action and waiting a round trip for the bookmark to fill in feels broken.
    const next = !shortlisted;
    setShortlisted(next);
    try {
      await (next ? getClient().addToShortlist(userId) : getClient().removeFromShortlist(userId));
    } catch (err) {
      setShortlisted(!next);
      setError(describeError(err, t).message);
    }
  }, [shortlisted, t, userId]);

  if (!userId) return null;

  const place = [card?.cityName, card?.countryCode?.toUpperCase()]
    .filter((part): part is string => Boolean(part))
    .join(', ');

  const meta =
    [card?.age !== null && card?.age !== undefined ? String(card.age) : null, place || null]
      .filter((part): part is string => Boolean(part))
      .join(' · ') || null;

  const overall = score?.overall ?? card?.compatibilityScore ?? null;

  // Only facts the card actually carries. No placeholders.
  const highlights: Highlight[] = [
    {
      key: 'place',
      icon: 'location-outline',
      value: place || null,
      caption: t('profile.display.livesIn'),
    },
    {
      key: 'compatibility',
      icon: 'sparkles-outline',
      value: overall !== null ? `${Math.round(overall)}%` : null,
      caption: t('compatibility.overall'),
    },
    {
      key: 'verified',
      icon: 'shield-checkmark-outline',
      value:
        card && card.verification.badges.length > 0
          ? t('profile.verifiedCount').replace('{{count}}', String(card.verification.badges.length))
          : null,
      caption: t('profile.verified'),
    },
  ];

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <ScrollView
        contentContainerStyle={[
          styles.pad,
          {
            paddingTop: spacing.md,
            paddingBottom: insets.bottom + spacing.xxxl + MIN_TOUCH_TARGET,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <ProfileHero
          userId={userId}
          displayName={card?.displayName ?? t('profile.someone')}
          meta={meta}
          photoUri={card?.primaryPhoto?.url ?? null}
          insetTop={insets.top}
          badge={
            // Compatibility and the safety menu share the top-right slot. The
            // menu is always present: being unable to report someone until
            // they have been scored would be exactly backwards.
            <View style={styles.heroActions}>
              {overall !== null ? <CompatibilityBadge score={overall} size="md" onDark /> : null}
              <SafetyMenu
                userId={userId}
                displayName={card?.displayName ?? null}
                // Leaves the screen: the person is now invisible to this
                // member, so staying on their profile would show a page that
                // can no longer be reloaded.
                onBlocked={() => router.back()}
                testID="profile-detail-safety"
              />
            </View>
          }
          pill={
            card && card.verification.badges.length > 0
              ? { label: t('profile.verified'), icon: 'shield-checkmark' }
              : null
          }
          leading={
            <Pressable
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel={t('common.back')}
              style={styles.back}
            >
              <Ionicons name="chevron-back" size={24} color="#FFFFFF" />
            </Pressable>
          }
          testID="profile-detail-hero"
        />

        <ProfileHighlights items={highlights} />

        {error ? <Banner tone="error" message={error} /> : null}

        {/* --- compatibility, which is the substance here ------------------ */}
        {loading ? (
          <SectionCard
            title={t('compatibility.title')}
            subtitle={t('compatibility.subtitle')}
            icon="sparkles"
          >
            <SkeletonBlock height={18} width="70%" />
            <SkeletonBlock height={18} width="55%" />
            <SkeletonBlock height={18} width="62%" />
          </SectionCard>
        ) : explanation && explanation.reasons.length + explanation.differences.length > 0 ? (
          <>
            {explanation.reasons.length > 0 ? (
              <SectionCard
                title={t('compatibility.reasons')}
                subtitle={t('compatibility.reasonsSubtitle')}
                icon="sparkles"
                index={0}
                testID="profile-detail-reasons"
              >
                <ChipRow>
                  {explanation.reasons.map((reason) => (
                    <InfoChip
                      key={reason.dimension}
                      label={t(`compatibility.${reason.dimension}.short`)}
                      icon="checkmark-circle"
                      tone={reason.sentiment === 'strong' ? 'brand' : 'neutral'}
                    />
                  ))}
                </ChipRow>
              </SectionCard>
            ) : null}

            {explanation.differences.length > 0 ? (
              <SectionCard
                title={t('compatibility.differences')}
                subtitle={t('compatibility.differencesSubtitle')}
                icon="git-compare-outline"
                index={1}
                testID="profile-detail-differences"
              >
                {explanation.differences.map((difference) => (
                  <View key={difference.dimension} style={styles.difference}>
                    <Ionicons
                      name="information-circle-outline"
                      size={17}
                      color={theme.colors.textSubtle}
                    />
                    <Text style={[styles.differenceText, { color: theme.colors.textMuted }]}>
                      <Text style={{ color: theme.colors.text, fontWeight: '600' }}>
                        {t(`compatibility.${difference.dimension}.label`)}
                      </Text>
                      {`  ${t(`compatibility.${difference.dimension}.short`)}`}
                    </Text>
                  </View>
                ))}
              </SectionCard>
            ) : null}
          </>
        ) : (
          <SectionCard title={t('compatibility.title')} icon="sparkles">
            <Text style={[styles.muted, { color: theme.colors.textMuted }]}>
              {t('compatibility.noScore')}
            </Text>
          </SectionCard>
        )}

        {/* The honest note about what is not here. Better than four empty
            sections implying this person told us nothing. */}
        <Text style={[styles.footnote, { color: theme.colors.textSubtle }]}>
          {t('profile.limitedByPrivacy')}
        </Text>
      </ScrollView>

      {/* --- action bar ---------------------------------------------------- */}
      <View
        style={[
          styles.bar,
          {
            paddingBottom: insets.bottom + spacing.md,
            backgroundColor: theme.colors.surface,
            borderTopColor: theme.colors.border,
          },
        ]}
      >
        <Pressable
          onPress={() => void toggleShortlist()}
          accessibilityRole="button"
          accessibilityLabel={shortlisted ? t('discovery.unsave') : t('discovery.save')}
          accessibilityState={{ selected: shortlisted }}
          style={[
            styles.save,
            {
              borderColor: shortlisted ? theme.colors.accent : theme.colors.border,
              backgroundColor: shortlisted ? theme.colors.accentSurface : 'transparent',
            },
          ]}
        >
          <Ionicons
            name={shortlisted ? 'bookmark' : 'bookmark-outline'}
            size={20}
            color={shortlisted ? theme.colors.accent : theme.colors.textMuted}
          />
        </Pressable>

        <Button
          label={sent ? t('interests.sent') : t('discovery.express')}
          onPress={() => void expressInterest()}
          loading={sending}
          disabled={sent}
          icon={<Ionicons name="heart" size={17} color={theme.colors.textOnBrand} />}
          style={styles.barButton}
          testID="profile-detail-express"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  heroActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  pad: {
    paddingHorizontal: layout.gutter,
    gap: spacing.md,
    width: '100%',
    maxWidth: layout.maxContentWidth,
    alignSelf: 'center',
  },
  back: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(3,41,31,0.38)',
  },
  difference: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  differenceText: { ...typography.caption, flex: 1, lineHeight: 20 },
  muted: { ...typography.caption },
  footnote: {
    ...typography.caption,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  bar: {
    flexDirection: 'row',
    gap: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: layout.gutter,
    paddingTop: spacing.md,
  },
  save: {
    width: MIN_TOUCH_TARGET + 4,
    height: MIN_TOUCH_TARGET,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  barButton: { flex: 1 },
});
