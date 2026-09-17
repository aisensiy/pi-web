import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionDialogAnswer,
  ExtensionDialogChoiceAnswer,
  ExternalSessionOwner,
  PendingExtensionDialog,
  SessionStatus,
} from "../../shared/apiTypes.js";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import type { SessionRouteRef } from "./sessionService.js";

const PROTOCOL_VERSION = 1;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROMPT_TEXT = 12 * 1024;

interface BridgeIdentity {
  protocolVersion: number;
  machineId: string;
  source: string;
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  pid: number;
  processIncarnation: string;
  endpointNonce: string;
}

interface BridgeRegistryRecord extends BridgeIdentity {
  socketPath: string;
  state: "ready" | "gone";
  updatedAt: string;
}

interface PermissionChoice {
  id: string;
  label: string;
  denialReason: "forbidden" | "required";
}

interface PermissionPresentation {
  requestId: string;
  incarnation: string;
  title: string;
  payload: unknown;
  choices: readonly PermissionChoice[];
}

interface BridgeSnapshot {
  identity: BridgeIdentity;
  revision: number;
  pending: readonly PermissionPresentation[];
}

type BridgeAnswerResult =
  | { outcome: "accepted" }
  | { outcome: "stale" }
  | { outcome: "invalid"; reason: string };

class ExternalOwnerGoneError extends Error {}

export interface ExternalPermissionOwner {
  identity: BridgeIdentity;
  owner: ExternalSessionOwner;
  socketPath: string | undefined;
  dialogs: readonly PendingExtensionDialog[];
  revision: number;
}

export interface ExternalPermissionBridgeRegistryOptions {
  directory: string;
  events: SessionEventHub;
  pollIntervalMs?: number;
  now?: () => Date;
  uid?: number;
}

/**
 * Trusted local registry for permission bridges owned by existing Pi
 * processes. Registry/socket ownership and canonical identity are validated
 * before a record can route any browser request.
 */
export class ExternalPermissionBridgeRegistry {
  private readonly owners = new Map<string, ExternalPermissionOwner>();
  private readonly firstSeenAt = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | undefined;

  constructor(private readonly options: ExternalPermissionBridgeRegistryOptions) {}

  async start(): Promise<void> {
    await this.refresh();
    const interval = this.options.pollIntervalMs ?? 300;
    this.timer = setInterval(() => { void this.refresh(); }, interval);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.refreshing;
  }

  async hasAnyOwner(): Promise<boolean> {
    await this.refresh();
    return this.owners.size > 0;
  }

  async listForCwd(cwd: string): Promise<readonly ExternalPermissionOwner[]> {
    await this.refresh();
    const canonicalCwd = await canonicalPath(cwd);
    return [...this.owners.values()].filter((owner) => owner.identity.cwd === canonicalCwd);
  }

  async resolve(ref: SessionRouteRef): Promise<ExternalPermissionOwner | undefined> {
    await this.refresh();
    const canonicalCwd = await canonicalPath(ref.cwd);
    return this.owners.get(ownerKey(canonicalCwd, ref.id));
  }

  status(owner: ExternalPermissionOwner): SessionStatus {
    return {
      sessionId: owner.identity.sessionId,
      persisted: true,
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      pendingDialogs: [...owner.dialogs],
    };
  }

  async answer(
    owner: ExternalPermissionOwner,
    dialogId: string,
    value: ExtensionDialogAnswer,
  ): Promise<{ result: BridgeAnswerResult; answerLabel?: string }> {
    if (owner.owner.state !== "ready" || owner.socketPath === undefined) throw new Error("Original Pi permission owner is unavailable");
    const answer = externalChoiceAnswer(value);
    const dialog = owner.dialogs.find((candidate) => candidate.dialogId === dialogId);
    if (dialog === undefined) return { result: { outcome: "stale" } };
    const optionIndex = dialog.optionValues?.indexOf(answer.choiceId) ?? -1;
    if (optionIndex < 0) throw new Error("External permission choice is invalid");
    const reasonRequirement = dialog.optionDenialReasons?.[optionIndex] ?? "forbidden";
    if (reasonRequirement === "required" && (answer.denialReason?.trim() ?? "") === "") {
      throw new Error("External permission denial reason is required");
    }
    if (reasonRequirement === "forbidden" && answer.denialReason !== undefined) {
      throw new Error("External permission denial reason is not accepted for this choice");
    }
    const presentation = ownerPresentations(owner).find((candidate) => permissionDialogId(candidate) === dialogId);
    if (presentation === undefined) return { result: { outcome: "stale" } };
    const result = await requestBridge(owner.socketPath, {
      type: "answer",
      answer: {
        requestId: presentation.requestId,
        incarnation: presentation.incarnation,
        choiceId: answer.choiceId,
        ...(answer.denialReason === undefined ? {} : { denialReason: answer.denialReason }),
      },
    });
    if (!isAnswerResponse(result)) throw new Error("Invalid external permission answer response");
    await this.refresh();
    const answerLabel = dialog.options?.[optionIndex];
    return { result: result.result, ...(answerLabel === undefined ? {} : { answerLabel }) };
  }

  private refresh(): Promise<void> {
    if (this.refreshing !== undefined) return this.refreshing;
    this.refreshing = this.refreshNow().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async refreshNow(): Promise<void> {
    const records = await readRegistryRecords(this.options.directory, this.options.uid ?? process.getuid?.());
    const grouped = groupRecords(records);
    const next = new Map<string, ExternalPermissionOwner>();
    for (const [key, candidates] of grouped) {
      next.set(key, await this.resolveCandidates(candidates, this.owners.get(key)));
    }
    for (const [key, previous] of this.owners) {
      if (!next.has(key)) next.set(key, retainUnavailableOwner(previous));
    }
    this.publishChanges(this.owners, next);
    this.owners.clear();
    for (const [key, owner] of next) this.owners.set(key, owner);
  }

  private async resolveCandidates(
    records: readonly BridgeRegistryRecord[],
    previous: ExternalPermissionOwner | undefined,
  ): Promise<ExternalPermissionOwner> {
    const fallback = records[0];
    if (fallback === undefined) throw new Error("Permission owner group is empty");
    const ready = records.filter((record) => record.state === "ready");
    if (ready.length > 1) return unavailableOwner(fallback, "conflict");
    if (ready.length === 0) return unavailableOwner(fallback, "gone");
    const record = ready[0];
    if (record === undefined) throw new Error("Permission owner group has no ready record");
    try {
      await validateProcessIncarnation(record);
      await validateSocket(record.socketPath, this.options.uid ?? process.getuid?.());
      const response = await requestBridge(record.socketPath, { type: "snapshot" });
      if (!isSnapshotResponse(response)) throw new Error("Invalid external permission snapshot response");
      const snapshot = parseSnapshot(response);
      assertIdentityMatches(record, snapshot.identity);
      const presentations = snapshot.pending.map(parsePresentation);
      const dialogs = presentations.map((presentation) => this.projectDialog(presentation));
      const owner: ExternalPermissionOwner = {
        identity: record,
        owner: { kind: "external-pi", source: "herdr", state: "ready", incarnation: record.processIncarnation },
        socketPath: record.socketPath,
        dialogs,
        revision: snapshot.revision,
      };
      presentationByOwner.set(owner, presentations);
      return owner;
    } catch (error: unknown) {
      if (error instanceof ExternalOwnerGoneError) return unavailableOwner(record, "gone");
      return unavailableOwner(record, "unavailable", previous);
    }
  }

  private projectDialog(presentation: PermissionPresentation): PendingExtensionDialog {
    const dialogId = permissionDialogId(presentation);
    const askedAt = this.firstSeenAt.get(dialogId) ?? this.options.now?.().toISOString() ?? new Date().toISOString();
    this.firstSeenAt.set(dialogId, askedAt);
    const choices = presentation.choices;
    return {
      dialogId,
      kind: "select",
      title: presentation.title,
      message: promptSummary(presentation.payload),
      options: choices.map((choice) => choice.label),
      optionValues: choices.map((choice) => choice.id),
      optionDenialReasons: choices.map((choice) => choice.denialReason),
      cancellable: false,
      askedAt,
      runScoped: true,
    };
  }

  private publishChanges(
    previous: ReadonlyMap<string, ExternalPermissionOwner>,
    next: ReadonlyMap<string, ExternalPermissionOwner>,
  ): void {
    for (const [key, owner] of next) {
      const prior = previous.get(key);
      const priorDialogs = new Map((prior?.dialogs ?? []).map((dialog) => [dialog.dialogId, dialog]));
      const nextDialogs = new Map(owner.dialogs.map((dialog) => [dialog.dialogId, dialog]));
      for (const dialog of owner.dialogs) {
        if (!priorDialogs.has(dialog.dialogId)) this.options.events.publish(owner.identity.sessionId, { type: "dialog.opened", dialog });
      }
      for (const dialog of prior?.dialogs ?? []) {
        if (!nextDialogs.has(dialog.dialogId)) {
          const reason = owner.owner.state === "ready" ? "peer-answered" : "session-ended";
          this.options.events.publish(owner.identity.sessionId, { type: "dialog.closed", dialogId: dialog.dialogId, reason });
          this.firstSeenAt.delete(dialog.dialogId);
        }
      }
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(owner)) {
        this.options.events.publish(owner.identity.sessionId, { type: "status.update", status: this.status(owner) });
      }
    }
  }
}

const presentationByOwner = new WeakMap<ExternalPermissionOwner, readonly PermissionPresentation[]>();

function ownerPresentations(owner: ExternalPermissionOwner): readonly PermissionPresentation[] {
  return presentationByOwner.get(owner) ?? [];
}

function unavailableOwner(
  record: BridgeRegistryRecord,
  state: "unavailable" | "gone" | "conflict",
  previous?: ExternalPermissionOwner,
): ExternalPermissionOwner {
  const retainsPending = state === "unavailable"
    && previous !== undefined
    && sameOwnerIncarnation(previous.identity, record);
  const owner: ExternalPermissionOwner = {
    identity: record,
    owner: { kind: "external-pi", source: "herdr", state, incarnation: record.processIncarnation },
    socketPath: undefined,
    dialogs: retainsPending ? previous.dialogs : [],
    revision: retainsPending ? previous.revision : 0,
  };
  if (retainsPending) {
    presentationByOwner.set(owner, ownerPresentations(previous));
  }
  return owner;
}

function retainUnavailableOwner(previous: ExternalPermissionOwner): ExternalPermissionOwner {
  const owner: ExternalPermissionOwner = {
    ...previous,
    owner: { ...previous.owner, state: "unavailable" },
    socketPath: undefined,
  };
  presentationByOwner.set(owner, ownerPresentations(previous));
  return owner;
}

function sameOwnerIncarnation(left: BridgeIdentity, right: BridgeIdentity): boolean {
  return left.machineId === right.machineId
    && left.source === right.source
    && left.sessionId === right.sessionId
    && left.cwd === right.cwd
    && left.transcriptPath === right.transcriptPath
    && left.pid === right.pid
    && left.processIncarnation === right.processIncarnation
    && left.endpointNonce === right.endpointNonce;
}

function groupRecords(records: readonly BridgeRegistryRecord[]): Map<string, BridgeRegistryRecord[]> {
  const grouped = new Map<string, BridgeRegistryRecord[]>();
  for (const record of records) {
    const key = ownerKey(record.cwd, record.sessionId);
    const values = grouped.get(key) ?? [];
    values.push(record);
    grouped.set(key, values);
  }
  return grouped;
}

async function readRegistryRecords(directory: string, uid: number | undefined): Promise<BridgeRegistryRecord[]> {
  let names: string[];
  try {
    const directoryMetadata = await stat(directory);
    if (!directoryMetadata.isDirectory()) throw new Error("Permission bridge registry is not a directory");
    assertPrivateOwner(directoryMetadata.uid, directoryMetadata.mode, uid, "permission bridge registry");
    names = await readdir(directory);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const records: BridgeRegistryRecord[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    const path = join(directory, name);
    try {
      const metadata = await lstat(path);
      assertPrivateOwner(metadata.uid, metadata.mode, uid, "registry record");
      const text = await readFile(path, "utf8");
      records.push(await parseRegistryRecord(JSON.parse(text)));
    } catch {
      // Malformed, foreign, or concurrently replaced records are ignored.
    }
  }
  return records;
}

async function parseRegistryRecord(value: unknown): Promise<BridgeRegistryRecord> {
  if (!isRecord(value)) throw new Error("Invalid permission bridge record");
  const state = value["state"];
  if (state !== "ready" && state !== "gone") throw new Error("Invalid permission bridge state");
  const record: BridgeRegistryRecord = {
    protocolVersion: requireNumber(value, "protocolVersion"),
    machineId: requireString(value, "machineId"),
    source: requireString(value, "source"),
    sessionId: requireString(value, "sessionId"),
    cwd: await canonicalPath(requireString(value, "cwd")),
    transcriptPath: await canonicalPath(requireString(value, "transcriptPath")),
    pid: requireNumber(value, "pid"),
    processIncarnation: requireString(value, "processIncarnation"),
    endpointNonce: requireString(value, "endpointNonce"),
    socketPath: requireString(value, "socketPath"),
    state,
    updatedAt: requireString(value, "updatedAt"),
  };
  if (record.protocolVersion !== PROTOCOL_VERSION || record.machineId !== "local" || record.source !== "herdr") {
    throw new Error("Unsupported permission bridge identity");
  }
  return record;
}

function parseSnapshot(response: Record<string, unknown>): BridgeSnapshot {
  const identity = parseIdentity(response["identity"]);
  const revision = requireNumber(response, "revision");
  const pending = response["pending"];
  if (!Array.isArray(pending)) throw new Error("Invalid bridge pending snapshot");
  return { identity, revision, pending: pending.map(parsePresentation) };
}

function parseIdentity(value: unknown): BridgeIdentity {
  if (!isRecord(value)) throw new Error("Invalid bridge identity");
  return {
    protocolVersion: requireNumber(value, "protocolVersion"),
    machineId: requireString(value, "machineId"),
    source: requireString(value, "source"),
    sessionId: requireString(value, "sessionId"),
    cwd: requireString(value, "cwd"),
    transcriptPath: requireString(value, "transcriptPath"),
    pid: requireNumber(value, "pid"),
    processIncarnation: requireString(value, "processIncarnation"),
    endpointNonce: requireString(value, "endpointNonce"),
  };
}

function parsePresentation(value: unknown): PermissionPresentation {
  if (!isRecord(value) || !Array.isArray(value["choices"])) throw new Error("Invalid permission presentation");
  return {
    requestId: requireString(value, "requestId"),
    incarnation: requireString(value, "incarnation"),
    title: requireString(value, "title"),
    payload: value["payload"],
    choices: value["choices"].map(parseChoice),
  };
}

function parseChoice(value: unknown): PermissionChoice {
  if (!isRecord(value)) throw new Error("Invalid permission choice");
  const denialReason = value["denialReason"];
  if (denialReason !== "forbidden" && denialReason !== "required") throw new Error("Invalid permission choice denial contract");
  return { id: requireString(value, "id"), label: requireString(value, "label"), denialReason };
}

function assertIdentityMatches(record: BridgeRegistryRecord, identity: BridgeIdentity): void {
  for (const key of ["protocolVersion", "machineId", "source", "sessionId", "cwd", "transcriptPath", "pid", "processIncarnation", "endpointNonce"] as const) {
    if (record[key] !== identity[key]) throw new Error(`Permission bridge identity mismatch: ${key}`);
  }
}

async function validateProcessIncarnation(record: BridgeRegistryRecord): Promise<void> {
  if (!record.processIncarnation.startsWith("linux:")) return;
  let statText: string;
  try {
    statText = await readFile(`/proc/${String(record.pid)}/stat`, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ESRCH")) {
      throw new ExternalOwnerGoneError("Permission bridge process exited");
    }
    throw error;
  }
  const fields = statText.slice(statText.lastIndexOf(")") + 2).trim().split(/\s+/u);
  const startTime = fields[19];
  if (startTime === undefined || record.processIncarnation !== `linux:${String(record.pid)}:${startTime}`) {
    throw new ExternalOwnerGoneError("Permission bridge process incarnation is stale");
  }
}

async function validateSocket(path: string, uid: number | undefined): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isSocket()) throw new Error("Permission bridge endpoint is not a socket");
  assertPrivateOwner(metadata.uid, metadata.mode, uid, "permission bridge socket");
}

function assertPrivateOwner(actualUid: number, mode: number, expectedUid: number | undefined, label: string): void {
  if (expectedUid !== undefined && actualUid !== expectedUid) throw new Error(`${label} has a foreign owner`);
  if ((mode & 0o077) !== 0) throw new Error(`${label} is not private`);
}

function requestBridge(path: string, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setEncoding("utf8");
    let response = "";
    socket.setTimeout(2_000, () => { socket.destroy(new Error("Permission bridge timed out")); });
    socket.on("connect", () => { socket.write(`${JSON.stringify(request)}\n`); });
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > MAX_RESPONSE_BYTES) socket.destroy(new Error("Permission bridge response too large"));
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(response.trim());
        if (!isRecord(parsed) || parsed["ok"] !== true) {
          const message = isRecord(parsed) && typeof parsed["error"] === "string" ? parsed["error"] : "Permission bridge failed";
          throw new Error(message);
        }
        resolve(parsed);
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function isSnapshotResponse(value: Record<string, unknown>): boolean {
  return value["identity"] !== undefined && value["pending"] !== undefined;
}

function isAnswerResponse(value: Record<string, unknown>): value is Record<string, unknown> & { result: BridgeAnswerResult } {
  const result = value["result"];
  return isRecord(result) && (result["outcome"] === "accepted" || result["outcome"] === "stale" || result["outcome"] === "invalid");
}

function permissionDialogId(presentation: PermissionPresentation): string {
  const digest = createHash("sha256").update(`${presentation.requestId}\0${presentation.incarnation}`).digest("hex").slice(0, 32);
  return `permission-${digest}`;
}

function promptSummary(payload: unknown): string {
  if (isRecord(payload) && isRecord(payload["request"])) {
    const request = payload["request"];
    const surface = typeof request["surface"] === "string" ? request["surface"] : "permission";
    const toolName = typeof request["toolName"] === "string" ? request["toolName"] : surface;
    const value = typeof request["value"] === "string" ? request["value"] : "";
    const summary = value === "" ? toolName : `${toolName}: ${value}`;
    return summary.length <= MAX_PROMPT_TEXT ? summary : `${summary.slice(0, MAX_PROMPT_TEXT)}…`;
  }
  return "Review this permission request in the original Pi session.";
}

function ownerKey(cwd: string, sessionId: string): string {
  return JSON.stringify([cwd, sessionId]);
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(path);
}

export function externalPermissionBridgeDirectory(env: Readonly<NodeJS.ProcessEnv>): string {
  const configured = env["PI_WEB_PERMISSION_BRIDGE_DIR"];
  if (configured !== undefined && configured !== "") return configured;
  const runtime = env["XDG_RUNTIME_DIR"];
  if (runtime !== undefined && runtime !== "") return join(runtime, "pi-web", "permission-bridges");
  return join(tmpdir(), `pi-web-${String(process.getuid?.() ?? 0)}`, "permission-bridges");
}

function externalChoiceAnswer(value: ExtensionDialogAnswer): ExtensionDialogChoiceAnswer {
  if (typeof value === "string") return { choiceId: value };
  if (typeof value === "object") return value;
  throw new Error("External permission answers require an opaque choice id");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") throw new Error(`Invalid ${key}`);
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${key}`);
  return value;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
