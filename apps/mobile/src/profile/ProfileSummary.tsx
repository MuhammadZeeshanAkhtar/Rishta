import { StyleSheet, Text, View } from 'react-native';
import type { OwnProfile } from '@nikahmate/domain';
import { ChipRow, InfoChip } from '../components/InfoChip';
import { ExpandableText } from '../components/ExpandableText';
import { SectionCard } from '../components/SectionCard';
import { useLocale } from '../i18n/LocaleProvider';
import { useTheme } from '../theme/ThemeProvider';
import { ProfileHighlights } from './ProfileHighlights';
import { useProfileView } from './useProfileView';
import { spacing, typography } from '../theme/tokens';

/**
 * A profile as a person reads it: highlights, an introduction, then sections.
 *
 * SHARED BY `/me` AND THE ONBOARDING PREVIEW, on purpose. "What the preview
 * showed" and "what my profile says" cannot drift apart if they are the same
 * component — and a preview that does not match the real thing is a preview
 * nobody can trust. The hero is NOT part of this, because the two callers
 * frame it differently: the profile screen opens on a full portrait, while the
 * preview sits inside an onboarding step that already has a title.
 *
 * WHAT IT WILL NOT RENDER. Nothing from `sensitive`, and never the date of
 * birth — only the derived age, which `useProfileView` is the single place to
 * compute. A section with no facts is dropped rather than shown empty.
 *
 * The chips, cards and expanding text are all shared components, so this file
 * holds the ORDER and nothing else. Order is the editorial decision: quick
 * impression, then the person's own words, then values, then life.
 */

export interface ProfileSummaryProps {
  profile: OwnProfile;
  /** Hidden on `/me`, where the hero already carries them. */
  showHighlights?: boolean;
  /** Entrance stagger starts here, so a caller can sequence it after a hero. */
  baseIndex?: number;
}

export function ProfileSummary({
  profile,
  showHighlights = true,
  baseIndex = 0,
}: ProfileSummaryProps) {
  const { t } = useLocale();
  const theme = useTheme();
  const view = useProfileView(profile);

  // One running counter, so the stagger does not reset when a section is
  // dropped for having nothing in it.
  let step = baseIndex;
  const next = () => {
    step += 1;
    return step - 1;
  };

  return (
    <View style={styles.root}>
      {showHighlights ? <ProfileHighlights items={view.highlights} index={next()} /> : null}

      {view.aboutText ? (
        <SectionCard
          title={view.aboutTitle}
          subtitle={t('profile.display.aboutSubtitle')}
          icon="person-outline"
          index={next()}
          testID="profile-about"
        >
          <ExpandableText
            text={view.aboutText}
            moreLabel={t('common.more')}
            lessLabel={t('common.less')}
          />
        </SectionCard>
      ) : null}

      {view.lookingFor ? (
        <SectionCard
          title={t('profile.display.lookingForTitle')}
          subtitle={t('profile.display.lookingForSubtitle')}
          icon="compass-outline"
          index={next()}
          testID="profile-looking-for"
        >
          <ExpandableText
            text={view.lookingFor}
            collapsedLines={3}
            moreLabel={t('common.more')}
            lessLabel={t('common.less')}
          />
        </SectionCard>
      ) : null}

      {view.sections.map((section) => (
        <SectionCard
          key={section.key}
          title={section.title}
          subtitle={section.subtitle}
          icon={section.icon}
          index={next()}
          testID={`profile-section-${section.key}`}
        >
          {section.facts.length > 0 ? (
            <ChipRow>
              {section.facts.map((fact) => (
                <InfoChip
                  key={fact.key}
                  label={fact.label}
                  icon={fact.icon}
                  tone={fact.tone ?? 'neutral'}
                />
              ))}
            </ChipRow>
          ) : null}

          {section.note ? (
            <Text style={[styles.note, { color: theme.colors.textMuted }]}>{section.note}</Text>
          ) : null}
        </SectionCard>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  note: { ...typography.caption, lineHeight: 20 },
});
