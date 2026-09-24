import { Screen } from '../../../src/components/Screen';
import { PhaseNotice } from '../../../src/components/PhaseNotice';
import { useLocale } from '../../../src/i18n/LocaleProvider';

export default function FamilyScreen() {
  const { t } = useLocale();
  return (
    <Screen title={t('tabs.family')}>
      <PhaseNotice
        phase="Phase 9"
        feature="Inviting a wali with read-only access to your profile and matches, plus the access log that shows you everything they have seen."
      />
    </Screen>
  );
}
