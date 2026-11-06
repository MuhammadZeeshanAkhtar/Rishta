import { useState } from 'react';
import { useRouter, usePathname } from 'expo-router';
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AdminArea } from '@nikahmate/domain';
import { isNikahMateError } from '@nikahmate/api-client';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { ChoiceGroup } from '../components/ChoiceGroup';
import { EmptyState } from '../components/EmptyState';
import { Logo } from '../components/Logo';
import { TextField } from '../components/TextField';
import { useLocale } from '../i18n/LocaleProvider';
import { useSession } from '../session/SessionProvider';
import { useTheme } from '../theme/ThemeProvider';
import { getClient } from '../api/client';
import { MIN_TOUCH_TARGET, radius, spacing, typography } from '../theme/tokens';
import {
  areasFor,
  decisionProblems,
  MAX_STAFF_NOTE,
  validTotpCode,
  type AdminGate,
} from './adminAccess';
import { useAdmin } from './AdminProvider';

/**
 * The admin console's frame, its access screens, and the decision form every
 * queue shares (review L1). Wider than the member app (`ADMIN_MAX_WIDTH`)
 * because staff work at a desk; still usable at phone width.
 */

export const ADMIN_MAX_WIDTH = 960;

const AREA_ROUTES: Record<AdminArea, string> = {
  photos: '/admin/photos',
  profiles: '/admin/profiles',
  reports: '/admin/reports',
  users: '/admin/users',
  dobCorrections: '/admin/dob',
  audit: '/admin/audit',
};

/** The page scaffold: brand, area navigation for the caller's roles, sign out. */
export function AdminShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { state } = useAdmin();
  const { signOut } = useSession();
  const roles = state.status === 'ready' ? state.session.roles : [];

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xxl },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.inner}>
        <View style={styles.brandRow}>
          <Pressable
            accessibilityRole="link"
            onPress={() => router.replace('/admin')}
            style={styles.brand}
          >
            <Logo size={28} />
            <Text style={[styles.brandText, { color: theme.colors.text }]}>
              {t('admin.console')}
            </Text>
          </Pressable>
          <Button
            label={t('auth.signOut')}
            variant="ghost"
            onPress={() => void signOut()}
            testID="admin-sign-out"
          />
        </View>
        {roles.length > 0 ? (
          <View accessibilityRole="tablist" style={styles.nav}>
            {areasFor(roles).map((area) => {
              const selected = pathname.startsWith(AREA_ROUTES[area]);
              return (
                <Pressable
                  key={area}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  onPress={() => router.replace(AREA_ROUTES[area] as never)}
                  testID={`admin-nav-${area}`}
                  style={[
                    styles.navItem,
                    {
                      borderColor: selected ? theme.colors.brand : theme.colors.border,
                      backgroundColor: selected ? theme.colors.brandSurface : theme.colors.surface,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.navLabel,
                      { color: selected ? theme.colors.brandHover : theme.colors.textMuted },
                    ]}
                  >
                    {t(`admin.area.${area}`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <Text style={[styles.title, { color: theme.colors.text }]}>{title}</Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>{subtitle}</Text>
        ) : null}
        {children}
      </View>
    </ScrollView>
  );
}

/** What to show when the API did not let the caller in. */
export function AdminGateScreen({ gate }: { gate: AdminGate }) {
  const { t } = useLocale();
  const router = useRouter();
  const { reload } = useAdmin();
  const { signOut } = useSession();

  if (gate === 'verify_mfa' || gate === 'enroll_mfa') {
    return (
      <AdminShell title={t('admin.mfa.title')} subtitle={t('admin.mfa.subtitle')}>
        <SecondFactor enrol={gate === 'enroll_mfa'} onDone={() => void reload()} />
      </AdminShell>
    );
  }
  const copy = {
    signed_out: {
      icon: 'log-in-outline',
      title: 'admin.gate.signedOutTitle',
      body: 'admin.gate.signedOutBody',
    },
    not_staff: {
      icon: 'lock-closed-outline',
      title: 'admin.gate.notStaffTitle',
      body: 'admin.gate.notStaffBody',
    },
    forbidden: {
      icon: 'hand-left-outline',
      title: 'admin.gate.forbiddenTitle',
      body: 'admin.gate.forbiddenBody',
    },
    error: {
      icon: 'cloud-offline-outline',
      title: 'admin.gate.errorTitle',
      body: 'admin.gate.errorBody',
    },
  }[gate] as { icon: 'lock-closed-outline'; title: string; body: string };

  return (
    <AdminShell title={t('admin.console')}>
      <EmptyState
        icon={copy.icon}
        tone={gate === 'error' ? 'error' : 'empty'}
        title={t(copy.title)}
        body={t(copy.body)}
        actionLabel={
          gate === 'signed_out'
            ? t('auth.signIn')
            : gate === 'error'
              ? t('common.retry')
              : t('auth.signOut')
        }
        onAction={() => {
          if (gate === 'signed_out') router.replace('/(auth)/sign-in');
          else if (gate === 'error') void reload();
          else void signOut();
        }}
      />
    </AdminShell>
  );
}

/**
 * The second factor. Supabase Auth issues the aal2 session; the API decides
 * whether it is enough. A staff member without an authenticator app enrols
 * one here: the QR code (web) or the key (anywhere) goes into the app, and
 * the first code both verifies the factor and upgrades this session.
 */
function SecondFactor({ enrol, onDone }: { enrol: boolean; onDone: () => void }) {
  const { t } = useLocale();
  const theme = useTheme();
  const [factor, setFactor] = useState<{
    factorId: string;
    qrCode: string | null;
    secret: string | null;
  } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      if (enrol) {
        const enrolled = await getClient().auth.enrollTotp();
        setFactor({
          factorId: enrolled.factorId,
          qrCode: enrolled.qrCode,
          secret: enrolled.secret,
        });
      } else {
        const [first] = await getClient().auth.listTotpFactors();
        if (!first) throw new Error('no factor');
        setFactor({ factorId: first.id, qrCode: null, secret: null });
      }
    } catch {
      setError(t('admin.mfa.startFailed'));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!factor) return;
    if (!validTotpCode(code)) {
      setError(t('admin.mfa.codeFormat'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await getClient().auth.verifyTotp(factor.factorId, code.trim());
      onDone();
    } catch (err) {
      setError(
        isNikahMateError(err) && err.kind === 'invalid_credentials'
          ? t('admin.mfa.codeWrong')
          : t('admin.mfa.startFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!factor) {
    return (
      <View style={styles.stack}>
        {error ? <Banner tone="error" message={error} /> : null}
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          {enrol ? t('admin.mfa.enrolExplains') : t('admin.mfa.verifyExplains')}
        </Text>
        <Button
          label={enrol ? t('admin.mfa.enrolStart') : t('admin.mfa.verifyStart')}
          onPress={() => void start()}
          loading={busy}
          testID="admin-mfa-start"
        />
      </View>
    );
  }

  return (
    <View style={styles.stack}>
      {error ? <Banner tone="error" message={error} /> : null}
      {factor.qrCode && Platform.OS === 'web' ? (
        <Image
          source={{ uri: factor.qrCode }}
          style={styles.qr}
          accessibilityLabel={t('admin.mfa.qrAlt')}
        />
      ) : null}
      {factor.secret ? (
        <Text
          selectable
          style={[
            styles.secret,
            { color: theme.colors.text, backgroundColor: theme.colors.surfaceSunken },
          ]}
        >
          {factor.secret}
        </Text>
      ) : null}
      <TextField
        label={t('admin.mfa.codeLabel')}
        value={code}
        onChangeText={setCode}
        keyboardType="number-pad"
        maxLength={6}
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        testID="admin-mfa-code"
      />
      <Button
        label={t('admin.mfa.verify')}
        onPress={() => void verify()}
        loading={busy}
        testID="admin-mfa-verify"
      />
    </View>
  );
}

export interface DecisionValue {
  decision: 'approve' | 'reject';
  reasonKey?: string;
  note: string;
}

/**
 * Approve or reject, with the reasons the audit and the member need.
 * `reasons` are i18n keys the member's app renders; omitted for DOB
 * corrections, where the written note is what the member sees.
 */
export function DecisionForm({
  area,
  reasons,
  onSubmit,
  testID,
}: {
  area: 'photos' | 'profiles' | 'dobCorrections';
  reasons?: readonly string[];
  onSubmit: (value: DecisionValue) => Promise<void>;
  testID?: string;
}) {
  const { t } = useLocale();
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);
  const [reasonKey, setReasonKey] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<ReturnType<typeof decisionProblems>>({});
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const next = decisionProblems({ area, decision, reasonKey, note });
    setProblems(next);
    if (Object.keys(next).length > 0 || decision === null) return;
    setBusy(true);
    try {
      await onSubmit({
        decision,
        note: note.trim(),
        ...(decision === 'reject' && reasonKey ? { reasonKey } : {}),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.stack} testID={testID}>
      <ChoiceGroup
        label={t('admin.decision.label')}
        choices={[
          { value: 'approve', label: t('admin.decision.approve') },
          { value: 'reject', label: t('admin.decision.reject') },
        ]}
        value={decision}
        onChange={(v) => setDecision(v as 'approve' | 'reject')}
        error={problems.decision ? t(problems.decision) : undefined}
      />
      {decision === 'reject' && reasons ? (
        <ChoiceGroup
          label={t('admin.decision.reasonLabel')}
          hint={t('admin.decision.reasonHint')}
          choices={reasons.map((key) => ({ value: key, label: t(key) }))}
          value={reasonKey}
          onChange={setReasonKey}
          error={problems.reasonKey ? t(problems.reasonKey) : undefined}
        />
      ) : null}
      <TextField
        label={
          area === 'dobCorrections'
            ? t('admin.decision.noteLabelDob')
            : t('admin.decision.noteLabel')
        }
        hint={
          area === 'dobCorrections' ? t('admin.decision.noteHintDob') : t('admin.decision.noteHint')
        }
        value={note}
        onChangeText={setNote}
        multiline
        maxLength={MAX_STAFF_NOTE}
        error={problems.note ? t(problems.note) : undefined}
      />
      <Button label={t('admin.decision.submit')} onPress={() => void submit()} loading={busy} />
    </View>
  );
}

/** A queue item frame. */
export function AdminCard({ children, testID }: { children: React.ReactNode; testID?: string }) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
    >
      {children}
    </View>
  );
}

export function AdminMeta({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <Text style={[styles.meta, { color: theme.colors.textMuted }]}>
      <Text style={{ color: theme.colors.text, fontWeight: '600' }}>{label}: </Text>
      {value}
    </Text>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, flexGrow: 1 },
  inner: { width: '100%', maxWidth: ADMIN_MAX_WIDTH, alignSelf: 'center', gap: spacing.md },
  brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: MIN_TOUCH_TARGET,
  },
  brandText: { ...typography.heading },
  nav: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  navItem: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    minHeight: MIN_TOUCH_TARGET - 8,
    justifyContent: 'center',
  },
  navLabel: { ...typography.caption, fontWeight: '600' },
  title: { ...typography.title },
  subtitle: { ...typography.body },
  stack: { gap: spacing.md },
  body: { ...typography.body },
  qr: { width: 200, height: 200, alignSelf: 'center' },
  secret: {
    ...typography.bodyStrong,
    padding: spacing.md,
    borderRadius: radius.sm,
    textAlign: 'center',
    letterSpacing: 1,
  },
  card: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
  meta: { ...typography.caption },
});
