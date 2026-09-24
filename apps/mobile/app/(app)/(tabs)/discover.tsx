import { Screen } from '../../../src/components/Screen';
import { PhaseNotice } from '../../../src/components/PhaseNotice';
import { useLocale } from '../../../src/i18n/LocaleProvider';

export default function DiscoverScreen() {
  const { t } = useLocale();
  return (
    <Screen title={t('tabs.discover')} subtitle={t('onboarding.welcome')}>
      <PhaseNotice
        phase="Phase 5"
        feature="Discovery sections, search and explainable compatibility arrive with the matching engine."
      />
    </Screen>
  );
}
