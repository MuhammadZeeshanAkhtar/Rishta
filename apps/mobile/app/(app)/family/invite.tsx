import { useCallback, useState } from 'react';
import { ScreenHeader } from '../../../src/components/ScreenHeader';
import { ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import * as Linking from 'expo-linking';
import { Ionicons } from '@expo/vector-icons';
import { FAMILY_JOIN_PATH, RELATIONSHIP_CODES, familyInviteQueryParams } from '@nikahmate/domain';
import { Banner } from '../../../src/components/Banner';
import { Button } from '../../../src/components/Button';
import { ChoiceGroup } from '../../../src/components/ChoiceGroup';
import { SectionCard } from '../../../src/components/SectionCard';
import { TextField } from '../../../src/components/TextField';
import { getClient } from '../../../src/api/client';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { iconSize, radius, spacing, typography } from '../../../src/theme/tokens';

/**
 * Invite a family member.
 *
 * THE TOKEN IS SHOWN ONCE. The server stores only a sha-256 digest, so this
 * screen is the single moment the raw link exists anywhere outside the
 * invitee's inbox. The copy says so plainly rather than letting someone
 * discover it by coming back for a link that is gone — and offers the one
 * remedy that works: cancel and re-send.
 *
 * THE LINK CARRIES BOTH HALVES (review B2). Accepting needs the invitation id
 * AND the token; this screen used to show the token alone, and nothing could
 * accept it. The link opens the invitee's Join screen, and the Join screen
 * also accepts it pasted. Its prefix is the platform's own (expo-linking): the
 * web origin on web, `nikahmate://` in a build, `exp://` in a dev client.
 * Shared through React Native's built-in Share sheet — no new dependency.
 *
 * TIER IS A PRESET, not a permission. Picking "can see and approve" writes
 * six permission rows; the owner can change any of them afterwards from the
 * member's own screen. Two choices here rather than six checkboxes because
 * this is the moment of invitation, not of fine-tuning, and a six-way
 * permission grid is how people grant more than they meant to.
 */
export default function InviteFamilyScreen() {
  const { t } = useLocale();
  const theme = useTheme();

  const [contact, setContact] = useState('');
  const [relationship, setRelationship] = useState<string | null>(null);
  const [tier, setTier] = useState<string | null>('reviewer');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  const send = useCallback(async () => {
    setError(null);
    setFieldError(undefined);

    if (contact.trim().length < 3) {
      setFieldError(t('validation.required'));
      return;
    }
    if (!relationship || !tier) {
      setError(t('validation.required'));
      return;
    }

    setSending(true);
    try {
      const created = await getClient().createFamilyInvitation({
        inviteeContact: contact.trim(),
        relationshipCode: relationship as (typeof RELATIONSHIP_CODES)[number],
        tier: tier as 'observer' | 'reviewer',
      });
      setLink(
        Linking.createURL(FAMILY_JOIN_PATH, {
          queryParams: familyInviteQueryParams({
            invitationId: created.id,
            token: created.token,
          }),
        }),
      );
    } catch {
      setError(t('family.errorSave'));
    } finally {
      setSending(false);
    }
  }, [contact, relationship, tier, t]);

  const share = useCallback(() => {
    if (!link) return;
    // Cancelling the share sheet is not an error, and a share failure leaves
    // the link on screen to copy by hand — nothing to report either way.
    void Share.share({ message: t('family.inviteShareMessage').replace('{{link}}', link) }).catch(
      () => undefined,
    );
  }, [link, t]);

  return (
    <>
      <ScreenHeader title={t('family.inviteHeading')} fallback="/family" />
      <ScrollView
        style={[styles.root, { backgroundColor: theme.colors.background }]}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {error ? <Banner tone="error" message={error} /> : null}

        {link === null ? (
          <>
            <SectionCard title={t('family.inviteHeading')} icon="person-add-outline" index={0}>
              <TextField
                label={t('family.inviteContact')}
                hint={t('family.inviteContactHint')}
                value={contact}
                onChangeText={setContact}
                error={fieldError}
                autoCapitalize="none"
                keyboardType="email-address"
                testID="invite-contact"
              />

              <ChoiceGroup
                label={t('family.inviteRelationship')}
                choices={RELATIONSHIP_CODES.map((code) => ({
                  value: code,
                  label: t(`family.relationship.${code}`),
                }))}
                value={relationship}
                onChange={setRelationship}
                testID="invite-relationship"
              />

              <ChoiceGroup
                label={t('family.inviteTier')}
                choices={[
                  { value: 'observer', label: t('family.tierObserver') },
                  { value: 'reviewer', label: t('family.tierReviewer') },
                ]}
                value={tier}
                onChange={setTier}
                testID="invite-tier"
              />

              <Text style={[styles.hint, { color: theme.colors.textMuted }]}>
                {tier === 'observer' ? t('family.tierObserverBody') : t('family.tierReviewerBody')}
              </Text>
            </SectionCard>

            <Button
              label={t('family.inviteSend')}
              onPress={() => void send()}
              loading={sending}
              testID="invite-send"
            />
          </>
        ) : (
          <SectionCard title={t('family.inviteSent')} icon="checkmark-circle-outline" index={0}>
            {/* The warning comes BEFORE the token, so it is read rather than
                scrolled past on the way to copying. */}
            <View
              style={[
                styles.warn,
                { backgroundColor: theme.colors.accentSurface, borderColor: theme.colors.accent },
              ]}
            >
              <Ionicons name="key-outline" size={iconSize.sm} color={theme.colors.accent} />
              <Text style={[styles.warnText, { color: theme.colors.accent }]}>
                {t('family.inviteTokenOnce')}
              </Text>
            </View>

            {/* Selectable as well as shareable: expo-clipboard is not a
                dependency of this project, and the share sheet already offers
                "copy" on both platforms. Long-press selects it. */}
            <View
              style={[
                styles.tokenBox,
                { backgroundColor: theme.colors.surfaceSunken, borderColor: theme.colors.border },
              ]}
              testID="invite-link"
            >
              <Text
                style={[styles.token, { color: theme.colors.text }]}
                selectable
                numberOfLines={4}
              >
                {link}
              </Text>
            </View>

            <Button label={t('family.inviteShare')} onPress={share} testID="invite-share" />
            <Button label={t('common.done')} variant="secondary" onPress={() => router.back()} />
          </SectionCard>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  hint: { ...typography.caption, lineHeight: 19 },
  warn: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  warnText: { ...typography.caption, flex: 1, lineHeight: 19 },
  tokenBox: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  token: { ...typography.caption, fontFamily: 'monospace' },
});
