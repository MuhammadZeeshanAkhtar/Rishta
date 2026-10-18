import React from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { useLocale } from '../i18n/LocaleProvider';
import { useTheme } from '../theme/ThemeProvider';
import { layout, radius, spacing, typography } from '../theme/tokens';
import { TOTAL_STEPS, stepIndex, type OnboardingStepKey } from './steps';

/**
 * The frame every onboarding step shares: progress, title, scrolling body,
 * and a footer that stays reachable above the keyboard.
 *
 * Centralising it means a step file contains only its own fields. It also
 * means the progress indicator cannot drift out of step with the route list,
 * because both read `steps.ts`.
 */
export function OnboardingStep({
  stepKey,
  subtitle,
  children,
  onBack,
  onNext,
  nextLabel,
  saving = false,
  error,
  nextDisabled = false,
}: {
  stepKey: OnboardingStepKey;
  subtitle?: string;
  children: React.ReactNode;
  onBack?: (() => void) | undefined;
  onNext: () => void;
  nextLabel?: string;
  saving?: boolean;
  error?: string | null;
  nextDisabled?: boolean;
}) {
  const { t } = useLocale();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const index = stepIndex(stepKey);
  const current = index + 1;
  const progress = current / TOTAL_STEPS;
  const title = t(`onboarding.${stepKey}Title`);

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + spacing.lg }]}>
        <Text style={[styles.stepCount, { color: theme.colors.textSubtle }]}>
          {t('onboarding.stepOf')
            .replace('{{current}}', String(current))
            .replace('{{total}}', String(TOTAL_STEPS))}
        </Text>

        <View
          accessibilityRole="progressbar"
          accessibilityLabel={t('a11y.progress')}
          accessibilityValue={{ min: 0, max: TOTAL_STEPS, now: current }}
          style={[styles.track, { backgroundColor: theme.colors.surfaceSunken }]}
        >
          {/*
            Width as a percentage rather than an animation: this renders on
            every step change, and an animated bar on a low-end device is one
            more thing to drop frames during a form.
          */}
          <View
            style={[
              styles.fill,
              { backgroundColor: theme.colors.brand, width: `${progress * 100}%` },
            ]}
          />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={styles.inner}>
          <Text style={[styles.title, { color: theme.colors.text }]}>{title}</Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>{subtitle}</Text>
          ) : null}

          {error ? <Banner tone="error" message={error} /> : null}

          <View style={styles.fields}>{children}</View>
        </View>
      </ScrollView>

      <View
        style={[
          styles.footer,
          {
            paddingBottom: insets.bottom + spacing.lg,
            borderTopColor: theme.colors.border,
            backgroundColor: theme.colors.surface,
          },
        ]}
      >
        {onBack ? (
          <Button
            label={t('common.back')}
            variant="ghost"
            onPress={onBack}
            style={styles.footerBack}
            testID="onboarding-back"
          />
        ) : null}
        <Button
          label={nextLabel ?? t('common.next')}
          onPress={onNext}
          loading={saving}
          disabled={nextDisabled}
          style={styles.footerNext}
          testID="onboarding-next"
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: layout.gutter, paddingBottom: spacing.md, gap: spacing.sm },
  stepCount: { ...typography.overline },
  track: { height: 6, borderRadius: radius.pill, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: radius.pill },
  content: { paddingHorizontal: layout.gutter, paddingBottom: spacing.xxl, flexGrow: 1 },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center' },
  title: { ...typography.title, marginTop: spacing.md },
  subtitle: { ...typography.body, marginTop: spacing.xs, marginBottom: spacing.lg },
  fields: { gap: spacing.lg, marginTop: spacing.md },
  footer: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: layout.gutter,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerBack: { flex: 1 },
  footerNext: { flex: 2 },
});
