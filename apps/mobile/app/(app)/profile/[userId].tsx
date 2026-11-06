import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type {
  CompatibilityExplanation,
  CompatibilityScore,
  ProfilePhotos,
  PublicProfile,
} from '@nikahmate/domain';
import { isNikahMateError } from '@nikahmate/api-client';
import { Banner } from '../../../src/components/Banner';
import { Button } from '../../../src/components/Button';
import { CompatibilityBadge } from '../../../src/components/CompatibilityBadge';
import { EmptyState } from '../../../src/components/EmptyState';
import { ExpandableText } from '../../../src/components/ExpandableText';
import { ChipRow, InfoChip } from '../../../src/components/InfoChip';
import { SectionCard } from '../../../src/components/SectionCard';
import { SkeletonBlock } from '../../../src/components/LoadingSkeleton';
import { recallCard } from '../../../src/discovery/cardCache';
import { SafetyMenu } from '../../../src/safety/SafetyMenu';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { ProfileHero } from '../../../src/profile/ProfileHero';
import { ProfileHighlights, type Highlight } from '../../../src/profile/ProfileHighlights';
import { publicProfileView, type LabelOf } from '../../../src/profile/publicProfileView';
import { ProfilePhotoGallery } from '../../../src/photos/ProfilePhotoGallery';
import { galleryView } from '../../../src/photos/photoAccess';
import { useReference } from '../../../src/reference/useReference';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { getClient } from '../../../src/api/client';
import { describeError } from '../../../src/lib/errors';
import { MIN_TOUCH_TARGET, layout, radius, spacing, typography } from '../../../src/theme/tokens';

/**
 * Someone else's profile (review L4, with L3 photos).
 *
 * A DIFFERENT SCREEN FROM `/me`, DELIBERATELY. The owner's profile is a
 * portrait plus the things you can change about it; this one is a portrait
 * plus the case for the two of you, and it ends in a decision.
 *
 * WHAT IT SHOWS IS WHAT THE SERVER RETURNED. `GET /profiles/{userId}` applies
 * the member's per-field visibility for THIS viewer — public, matched-only,
 * on-request and private — and leaves out what this viewer may not see. The
 * screen renders present fields only (`publicProfileView`), never "Not
 * stated", never a default; it says how many fields were withheld, because
 * four missing headings would read as a person who said nothing.
 *
 * PHOTOS come from `GET /profiles/{userId}/photos`: only objects this viewer
 * may read, signed with their own token. Blurred is a server-made file.
 *
 * UNAVAILABLE IS ONE STATE. Blocked either way, suspended, unreviewed or
 * deleted all arrive as 404 and all read the same — the screen never says
 * which, because saying "blocked" would tell someone they were blocked.
 *
 * COMPATIBILITY still carries the substance it always did, and differences
 * are shown: a one-sided explanation is a sales pitch.
 */
export default function ProfileDetailScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { userId } = useLocalSearchParams<{ userId: string }>();

  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [photos, setPhotos] = useState<ProfilePhotos | null>(null);
  const [score, setScore] = useState<CompatibilityScore | null>(null);
  const [explanation, setExplanation] = useState<CompatibilityExplanation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  // What the list that brought us here had: a name to show while loading.
  // Never used for a field the profile response withholds.
  const card = useMemo(() => recallCard(userId), [userId]);
  const [shortlisted, setShortlisted] = useState(card?.isShortlisted ?? false);

  const countries = useReference('country').items;
  const marital = useReference('marital_status').items;
  const practices = useReference('religious_practice').items;
  const timelines = useReference('marriage_timeline').items;
  const relocations = useReference('relocation_option').items;
  const languages = useReference('language').items;

  const labelOf: LabelOf = useCallback(
    (type, code) => {
      const items = {
        country: countries,
        marital_status: marital,
        religious_practice: practices,
        marriage_timeline: timelines,
        relocation_option: relocations,
        language: languages,
      }[type];
      return items.find((item) => item.code === code)?.label ?? code;
    },
    [countries, marital, practices, timelines, relocations, languages],
  );

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const next = await getClient().getPublicProfile(userId);
      setProfile(next);
      setUnavailable(false);
      setError(null);
      // Fire and forget: "who viewed me" is a courtesy to the owner, never a
      // reason to fail this screen.
      void getClient()
        .recordProfileView(userId)
        .catch(() => undefined);
    } catch (err) {
      if (isNikahMateError(err) && err.kind === 'not_found') {
        setUnavailable(true);
        setProfile(null);
      } else {
        setError(describeError(err, t).message);
      }
      setLoading(false);
      return;
    }

    // Photos and compatibility in parallel; each degrades on its own.
    const [nextPhotos, nextScore, nextExplanation] = await Promise.allSettled([
      getClient().getProfilePhotos(userId),
      getClient().getCompatibility(userId),
      getClient().getCompatibilityExplanation(userId),
    ]);
    if (nextPhotos.status === 'fulfilled') setPhotos(nextPhotos.value);
    if (nextScore.status === 'fulfilled') setScore(nextScore.value);
    if (nextExplanation.status === 'fulfilled') setExplanation(nextExplanation.value);
    setLoading(false);
  }, [t, userId]);

  // Signed photo URLs last five minutes: re-read whenever the screen returns.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    setLoading(true);
  }, [userId]);

  const requestPhotos = useCallback(
    async (message: string | undefined) => {
      if (!userId) return;
      setError(null);
      try {
        await getClient().requestPhotos(userId, message);
        setNotice(t('photoAccess.sent'));
        setPhotos(await getClient().getProfilePhotos(userId));
      } catch (err) {
        const described = describeError(err, t);
        setError(
          described.fields?.message === 'contact_details_not_allowed'
            ? t('photoAccess.contactDetails')
            : described.message,
        );
        throw err;
      }
    },
    [t, userId],
  );

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

  if (unavailable) {
    return (
      <View
        style={[
          styles.root,
          styles.centre,
          { backgroundColor: theme.colors.background, paddingTop: insets.top },
        ]}
      >
        <EmptyState
          icon="eye-off-outline"
          title={t('publicProfile.unavailableTitle')}
          body={t('publicProfile.unavailableBody')}
          actionLabel={t('common.back')}
          onAction={() => router.back()}
        />
      </View>
    );
  }

  const view = profile
    ? publicProfileView(profile, labelOf, {
        hasChildren: t('profile.display.hasChildren'),
        noChildren: t('profile.display.noChildren'),
      })
    : null;
  const displayName = view?.displayName ?? card?.displayName ?? null;
  const firstName = (displayName ?? '').trim().split(/\s+/)[0] || t('profile.someone');
  const age = view?.facts.find((f) => f.key === 'age')?.value ?? null;
  const country = view?.facts.find((f) => f.key === 'country')?.value ?? null;
  const meta = [age, country].filter((p): p is string => Boolean(p)).join(' · ') || null;
  const overall = score?.overall ?? card?.compatibilityScore ?? null;
  const portrait = galleryView(photos).shown[0]?.url ?? null;
  const badges = profile?.verification.badges ?? card?.verification.badges ?? [];
  const details = (view?.facts ?? []).filter((f) => f.key !== 'age' && f.key !== 'country');

  const highlights: Highlight[] = [
    {
      key: 'place',
      icon: 'location-outline',
      value: country,
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
        badges.length > 0
          ? t('profile.verifiedCount').replace('{{count}}', String(badges.length))
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
          displayName={displayName ?? t('profile.someone')}
          meta={meta}
          photoUri={portrait}
          insetTop={insets.top}
          badge={
            <View style={styles.heroActions}>
              {overall !== null ? <CompatibilityBadge score={overall} size="md" onDark /> : null}
              <SafetyMenu
                userId={userId}
                displayName={displayName}
                onBlocked={() => router.back()}
                testID="profile-detail-safety"
              />
            </View>
          }
          pill={
            badges.length > 0 ? { label: t('profile.verified'), icon: 'shield-checkmark' } : null
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
        {notice ? <Banner tone="success" message={notice} /> : null}

        {loading && !profile ? (
          <SectionCard title={t('publicProfile.aboutTitle')} icon="person-outline">
            <SkeletonBlock height={18} width="80%" />
            <SkeletonBlock height={18} width="60%" />
          </SectionCard>
        ) : null}

        {view?.aboutMe ? (
          <SectionCard
            title={t('profile.display.aboutName').replace('{{name}}', firstName)}
            icon="person-outline"
            testID="profile-detail-about"
          >
            <ExpandableText
              text={view.aboutMe}
              moreLabel={t('common.more')}
              lessLabel={t('common.less')}
            />
          </SectionCard>
        ) : null}

        {details.length > 0 ? (
          <SectionCard
            title={t('publicProfile.detailsTitle')}
            icon="list-outline"
            testID="profile-detail-facts"
          >
            <ChipRow>
              {details.map((fact) => (
                <InfoChip
                  key={fact.key}
                  prefix={t(`publicProfile.fact.${fact.key}`)}
                  label={fact.value}
                />
              ))}
            </ChipRow>
          </SectionCard>
        ) : null}

        <ProfilePhotoGallery
          photos={photos}
          name={firstName}
          onRequest={requestPhotos}
          testID="profile-detail-photos"
        />

        {explanation && explanation.reasons.length + explanation.differences.length > 0 ? (
          <>
            {explanation.reasons.length > 0 ? (
              <SectionCard
                title={t('compatibility.reasons')}
                subtitle={t('compatibility.reasonsSubtitle')}
                icon="sparkles"
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
        ) : !loading ? (
          <SectionCard title={t('compatibility.title')} icon="sparkles">
            <Text style={[styles.muted, { color: theme.colors.textMuted }]}>
              {t('compatibility.noScore')}
            </Text>
          </SectionCard>
        ) : null}

        {view && view.hiddenFieldCount > 0 ? (
          <Text
            style={[styles.footnote, { color: theme.colors.textSubtle }]}
            testID="profile-detail-hidden"
          >
            {t(
              view.relationship === 'match'
                ? 'publicProfile.hiddenFieldsMatch'
                : 'publicProfile.hiddenFields',
            ).replace('{{count}}', String(view.hiddenFieldCount))}
          </Text>
        ) : null}
      </ScrollView>

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
          label={
            profile?.viewerRelationship === 'match'
              ? t('publicProfile.matched')
              : sent
                ? t('interests.sent')
                : profile?.viewerRelationship === 'interest_pending'
                  ? t('publicProfile.interestPending')
                  : t('discovery.express')
          }
          onPress={() => void expressInterest()}
          loading={sending}
          disabled={
            sent ||
            profile?.viewerRelationship === 'match' ||
            profile?.viewerRelationship === 'interest_pending'
          }
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
  centre: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: layout.gutter },
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
