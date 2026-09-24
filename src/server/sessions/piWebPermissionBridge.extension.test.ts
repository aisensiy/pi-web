import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionPresentationEvent, PermissionPresentationService } from "@gotgenes/pi-permission-system";
import { afterEach, describe, expect, it, vi } from "vitest";
import piWebPermissionBridge from "../../../extensions/pi-web-permission-bridge.js";

const PRESENTATION_SERVICES_KEY = Symbol.for("@gotgenes/pi-permission-system:permission-presentation-services");
const cleanup: (() => Promise<void>)[] = [];

function fakePi() {
  const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  return {
    pi: {
      events: createEventBus(),
      on: vi.fn((name: string, handler: (event?: unknown, ctx?: unknown) => unknown) => { handlers.set(name, handler); }),
    },
    handlers,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  Reflect.deleteProperty(globalThis, PRESENTATION_SERVICES_KEY);
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

describe("pi-web permission bridge activation", () => {
  it("does not identify an ordinary Pi process as Herdr-owned", () => {
    vi.stubEnv("HERDR_ENV", undefined);
    const { pi } = fakePi();

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- intentionally narrow ExtensionAPI test double
    piWebPermissionBridge(pi as unknown as ExtensionAPI);

    expect(pi.on).not.toHaveBeenCalled();
  });

  it("registers bridge lifecycle only inside a Herdr environment", () => {
    vi.stubEnv("HERDR_ENV", "1");
    const { pi } = fakePi();
    const eventOn = vi.spyOn(pi.events, "on");

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- intentionally narrow ExtensionAPI test double
    piWebPermissionBridge(pi as unknown as ExtensionAPI);

    expect(eventOn).toHaveBeenCalledWith("permissions:ready", expect.any(Function));
    expect(eventOn).toHaveBeenCalledWith("permissions:ui_prompt", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("serves snapshot and typed answers from the original session service", async () => {
    vi.stubEnv("HERDR_ENV", "1");
    const root = await mkdtemp(join(tmpdir(), "pi-web-bridge-extension-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const bridgeDir = join(root, "bridges");
    const cwd = join(root, "workspace");
    const transcriptPath = join(root, "session.jsonl");
    await mkdir(cwd);
    await writeFile(transcriptPath, "");
    vi.stubEnv("PI_WEB_PERMISSION_BRIDGE_DIR", bridgeDir);

    let presentationListener: ((event: PermissionPresentationEvent) => void) | undefined;
    const answer = vi.fn<PermissionPresentationService["answer"]>(() => ({ outcome: "accepted" }));
    const service: PermissionPresentationService = {
      snapshot: () => [{
        requestId: "request-1",
        incarnation: "presentation-1",
        title: "Permission Required",
        payload: {
          kind: "tool",
          request: {
            requester: { agentName: null, forwarded: false, sessionId: null },
            surface: "write",
            toolName: "write",
            invokedToolName: null,
            value: "/tmp/effect",
            matchedPattern: null,
            commandContext: null,
            executedUnit: null,
          },
          evidence: [],
          annotations: [],
        },
        choices: [{ id: "allow-token", label: "Yes", denialReason: "forbidden" }],
      }],
      subscribe: (listener) => { presentationListener = listener; return () => { presentationListener = undefined; }; },
      answer,
    };
    Reflect.set(globalThis, PRESENTATION_SERVICES_KEY, new Map([["session-1", service]]));

    const { pi, handlers } = fakePi();
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- intentionally narrow ExtensionAPI test double
    piWebPermissionBridge(pi as unknown as ExtensionAPI);
    const sessionStart = handlers.get("session_start");
    const sessionShutdown = handlers.get("session_shutdown");
    if (sessionStart === undefined || sessionShutdown === undefined) throw new Error("bridge lifecycle handlers missing");
    sessionStart({}, {
      cwd,
      sessionManager: {
        getSessionId: () => "session-1",
        getSessionFile: () => transcriptPath,
      },
      ui: { notify: vi.fn() },
    });

    const registryPath = await waitForRegistry(bridgeDir);
    const record = parseObject(await readFile(registryPath, "utf8"));
    const socketPath = requireString(record, "socketPath");
    expect(record["state"]).toBe("ready");
    const first = await request(socketPath, { type: "snapshot" });
    expect(first).toMatchObject({ ok: true, revision: 0, pending: [{ requestId: "request-1" }] });

    presentationListener?.({ type: "settled", requestId: "request-1", incarnation: "presentation-1", winner: "external" });
    const second = await request(socketPath, { type: "snapshot" });
    expect(second).toMatchObject({ ok: true, revision: 1 });
    expect(await request(socketPath, { type: "answer", answer: { requestId: "request-1", incarnation: "presentation-1", choiceId: "allow-token" } })).toEqual({ ok: true, result: { outcome: "accepted" } });
    expect(answer).toHaveBeenCalledWith({ requestId: "request-1", incarnation: "presentation-1", choiceId: "allow-token" });

    await sessionShutdown();
    const gone = parseObject(await readFile(registryPath, "utf8"));
    expect(gone["state"]).toBe("gone");
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("shuts down while a web client connection is still open", async () => {
    vi.stubEnv("HERDR_ENV", "1");
    const root = await mkdtemp(join(tmpdir(), "pi-web-bridge-extension-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const bridgeDir = join(root, "bridges");
    const cwd = join(root, "workspace");
    const transcriptPath = join(root, "session.jsonl");
    await mkdir(cwd);
    await writeFile(transcriptPath, "");
    vi.stubEnv("PI_WEB_PERMISSION_BRIDGE_DIR", bridgeDir);

    let presentationListener: ((event: PermissionPresentationEvent) => void) | undefined;
    const service: PermissionPresentationService = {
      snapshot: () => [],
      subscribe: (listener) => { presentationListener = listener; return () => { presentationListener = undefined; }; },
      answer: () => ({ outcome: "accepted" }),
    };
    Reflect.set(globalThis, PRESENTATION_SERVICES_KEY, new Map([["session-1", service]]));

    const { pi, handlers } = fakePi();
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- intentionally narrow ExtensionAPI test double
    piWebPermissionBridge(pi as unknown as ExtensionAPI);
    const sessionStart = handlers.get("session_start");
    const sessionShutdown = handlers.get("session_shutdown");
    if (sessionStart === undefined || sessionShutdown === undefined) throw new Error("bridge lifecycle handlers missing");
    sessionStart({}, {
      cwd,
      sessionManager: {
        getSessionId: () => "session-1",
        getSessionFile: () => transcriptPath,
      },
      ui: { notify: vi.fn() },
    });

    const registryPath = await waitForRegistry(bridgeDir);
    const record = parseObject(await readFile(registryPath, "utf8"));
    const socketPath = requireString(record, "socketPath");
    expect(presentationListener).toBeTypeOf("function");

    // The web poller holds a connection per poll; simulate an in-flight poll
    // that has not closed its half when Pi quits. Teardown must still finish.
    const held = createConnection(socketPath);
    cleanup.push(() => {
      held.destroy();
      return Promise.resolve();
    });
    await once(held, "connect");

    await sessionShutdown();
    const gone = parseObject(await readFile(registryPath, "utf8"));
    expect(gone["state"]).toBe("gone");
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("activates before the transcript exists by canonicalizing the parent directory", async () => {
    vi.stubEnv("HERDR_ENV", "1");
    const root = await mkdtemp(join(tmpdir(), "pi-web-bridge-extension-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const bridgeDir = join(root, "bridges");
    const cwd = join(root, "workspace");
    const transcriptPath = join(root, "session.jsonl");
    await mkdir(cwd);
    // Pi creates the transcript on the first persisted entry, so it is absent
    // at session start; the bridge must still activate without warning.
    vi.stubEnv("PI_WEB_PERMISSION_BRIDGE_DIR", bridgeDir);

    let presentationListener: ((event: PermissionPresentationEvent) => void) | undefined;
    const service: PermissionPresentationService = {
      snapshot: () => [],
      subscribe: (listener) => { presentationListener = listener; return () => { presentationListener = undefined; }; },
      answer: () => ({ outcome: "accepted" }),
    };
    Reflect.set(globalThis, PRESENTATION_SERVICES_KEY, new Map([["session-1", service]]));

    const { pi, handlers } = fakePi();
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- intentionally narrow ExtensionAPI test double
    piWebPermissionBridge(pi as unknown as ExtensionAPI);
    const sessionStart = handlers.get("session_start");
    if (sessionStart === undefined) throw new Error("bridge lifecycle handlers missing");
    const notify = vi.fn();
    sessionStart({}, {
      cwd,
      sessionManager: {
        getSessionId: () => "session-1",
        getSessionFile: () => transcriptPath,
      },
      ui: { notify },
    });

    const registryPath = await waitForRegistry(bridgeDir);
    const record = parseObject(await readFile(registryPath, "utf8"));
    expect(record["state"]).toBe("ready");
    expect(record["transcriptPath"]).toBe(join(await realpath(root), "session.jsonl"));
    expect(presentationListener).toBeTypeOf("function");
    expect(notify).not.toHaveBeenCalled();
  });
});

async function waitForRegistry(directory: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const name = (await readdir(directory)).find((candidate) => candidate.endsWith(".json"));
      if (name !== undefined) return join(directory, name);
    } catch {
      // The async activation has not created its private directory yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("bridge registry was not created");
}

function request(socketPath: string, message: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let response = "";
    socket.on("connect", () => { socket.write(`${JSON.stringify(message)}\n`); });
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(parseObject(response));
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text.trim());
  if (!isRecord(value)) throw new Error("expected object JSON");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`expected string field: ${key}`);
  return value;
}
