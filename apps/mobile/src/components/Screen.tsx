import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocale } from '../i18n/LocaleProvider';
import { colors, layout, spacing, typography } from '../theme/tokens';

/**
 * Screen scaffold.
 *
 * Every text style here sets `writingDirection` from the active locale and uses
 * `textAlign: 'start'`, so Arabic and Urdu read right-to-left without any
 * screen having to think about it. Hardcoding 'left' anywhere is the bug this
 * exists to prevent.
 */
export function Screen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  const { direction } = useLocale();
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg },
      ]}
    >
      <View style={styles.inner}>
        <Text style={[styles.title, { writingDirection: direction, textAlign: 'left' }]}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { writingDirection: direction, textAlign: 'left' }]}>
            {subtitle}
          </Text>
        ) : null}
        {children}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: layout.gutter, flexGrow: 1 },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center' },
  title: { ...typography.display, color: colors.text, marginBottom: spacing.sm },
  subtitle: { ...typography.body, color: colors.textMuted, marginBottom: spacing.lg },
});
