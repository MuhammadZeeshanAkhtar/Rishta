import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Preferences, PreferencesUpdate } from '@nikahmate/domain';
import { Checkbox } from '../components/Checkbox';
import { ReferenceSelect } from '../components/ReferenceSelect';
import { TextField } from '../components/TextField';
import { useLocale } from '../i18n/LocaleProvider';
import { useTheme } from '../theme/ThemeProvider';
import { validateAgeRange, type ValidationKey } from '../lib/validation';
import { spacing, typography } from '../theme/tokens';

/**
 * The partner-preferences fields, without a screen around them.
 *
 * Extracted so onboarding step 5 and the edit screen are the same form rather
 * than two forms that drift — a duplicated `excludeUnstatedSect` default would
 * be an A2 violation nobody notices until someone disappears from search.
 *
 * The caller owns submission: onboarding advances, edit saves in place.
 * `useCollectedPreferences` hands back both the fields and a validated patch.
 */

export interface PreferencesFormState {
  fields: React.ReactNode;
  /** Validated patch, or null when something is wrong. Sets errors as a side effect. */
  collect: () => PreferencesUpdate | null;
}

export function usePreferencesForm(preferences: Preferences | null): PreferencesFormState {
  const { t } = useLocale();
  const theme = useTheme();

  const [ageMin, setAgeMin] = useState('');
  const [ageMax, setAgeMax] = useState('');
  const [countries, setCountries] = useState<string[]>([]);
  const [maritalStatuses, setMaritalStatuses] = useState<string[]>([]);
  const [practices, setPractices] = useState<string[]>([]);
  const [sects, setSects] = useState<string[]>([]);
  const [excludeUnstatedSect, setExcludeUnstatedSect] = useState(false);
  const [educationLevels, setEducationLevels] = useState<string[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, ValidationKey>>({});

  useEffect(() => {
    if (!preferences) return;
    setAgeMin(preferences.ageMin === null ? '' : String(preferences.ageMin));
    setAgeMax(preferences.ageMax === null ? '' : String(preferences.ageMax));
    setCountries(preferences.countryCodes);
    setMaritalStatuses(preferences.maritalStatusCodes);
    setPractices(preferences.religiousPracticeCodes);
    setSects(preferences.sectCodes);
    setExcludeUnstatedSect(preferences.excludeUnstatedSect);
    setEducationLevels(preferences.educationLevelCodes);
    setLanguages(preferences.languageCodes);
  }, [preferences]);

  const collect = (): PreferencesUpdate | null => {
    const min = ageMin ? Number(ageMin) : null;
    const max = ageMax ? Number(ageMax) : null;

    const next: Record<string, ValidationKey> = {
      ageMin:
        ageMin && (!Number.isInteger(min) || (min as number) < 18)
          ? 'validation.numberInvalid'
          : undefined,
      ageMax: ageMax && !Number.isInteger(max) ? 'validation.numberInvalid' : undefined,
    };
    if (!next.ageMin && !next.ageMax && min !== null && max !== null) {
      next.ageMin = validateAgeRange(min, max);
    }
    setErrors(next);
    if (Object.values(next).some(Boolean)) return null;

    return {
      ageMin: min,
      ageMax: max,
      countryCodes: countries,
      maritalStatusCodes: maritalStatuses,
      religiousPracticeCodes: practices,
      sectCodes: sects,
      excludeUnstatedSect,
      educationLevelCodes: educationLevels,
      languageCodes: languages,
    };
  };

  const fields = (
    <>
      <View style={styles.ageRow}>
        <View style={styles.ageField}>
          <TextField
            label={t('preferences.ageMin')}
            value={ageMin}
            onChangeText={setAgeMin}
            error={errors.ageMin ? t(errors.ageMin) : undefined}
            keyboardType="number-pad"
            maxLength={3}
            testID="preferences-age-min"
          />
        </View>
        <View style={styles.ageField}>
          <TextField
            label={t('preferences.ageMax')}
            value={ageMax}
            onChangeText={setAgeMax}
            error={errors.ageMax ? t(errors.ageMax) : undefined}
            keyboardType="number-pad"
            maxLength={3}
            testID="preferences-age-max"
          />
        </View>
      </View>

      <ReferenceSelect
        label={t('preferences.countries')}
        type="country"
        value={countries}
        onChange={(next) => setCountries(next)}
        multiple
        placeholder={t('preferences.anyAnswer')}
        testID="preferences-countries"
      />

      <ReferenceSelect
        label={t('preferences.maritalStatuses')}
        type="marital_status"
        value={maritalStatuses}
        onChange={(next) => setMaritalStatuses(next)}
        multiple
        placeholder={t('preferences.anyAnswer')}
        testID="preferences-marital"
      />

      <ReferenceSelect
        label={t('preferences.religiousPractice')}
        type="religious_practice"
        value={practices}
        onChange={(next) => setPractices(next)}
        multiple
        placeholder={t('preferences.anyAnswer')}
        testID="preferences-practice"
      />

      <ReferenceSelect
        label={t('preferences.sects')}
        type="sect"
        value={sects}
        onChange={(next) => setSects(next)}
        multiple
        placeholder={t('preferences.anyAnswer')}
        testID="preferences-sects"
      />

      <View>
        <Checkbox
          label={t('preferences.excludeUnstatedSect')}
          checked={excludeUnstatedSect}
          onChange={setExcludeUnstatedSect}
          testID="preferences-exclude-unstated"
        />
        {/*
          The consequence, next to the control. Many people leave sect blank,
          and turning this on hides every one of them — a choice worth making
          deliberately rather than inheriting.
        */}
        <Text style={[styles.hint, { color: theme.colors.textSubtle }]}>
          {t('preferences.excludeUnstatedSectHint')}
        </Text>
      </View>

      <ReferenceSelect
        label={t('preferences.educationLevels')}
        type="education_level"
        value={educationLevels}
        onChange={(next) => setEducationLevels(next)}
        multiple
        placeholder={t('preferences.anyAnswer')}
        testID="preferences-education"
      />

      <ReferenceSelect
        label={t('preferences.languages')}
        type="language"
        value={languages}
        onChange={(next) => setLanguages(next)}
        multiple
        placeholder={t('preferences.anyAnswer')}
        testID="preferences-languages"
      />
    </>
  );

  return { fields, collect };
}

const styles = StyleSheet.create({
  ageRow: { flexDirection: 'row', gap: spacing.md },
  ageField: { flex: 1 },
  hint: { ...typography.caption, marginTop: spacing.xs },
});
