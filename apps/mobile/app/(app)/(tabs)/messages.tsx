import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Banner } from '../../../src/components/Banner';
import { EmptyState } from '../../../src/components/EmptyState';
import { SkeletonList } from '../../../src/components/LoadingSkeleton';
import { ProfileAvatar } from '../../../src/components/ProfileAvatar';
import { Screen } from '../../../src/components/Screen';
import { StatusBadge } from '../../../src/components/StatusBadge';
import { useConversations } from '../../../src/chat/useChat';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { iconSize, radius, spacing, typography } from '../../../src/theme/tokens';

/**
 * Messages — the conversation list (Phase 7).
 *
 * A CLOSED THREAD STILL APPEARS, and says why. A conversation whose family
 * approval was withdrawn, or where a block exists, is readable history: hiding
 * it would look like deleted messages, which is the one thing a safety feature
 * must never resemble. The row is shown with the reason and no unread badge.
 *
 * `canWrite` comes from the server rather than being inferred from the match
 * state, because the client would otherwise be reimplementing
 * `app.can_write_message()` — four conditions, each of which has closed a real
 * hole in this schema.
 */
export default function MessagesScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const { conversations, loading, error } = useConversations();

  return (
    <Screen title={t('chat.title')} subtitle={t('chat.subtitle')}>
      <View style={styles.body}>
        {error ? <Banner tone="error" message={t('chat.errorLoad')} /> : null}

        {loading ? (
          <SkeletonList />
        ) : conversations.length === 0 ? (
          <EmptyState
            icon="chatbubbles-outline"
            title={t('chat.emptyTitle')}
            body={t('chat.emptyBody')}
          />
        ) : (
          conversations.map((conversation) => (
            <Pressable
              key={conversation.id}
              onPress={() =>
                router.push({
                  pathname: '/chat/[conversationId]',
                  params: { conversationId: conversation.id },
                })
              }
              accessibilityRole="button"
              accessibilityLabel={conversation.counterpartDisplayName ?? ''}
              testID={`conversation-${conversation.id}`}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: pressed ? theme.colors.surfaceSunken : theme.colors.surface,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <ProfileAvatar
                userId={conversation.counterpartUserId}
                displayName={conversation.counterpartDisplayName}
                size="md"
              />

              <View style={styles.main}>
                <View style={styles.titleRow}>
                  <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
                    {conversation.counterpartDisplayName ?? ''}
                  </Text>
                  {conversation.unreadCount > 0 ? (
                    <StatusBadge
                      label={
                        conversation.unreadCount === 1
                          ? t('chat.unreadOne')
                          : t('chat.unreadMany').replace(
                              '{{count}}',
                              String(conversation.unreadCount),
                            )
                      }
                      tone="brand"
                    />
                  ) : null}
                </View>

                {/* The reason replaces the preview when writing is closed:
                    that is what the person needs to know on this screen. */}
                {conversation.writeBlockedReason ? (
                  <View style={styles.closedRow}>
                    <Ionicons
                      name="lock-closed-outline"
                      size={iconSize.xs}
                      color={theme.colors.textSubtle}
                    />
                    <Text
                      style={[styles.closed, { color: theme.colors.textSubtle }]}
                      numberOfLines={2}
                    >
                      {t(
                        `chat.closed${conversation.writeBlockedReason
                          .charAt(0)
                          .toUpperCase()}${conversation.writeBlockedReason.slice(1)}`,
                      )}
                    </Text>
                  </View>
                ) : (
                  <Text
                    style={[styles.preview, { color: theme.colors.textMuted }]}
                    numberOfLines={1}
                  >
                    {conversation.lastMessagePreview ?? t('chat.noMessages')}
                  </Text>
                )}
              </View>

              <Ionicons name="chevron-forward" size={iconSize.sm} color={theme.colors.textSubtle} />
            </Pressable>
          ))
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.sm, marginTop: spacing.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  // flexShrink so a long name never pushes the chevron off a 320dp screen.
  main: { flex: 1, flexShrink: 1, gap: spacing.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { ...typography.bodyStrong, flexShrink: 1 },
  preview: { ...typography.caption },
  closedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  closed: { ...typography.caption, flex: 1, flexShrink: 1 },
});
