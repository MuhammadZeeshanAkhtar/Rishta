import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Banner } from '../../../src/components/Banner';
import { EmptyState } from '../../../src/components/EmptyState';
import { SkeletonList } from '../../../src/components/LoadingSkeleton';
import { useFamilyAccessLog } from '../../../src/family/useFamily';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { iconSize, radius, spacing, typography } from '../../../src/theme/tokens';

/**
 * What your family has seen — the anti-coercion control (R16).
 *
 * This screen is the reason the control works at all. `family_access_log` has
 * recorded every delegated read since Phase 6b, but a log that only a database
 * holds protects nobody: the point is that the person being acted for can see
 * what was done in their name, and decide whether to revoke.
 *
 * EVERY ROW NAMES THE PERMISSION. Without it an owner sees that their brother
 * opened something but not under which right — which is the question they
 * would actually be asking before deciding.
 */
export default function FamilyAccessLogScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const { entries, loading, error } = useFamilyAccessLog();

  return (
    <>
      <Stack.Screen options={{ title: t('family.accessLogTitle') }} />
      <ScrollView
        style={[styles.root, { backgroundColor: theme.colors.background }]}
        contentContainerStyle={styles.content}
      >
        <Text style={[styles.note, { color: theme.colors.textMuted }]}>
          {t('family.accessLogNote')}
        </Text>

        {error ? <Banner tone="error" message={t('family.errorLoad')} /> : null}

        {loading ? (
          <SkeletonList />
        ) : entries.length === 0 ? (
          <EmptyState icon="eye-outline" title={t('family.accessLogEmpty')} />
        ) : (
          entries.map((entry) => (
            <View
              key={entry.id}
              style={[
                styles.row,
                { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
              ]}
              testID={`access-log-${entry.id}`}
            >
              <Ionicons name="eye-outline" size={iconSize.sm} color={theme.colors.textSubtle} />
              <View style={styles.rowMain}>
                <Text style={[styles.rowTitle, { color: theme.colors.text }]}>
                  {entry.delegateDisplayName ?? entry.relationshipCode ?? ''}
                </Text>
                <Text style={[styles.rowSub, { color: theme.colors.textMuted }]}>
                  {entry.action}{' '}
                  {t('family.accessLogUnder').replace('{{permission}}', entry.permission)}
                </Text>
                <Text style={[styles.rowTime, { color: theme.colors.textSubtle }]}>
                  {new Date(entry.createdAt).toLocaleString()}
                </Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  note: { ...typography.caption, lineHeight: 19, marginBottom: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  rowMain: { flex: 1, flexShrink: 1, gap: spacing.xs },
  rowTitle: { ...typography.bodyStrong },
  rowSub: { ...typography.caption, lineHeight: 19 },
  rowTime: { ...typography.caption },
});
