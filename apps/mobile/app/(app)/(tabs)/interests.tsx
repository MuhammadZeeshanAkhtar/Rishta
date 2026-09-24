import { Screen } from '../../../src/components/Screen';
import { PhaseNotice } from '../../../src/components/PhaseNotice';
import { useLocale } from '../../../src/i18n/LocaleProvider';

export default function InterestsScreen() {
  const { t } = useLocale();
  return (
    <Screen title={t('tabs.interests')}>
      <PhaseNotice
        phase="Phase 6"
        feature="Sending and responding to interest, and mutual matches, arrive in Phase 6."
      />
    </Screen>
  );
}
