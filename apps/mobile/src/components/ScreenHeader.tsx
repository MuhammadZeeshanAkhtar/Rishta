import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocale } from '../i18n/LocaleProvider';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH_TARGET, iconSize, spacing, typography } from '../theme/tokens';

/**
 * A back button and a title, for a screen reached from somewhere else.
 *
 * The `(app)` stack hides the navigator's own header, so without this a pushed screen
 * has no title and no way back except a phone's hardware button. On the web and on
 * iOS that means no way back at all.
 *
 * If there is nothing to go back to, as when a link opened this screen directly, it
 * goes to `fallback` instead of doing nothing.
 */
export function ScreenHeader({
  title,
  fallback = '/',
  right,
}: {
  title: string;
  fallback?: string;
  right?: React.ReactNode;
}) {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: insets.top + spacing.sm,
          backgroundColor: theme.colors.background,
          borderBottomColor: theme.colors.border,
        },
      ]}
    >
      <Pressable
        onPress={() => (router.canGoBack() ? router.back() : router.replace(fallback as never))}
        accessibilityRole="button"
        accessibilityLabel={t('common.back')}
        style={styles.back}
        testID="screen-back"
      >
        <Ionicons name="chevron-back" size={iconSize.md} color={theme.colors.text} />
      </Pressable>
      <Text
        style={[styles.title, { color: theme.colors.text }]}
        numberOfLines={1}
        accessibilityRole="header"
      >
        {title}
      </Text>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...typography.bodyStrong, flex: 1 },
  right: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
