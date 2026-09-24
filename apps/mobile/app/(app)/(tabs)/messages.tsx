import { Screen } from '../../../src/components/Screen';
import { PhaseNotice } from '../../../src/components/PhaseNotice';
import { useLocale } from '../../../src/i18n/LocaleProvider';

export default function MessagesScreen() {
  const { t } = useLocale();
  return (
    <Screen title={t('tabs.messages')}>
      <PhaseNotice
        phase="Phase 7"
        feature="Staged conversation, from Introduction through to Serious Proposal, arrives in Phase 7."
      />
    </Screen>
  );
}
