import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { layout, spacing, typography } from '../../../src/theme/tokens';

/**
 * Five tabs (ADR 0004): Discover, Interests, Messages, Family, Me.
 *
 * Family has its own tab deliberately. Family involvement is what separates
 * this product from a dating app, and the family access log is an
 * anti-coercion control — burying either in a settings screen would be the
 * wrong signal.
 *
 * Five labels must fit 320dp. The label character budget is enforced as a
 * test in @nikahmate/i18n.
 *
 * Icons are outline when inactive and filled when active: a second, redundant
 * signal alongside colour, which matters for anyone who cannot rely on the
 * colour difference alone.
 */

/**
 * The label is rendered here rather than through `tabBarLabelStyle`.
 *
 * react-navigation places the label in a height-constrained flex column and
 * writes its own height. The default `flexShrink` then pulls the box back to
 * ~13px whatever lineHeight is asked for, which clipped descenders. Owning the
 * element, with an explicit height and `flexShrink: 0`, is the reliable fix.
 */
function TabLabel({ label, color }: { label: string; color: ColorValue }) {
  return (
    <Text testID="tab-label" numberOfLines={1} style={[styles.label, { color }]}>
      {label}
    </Text>
  );
}

type IconName = keyof typeof Ionicons.glyphMap;

export default function TabsLayout() {
  const { t } = useLocale();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const screenOptions = {
    headerShown: false,
    tabBarActiveTintColor: theme.colors.brand,
    tabBarInactiveTintColor: theme.colors.textSubtle,
    tabBarStyle: {
      borderTopColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      height: layout.tabBarHeight + insets.bottom,
      paddingBottom: insets.bottom + spacing.xs,
      paddingTop: spacing.sm,
    },
    sceneStyle: { backgroundColor: theme.colors.background } as const,
  };

  const tab = (name: string, key: string, icon: IconName, iconActive: IconName) => (
    <Tabs.Screen
      key={name}
      name={name}
      options={{
        title: t(key),
        tabBarLabel: ({ color }: { color: ColorValue }) => (
          <TabLabel label={t(key)} color={color} />
        ),
        tabBarIcon: ({
          color,
          size,
          focused,
        }: {
          color: ColorValue;
          size: number;
          focused: boolean;
        }) => (
          <Ionicons name={focused ? iconActive : icon} color={color as string} size={size - 2} />
        ),
      }}
    />
  );

  return (
    <Tabs screenOptions={screenOptions}>
      {tab('discover', 'tabs.discover', 'search-outline', 'search')}
      {tab('interests', 'tabs.interests', 'heart-outline', 'heart')}
      {tab('messages', 'tabs.messages', 'chatbubbles-outline', 'chatbubbles')}
      {tab('family', 'tabs.family', 'people-outline', 'people')}
      {tab('me', 'tabs.me', 'person-outline', 'person')}
    </Tabs>
  );
}

const styles = StyleSheet.create({
  label: {
    ...typography.tabLabel,
    // Explicitly taller than the Latin-derived default, and not allowed to
    // shrink, so every script we ship renders without clipping.
    height: typography.tabLabel.lineHeight + 3,
    flexShrink: 0,
    textAlign: 'center',
    includeFontPadding: false,
  },
});
