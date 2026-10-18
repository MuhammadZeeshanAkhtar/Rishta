import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { REPORT_CATEGORIES, type ReportCategory } from '@nikahmate/domain';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { useLocale } from '../i18n/LocaleProvider';
import { useTheme } from '../theme/ThemeProvider';
import { getClient } from '../api/client';
import { describeError } from '../lib/errors';
import { MIN_TOUCH_TARGET, layout, radius, spacing, typography } from '../theme/tokens';

/**
 * Block and report, from anywhere a member is shown.
 *
 * TWO ACTIONS, NOT ONE. Blocking is instant, private and reversible;
 * reporting asks a human to look at someone and changes nothing by itself.
 * A combined "block and report" button would either file reports nobody meant
 * to file, or leave someone exposed while they decide which they wanted. They
 * are offered together and taken separately.
 *
 * BLOCKING CONFIRMS, REPORTING DOES NOT. A block takes effect immediately and
 * the other person disappears, so it gets a destructive confirmation naming
 * the consequence. A report opens a form, and the form IS the confirmation —
 * a second dialog in front of it would just be a step to dismiss.
 *
 * NOTHING HERE ENFORCES ANYTHING. Every rule lives in the API and in RLS: the
 * block takes effect because `app.is_blocked()` is consulted by every shared
 * read, not because this screen stopped showing a button. This is the way in,
 * not the control.
 */

export interface SafetyMenuProps {
  userId: string;
  /** Used only in the confirmation copy. Null falls back to a neutral phrase. */
  displayName: string | null;
  /** Called after a successful block, so the caller can leave or refresh. */
  onBlocked?: () => void;
  /** `icon` for an overflow button on a dark hero; `row` for a list. */
  variant?: 'icon' | 'row';
  tint?: string;
  testID?: string;
}

export function SafetyMenu({
  userId,
  displayName,
  onBlocked,
  variant = 'icon',
  tint,
  testID,
}: SafetyMenuProps) {
  const { t } = useLocale();
  const theme = useTheme();

  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const who = displayName?.trim() || t('profile.someone');

  const doBlock = useCallback(() => {
    setMenuOpen(false);
    Alert.alert(
      t('safety.blockTitle').replace('{{name}}', who),
      t('safety.blockBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('safety.block'),
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            setError(null);
            void getClient()
              .blockUser(userId)
              .then(() => onBlocked?.())
              .catch((err: unknown) => setError(describeError(err, t).message))
              .finally(() => setBusy(false));
          },
        },
      ],
      { cancelable: true },
    );
  }, [onBlocked, t, userId, who]);

  const openReport = useCallback(() => {
    setMenuOpen(false);
    setError(null);
    // Deferred a tick: on iOS, opening a second modal in the same frame as
    // dismissing the first leaves the new one behind the old backdrop.
    setTimeout(() => setReportOpen(true), 0);
  }, []);

  const trigger =
    variant === 'row' ? (
      <Pressable
        onPress={() => setMenuOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={t('safety.title')}
        testID={testID}
        style={styles.rowTrigger}
        hitSlop={8}
      >
        <Ionicons name="ellipsis-horizontal" size={18} color={tint ?? theme.colors.textSubtle} />
      </Pressable>
    ) : (
      <Pressable
        onPress={() => setMenuOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={t('safety.title')}
        testID={testID}
        style={styles.iconTrigger}
      >
        <Ionicons name="ellipsis-horizontal" size={22} color={tint ?? '#FFFFFF'} />
      </Pressable>
    );

  return (
    <>
      {trigger}

      {busy ? (
        <View style={styles.busy} pointerEvents="none">
          <ActivityIndicator color={theme.colors.brand} accessibilityLabel={t('a11y.loading')} />
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorSlot}>
          <Banner tone="error" message={error} />
        </View>
      ) : null}

      <OptionSheet
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={t('safety.title')}
        options={[
          {
            key: 'block',
            icon: 'remove-circle-outline',
            label: t('safety.block'),
            detail: t('safety.blockDetail'),
            destructive: true,
            onPress: doBlock,
          },
          {
            key: 'report',
            icon: 'flag-outline',
            label: t('safety.report'),
            detail: t('safety.reportDetail'),
            onPress: openReport,
          },
        ]}
      />

      <ReportSheet
        visible={reportOpen}
        userId={userId}
        who={who}
        onClose={() => setReportOpen(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------

interface Option {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  detail: string;
  destructive?: boolean;
  onPress: () => void;
}

/** A bottom sheet of choices. Plain Modal — no new dependency for two rows. */
function OptionSheet({
  visible,
  onClose,
  title,
  options,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  options: readonly Option[];
}) {
  const theme = useTheme();
  const { t } = useLocale();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t('common.close')} />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.surface,
            paddingBottom: insets.bottom + spacing.lg,
          },
        ]}
      >
        <View style={[styles.grabber, { backgroundColor: theme.colors.border }]} />
        <Text style={[styles.sheetTitle, { color: theme.colors.text }]}>{title}</Text>

        {options.map((option) => (
          <Pressable
            key={option.key}
            onPress={option.onPress}
            accessibilityRole="button"
            accessibilityLabel={`${option.label}. ${option.detail}`}
            style={[styles.option, { borderColor: theme.colors.border }]}
          >
            <Ionicons
              name={option.icon}
              size={20}
              color={option.destructive ? theme.colors.danger : theme.colors.text}
            />
            <View style={styles.optionText}>
              <Text
                style={[
                  styles.optionLabel,
                  { color: option.destructive ? theme.colors.danger : theme.colors.text },
                ]}
              >
                {option.label}
              </Text>
              <Text style={[styles.optionDetail, { color: theme.colors.textMuted }]}>
                {option.detail}
              </Text>
            </View>
          </Pressable>
        ))}

        <Button label={t('common.cancel')} variant="ghost" onPress={onClose} />
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

/**
 * The report form.
 *
 * CATEGORIES COME FROM THE DOMAIN CONSTANT, not from a list retyped here, so
 * a category the API would refuse cannot be offered. The labels are catalog
 * keys; the codes never reach the screen.
 *
 * The description is optional and capped at the contract's 2000 characters.
 * Nothing written here is ever shown to the reported member.
 */
function ReportSheet({
  visible,
  userId,
  who,
  onClose,
}: {
  visible: boolean;
  userId: string;
  who: string;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [description, setDescription] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    onClose();
    // Reset after the dismiss animation, so the form does not visibly empty
    // itself on the way out.
    setTimeout(() => {
      setCategory(null);
      setDescription('');
      setSent(false);
      setError(null);
    }, 250);
  }, [onClose]);

  const submit = useCallback(() => {
    if (!category) return;
    setSending(true);
    setError(null);
    void getClient()
      .createReport({
        reportedUserId: userId,
        category,
        ...(description.trim() ? { description: description.trim() } : {}),
        contextType: 'profile',
      })
      .then(() => setSent(true))
      .catch((err: unknown) => setError(describeError(err, t).message))
      .finally(() => setSending(false));
  }, [category, description, t, userId]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} accessibilityLabel={t('common.close')} />
      <View
        style={[
          styles.sheet,
          styles.reportSheet,
          { backgroundColor: theme.colors.surface, paddingBottom: insets.bottom + spacing.lg },
        ]}
      >
        <View style={[styles.grabber, { backgroundColor: theme.colors.border }]} />

        {sent ? (
          // Deliberately says a human will look, and nothing about what will
          // happen to the other account — that is not the reporter's business
          // and promising an outcome we cannot guarantee is worse than silence.
          <View style={styles.done}>
            <View style={[styles.doneMark, { backgroundColor: theme.colors.successSurface }]}>
              <Ionicons name="checkmark" size={26} color={theme.colors.success} />
            </View>
            <Text style={[styles.sheetTitle, { color: theme.colors.text }]}>
              {t('safety.reportedTitle')}
            </Text>
            <Text style={[styles.doneBody, { color: theme.colors.textMuted }]}>
              {t('safety.reportedBody')}
            </Text>
            <Button label={t('common.done')} onPress={close} style={styles.doneAction} />
          </View>
        ) : (
          <>
            <Text style={[styles.sheetTitle, { color: theme.colors.text }]}>
              {t('safety.reportTitle').replace('{{name}}', who)}
            </Text>
            <Text style={[styles.sheetBody, { color: theme.colors.textMuted }]}>
              {t('safety.reportBody')}
            </Text>

            {error ? <Banner tone="error" message={error} /> : null}

            <ScrollView
              style={styles.categories}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {REPORT_CATEGORIES.map((key) => {
                const selected = category === key;
                return (
                  <Pressable
                    key={key}
                    onPress={() => setCategory(key)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={t(`safety.category.${key}`)}
                    style={[
                      styles.category,
                      {
                        borderColor: selected ? theme.colors.brand : theme.colors.border,
                        backgroundColor: selected ? theme.colors.brandSurface : 'transparent',
                      },
                    ]}
                  >
                    <Ionicons
                      name={selected ? 'radio-button-on' : 'radio-button-off'}
                      size={19}
                      color={selected ? theme.colors.brand : theme.colors.textSubtle}
                    />
                    <Text
                      style={[
                        styles.categoryLabel,
                        { color: selected ? theme.colors.brandHover : theme.colors.text },
                      ]}
                    >
                      {t(`safety.category.${key}`)}
                    </Text>
                  </Pressable>
                );
              })}

              <Text style={[styles.fieldLabel, { color: theme.colors.textSubtle }]}>
                {t('safety.descriptionLabel')}
              </Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder={t('safety.descriptionHint')}
                placeholderTextColor={theme.colors.textSubtle}
                multiline
                maxLength={2000}
                style={[
                  styles.input,
                  {
                    color: theme.colors.text,
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surfaceSunken,
                  },
                ]}
                accessibilityLabel={t('safety.descriptionLabel')}
              />
            </ScrollView>

            <View style={styles.reportActions}>
              <Button label={t('common.cancel')} variant="ghost" onPress={close} />
              <Button
                label={t('safety.reportSubmit')}
                onPress={submit}
                loading={sending}
                disabled={category === null}
                style={styles.submit}
                testID="safety-report-submit"
              />
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  iconTrigger: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(3,41,31,0.38)',
  },
  rowTrigger: {
    width: MIN_TOUCH_TARGET - 8,
    height: MIN_TOUCH_TARGET - 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  busy: { position: 'absolute' },
  errorSlot: { position: 'absolute', left: 0, right: 0, bottom: 0 },

  backdrop: { flex: 1, backgroundColor: 'rgba(3,41,31,0.42)' },
  sheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: layout.gutter,
    paddingTop: spacing.sm,
    gap: spacing.md,
  },
  reportSheet: { maxHeight: '86%' },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  sheetTitle: { ...typography.title },
  sheetBody: { ...typography.caption, lineHeight: 20 },

  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: MIN_TOUCH_TARGET + spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
  },
  optionText: { flex: 1, gap: 1 },
  optionLabel: { ...typography.bodyStrong },
  optionDetail: { ...typography.caption },

  categories: { flexGrow: 0 },
  category: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  categoryLabel: { ...typography.body, flex: 1, flexShrink: 1 },
  fieldLabel: { ...typography.overline, marginTop: spacing.sm, marginBottom: spacing.xs },
  input: {
    minHeight: 92,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    textAlignVertical: 'top',
    ...typography.body,
  },
  reportActions: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  submit: { flex: 1 },

  done: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.lg },
  doneMark: {
    width: 58,
    height: 58,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneBody: { ...typography.body, textAlign: 'center', maxWidth: 320 },
  doneAction: { minWidth: 200, marginTop: spacing.sm },
});
