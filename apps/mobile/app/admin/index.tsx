import { useRouter } from 'expo-router';
import type { AdminArea } from '@nikahmate/domain';
import { ActionRow } from '../../src/components/ActionRow';
import { AdminShell } from '../../src/admin/AdminChrome';
import { useAdmin } from '../../src/admin/AdminProvider';
import { areasFor } from '../../src/admin/adminAccess';
import { useLocale } from '../../src/i18n/LocaleProvider';

/** The console home: the areas this staff member's roles allow. */

const ROUTES: Record<AdminArea, string> = {
  photos: '/admin/photos',
  profiles: '/admin/profiles',
  reports: '/admin/reports',
  users: '/admin/users',
  dobCorrections: '/admin/dob',
  audit: '/admin/audit',
};

const ICONS = {
  photos: 'images-outline',
  profiles: 'person-outline',
  reports: 'flag-outline',
  users: 'people-outline',
  dobCorrections: 'calendar-outline',
  audit: 'list-outline',
} as const;

export default function AdminHome() {
  const { t } = useLocale();
  const router = useRouter();
  const { state } = useAdmin();
  if (state.status !== 'ready') return null;
  const roles = state.session.roles;

  return (
    <AdminShell
      title={t('admin.homeTitle')}
      subtitle={t('admin.homeSubtitle').replace(
        '{{roles}}',
        roles.map((r) => t(`admin.role.${r}`)).join(', '),
      )}
    >
      {areasFor(roles).map((area) => (
        <ActionRow
          key={area}
          icon={ICONS[area]}
          label={t(`admin.area.${area}`)}
          sublabel={t(`admin.areaHint.${area}`)}
          onPress={() => router.push(ROUTES[area] as never)}
          testID={`admin-home-${area}`}
        />
      ))}
    </AdminShell>
  );
}
