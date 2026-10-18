import { useEffect } from 'react';
import { Animated, Image, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import type { ProfileCard as ProfileCardData } from '@nikahmate/domain';
import { CompatibilityBadge } from './CompatibilityBadge';
import { ProfileAvatar } from './ProfileAvatar';
import { rememberCard } from '../discovery/cardCache';
import { useLocale } from '../i18n/LocaleProvider';
import { useEntrance, usePressScale } from '../theme/useEntrance';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH_TARGET, radius, spacing, typography } from '../theme/tokens';

/**
 * The profile card. The single most important surface in the product.
 *
 * PHOTO-FIRST, WITH A REAL FALLBACK. Cross-user photos do not exist yet, so
 * the gradient portrait is what people will actually see — it is designed as
 * the primary state, not as a broken-image placeholder. When Storage delivery
 * lands, `primaryPhoto.url` fills the same frame and nothing else moves.
 *
 * WHAT IS ON IT, AND WHY NOT MORE. Name, age, place, compatibility, up to two
 * reasons, and verification. That is what someone needs to decide whether to
 * open a profile. Education and profession are deliberately NOT here: the card
 * appears in a scrolling list, and a card that tries to be a profile stops
 * being scannable — which is the one job it has. They are on the detail
 * screen, one tap away.
 *
 * NOTHING PRIVATE. The data comes from the server's card allowlist, so there
 * is no birth date, no review status and nothing sensitive to leak. The screen
 * cannot show what it was never sent.
 */

export interface ProfileCardProps {
  profile: ProfileCardData;
  onPress?: () => void;
  /** Rendered along the bottom edge. */
  actions?: React.ReactNode;
  /** Staggered entrance index. Omit for no animation. */
  index?: number;
  style?: ViewStyle;
  testID?: string;
}

const MAX_REASONS = 2;

export function ProfileCard({ profile, onPress, actions, index, style, testID }: ProfileCardProps) {
  const theme = useTheme();
  const { t } = useLocale();

  // The profile detail screen has only a user id to work with — there is no
  // public profile endpoint, by design. Registering the card here means every
  // list in the app seeds the detail screen's hero without any of them having
  // to know about it, and without personal data travelling through a URL.
  useEffect(() => {
    rememberCard(profile);
  }, [profile]);

  // Entrance and press feedback both honour the device's reduce-motion
  // setting; see theme/useEntrance.ts.
  const entrance = useEntrance(index);
  const press = usePressScale();

  const place = [profile.cityName, countryName(profile.countryCode)]
    .filter((part): part is string => Boolean(part))
    .join(', ');

  const reasons = profile.topReasons.slice(0, MAX_REASONS);
  const badges = profile.verification.badges;

  return (
    <Animated.View
      style={[
        {
          opacity: entrance,
          transform: [
            { scale: press.scale },
            {
              translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }),
            },
          ],
        },
        style,
      ]}
    >
      <Pressable
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabelFor(profile, place)}
        testID={testID}
        style={[
          styles.card,
          theme.shadow.card,
          { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
        ]}
      >
        {/* --- portrait ---------------------------------------------------- */}
        <View style={styles.portrait}>
          {profile.primaryPhoto?.url ? (
            <Image
              source={{ uri: profile.primaryPhoto.url }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
              accessibilityIgnoresInvertColors
              accessible={false}
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.centre]}>
              <ProfileAvatar
                userId={profile.userId}
                displayName={profile.displayName}
                size="hero"
              />
            </View>
          )}

          {/* A scrim so white text holds over any photo. Bottom-weighted, so
              the face stays clear. */}
          <LinearGradient
            colors={['transparent', 'rgba(3,41,31,0.10)', 'rgba(3,41,31,0.82)']}
            locations={[0, 0.45, 1]}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />

          {profile.compatibilityScore !== null ? (
            <CompatibilityBadge
              score={profile.compatibilityScore}
              size="sm"
              onDark
              style={styles.score}
            />
          ) : null}

          {profile.isShortlisted ? (
            <View style={styles.saved} accessibilityLabel={t('discovery.saved')}>
              <Ionicons name="bookmark" size={14} color={theme.colors.accent} />
            </View>
          ) : null}

          <View style={styles.identity} pointerEvents="none">
            <View style={styles.nameRow}>
              <Text style={styles.name} numberOfLines={1}>
                {profile.displayName ?? t('profile.someone')}
                {profile.age !== null ? <Text style={styles.age}>{`  ${profile.age}`}</Text> : null}
              </Text>
              {badges.length > 0 ? (
                <Ionicons name="shield-checkmark" size={15} color="#E5C76B" />
              ) : null}
            </View>
            {place ? (
              <Text style={styles.place} numberOfLines={1}>
                {place}
              </Text>
            ) : null}
          </View>
        </View>

        {/* --- reasons ------------------------------------------------------ */}
        {reasons.length > 0 ? (
          <View style={styles.reasons}>
            {reasons.map((key) => (
              <View
                key={key}
                style={[styles.reason, { backgroundColor: theme.colors.brandSurface }]}
              >
                <Ionicons name="checkmark-circle" size={13} color={theme.colors.brand} />
                <Text
                  style={[styles.reasonText, { color: theme.colors.brandHover }]}
                  numberOfLines={1}
                >
                  {t(`${key}.short`)}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {actions ? <View style={styles.actions}>{actions}</View> : null}
      </Pressable>
    </Animated.View>
  );
}

/**
 * One sentence for a screen reader, instead of six separate announcements.
 *
 * A card read as "Fatima. 27. Lahore. 82 percent match. Verified." is five
 * stops for one item; as a sentence it is one swipe.
 */
function accessibilityLabelFor(profile: ProfileCardData, place: string): string {
  const parts = [profile.displayName ?? 'Member'];
  if (profile.age !== null) parts.push(`${profile.age} years old`);
  if (place) parts.push(place);
  if (profile.compatibilityScore !== null) {
    parts.push(`${Math.round(profile.compatibilityScore)} percent compatible`);
  }
  if (profile.verification.badges.length > 0) parts.push('verified');
  return parts.join(', ');
}

/** Two-letter codes read badly; the label comes from reference data elsewhere. */
function countryName(code: string | null): string | null {
  return code ? code.toUpperCase() : null;
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.xl, overflow: 'hidden' },
  portrait: { height: 300, backgroundColor: '#064E3B', justifyContent: 'flex-end' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  score: { position: 'absolute', top: spacing.md, right: spacing.md },
  saved: {
    position: 'absolute',
    top: spacing.md,
    left: spacing.md,
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  identity: { padding: spacing.lg, gap: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { ...typography.title, color: '#FFFFFF', flexShrink: 1 },
  age: { ...typography.title, color: 'rgba(255,255,255,0.82)', fontWeight: '400' },
  place: { ...typography.caption, color: 'rgba(255,255,255,0.86)' },
  reasons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radius.pill,
    paddingVertical: 5,
    paddingHorizontal: spacing.sm + 2,
    maxWidth: '100%',
  },
  reasonText: { ...typography.caption, fontWeight: '600', flexShrink: 1 },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.lg,
    minHeight: MIN_TOUCH_TARGET + spacing.lg,
  },
});
