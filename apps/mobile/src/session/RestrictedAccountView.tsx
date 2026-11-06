import { StyleSheet, Text, View } from 'react-native';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Screen } from '../components/Screen';
import { spacing, typography } from '../theme/tokens';
import type { DeletionDetails } from '../account/accountDeletion';
import { restrictedContent, type RestrictedAction } from './restrictedContent';

/**
 * What a restricted account sees (review N7). No hooks and no data fetching, so
 * the wording and the buttons each status gets can be tested directly. Colours
 * come from `colors`, passed in by the route.
 */

export interface RestrictedAccountViewProps {
  status: string;
  t: (key: string) => string;
  colors: { text: string; textMuted: string };
  /** The action in progress, so its button shows a spinner and the rest wait. */
  busy: RestrictedAction | null;
  /** Already translated. */
  error: string | null;
  onAction: (action: RestrictedAction) => void;
  /** What is known about an open deletion request. */
  deletion?: DeletionDetails;
}

export function RestrictedAccountView({
  status,
  t,
  colors,
  busy,
  error,
  onAction,
  deletion,
}: RestrictedAccountViewProps) {
  const content = restrictedContent(status);
  return (
    <Screen title={t(content.titleKey)}>
      <View style={styles.body}>
        <Text style={[styles.text, { color: colors.text }]}>{t(content.explanationKey)}</Text>
        {status === 'pending_deletion' && deletion?.scheduledOn ? (
          <Text style={[styles.text, { color: colors.text }]} testID="restricted-scheduled">
            {t('restricted.pendingDeletion.scheduled').replace('{{date}}', deletion.scheduledOn)}
          </Text>
        ) : null}
        {status === 'pending_deletion' && deletion?.held ? (
          <Text style={[styles.text, { color: colors.text }]} testID="restricted-held">
            {t('restricted.pendingDeletion.held')}
          </Text>
        ) : null}
        <Text style={[styles.text, { color: colors.textMuted }]}>{t(content.nextStepKey)}</Text>
        {error ? <Banner tone="error" message={error} /> : null}
        <View style={styles.actions}>
          {content.actions.map((action, index) => (
            <Button
              key={action}
              testID={`restricted-${action}`}
              label={t(`restricted.action.${action}`)}
              variant={index === 0 ? 'primary' : 'ghost'}
              loading={busy === action}
              disabled={busy !== null && busy !== action}
              onPress={() => onAction(action)}
            />
          ))}
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md },
  text: { ...typography.body },
  actions: { gap: spacing.sm, marginTop: spacing.md },
});
