import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { OwnProfile, Preferences, ProfileUpdate, PreferencesUpdate } from '@nikahmate/domain';
import { getClient } from '../api/client';

/**
 * The profile being assembled, backed by the server.
 *
 * Each step saves when it advances rather than holding everything until the
 * end. Three reasons that is worth the extra requests:
 *
 *   - **Onboarding is long and connections here are not.** Losing six screens
 *     of answers to a dropped connection is the kind of thing people do not
 *     come back from.
 *   - **Reopening resumes.** The session gate sends an unfinished account back
 *     into onboarding, and it should land on a form that already knows them.
 *   - **The server owns validation anyway.** Saving per step means a rejected
 *     value is reported next to the field that caused it, not six screens later.
 *
 * Nothing is written to device storage. The draft holds a date of birth and
 * religious details — Article 9 special-category data (README §9.8) — and the
 * server, which has a lawful basis recorded for it, is where that belongs.
 */

interface DraftContextValue {
  profile: OwnProfile | null;
  preferences: Preferences | null;
  loading: boolean;
  saving: boolean;
  /** Already-translated, or null. */
  error: string | null;
  /** Field path -> message, from the server. */
  fieldErrors: Record<string, string> | undefined;
  /** Saves a patch and returns true when it succeeded. */
  save: (patch: ProfileUpdate) => Promise<boolean>;
  savePreferences: (patch: PreferencesUpdate) => Promise<boolean>;
  reload: () => Promise<void>;
  clearError: () => void;
}

const DraftContext = createContext<DraftContextValue | null>(null);

export function OnboardingDraftProvider({
  children,
  describeError,
}: {
  children: React.ReactNode;
  /** Injected so this file stays free of i18n wiring. */
  describeError: (error: unknown) => {
    message: string;
    fields: Record<string, string> | undefined;
  };
}) {
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string> | undefined>(undefined);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      // Both at once: the preview step needs them together, and two serial
      // round trips is a visible pause on a slow connection.
      const [nextProfile, nextPreferences] = await Promise.all([
        getClient().getProfile(),
        getClient().getPreferences(),
      ]);
      setProfile(nextProfile);
      setPreferences(nextPreferences);
      setError(null);
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setLoading(false);
    }
  }, [describeError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (patch: ProfileUpdate): Promise<boolean> => {
      setSaving(true);
      setError(null);
      setFieldErrors(undefined);
      try {
        setProfile(await getClient().updateProfile(patch));
        return true;
      } catch (err) {
        const described = describeError(err);
        setError(described.message);
        setFieldErrors(described.fields);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [describeError],
  );

  const savePreferences = useCallback(
    async (patch: PreferencesUpdate): Promise<boolean> => {
      setSaving(true);
      setError(null);
      setFieldErrors(undefined);
      try {
        setPreferences(await getClient().updatePreferences(patch));
        return true;
      } catch (err) {
        const described = describeError(err);
        setError(described.message);
        setFieldErrors(described.fields);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [describeError],
  );

  const value = useMemo<DraftContextValue>(
    () => ({
      profile,
      preferences,
      loading,
      saving,
      error,
      fieldErrors,
      save,
      savePreferences,
      reload,
      clearError: () => {
        setError(null);
        setFieldErrors(undefined);
      },
    }),
    [profile, preferences, loading, saving, error, fieldErrors, save, savePreferences, reload],
  );

  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

export function useOnboardingDraft(): DraftContextValue {
  const context = useContext(DraftContext);
  if (!context) {
    throw new Error('useOnboardingDraft must be used inside OnboardingDraftProvider');
  }
  return context;
}
