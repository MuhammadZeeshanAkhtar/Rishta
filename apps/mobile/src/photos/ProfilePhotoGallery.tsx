import { useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ProfilePhotos } from '@nikahmate/domain';
import { MAX_PHOTO_REQUEST_MESSAGE } from '@nikahmate/domain';
import { Button } from '../components/Button';
import { SectionCard } from '../components/SectionCard';
import { StatusBadge } from '../components/StatusBadge';
import { TextField } from '../components/TextField';
import { useLocale } from '../i18n/LocaleProvider';
import { useTheme } from '../theme/ThemeProvider';
import { iconSize, radius, spacing, typography } from '../theme/tokens';
import { galleryView } from './photoAccess';

/**
 * Another member's photos (review L3).
 *
 * Draws only what `GET /profiles/{userId}/photos` returned — each URL is a
 * short-lived signature for exactly the object this viewer may read, issued
 * with their own token and checked again by the Storage policy. A blurred
 * photo is the server-generated blurred FILE; nothing is blurred here, so the
 * original never reaches this device unless the owner allowed it.
 *
 * The URLs expire in five minutes, so they are never cached: the screen
 * re-reads on focus.
 */

export interface ProfilePhotoGalleryProps {
  photos: ProfilePhotos | null;
  /** First name or a neutral word, for the copy. */
  name: string;
  onRequest: (message: string | undefined) => Promise<void>;
  testID?: string;
}

export function ProfilePhotoGallery({ photos, name, onRequest, testID }: ProfilePhotoGalleryProps) {
  const { t } = useLocale();
  const theme = useTheme();
  const view = galleryView(photos);
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  // No photos the viewer may know about: say nothing. Profiles without photos
  // are first-class (README A1) — an empty frame would read as a penalty.
  if (view.shown.length === 0 && view.lockedCount === 0 && view.action === 'none') return null;

  const send = async () => {
    setSending(true);
    try {
      await onRequest(message.trim().length > 0 ? message.trim() : undefined);
      setComposing(false);
      setMessage('');
    } finally {
      setSending(false);
    }
  };

  return (
    <SectionCard
      title={t('photoAccess.title')}
      subtitle={t('photoAccess.subtitle')}
      icon="images-outline"
      testID={testID}
    >
      {view.shown.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
        >
          {view.shown.map((photo) => (
            <View key={photo.id} style={styles.frame}>
              <Image
                source={{ uri: photo.url }}
                style={[styles.image, { backgroundColor: theme.colors.surfaceSunken }]}
                resizeMode="cover"
                accessibilityLabel={
                  photo.blurred
                    ? t('photoAccess.blurredAlt').replace('{{name}}', name)
                    : t('photoAccess.photoAlt').replace('{{name}}', name)
                }
              />
              {photo.blurred ? (
                <View style={styles.overlay}>
                  <Ionicons name="eye-off-outline" size={iconSize.sm} color="#FFFFFF" />
                </View>
              ) : null}
            </View>
          ))}
          {Array.from({ length: view.lockedCount }, (_, i) => (
            <View
              key={`locked-${i}`}
              style={[
                styles.frame,
                styles.locked,
                { backgroundColor: theme.colors.surfaceSunken, borderColor: theme.colors.border },
              ]}
              accessibilityLabel={t('photoAccess.lockedAlt')}
            >
              <Ionicons
                name="lock-closed-outline"
                size={iconSize.md}
                color={theme.colors.textSubtle}
              />
            </View>
          ))}
        </ScrollView>
      ) : view.lockedCount > 0 ? (
        <Text style={[styles.note, { color: theme.colors.textMuted }]}>
          {t('photoAccess.lockedCount').replace('{{count}}', String(view.lockedCount))}
        </Text>
      ) : null}

      {view.action === 'request' && !composing ? (
        <Button
          label={t('photoAccess.request')}
          variant="secondary"
          onPress={() => setComposing(true)}
          icon={<Ionicons name="key-outline" size={iconSize.sm} color={theme.colors.brand} />}
          testID="photo-access-request"
        />
      ) : null}

      {view.action === 'request' && composing ? (
        <View style={styles.compose}>
          <TextField
            label={t('photoAccess.messageLabel')}
            hint={t('photoAccess.messageHint')}
            value={message}
            onChangeText={setMessage}
            multiline
            maxLength={MAX_PHOTO_REQUEST_MESSAGE}
            testID="photo-access-message"
          />
          <View style={styles.actions}>
            <Button
              label={t('common.cancel')}
              variant="ghost"
              onPress={() => setComposing(false)}
            />
            <Button
              label={t('photoAccess.send')}
              onPress={() => void send()}
              loading={sending}
              testID="photo-access-send"
            />
          </View>
        </View>
      ) : null}

      {view.action === 'pending' ? (
        <StatusBadge label={t('photoAccess.pending')} tone="warm" />
      ) : null}
      {view.action === 'declined' ? (
        <Text style={[styles.note, { color: theme.colors.textMuted }]}>
          {t('photoAccess.declined')}
        </Text>
      ) : null}
      {view.action === 'granted' ? (
        <StatusBadge label={t('photoAccess.granted')} tone="success" />
      ) : null}
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  row: { gap: spacing.sm, paddingVertical: spacing.xs },
  frame: { width: 132, height: 168, borderRadius: radius.md, overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  overlay: {
    position: 'absolute',
    right: spacing.xs,
    top: spacing.xs,
    backgroundColor: 'rgba(3,41,31,0.55)',
    borderRadius: radius.pill,
    padding: spacing.xs,
  },
  locked: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  note: { ...typography.caption },
  compose: { gap: spacing.sm },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
});
