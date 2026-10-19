import {
  bootstrapRequestSchema,
  createUploadRequestSchema,
  fieldVisibilityMapSchema,
  meSchema,
  ownPhotoSchema,
  photoReorderSchema,
  photoUpdateSchema,
  ownProfileSchema,
  preferencesSchema,
  preferencesUpdateSchema,
  profileCompletionSchema,
  profileUpdateSchema,
  referenceListSchema,
  uploadTargetSchema,
  userSettingsUpdateSchema,
  type BootstrapRequest,
  type CreateUploadRequest,
  type FieldVisibilityMap,
  type Me,
  type OwnPhoto,
  type PhotoUpdate,
  type OwnProfile,
  type Preferences,
  type PreferencesUpdate,
  type ProfileCompletion,
  type ProfileUpdate,
  type ReferenceList,
  type UploadTarget,
  type ReferenceType,
  type UserSettingsUpdate,
  compatibilityExplanationSchema,
  compatibilityScoreSchema,
  interestPageSchema,
  interestSchema,
  matchPageSchema,
  notificationPageSchema,
  profileCardPageSchema,
  respondToInterestResultSchema,
  blockPageSchema,
  createReportSchema,
  conversationDetailSchema,
  conversationPageSchema,
  conversationStageSchema,
  markReadSchema,
  messagePageSchema,
  messageSchema,
  respondToStageSchema,
  sendMessageSchema,
  stageProposalSchema,
  type ConversationDetail,
  type ConversationPage,
  type ConversationStage,
  type Message,
  type MessagePage,
  type StageProposal,
  createInvitationSchema,
  createInvitationResponseSchema,
  decideReviewSchema,
  familyAccessLogPageSchema,
  familyInvitationPageSchema,
  familyMemberPageSchema,
  reviewPacketSchema,
  reviewSummaryPageSchema,
  updatePermissionsSchema,
  type CreateInvitationRequest,
  type DecideReviewRequest,
  type FamilyAccessLogPage,
  type FamilyInvitationPage,
  type FamilyMemberPage,
  type FamilyPermission,
  type ReviewPacket,
  type ReviewSummaryPage,
  reportPageSchema,
  reportSchema,
  type BlockPage,
  type CompatibilityExplanation,
  type CompatibilityScore,
  type CreateReportRequest,
  type Report,
  type ReportPage,
  type DiscoverySectionSummary,
  type Interest,
  type InterestDecision,
  type InterestDirection,
  type InterestPage,
  type InterestStatus,
  type MatchPage,
  type NotificationPage,
  type ProfileCardPage,
  type RespondToInterestResult,
} from '@nikahmate/domain';
import { AuthClient, type AuthClientOptions } from './auth';
import { HttpClient } from './http';
import { NikahMateError } from './errors';

/**
 * The single client the app talks to.
 *
 * Auth and the API are one object because they are one relationship: the
 * access token that proves who you are to Supabase is the same token the API
 * verifies. Handing screens two separate clients invites the bug where one
 * knows you are signed out and the other has not noticed yet.
 */

export interface NikahMateClientOptions extends AuthClientOptions {
  apiBaseUrl: string;
  getLocale?: () => string;
  fetchImpl?: typeof fetch;
}

/**
 * Parses a response against its shared schema.
 *
 * A server that changes shape should fail at the boundary with a clear reason,
 * not hand `undefined` to a screen and fail three renders later with
 * "cannot read property of undefined".
 */
function parse<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
  value: unknown,
  what: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success || result.data === undefined) {
    throw new NikahMateError('server', { detail: `Unexpected ${what} response shape` });
  }
  return result.data;
}

export class NikahMateClient {
  readonly auth: AuthClient;
  readonly http: HttpClient;

  constructor(options: NikahMateClientOptions) {
    this.auth = new AuthClient(options);
    this.http = new HttpClient({
      baseUrl: options.apiBaseUrl,
      getAccessToken: () => this.auth.getAccessToken(),
      ...(options.getLocale ? { getLocale: options.getLocale } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  /**
   * Links the Supabase auth account to our `users` row.
   *
   * Idempotent by design: the server returns the existing account when the
   * auth id is already linked. Sign-up can therefore be retried after a dropped
   * connection without stranding someone between an auth account and no
   * application account.
   */
  async bootstrap(request: BootstrapRequest): Promise<Me> {
    const body = bootstrapRequestSchema.parse(request);
    const response = await this.http.post<unknown>('/account/bootstrap', body);
    return parse(meSchema, response, 'bootstrap');
  }

  async getMe(): Promise<Me> {
    return parse(meSchema, await this.http.get<unknown>('/me'), 'me');
  }

  async updateSettings(patch: UserSettingsUpdate): Promise<Me> {
    const body = userSettingsUpdateSchema.parse(patch);
    return parse(meSchema, await this.http.patch<unknown>('/me', body), 'me');
  }

  /** Public reference data. Anonymous: it is identical for every caller. */
  async getReference(type: ReferenceType, locale?: string): Promise<ReferenceList> {
    const response = await this.http.get<unknown>(`/reference/${type}`, {
      anonymous: true,
      ...(locale ? { query: { locale } } : {}),
    });
    return parse(referenceListSchema, response, 'reference');
  }

  async getReferenceManifest(): Promise<Record<string, string>> {
    return this.http.get<Record<string, string>>('/reference/manifest', { anonymous: true });
  }

  // --- profile ---------------------------------------------------------------

  /**
   * The owner's full profile.
   *
   * The server creates an empty row on first read rather than 404ing, so the
   * app never has to special-case its own first screen.
   */
  async getProfile(): Promise<OwnProfile> {
    return parse(ownProfileSchema, await this.http.get<unknown>('/me/profile'), 'profile');
  }

  /** Partial. Validated here before the request, and again by the server. */
  async updateProfile(patch: ProfileUpdate): Promise<OwnProfile> {
    const body = profileUpdateSchema.parse(patch);
    return parse(ownProfileSchema, await this.http.patch<unknown>('/me/profile', body), 'profile');
  }

  async getProfileCompletion(): Promise<ProfileCompletion> {
    return parse(
      profileCompletionSchema,
      await this.http.get<unknown>('/me/profile/completion'),
      'completion',
    );
  }

  /** Moves the profile to review. Refused, with named fields, if incomplete. */
  async submitProfile(): Promise<ProfileCompletion> {
    return parse(
      profileCompletionSchema,
      await this.http.post<unknown>('/me/profile/submit'),
      'completion',
    );
  }

  // --- preferences -----------------------------------------------------------

  async getPreferences(): Promise<Preferences> {
    return parse(preferencesSchema, await this.http.get<unknown>('/me/preferences'), 'preferences');
  }

  async updatePreferences(patch: PreferencesUpdate): Promise<Preferences> {
    const body = preferencesUpdateSchema.parse(patch);
    return parse(
      preferencesSchema,
      await this.http.put<unknown>('/me/preferences', body),
      'preferences',
    );
  }

  // --- photos ----------------------------------------------------------------

  async listPhotos(): Promise<OwnPhoto[]> {
    const response = await this.http.get<{ items: unknown[] }>('/me/photos');
    return (response.items ?? []).map((item) => parse(ownPhotoSchema, item, 'photo'));
  }

  /**
   * Step one of three: reserve a slot and get somewhere to put the bytes.
   *
   * The API never carries the image itself — the app uploads straight to
   * storage with the returned target, which keeps a 10MB file off the request
   * path and out of the API's memory.
   */
  async createPhotoUploadTarget(request: CreateUploadRequest): Promise<UploadTarget> {
    const body = createUploadRequestSchema.parse(request);
    return parse(
      uploadTargetSchema,
      await this.http.post<unknown>('/me/photos/upload-url', body),
      'upload target',
    );
  }

  /**
   * Step two: PUT the bytes at the signed target.
   *
   * Deliberately NOT routed through `HttpClient` — that attaches our bearer
   * token and JSON headers, and this request goes to Storage with a signed URL
   * that is already its own credential.
   */
  async uploadPhotoBytes(target: UploadTarget, body: Blob | ArrayBuffer): Promise<void> {
    const response = await fetch(target.uploadUrl, {
      method: target.method,
      headers: target.headers,
      body: body as BodyInit,
    });
    if (!response.ok) {
      throw new NikahMateError(response.status >= 500 ? 'server' : 'validation_failed', {
        detail: `Storage upload failed with ${response.status}`,
      });
    }
  }

  /** Step three: generate variants, run moderation, make it usable. */
  async finalizePhoto(photoId: string): Promise<OwnPhoto> {
    return parse(
      ownPhotoSchema,
      await this.http.post<unknown>(`/me/photos/${photoId}/finalize`),
      'photo',
    );
  }

  async updatePhoto(photoId: string, patch: PhotoUpdate): Promise<OwnPhoto> {
    const body = photoUpdateSchema.parse(patch);
    return parse(
      ownPhotoSchema,
      await this.http.patch<unknown>(`/me/photos/${photoId}`, body),
      'photo',
    );
  }

  async reorderPhotos(photoIds: string[]): Promise<OwnPhoto[]> {
    const body = photoReorderSchema.parse({ photoIds });
    const response = await this.http.put<{ items: unknown[] }>('/me/photos/order', body);
    return (response.items ?? []).map((item) => parse(ownPhotoSchema, item, 'photo'));
  }

  async deletePhoto(photoId: string): Promise<void> {
    await this.http.delete(`/me/photos/${photoId}`);
  }

  // --- per-field visibility ---------------------------------------------------

  async getFieldVisibility(): Promise<FieldVisibilityMap> {
    return parse(
      fieldVisibilityMapSchema,
      await this.http.get<unknown>('/me/profile/visibility'),
      'visibility',
    );
  }

  /** Partial: send only what changed. */
  async updateFieldVisibility(patch: FieldVisibilityMap): Promise<FieldVisibilityMap> {
    const body = fieldVisibilityMapSchema.parse(patch);
    return parse(
      fieldVisibilityMapSchema,
      await this.http.put<unknown>('/me/profile/visibility', body),
      'visibility',
    );
  }

  // --- Discovery -------------------------------------------------------------

  /**
   * One discovery section, paginated.
   *
   * Served from precomputed candidates, with blocks, dismissals and privacy
   * re-applied on read — so a profile blocked since the last precompute never
   * arrives here.
   */
  async getDiscoverySection(
    sectionKey: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ProfileCardPage> {
    const query: Record<string, string | number | undefined> = {};
    if (options.cursor) query.cursor = options.cursor;
    if (options.limit) query.limit = options.limit;
    return parse(
      profileCardPageSchema,
      await this.http.get(`/discovery/sections/${encodeURIComponent(sectionKey)}`, { query }),
      'discovery section',
    );
  }

  async listDiscoverySections(): Promise<{ items: DiscoverySectionSummary[] }> {
    const body = (await this.http.get('/discovery/sections')) as {
      items?: DiscoverySectionSummary[];
    };
    return { items: body.items ?? [] };
  }

  async getShortlist(options: { cursor?: string; limit?: number } = {}): Promise<ProfileCardPage> {
    const query: Record<string, string | number | undefined> = {};
    if (options.cursor) query.cursor = options.cursor;
    if (options.limit) query.limit = options.limit;
    return parse(
      profileCardPageSchema,
      await this.http.get('/discovery/shortlist', { query }),
      'shortlist',
    );
  }

  /** Idempotent: saving twice is one statement made twice. */
  async addToShortlist(userId: string): Promise<void> {
    await this.http.put(`/discovery/shortlist/${userId}`);
  }

  async removeFromShortlist(userId: string): Promise<void> {
    await this.http.delete(`/discovery/shortlist/${userId}`);
  }

  /** Permanent, and never surfaced to the dismissed member. */
  async dismissProfile(userId: string): Promise<void> {
    await this.http.post(`/discovery/${userId}/dismiss`);
  }

  // --- Compatibility ---------------------------------------------------------

  async getCompatibility(userId: string): Promise<CompatibilityScore> {
    return parse(
      compatibilityScoreSchema,
      await this.http.get(`/compatibility/${userId}`),
      'compatibility',
    );
  }

  /**
   * Reasons and differences as KEYS and FACTS, never prose.
   *
   * The client renders them against the catalogs, which is what keeps an
   * explanation incapable of inventing something about a real person.
   */
  async getCompatibilityExplanation(userId: string): Promise<CompatibilityExplanation> {
    return parse(
      compatibilityExplanationSchema,
      await this.http.get(`/compatibility/${userId}/explanation`),
      'compatibility explanation',
    );
  }

  // --- Interests -------------------------------------------------------------

  async sendInterest(recipientUserId: string, note?: string): Promise<Interest> {
    return parse(
      interestSchema,
      await this.http.post(
        '/interests',
        note === undefined ? { recipientUserId } : { recipientUserId, note },
      ),
      'interest',
    );
  }

  async listInterests(
    direction: InterestDirection,
    options: { status?: InterestStatus; cursor?: string; limit?: number } = {},
  ): Promise<InterestPage> {
    const query: Record<string, string | number | undefined> = { direction };
    if (options.status) query.status = options.status;
    if (options.cursor) query.cursor = options.cursor;
    if (options.limit) query.limit = options.limit;
    return parse(interestPageSchema, await this.http.get('/interests', { query }), 'interests');
  }

  /** Accepting creates a match. It does NOT open a conversation (ADR 0011). */
  async respondToInterest(
    interestId: string,
    decision: InterestDecision,
  ): Promise<RespondToInterestResult> {
    return parse(
      respondToInterestResultSchema,
      await this.http.post(`/interests/${interestId}/respond`, { decision }),
      'interest response',
    );
  }

  /** Sender only, and no quota is refunded. */
  async withdrawInterest(interestId: string): Promise<void> {
    await this.http.delete(`/interests/${interestId}`);
  }

  // --- Matches ---------------------------------------------------------------

  async listMatches(options: { cursor?: string; limit?: number } = {}): Promise<MatchPage> {
    const query: Record<string, string | number | undefined> = {};
    if (options.cursor) query.cursor = options.cursor;
    if (options.limit) query.limit = options.limit;
    return parse(matchPageSchema, await this.http.get('/matches', { query }), 'matches');
  }

  async unmatch(matchId: string, reason?: string): Promise<void> {
    await this.http.post(`/matches/${matchId}/unmatch`, reason === undefined ? {} : { reason });
  }

  // --- Notifications ---------------------------------------------------------

  async listNotifications(
    options: { unreadOnly?: boolean; cursor?: string; limit?: number } = {},
  ): Promise<NotificationPage> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (options.unreadOnly) query.unreadOnly = true;
    if (options.cursor) query.cursor = options.cursor;
    if (options.limit) query.limit = options.limit;
    return parse(
      notificationPageSchema,
      await this.http.get('/notifications', { query }),
      'notifications',
    );
  }

  async markNotificationRead(notificationId: string): Promise<void> {
    await this.http.post(`/notifications/${notificationId}/read`);
  }

  async markAllNotificationsRead(): Promise<void> {
    await this.http.post('/notifications/read-all');
  }

  // --- Safety: blocks and reports --------------------------------------------

  /**
   * People this member has blocked.
   *
   * One direction only. There is no call for "who has blocked me" and there
   * never will be — the blocked party must not be able to detect the block.
   */
  async listBlocks(options: { cursor?: string; limit?: number } = {}): Promise<BlockPage> {
    const query: Record<string, string | number | undefined> = {};
    if (options.cursor) query.cursor = options.cursor;
    if (options.limit) query.limit = options.limit;
    return parse(blockPageSchema, await this.http.get('/blocks', { query }), 'blocks');
  }

  /**
   * Block a member. Idempotent — blocking someone already blocked succeeds.
   *
   * `reasonCode` is optional and never shown to the blocked member.
   */
  async blockUser(userId: string, reasonCode?: string): Promise<void> {
    await this.http.put(`/blocks/${userId}`, reasonCode === undefined ? {} : { reasonCode });
  }

  async unblockUser(userId: string): Promise<void> {
    await this.http.delete(`/blocks/${userId}`);
  }

  /**
   * Report a member.
   *
   * Reporting does NOT block: the two are separate decisions and the app asks
   * for them separately. Filing a second report about the same person while
   * the first is still open answers 409.
   */
  async createReport(report: CreateReportRequest): Promise<Report> {
    const body = createReportSchema.parse(report);
    return parse(reportSchema, await this.http.post('/reports', body), 'report');
  }

  /** Reports this member has filed, and their outcomes. */
  async listMyReports(options: { cursor?: string; limit?: number } = {}): Promise<ReportPage> {
    const query: Record<string, string | number | undefined> = {};
    if (options.cursor) query.cursor = options.cursor;
    if (options.limit) query.limit = options.limit;
    return parse(reportPageSchema, await this.http.get('/me/reports', { query }), 'reports');
  }

  // --- Family / Wali (Phase 6b, ADR 0011) ------------------------------------

  /** My family members, and exactly what each one holds. */
  async listFamilyMembers(
    options: { cursor?: string; limit?: number } = {},
  ): Promise<FamilyMemberPage> {
    const query: Record<string, string | number | undefined> = {};
    if (options.cursor) query.cursor = options.cursor;
    if (options.limit) query.limit = options.limit;
    return parse(
      familyMemberPageSchema,
      await this.http.get('/family/members', { query }),
      'family members',
    );
  }

  /**
   * Invite someone, with a tier and the grants it expands to.
   *
   * The returned `token` is shown ONCE and is not stored unhashed anywhere.
   * It will not appear in `listFamilyInvitations()`, so it has to be handed
   * to the invitee from this response or not at all.
   */
  async createFamilyInvitation(invitation: CreateInvitationRequest) {
    const body = createInvitationSchema.parse(invitation);
    return parse(
      createInvitationResponseSchema,
      await this.http.post('/family/invitations', body),
      'invitation',
    );
  }

  async listFamilyInvitations(): Promise<FamilyInvitationPage> {
    return parse(
      familyInvitationPageSchema,
      await this.http.get('/family/invitations'),
      'invitations',
    );
  }

  /** Accept or decline, by presenting the token from the invitation link. */
  async respondToFamilyInvitation(
    invitationId: string,
    token: string,
    accept: boolean,
  ): Promise<void> {
    await this.http.post(`/family/invitations/${invitationId}/respond`, { token, accept });
  }

  async cancelFamilyInvitation(invitationId: string): Promise<void> {
    await this.http.delete(`/family/invitations/${invitationId}`);
  }

  /**
   * Replace what a delegate holds.
   *
   * THE COMPLETE SET, not a delta — sending a subset revokes the rest. A
   * permission whose phase has not arrived is refused with 400 rather than
   * accepted and ignored.
   */
  async updateFamilyPermissions(
    relationshipId: string,
    permissions: FamilyPermission[],
  ): Promise<void> {
    const body = updatePermissionsSchema.parse({ permissions });
    await this.http.patch(`/family/members/${relationshipId}/permissions`, body);
  }

  /** Revoke a delegate. Instant, and needs nobody's agreement. */
  async revokeFamilyMember(relationshipId: string): Promise<void> {
    await this.http.delete(`/family/members/${relationshipId}`);
  }

  /** Every action taken in my name, and the permission that authorised it. */
  async listFamilyAccessLog(
    options: { cursor?: string; limit?: number } = {},
  ): Promise<FamilyAccessLogPage> {
    const query: Record<string, string | number | undefined> = {};
    if (options.cursor) query.cursor = options.cursor;
    if (options.limit) query.limit = options.limit;
    return parse(
      familyAccessLogPageSchema,
      await this.http.get('/family/access-log', { query }),
      'access log',
    );
  }

  /** The people I hold rights over. */
  async listManagedProfiles(): Promise<FamilyMemberPage> {
    return parse(familyMemberPageSchema, await this.http.get('/family/managed'), 'managed');
  }

  /** Matches awaiting my decision as a delegate. */
  async listFamilyReviews(
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ReviewSummaryPage> {
    const query: Record<string, string | number | undefined> = {};
    if (options.cursor) query.cursor = options.cursor;
    if (options.limit) query.limit = options.limit;
    return parse(
      reviewSummaryPageSchema,
      await this.http.get('/family/reviews', { query }),
      'reviews',
    );
  }

  /**
   * The review packet for ONE match.
   *
   * Match-scoped by design: there is no call that returns a list of people a
   * delegate may look at. 404 for any match they were not asked about.
   */
  async getReviewPacket(matchId: string): Promise<ReviewPacket> {
    return parse(
      reviewPacketSchema,
      await this.http.get(`/family/reviews/${matchId}`),
      'review packet',
    );
  }

  /** Approve, reject, or ask for more information. */
  async decideReview(matchId: string, decision: DecideReviewRequest) {
    const body = decideReviewSchema.parse(decision);
    return this.http.post(`/family/reviews/${matchId}/decide`, body);
  }

  /** Withdraw an approval. Closes writing without destroying the match. */
  async revokeReview(matchId: string, note?: string) {
    return this.http.post(`/family/reviews/${matchId}/revoke`, note === undefined ? {} : { note });
  }

  /** Reviews pending on MY matches, and the stalled-review warning. */
  async listMyFamilyReviews() {
    return this.http.get('/family/my-reviews');
  }

  // --- Conversations (Phase 7) -----------------------------------------------

  /**
   * My threads, newest traffic first.
   *
   * Each carries `canWrite` and `writeBlockedReason`. Do NOT infer writability
   * from membership: a thread can be readable and closed at the same time
   * because a family approval was withdrawn or a block appeared, and a
   * composer that only fails on send is a worse answer than one that explains
   * itself.
   */
  async listConversations(
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ConversationPage> {
    const query: Record<string, string | number | undefined> = {};
    if (options.cursor) query.cursor = options.cursor;
    if (options.limit) query.limit = options.limit;
    return parse(
      conversationPageSchema,
      await this.http.get('/conversations', { query }),
      'conversations',
    );
  }

  async getConversation(conversationId: string): Promise<ConversationDetail> {
    return parse(
      conversationDetailSchema,
      await this.http.get(`/conversations/${conversationId}`),
      'conversation',
    );
  }

  /** Newest first — a chat opens at the bottom, and paging goes backwards. */
  async listMessages(
    conversationId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<MessagePage> {
    const query: Record<string, string | number | undefined> = {};
    if (options.cursor) query.cursor = options.cursor;
    if (options.limit) query.limit = options.limit;
    return parse(
      messagePageSchema,
      await this.http.get(`/conversations/${conversationId}/messages`, { query }),
      'messages',
    );
  }

  /** 409 when the gate is closed, with the reason in the message. */
  async sendMessage(conversationId: string, body: string): Promise<Message> {
    const payload = sendMessageSchema.parse({ body });
    return parse(
      messageSchema,
      await this.http.post(`/conversations/${conversationId}/messages`, payload),
      'message',
    );
  }

  async markRead(conversationId: string, lastReadMessageId: string): Promise<void> {
    const payload = markReadSchema.parse({ lastReadMessageId });
    await this.http.post(`/conversations/${conversationId}/read`, payload);
  }

  async getStage(conversationId: string): Promise<ConversationStage> {
    return parse(
      conversationStageSchema,
      await this.http.get(`/conversations/${conversationId}/stage`),
      'stage',
    );
  }

  /** Propose advancing one stage. The counterpart must accept. */
  async proposeStage(conversationId: string): Promise<StageProposal> {
    return parse(
      stageProposalSchema,
      await this.http.post(`/conversations/${conversationId}/stage/propose`, {}),
      'proposal',
    );
  }

  async respondToStage(conversationId: string, accept: boolean): Promise<ConversationStage> {
    const payload = respondToStageSchema.parse({ accept });
    return parse(
      conversationStageSchema,
      await this.http.post(`/conversations/${conversationId}/stage/respond`, payload),
      'stage',
    );
  }

  /** Leave a thread. Not an unmatch — the match itself is ended elsewhere. */
  async leaveConversation(conversationId: string): Promise<void> {
    await this.http.post(`/conversations/${conversationId}/leave`, {});
  }

  /**
   * Live delivery for one thread.
   *
   * Fires on every insert the caller is permitted to see; the app re-reads
   * through `listMessages` rather than trusting the payload, so one decoder
   * owns the shape. Returns an unsubscribe the caller MUST invoke on unmount.
   */
  subscribeToMessages(conversationId: string, onInsert: () => void): () => void {
    return this.auth.subscribeToMessages(conversationId, onInsert);
  }
}
