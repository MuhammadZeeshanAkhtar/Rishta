import { useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { M1_FAMILY_PERMISSIONS, type FamilyMember, type FamilyPermission } from '@nikahmate/domain';
import { getClient } from '../api/client';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { useLocale } from '../i18n/LocaleProvider';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, typography } from '../theme/tokens';

/**
 * The owner choosing exactly what one family member may do. The API takes the complete
 * set each time, and refuses a permission whose feature does not exist yet, so only
 * those that work are offered. Before this the only choice after inviting someone was
 * to remove them altogether.
 */
export function FamilyPermissionsEditor({
  member,
  onSaved,
}: {
  member: FamilyMember;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<FamilyPermission[]>(member.permissions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button
        label={t('family.permissionsCta')}
        variant="ghost"
        onPress={() => setOpen(true)}
        testID={`family-permissions-${member.id}`}
      />
    );
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await getClient().updateFamilyPermissions(member.id, chosen);
      setOpen(false);
      onSaved();
    } catch {
      setError(t('family.errorSave'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root} testID={`family-permissions-editor-${member.id}`}>
      {error ? <Banner tone="error" message={error} /> : null}
      {M1_FAMILY_PERMISSIONS.map((permission) => {
        const label = t(`family.perm${permission.charAt(0).toUpperCase()}${permission.slice(1)}`);
        return (
          <View key={permission} style={styles.row}>
            <Text style={[styles.label, { color: theme.colors.text }]}>{label}</Text>
            <Switch
              value={chosen.includes(permission)}
              disabled={busy}
              accessibilityLabel={label}
              onValueChange={(on) =>
                setChosen((list) =>
                  on ? [...list, permission] : list.filter((item) => item !== permission),
                )
              }
              testID={`family-permission-${permission}`}
            />
          </View>
        );
      })}
      <Button
        label={t('family.permissionsSave')}
        loading={busy}
        onPress={() => void save()}
        testID={`family-permissions-save-${member.id}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  label: { ...typography.caption, flex: 1 },
});
