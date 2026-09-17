import { realpath } from "node:fs/promises";
import type {
  AskUserCloseResponse,
  AskUserSubmission,
  ExtensionDialogAnswer,
  ExtensionDialogCloseResponse,
  SavedPromptAttachment,
  SessionBulkArchiveResponse,
  SessionBulkDeleteArchivedResponse,
  SessionBulkMutationRef,
  SessionDefaults,
  SessionDefaultsUpdate,
  SessionModelScopeMode,
  SessionNotificationCatalogSnapshot,
  SessionNotificationDismissAllRequest,
  SessionNotificationDismissRequest,
  SessionNotificationInboxSnapshot,
  SessionUnreadAcknowledgeRequest,
  SessionUnreadCatalogSnapshot,
} from "../../shared/apiTypes.js";
import type {
  ClientArchiveSessionsResponse,
  ClientCommand,
  ClientCommandResult,
  ClientMessagePage,
  ClientSession,
  ClientSessionCleanupExecuteResponse,
  ClientSessionCleanupPreviewResponse,
  ClientSessionModel,
  ClientSessionModelCatalogEntry,
  ClientSessionStatus,
  ClientSessionTreeForkRequest,
  ClientSessionTreeForkResult,
  ClientSessionTreeNavigateRequest,
  ClientSessionTreeNavigateResult,
  ClientThinkingLevel,
  SessionStreamSnapshot,
} from "../types.js";
import { INLINE_IMAGE_DATA_LIMIT, mediaIdForData } from "../browserMessageProjection.js";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import { pageMessagesAtSafeBoundary } from "./messagePaging.js";
import type { PiSessionManagerGateway } from "./piSessionService.js";
import type { NormalizedSessionCleanupRequest } from "./sessionCleanup.js";
import type { SessionRouteRef, SessionRouteService } from "./sessionService.js";
import { historyMessagesFromEntries } from "./transcriptMessages.js";
import type { ExternalPermissionOwner } from "./externalPermissionBridgeRegistry.js";

export interface ExternalPermissionOwners {
  hasAnyOwner(): Promise<boolean>;
  listForCwd(cwd: string): Promise<readonly ExternalPermissionOwner[]>;
  resolve(ref: SessionRouteRef): Promise<ExternalPermissionOwner | undefined>;
  status(owner: ExternalPermissionOwner): ClientSessionStatus;
  answer(owner: ExternalPermissionOwner, dialogId: string, value: ExtensionDialogAnswer): Promise<{
    result: { outcome: "accepted" } | { outcome: "stale" } | { outcome: "invalid"; reason: string };
    answerLabel?: string;
  }>;
}

/**
 * Routes verified externally owned sessions before any PiSessionService method
 * can restore a competing AgentSession. Ordinary PI WEB sessions delegate
 * unchanged.
 */
export class SessionOwnerRouter implements SessionRouteService {
  constructor(
    private readonly local: SessionRouteService,
    private readonly external: ExternalPermissionOwners,
    private readonly sessionManager: PiSessionManagerGateway,
    private readonly events: SessionEventHub,
  ) {}

  async list(cwd: string): Promise<ClientSession[]> {
    const [sessions, owners] = await Promise.all([this.local.list(cwd), this.external.listForCwd(cwd)]);
    const bySessionId = new Map(owners.map((owner) => [owner.identity.sessionId, owner]));
    return Promise.all(sessions.map(async (session) => {
      const owner = bySessionId.get(session.id);
      if (owner === undefined) return session;
      const sameTranscript = await canonicalPathMatches(session.path, owner.identity.transcriptPath);
      return { ...session, owner: sameTranscript ? owner.owner : { ...owner.owner, state: "conflict" as const } };
    }));
  }

  start(cwd: string, options?: { startupToken?: string }): Promise<ClientSession> {
    return this.local.start(cwd, options);
  }

  async messages(ref: SessionRouteRef, page?: { before?: number; limit?: number }): Promise<ClientMessagePage> {
    const owner = await this.resolveExternal(ref);
    if (owner === undefined) return this.local.messages(ref, page);
    const entries = await this.externalBranch(owner);
    return pageMessagesAtSafeBoundary(historyMessagesFromEntries(entries), page);
  }

  async media(ref: SessionRouteRef, mediaId: string): Promise<{ mimeType: string; data: Buffer } | undefined> {
    const owner = await this.resolveExternal(ref);
    if (owner === undefined) return this.local.media(ref, mediaId);
    for (const message of historyMessagesFromEntries(await this.externalBranch(owner))) {
      if (!isRecord(message) || !Array.isArray(message["content"])) continue;
      for (const part of message["content"]) {
        if (!isRecord(part) || part["type"] !== "image") continue;
        const data = part["data"];
        if (typeof data !== "string" || data.length <= INLINE_IMAGE_DATA_LIMIT || mediaIdForData(data) !== mediaId) continue;
        const mimeType = part["mimeType"];
        return { mimeType: typeof mimeType === "string" && mimeType !== "" ? mimeType : "application/octet-stream", data: Buffer.from(data, "base64") };
      }
    }
    return undefined;
  }

  async status(ref: SessionRouteRef): Promise<ClientSessionStatus> {
    const owner = await this.resolveExternal(ref);
    return owner === undefined ? this.local.status(ref) : this.external.status(owner);
  }

  async streamSnapshot(ref: SessionRouteRef): Promise<SessionStreamSnapshot> {
    const owner = await this.resolveExternal(ref);
    return owner === undefined ? this.local.streamSnapshot(ref) : { seq: this.events.currentSeq(owner.identity.sessionId), partial: null };
  }

  notificationCatalog(): SessionNotificationCatalogSnapshot | Promise<SessionNotificationCatalogSnapshot> {
    return this.local.notificationCatalog();
  }

  unreadCatalog(): Promise<SessionUnreadCatalogSnapshot> {
    return this.local.unreadCatalog();
  }

  async acknowledgeUnread(sessionId: string, request: SessionUnreadAcknowledgeRequest): Promise<SessionUnreadCatalogSnapshot> {
    await this.rejectExternal({ id: sessionId, cwd: request.cwd });
    return this.local.acknowledgeUnread(sessionId, request);
  }

  async notificationInbox(ref: SessionRouteRef): Promise<SessionNotificationInboxSnapshot> {
    await this.rejectExternal(ref);
    return this.local.notificationInbox(ref);
  }

  async dismissNotification(ref: SessionRouteRef, request: Omit<SessionNotificationDismissRequest, "cwd">): Promise<SessionNotificationInboxSnapshot> {
    await this.rejectExternal(ref);
    return this.local.dismissNotification(ref, request);
  }

  async dismissAllNotifications(ref: SessionRouteRef, request: Omit<SessionNotificationDismissAllRequest, "cwd">): Promise<SessionNotificationInboxSnapshot> {
    await this.rejectExternal(ref);
    return this.local.dismissAllNotifications(ref, request);
  }

  async clearQueue(ref: SessionRouteRef): Promise<ClientSessionStatus> {
    await this.rejectExternal(ref);
    return this.local.clearQueue(ref);
  }

  async submitAsk(ref: SessionRouteRef, askId: string, submission: AskUserSubmission): Promise<AskUserCloseResponse> {
    await this.rejectExternal(ref);
    return this.local.submitAsk(ref, askId, submission);
  }

  async cancelAsk(ref: SessionRouteRef, askId: string): Promise<AskUserCloseResponse> {
    await this.rejectExternal(ref);
    return this.local.cancelAsk(ref, askId);
  }

  async answerDialog(ref: SessionRouteRef, dialogId: string, value: ExtensionDialogAnswer): Promise<ExtensionDialogCloseResponse> {
    const owner = await this.resolveExternal(ref);
    if (owner === undefined) return this.local.answerDialog(ref, dialogId, value);
    const dialog = owner.dialogs.find((candidate) => candidate.dialogId === dialogId);
    const answered = await this.external.answer(owner, dialogId, value);
    const sessionStatus = await this.status(ref);
    if (answered.result.outcome === "stale") return { result: "stale", sessionStatus };
    if (answered.result.outcome === "invalid") throw new Error(answered.result.reason);
    if (dialog === undefined || answered.answerLabel === undefined) return { result: "stale", sessionStatus };
    return {
      result: "closed",
      outcome: {
        dialogId,
        reason: "answered",
        answer: answered.answerLabel,
        askedAt: dialog.askedAt,
        closedAt: new Date().toISOString(),
      },
      sessionStatus,
    };
  }

  async cancelDialog(ref: SessionRouteRef, dialogId: string): Promise<ExtensionDialogCloseResponse> {
    await this.rejectExternal(ref);
    return this.local.cancelDialog(ref, dialogId);
  }

  async dismissWarning(ref: SessionRouteRef, dismissId: string): Promise<ClientSessionStatus> {
    await this.rejectExternal(ref);
    return this.local.dismissWarning(ref, dismissId);
  }

  async getSessionDefaults(ref: SessionRouteRef): Promise<SessionDefaults> {
    await this.rejectExternal(ref);
    return this.local.getSessionDefaults(ref);
  }

  async setSessionDefaults(ref: SessionRouteRef, defaults: SessionDefaultsUpdate): Promise<SessionDefaults> {
    await this.rejectExternal(ref);
    return this.local.setSessionDefaults(ref, defaults);
  }

  async availableModels(ref: SessionRouteRef): Promise<ClientSessionModel[]> {
    await this.rejectExternal(ref);
    return this.local.availableModels(ref);
  }

  async modelCatalog(ref: SessionRouteRef): Promise<ClientSessionModelCatalogEntry[]> {
    await this.rejectExternal(ref);
    return this.local.modelCatalog(ref);
  }

  async setModel(ref: SessionRouteRef, provider: string, modelId: string): Promise<ClientSessionStatus> {
    await this.rejectExternal(ref);
    return this.local.setModel(ref, provider, modelId);
  }

  async setModelEnabled(ref: SessionRouteRef, provider: string, modelId: string, enabled: boolean): Promise<ClientSessionModelCatalogEntry[]> {
    await this.rejectExternal(ref);
    return this.local.setModelEnabled(ref, provider, modelId, enabled);
  }

  async setModelScope(ref: SessionRouteRef, mode: SessionModelScopeMode): Promise<ClientSessionModelCatalogEntry[]> {
    await this.rejectExternal(ref);
    return this.local.setModelScope(ref, mode);
  }

  async cycleModel(ref: SessionRouteRef, direction: "forward" | "backward"): Promise<ClientSessionStatus> {
    await this.rejectExternal(ref);
    return this.local.cycleModel(ref, direction);
  }

  async availableThinkingLevels(ref: SessionRouteRef): Promise<ClientThinkingLevel[]> {
    await this.rejectExternal(ref);
    return this.local.availableThinkingLevels(ref);
  }

  async setThinkingLevel(ref: SessionRouteRef, level: string): Promise<ClientSessionStatus> {
    await this.rejectExternal(ref);
    return this.local.setThinkingLevel(ref, level);
  }

  async cycleThinkingLevel(ref: SessionRouteRef): Promise<ClientSessionStatus> {
    await this.rejectExternal(ref);
    return this.local.cycleThinkingLevel(ref);
  }

  async commands(ref: SessionRouteRef): Promise<ClientCommand[]> {
    await this.rejectExternal(ref);
    return this.local.commands(ref);
  }

  async prompt(ref: SessionRouteRef, text: unknown, streamingBehavior?: unknown, attachments?: unknown): Promise<void> {
    await this.rejectExternal(ref);
    return this.local.prompt(ref, text, streamingBehavior, attachments);
  }

  async saveAttachments(ref: SessionRouteRef, attachments: unknown, folder?: string): Promise<SavedPromptAttachment[]> {
    await this.rejectExternal(ref);
    return this.local.saveAttachments(ref, attachments, folder);
  }

  async cleanupPreview(request: NormalizedSessionCleanupRequest): Promise<ClientSessionCleanupPreviewResponse> {
    await this.rejectCleanupWithExternalOwners();
    return this.local.cleanupPreview(request);
  }

  async cleanup(request: NormalizedSessionCleanupRequest): Promise<ClientSessionCleanupExecuteResponse> {
    await this.rejectCleanupWithExternalOwners();
    return this.local.cleanup(request);
  }

  async archiveMany(refs: readonly SessionBulkMutationRef[]): Promise<SessionBulkArchiveResponse> {
    await Promise.all(refs.map((ref) => this.rejectExternal(ref)));
    return this.local.archiveMany(refs);
  }

  async deleteArchivedMany(refs: readonly SessionBulkMutationRef[]): Promise<SessionBulkDeleteArchivedResponse> {
    await Promise.all(refs.map((ref) => this.rejectExternal(ref)));
    return this.local.deleteArchivedMany(refs);
  }

  async shell(ref: SessionRouteRef, text: string): Promise<void> {
    await this.rejectExternal(ref);
    return this.local.shell(ref, text);
  }

  async runCommand(ref: SessionRouteRef, text: string): Promise<ClientCommandResult> {
    await this.rejectExternal(ref);
    return this.local.runCommand(ref, text);
  }

  async respondToCommand(ref: SessionRouteRef, requestId: string, value: string): Promise<ClientCommandResult> {
    await this.rejectExternal(ref);
    return this.local.respondToCommand(ref, requestId, value);
  }

  async navigateTree(ref: SessionRouteRef, request: ClientSessionTreeNavigateRequest): Promise<ClientSessionTreeNavigateResult> {
    await this.rejectExternal(ref);
    return this.local.navigateTree(ref, request);
  }

  async forkFromTree(ref: SessionRouteRef, request: ClientSessionTreeForkRequest): Promise<ClientSessionTreeForkResult> {
    await this.rejectExternal(ref);
    return this.local.forkFromTree(ref, request);
  }

  async abort(ref: SessionRouteRef): Promise<void> {
    await this.rejectExternal(ref);
    return this.local.abort(ref);
  }

  async stop(ref: SessionRouteRef): Promise<void> {
    await this.rejectExternal(ref);
    await this.local.stop(ref);
  }

  async archive(ref: SessionRouteRef): Promise<void> {
    await this.rejectExternal(ref);
    return this.local.archive(ref);
  }

  async archiveTree(ref: SessionRouteRef): Promise<ClientArchiveSessionsResponse> {
    await this.rejectExternal(ref);
    return this.local.archiveTree(ref);
  }

  async restore(ref: SessionRouteRef): Promise<void> {
    await this.rejectExternal(ref);
    return this.local.restore(ref);
  }

  async reload(ref: SessionRouteRef): Promise<void> {
    await this.rejectExternal(ref);
    return this.local.reload(ref);
  }

  async detachParent(ref: SessionRouteRef): Promise<void> {
    await this.rejectExternal(ref);
    return this.local.detachParent(ref);
  }

  private async externalBranch(owner: ExternalPermissionOwner): Promise<unknown[]> {
    if (this.sessionManager.readBranch === undefined) throw new Error("Read-only transcript snapshots are unavailable");
    const branch = await this.sessionManager.readBranch(owner.identity.transcriptPath);
    if (branch === undefined) throw new Error("External session transcript is unavailable");
    return branch;
  }

  private async rejectExternal(ref: SessionRouteRef): Promise<void> {
    if (await this.resolveExternal(ref) !== undefined) {
      throw new Error("This session is owned by the original Herdr Pi and is read-only in PI WEB");
    }
  }

  private async resolveExternal(ref: SessionRouteRef): Promise<ExternalPermissionOwner | undefined> {
    const owner = await this.external.resolve(ref);
    if (owner === undefined) return undefined;
    const resolved = await this.sessionManager.resolveSessionFile(ref.cwd, ref.id);
    if (resolved === undefined || !await canonicalPathMatches(resolved.path, owner.identity.transcriptPath)) {
      throw new Error("External Pi owner identity conflicts with the persisted session");
    }
    return owner;
  }

  private async rejectCleanupWithExternalOwners(): Promise<void> {
    if (await this.external.hasAnyOwner()) {
      throw new Error("Session cleanup is unavailable while an original Herdr Pi owns a visible session");
    }
  }
}

async function canonicalPathMatches(left: string, right: string): Promise<boolean> {
  try {
    return await realpath(left) === await realpath(right);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
