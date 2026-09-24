import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { colors, layout, spacing, typography } from '../../../src/theme/tokens';

/**
 * Five tabs (ADR 0004): Discover, Interests, Messages, Family, Me.
 *
 * Family has its own tab deliberately. Family involvement is what separates
 * this product from a dating app, and the family access log is an
 * anti-coercion control — burying either in a settings screen would be the
 * wrong signal.
 *
 * Five labels must fit 320dp, and Urdu and Arabic run longer than English.
 * The label character budget is enforced as a test in @nikahmate/i18n.
 */

/**
 * The label is rendered here rather than through `tabBarLabelStyle`.
 *
 * react-navigation writes an explicit `height` on its own label element, sized
 * for Latin text (fontSize x ~1.2), together with `overflow: hidden`. At 11px
 * that is 13px, which clips Arabic and Urdu descenders no matter what
 * lineHeight the style asks for. Owning the element is the only reliable fix.
 */
function TabLabel({ label, color }: { label: string; color: ColorValue }) {
  return (
    <Text testID="tab-label" numberOfLines={1} style={[styles.label, { color }]}>
      {label}
    </Text>
  );
}

export default function TabsLayout() {
  const { t, isRtl } = useLocale();
  const insets = useSafeAreaInsets();

  const screenOptions = {
    headerShown: false,
    tabBarActiveTintColor: colors.primary,
    tabBarInactiveTintColor: colors.textMuted,
    tabBarStyle: {
      borderTopColor: colors.border,
      backgroundColor: colors.background,
      height: layout.tabBarHeight + insets.bottom,
      paddingBottom: insets.bottom + spacing.xs,
      paddingTop: spacing.xs,
    },
    // The tab bar mirrors with the locale, so the first tab sits where the
    // reader's eye starts.
    sceneStyle: { backgroundColor: colors.background, direction: isRtl ? 'rtl' : 'ltr' } as const,
  };

  const tab = (name: string, key: string, icon: keyof typeof Ionicons.glyphMap) => (
    <Tabs.Screen
      key={name}
      name={name}
      options={{
        title: t(key),
        tabBarLabel: ({ color }: { color: ColorValue }) => (
          <TabLabel label={t(key)} color={color} />
        ),
        tabBarIcon: ({ color, size }: { color: ColorValue; size: number }) => (
          <Ionicons name={icon} color={color as string} size={size} />
        ),
      }}
    />
  );

  return (
    <Tabs screenOptions={screenOptions}>
      {tab('discover', 'tabs.discover', 'search')}
      {tab('interests', 'tabs.interests', 'heart')}
      {tab('messages', 'tabs.messages', 'chatbubbles')}
      {tab('family', 'tabs.family', 'people')}
      {tab('me', 'tabs.me', 'person')}
    </Tabs>
  );
}

const styles = StyleSheet.create({
  label: {
    ...typography.tabLabel,
    // Explicitly taller than the Latin-derived default, and centred, so every
    // script we ship renders without clipping.
    height: typography.tabLabel.lineHeight + 3,
    // flexShrink: 0 is the part that actually matters. react-navigation places
    // the label in a height-constrained flex column, and the default shrink
    // pulled the box back to ~13px regardless of the height asked for — which
    // clipped Arabic and Urdu descenders while leaving Latin untouched.
    flexShrink: 0,
    textAlign: 'center',
    includeFontPadding: false,
  },
});
