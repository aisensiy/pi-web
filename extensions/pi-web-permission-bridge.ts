import { createServer, type Server, type Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  PendingPermissionPresentation,
  PermissionPresentationAnswer,
  PermissionPresentationAnswerResult,
  PermissionPresentationService,
  PermissionsReadyEvent,
} from "@gotgenes/pi-permission-system";

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 64 * 1024;

type PermissionApi = typeof import("@gotgenes/pi-permission-system");

interface BridgeIdentity {
  protocolVersion: typeof PROTOCOL_VERSION;
  machineId: "local";
  source: "herdr";
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

type BridgeRequest =
  | { type: "snapshot" }
  | { type: "answer"; answer: PermissionPresentationAnswer };

type BridgeResponse =
  | { ok: true; identity: BridgeIdentity; revision: number; pending: readonly PendingPermissionPresentation[] }
  | { ok: true; result: PermissionPresentationAnswerResult }
  | { ok: false; error: string };

interface ActiveBridge {
  identity: BridgeIdentity;
  registryPath: string;
  socketPath: string;
  server: Server;
  unsubscribe: () => void;
  service: PermissionPresentationService;
  revision: number;
}

/**
 * Publish the current Pi session's permission-presentation service over a
 * same-user Unix socket. PI WEB discovers sockets only through owner-written
 * registry records; browser input never selects an endpoint.
 */
export default function piWebPermissionBridge(pi: ExtensionAPI): void {
  if (process.env["HERDR_ENV"] !== "1") return;
  let context: ExtensionContext | undefined;
  let active: ActiveBridge | undefined;
  let activation: Promise<void> = Promise.resolve();
  let permissionApi: PermissionApi | undefined;

  const activate = (nextContext: ExtensionContext): void => {
    context = nextContext;
    activation = activation.then(async () => {
      await closeActive("gone");
      permissionApi ??= await loadPermissionApi();
      if (permissionApi === undefined) return;
      const sessionId = nextContext.sessionManager.getSessionId();
      const transcriptPath = nextContext.sessionManager.getSessionFile();
      if (transcriptPath === undefined) return;
      const service = permissionApi.getPermissionPresentationService(sessionId);
      if (service === undefined) return;
      active = await openBridge(nextContext, sessionId, transcriptPath, service);
    }).catch((error: unknown) => {
      nextContext.ui.notify(`PI WEB permission bridge unavailable: ${errorMessage(error)}`, "warning");
    });
  };

  const retryActivation = (event: unknown): void => {
    if (!isPermissionsReadyEvent(event) || event.sessionId === null || context === undefined) return;
    if (event.sessionId !== context.sessionManager.getSessionId() || active?.identity.sessionId === event.sessionId) return;
    activate(context);
  };

  const unsubscribeReady = pi.events.on("permissions:ready", retryActivation);
  // A prompt broadcast happens after the service is published and after the
  // transcript normally exists. It closes the load-order/file-creation gap.
  const unsubscribePrompt = pi.events.on("permissions:ui_prompt", () => {
    if (context !== undefined && active === undefined) activate(context);
  });
  pi.on("session_start", (_event, nextContext) => { activate(nextContext); });
  pi.on("session_shutdown", async () => {
    context = undefined;
    unsubscribeReady();
    unsubscribePrompt();
    activation = activation.then(() => closeActive("gone"));
    await activation;
  });

  async function closeActive(state: "gone"): Promise<void> {
    const bridge = active;
    active = undefined;
    if (bridge === undefined) return;
    bridge.unsubscribe();
    await writeRegistry(bridge.registryPath, { ...bridge.identity, socketPath: bridge.socketPath, state, updatedAt: new Date().toISOString() });
    await new Promise<void>((resolve) => { bridge.server.close(() => { resolve(); }); });
    await rm(bridge.socketPath, { force: true });
  }
}

async function loadPermissionApi(): Promise<PermissionApi | undefined> {
  try {
    return await import("@gotgenes/pi-permission-system");
  } catch (error: unknown) {
    if (isMissingPackageError(error)) return undefined;
    throw error;
  }
}

async function openBridge(
  context: ExtensionContext,
  sessionId: string,
  sessionFile: string,
  service: PermissionPresentationService,
): Promise<ActiveBridge> {
  const directory = bridgeDirectory(process.env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const endpointNonce = randomUUID();
  const socketPath = join(directory, `${String(process.pid)}-${endpointNonce.slice(0, 8)}.sock`);
  const sessionKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  const registryPath = join(directory, `${sessionKey}-${String(process.pid)}-${endpointNonce.slice(0, 8)}.json`);
  const identity: BridgeIdentity = Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    machineId: "local",
    source: "herdr",
    sessionId,
    cwd: await canonicalPath(context.cwd),
    transcriptPath: await canonicalPath(sessionFile),
    pid: process.pid,
    processIncarnation: await processIncarnation(endpointNonce),
    endpointNonce,
  });
  let revision = 0;
  const server = createServer((socket) => {
    handleSocket(socket, identity, service, () => revision);
  });
  await rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  const record: BridgeRegistryRecord = { ...identity, socketPath, state: "ready", updatedAt: new Date().toISOString() };
  await writeRegistry(registryPath, record);
  const unsubscribe = service.subscribe(() => { revision += 1; });
  return { identity, registryPath, socketPath, server, unsubscribe, service, revision };
}

function handleSocket(
  socket: Socket,
  identity: BridgeIdentity,
  service: PermissionPresentationService,
  revision: () => number,
): void {
  socket.setEncoding("utf8");
  let input = "";
  socket.on("data", (chunk: string) => {
    input += chunk;
    if (input.length > MAX_REQUEST_BYTES) {
      sendResponse(socket, { ok: false, error: "request too large" });
      return;
    }
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const line = input.slice(0, newline);
    input = "";
    try {
      const parsed: unknown = JSON.parse(line);
      const request = parseRequest(parsed);
      if (request.type === "snapshot") {
        sendResponse(socket, { ok: true, identity, revision: revision(), pending: service.snapshot() });
        return;
      }
      sendResponse(socket, { ok: true, result: service.answer(request.answer) });
    } catch (error: unknown) {
      sendResponse(socket, { ok: false, error: errorMessage(error) });
    }
  });
  socket.on("error", () => { socket.destroy(); });
}

function parseRequest(value: unknown): BridgeRequest {
  if (!isRecord(value)) throw new Error("invalid request");
  if (value["type"] === "snapshot") return { type: "snapshot" };
  if (value["type"] !== "answer" || !isRecord(value["answer"])) throw new Error("invalid request");
  const answer = value["answer"];
  return {
    type: "answer",
    answer: {
      requestId: requireString(answer, "requestId"),
      incarnation: requireString(answer, "incarnation"),
      choiceId: requireString(answer, "choiceId"),
      ...(typeof answer["denialReason"] === "string" ? { denialReason: answer["denialReason"] } : {}),
    },
  };
}

function sendResponse(socket: Socket, response: BridgeResponse): void {
  if (socket.destroyed) return;
  socket.end(`${JSON.stringify(response)}\n`);
}

async function writeRegistry(path: string, record: BridgeRegistryRecord): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function processIncarnation(fallbackNonce: string): Promise<string> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile("/proc/self/stat", "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
      const startTime = fields[19];
      if (startTime !== undefined) return `linux:${String(process.pid)}:${startTime}`;
    } catch {
      // Fall through to an unguessable generation on platforms without procfs.
    }
  }
  return `process:${String(process.pid)}:${fallbackNonce}`;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error: unknown) {
    if (!isEnoentError(error)) throw error;
    // The transcript is created on the first persisted entry, so the leaf can
    // still be missing at session start; canonicalize the parent instead.
    return join(await realpath(dirname(path)), basename(path));
  }
}

function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function bridgeDirectory(env: Readonly<NodeJS.ProcessEnv>): string {
  const configured = env["PI_WEB_PERMISSION_BRIDGE_DIR"];
  if (configured !== undefined && configured !== "") return configured;
  const runtime = env["XDG_RUNTIME_DIR"];
  if (runtime !== undefined && runtime !== "") return join(runtime, "pi-web", "permission-bridges");
  return join(tmpdir(), `pi-web-${String(process.getuid?.() ?? 0)}`, "permission-bridges");
}

function isPermissionsReadyEvent(value: unknown): value is PermissionsReadyEvent {
  return isRecord(value) && (typeof value["sessionId"] === "string" || value["sessionId"] === null);
}

function isMissingPackageError(error: unknown): boolean {
  return error instanceof Error && (error.message.includes("Cannot find package") || error.message.includes("Cannot find module"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") throw new Error(`invalid ${key}`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
