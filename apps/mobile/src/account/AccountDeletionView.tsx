import { StyleSheet, Text, View } from 'react-native';
import { DELETION_GRACE_DAYS } from '@nikahmate/domain';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Screen } from '../components/Screen';
import { TextField } from '../components/TextField';
import { spacing, typography } from '../theme/tokens';
import { DELETION_CONFIRMATION_WORD, deletionConfirmed } from './accountDeletion';

/**
 * Asking to delete an account (review L7, Play Store account deletion). No hooks
 * and no data fetching, so what it says and when it can be pressed are tested
 * directly. It says what will happen before anything does, and that the request can
 * be undone, so the decision is an informed one.
 */

export interface AccountDeletionViewProps {
  t: (key: string) => string;
  colors: { text: string; textMuted: string };
  typed: string;
  onChangeTyped: (value: string) => void;
  busy: boolean;
  /** Already translated. */
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const POINTS = ['hidden', 'grace', 'erased', 'kept', 'held'] as const;

export function AccountDeletionView({
  t,
  colors,
  typed,
  onChangeTyped,
  busy,
  error,
  onConfirm,
  onCancel,
}: AccountDeletionViewProps) {
  const fill = (text: string) =>
    text
      .replace('{{days}}', String(DELETION_GRACE_DAYS))
      .replace('{{word}}', DELETION_CONFIRMATION_WORD);

  return (
    <Screen title={t('accountDeletion.title')} subtitle={t('accountDeletion.intro')}>
      <View style={styles.body}>
        {POINTS.map((point) => (
          <Text key={point} style={[styles.point, { color: colors.text }]}>
            {fill(t(`accountDeletion.point.${point}`))}
          </Text>
        ))}
        {error ? <Banner tone="error" message={error} /> : null}
        <TextField
          label={fill(t('accountDeletion.confirmLabel'))}
          value={typed}
          onChangeText={onChangeTyped}
          autoCapitalize="characters"
          editable={!busy}
          testID="delete-account-word"
        />
        <View style={styles.actions}>
          <Button
            testID="delete-account-confirm"
            label={t('accountDeletion.confirm')}
            variant="danger"
            loading={busy}
            disabled={!deletionConfirmed(typed)}
            onPress={onConfirm}
          />
          <Button
            testID="delete-account-cancel"
            label={t('accountDeletion.cancel')}
            variant="ghost"
            disabled={busy}
            onPress={onCancel}
          />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md },
  point: { ...typography.body },
  actions: { gap: spacing.sm, marginTop: spacing.md },
});
