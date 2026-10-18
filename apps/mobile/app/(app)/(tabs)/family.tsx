import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../../src/components/Screen';
import { SectionCard } from '../../../src/components/SectionCard';
import { StatusBadge } from '../../../src/components/StatusBadge';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { iconSize, radius, spacing, typography } from '../../../src/theme/tokens';

/**
 * Family — not built yet, and saying so properly.
 *
 * WHY THIS IS NOT A BLANK "COMING SOON". Family involvement is the thing that
 * distinguishes this product (README D12, ADR 0011), and this tab is where
 * someone goes to look for it. A one-line placeholder tells them the tab is
 * broken; an explanation tells them what the product intends and why the tab
 * is empty, which is the difference between an unfinished app and an
 * untrustworthy one.
 *
 * NOTHING HERE IS INTERACTIVE, deliberately. There is no invite button that
 * does nothing, no fake member list, no mock access log. Every control on this
 * screen would be a promise the backend cannot keep — Phase 6b has no table,
 * no endpoint and no approval path — and a button that silently fails is worse
 * than no button at all.
 *
 * The three cards mirror the real model so the eventual build has somewhere to
 * land: invite, permissions, review. When 6b ships, each becomes the live
 * surface it currently describes.
 */
export default function FamilyScreen() {
  const { t } = useLocale();
  const theme = useTheme();

  const steps = [
    {
      key: 'invite',
      icon: 'person-add-outline' as const,
      title: t('family.inviteTitle'),
      body: t('family.inviteBody'),
    },
    {
      key: 'permissions',
      icon: 'key-outline' as const,
      title: t('family.permissionsTitle'),
      body: t('family.permissionsBody'),
    },
    {
      key: 'review',
      icon: 'shield-checkmark-outline' as const,
      title: t('family.reviewTitle'),
      body: t('family.reviewBody'),
    },
  ];

  return (
    <Screen title={t('tabs.family')} subtitle={t('family.subtitle')}>
      <View style={styles.body}>
        {/* The honest status, stated once and at the top rather than repeated
            on each card. `warm` rather than `danger`: nothing is wrong, it is
            simply not here yet. */}
        <View
          style={[
            styles.notice,
            { backgroundColor: theme.colors.accentSurface, borderColor: theme.colors.accent },
          ]}
          accessible
          accessibilityLabel={`${t('family.notYetTitle')}. ${t('family.notYetBody')}`}
        >
          <View style={styles.noticeHead}>
            <Ionicons name="time-outline" size={iconSize.sm} color={theme.colors.accent} />
            <Text style={[styles.noticeTitle, { color: theme.colors.accent }]}>
              {t('family.notYetTitle')}
            </Text>
            <StatusBadge label={t('family.phase')} tone="warm" />
          </View>
          <Text style={[styles.noticeBody, { color: theme.colors.textMuted }]}>
            {t('family.notYetBody')}
          </Text>
        </View>

        {steps.map((step, index) => (
          <SectionCard
            key={step.key}
            title={step.title}
            icon={step.icon}
            index={index + 1}
            testID={`family-step-${step.key}`}
          >
            <Text style={[styles.stepBody, { color: theme.colors.textMuted }]}>{step.body}</Text>
          </SectionCard>
        ))}

        {/* The promise that matters most, and the reason the gate exists at
            all. Last, so it is what someone leaves the screen with. */}
        <View style={[styles.footnote, { borderTopColor: theme.colors.border }]}>
          <Ionicons name="lock-closed-outline" size={iconSize.xs} color={theme.colors.textSubtle} />
          <Text style={[styles.footnoteText, { color: theme.colors.textSubtle }]}>
            {t('family.privacyNote')}
          </Text>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md, marginTop: spacing.lg },
  notice: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  noticeHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  noticeTitle: { ...typography.bodyStrong, flex: 1, flexShrink: 1 },
  noticeBody: { ...typography.caption, lineHeight: 20 },
  stepBody: { ...typography.body, lineHeight: 23 },
  footnote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.lg,
    marginTop: spacing.sm,
  },
  footnoteText: { ...typography.caption, flex: 1, lineHeight: 19 },
});
