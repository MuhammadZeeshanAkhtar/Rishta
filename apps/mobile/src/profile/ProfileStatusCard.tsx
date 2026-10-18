import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ProfileCompletion } from '@nikahmate/domain';
import { Button } from '../components/Button';
import { useLocale } from '../i18n/LocaleProvider';
import { useTheme } from '../theme/ThemeProvider';
import { useEntrance } from '../theme/useEntrance';
import { useReducedMotion } from '../theme/useReducedMotion';
import { radius, spacing, typography } from '../theme/tokens';

/**
 * Where the profile stands — but only while that is worth saying.
 *
 * THIS IS THE FIX FOR "DRAFT SAVED". The old screen showed the onboarding
 * "Draft saved" banner whenever `reviewStatus` was `pending`, which is exactly
 * backwards: `pending` means the profile has been SUBMITTED and is waiting for
 * review. Calling a finished profile a draft made the most complete state in
 * the product look like unsaved work, on the one screen whose whole job is to
 * feel finished.
 *
 * So each status now says what is actually true, and the one state that needs
 * no comment gets none:
 *
 *   draft     → progress, and a way to carry on. The only place a percentage
 *               belongs: it is a to-do list, and a to-do list with no progress
 *               bar is just a list.
 *   pending   → "in review". Submitted, nothing to do, do not imply otherwise.
 *   rejected  → what to change, and a way to get there. The reason arrives as
 *               a key so the catalogs own the wording.
 *   approved  → NOTHING. The hero already carries a "Profile complete" pill.
 *               A progress bar that never goes away reads as nagging, and a
 *               card confirming success every single visit is clutter.
 *
 * The percentage is never synthesised. It is `completion.score`, straight from
 * the API, and when the API has nothing to say neither does this.
 */

export interface ProfileStatusCardProps {
  completion: ProfileCompletion;
  onEdit: () => void;
  /** Staggered entrance index. */
  index?: number;
}

export function ProfileStatusCard({ completion, onEdit, index }: ProfileStatusCardProps) {
  const { t } = useLocale();
  const theme = useTheme();

  const entrance = useEntrance(index);
  const reduced = useReducedMotion();

  // The bar fills from zero rather than appearing full - the one animation on
  // this screen that carries information, since the motion IS the progress.
  // Under reduced motion it is simply drawn at its value: the number is the
  // message, and the movement was only ever the delivery.
  const fill = useRef(new Animated.Value(reduced ? completion.score : 0)).current;

  useEffect(() => {
    if (reduced) {
      fill.setValue(completion.score);
      return;
    }
    const animation = Animated.timing(fill, {
      toValue: completion.score,
      duration: 620,
      delay: 140,
      // NOT native-driven, because this animates `width`. `scaleX` would be,
      // but RN scales from the centre and there is no `transformOrigin` here,
      // so a half-full bar would render as a bar floating in the middle of the
      // track.
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [completion.score, fill, reduced]);

  // An approved profile is simply finished. Saying so again, every visit, in a
  // card, is the clutter this redesign exists to remove.
  if (completion.reviewStatus === 'approved') return null;

  const tone =
    completion.reviewStatus === 'rejected'
      ? { bg: theme.colors.dangerSurface, fg: theme.colors.danger, border: theme.colors.danger }
      : completion.reviewStatus === 'pending'
        ? { bg: theme.colors.accentSurface, fg: theme.colors.accent, border: theme.colors.accent }
        : {
            bg: theme.colors.brandSurface,
            fg: theme.colors.brandHover,
            border: theme.colors.brandBorder,
          };

  const copy = {
    draft: {
      icon: 'create-outline' as const,
      title: t('profile.status.draftTitle'),
      body: t('profile.completionHint'),
    },
    pending: {
      icon: 'hourglass-outline' as const,
      title: t('profile.status.pendingTitle'),
      body: t('profile.status.pendingBody'),
    },
    rejected: {
      icon: 'alert-circle-outline' as const,
      title: t('profile.status.rejectedTitle'),
      body: completion.rejectionReasonKey
        ? t(completion.rejectionReasonKey)
        : t('profile.status.rejectedBody'),
    },
    approved: { icon: 'checkmark-circle' as const, title: '', body: '' },
  }[completion.reviewStatus];

  const showProgress = completion.reviewStatus === 'draft';

  return (
    <Animated.View
      style={[
        styles.card,
        { backgroundColor: tone.bg, borderColor: tone.border },
        {
          opacity: entrance,
          transform: [
            { translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
          ],
        },
      ]}
      testID="profile-status"
    >
      <View style={styles.head}>
        <Ionicons name={copy.icon} size={19} color={tone.fg} />
        <Text style={[styles.title, { color: tone.fg }]}>{copy.title}</Text>
        {showProgress ? (
          <Text style={[styles.percent, { color: tone.fg }]}>{`${completion.score}%`}</Text>
        ) : null}
      </View>

      {showProgress ? (
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={t('profile.completion').replace(
            '{{percent}}',
            String(completion.score),
          )}
          accessibilityValue={{ min: 0, max: 100, now: completion.score }}
          style={[styles.track, { backgroundColor: theme.colors.surface }]}
        >
          <Animated.View
            style={[
              styles.fill,
              {
                backgroundColor: theme.colors.brand,
                width: fill.interpolate({
                  inputRange: [0, 100],
                  outputRange: ['0%', '100%'],
                  // A score outside 0–100 should not produce a bar wider than
                  // its track; the schema already bounds it, so this is only
                  // belt and braces.
                  extrapolate: 'clamp',
                }),
              },
            ]}
          />
        </View>
      ) : null}

      <Text style={[styles.body, { color: theme.colors.textMuted }]}>{copy.body}</Text>

      {completion.reviewStatus !== 'pending' ? (
        <Button
          label={t(
            completion.reviewStatus === 'rejected' ? 'common.edit' : 'profile.continueSetup',
          )}
          variant="primary"
          onPress={onEdit}
          style={styles.action}
          testID="profile-status-action"
        />
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { ...typography.bodyStrong, flex: 1, flexShrink: 1 },
  percent: { ...typography.bodyStrong },
  track: {
    height: 7,
    borderRadius: radius.pill,
    overflow: 'hidden',
    marginTop: spacing.xs,
  },
  fill: { height: '100%', borderRadius: radius.pill, alignSelf: 'flex-start' },
  body: { ...typography.caption, lineHeight: 19 },
  action: { marginTop: spacing.sm },
});
