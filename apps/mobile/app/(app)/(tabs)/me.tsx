import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { OwnPhoto, OwnProfile, ProfileCompletion } from '@nikahmate/domain';
import { ActionRow } from '../../../src/components/ActionRow';
import { Banner } from '../../../src/components/Banner';
import { SkeletonBlock } from '../../../src/components/LoadingSkeleton';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { ProfileHero } from '../../../src/profile/ProfileHero';
import { ProfileHighlights } from '../../../src/profile/ProfileHighlights';
import { ProfileStatusCard } from '../../../src/profile/ProfileStatusCard';
import { ProfileSummary } from '../../../src/profile/ProfileSummary';
import { useProfileView } from '../../../src/profile/useProfileView';
import { useSession } from '../../../src/session/SessionProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { getClient } from '../../../src/api/client';
import { describeError } from '../../../src/lib/errors';
import { layout, radius, spacing, typography } from '../../../src/theme/tokens';

/**
 * My profile.
 *
 * READS AS FINISHED, BECAUSE IT IS. A completed profile opens on a full-bleed
 * portrait with the member's name on it and no mention of drafts, percentages
 * or saving — the states that belong to editing stay in editing. The previous
 * version showed the onboarding "Draft saved" banner the whole time the
 * profile sat in review, which made the most complete state in the product
 * look like unsaved work.
 *
 * SO WHERE DID THE PERCENTAGE GO. Into `ProfileStatusCard`, which renders only
 * while there is something to do: progress while drafting, "in review" while
 * pending, what to fix if rejected, and nothing at all once approved. A
 * progress bar that never goes away stops being help and becomes nagging.
 *
 * THE PHOTO IS THE MEMBER'S OWN. `listPhotos()` returns short-lived signed
 * URLs for the owner's own photos, which is the only place in this app a real
 * photograph can be shown today — cross-user delivery does not exist yet. A
 * rejected photo is skipped: whatever moderation turned down should not be the
 * first thing its owner sees.
 *
 * ORDER IS THE DESIGN. Portrait, then what needs doing, then the quick
 * impression, then their own words, then values, then life, and only at the
 * bottom the things you do TO the profile. Put the four settings rows at the
 * top and the screen becomes a settings menu with a photograph attached, which
 * is what it was.
 */
export default function MeScreen() {
  const { t } = useLocale();
  const { signOut } = useSession();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [completion, setCompletion] = useState<ProfileCompletion | null>(null);
  const [photos, setPhotos] = useState<OwnPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // All three at once. Serially this is three round trips before anything
      // renders, which on the connections this product targets is the
      // difference between a screen and a spinner.
      const [nextProfile, nextCompletion, nextPhotos] = await Promise.all([
        getClient().getProfile(),
        getClient().getProfileCompletion(),
        // The portrait is an enhancement, not the screen. A photo service
        // having a bad minute must not blank out a profile that loaded fine.
        getClient()
          .listPhotos()
          .catch(() => [] as OwnPhoto[]),
      ]);
      setProfile(nextProfile);
      setCompletion(nextCompletion);
      setPhotos(nextPhotos);
      setError(null);
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  // Focus only — it fires on mount too, so a separate mount effect would make
  // every open of this tab two identical requests.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (loading) {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <View style={[styles.pad, { paddingTop: insets.top + spacing.md }]}>
          <SkeletonBlock height={380} rounded={radius.xl} />
          <View style={styles.skeletonRow}>
            <SkeletonBlock height={78} rounded={radius.lg} width="48%" />
            <SkeletonBlock height={78} rounded={radius.lg} width="48%" />
          </View>
          <SkeletonBlock height={140} rounded={radius.xl} />
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      contentContainerStyle={[
        styles.pad,
        { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.xxl },
      ]}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load();
          }}
          tintColor={theme.colors.brand}
          colors={[theme.colors.brand]}
        />
      }
    >
      {error ? <Banner tone="error" message={error} /> : null}

      {profile ? (
        <Hero profile={profile} completion={completion} photos={photos} />
      ) : (
        <Banner tone="error" message={t('profile.notProvided')} />
      )}

      {completion ? (
        <ProfileStatusCard
          completion={completion}
          onEdit={() => router.push('/(app)/edit-profile')}
          index={0}
        />
      ) : null}

      {/* The hero block already carries the four highlights, so the summary
          skips them here. They stay on by default for the onboarding preview,
          which has no hero to put them under. */}
      {profile ? <ProfileSummary profile={profile} showHighlights={false} baseIndex={1} /> : null}

      <View style={styles.actions}>
        <Text style={[styles.actionsLabel, { color: theme.colors.textSubtle }]}>
          {t('profile.manage')}
        </Text>

        <ActionRow
          icon="create-outline"
          label={t('profile.editProfile')}
          sublabel={t('profile.editProfileHint')}
          onPress={() => router.push('/(app)/edit-profile')}
          testID="me-edit-profile"
        />
        <ActionRow
          icon="lock-closed-outline"
          label={t('privacy.openPrivacy')}
          sublabel={t('privacy.openPrivacyHint')}
          onPress={() => router.push('/(app)/privacy')}
          testID="me-privacy"
        />
        <ActionRow
          icon="options-outline"
          label={t('preferences.editPreferences')}
          sublabel={t('preferences.editPreferencesHint')}
          onPress={() => router.push('/(app)/edit-preferences')}
          testID="me-edit-preferences"
        />
      </View>

      {/* Separated by space and a rule rather than by colour. Signing out is
          not an emergency, and a red block at the end of a profile reads as
          one. */}
      <View style={[styles.account, { borderTopColor: theme.colors.border }]}>
        <ActionRow
          icon="log-out-outline"
          label={t('auth.signOut')}
          onPress={() => void signOut()}
          destructive
          testID="me-sign-out"
        />
      </View>
    </ScrollView>
  );
}

/**
 * The hero, plus the highlight grid it sits on.
 *
 * Split out so `useProfileView` is called from a component that only renders
 * once a profile exists — a hook cannot be called conditionally, and the
 * alternative is calling it with a fabricated empty profile.
 */
function Hero({
  profile,
  completion,
  photos,
}: {
  profile: OwnProfile;
  completion: ProfileCompletion | null;
  photos: readonly OwnPhoto[];
}) {
  const { t } = useLocale();
  const view = useProfileView(profile);

  // Primary first, then position, and never a rejected one. `full` over
  // `thumb`: this frame is 380dp tall and a thumbnail would show its pixels.
  const portrait =
    photos
      .filter((photo) => photo.moderationStatus !== 'rejected' && photo.urls.full !== null)
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.position - b.position)[0]?.urls
      .full ?? null;

  const pill =
    completion?.reviewStatus === 'approved'
      ? { label: t('profile.status.complete'), icon: 'checkmark-circle' as const }
      : completion?.reviewStatus === 'pending'
        ? { label: t('profile.status.inReview'), icon: 'hourglass-outline' as const }
        : null;

  return (
    <View style={styles.heroBlock}>
      <ProfileHero
        userId={profile.userId}
        displayName={view.displayName}
        meta={view.meta}
        tagline={view.tagline}
        photoUri={portrait}
        pill={pill}
        testID="me-hero"
      />
      <ProfileHighlights items={view.highlights} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: {
    paddingHorizontal: layout.gutter,
    gap: spacing.md,
    width: '100%',
    maxWidth: layout.maxContentWidth,
    alignSelf: 'center',
  },
  heroBlock: { gap: spacing.md },
  skeletonRow: { flexDirection: 'row', gap: spacing.md },
  actions: { gap: spacing.sm, marginTop: spacing.lg },
  actionsLabel: { ...typography.overline, letterSpacing: 0.6, paddingHorizontal: spacing.xs },
  account: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.lg,
    marginTop: spacing.lg,
  },
});
