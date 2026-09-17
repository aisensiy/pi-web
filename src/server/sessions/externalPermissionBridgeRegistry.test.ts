import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapturingSessionEventHub } from "./piSessionService.testSupport.js";
import { ExternalPermissionBridgeRegistry } from "./externalPermissionBridgeRegistry.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-permission-registry-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const registryDir = join(root, "registry");
  const cwd = join(root, "workspace");
  const transcriptPath = join(root, "session.jsonl");
  await mkdir(registryDir, { mode: 0o700 });
  await mkdir(cwd);
  await writeFile(transcriptPath, "");
  const socketPath = join(root, "bridge.sock");
  let identity = {
    protocolVersion: 1,
    machineId: "local",
    source: "herdr",
    sessionId: "session-1",
    cwd: await realpath(cwd),
    transcriptPath: await realpath(transcriptPath),
    pid: process.pid,
    processIncarnation: `test:${String(process.pid)}:10`,
    endpointNonce: "nonce",
  };
  let pending = [presentation()];
  let snapshotFailure = false;
  const answers: unknown[] = [];
  const server = createServer((socket) => {
    readRequest(socket, (request) => {
      if (isRecord(request) && request["type"] === "snapshot") {
        socket.end(`${JSON.stringify(snapshotFailure
          ? { ok: false, error: "temporary snapshot failure" }
          : { ok: true, identity, revision: answers.length, pending })}\n`);
        return;
      }
      if (isRecord(request) && request["type"] === "answer") {
        answers.push(request["answer"]);
        pending = [];
        socket.end(`${JSON.stringify({ ok: true, result: { outcome: "accepted" } })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ ok: false, error: "bad request" })}\n`);
    });
  });
  await listen(server, socketPath);
  await chmod(socketPath, 0o600);
  cleanup.push(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  });
  const record = { ...identity, socketPath, state: "ready", updatedAt: "2026-09-17T00:00:00.000Z" };
  const recordPath = join(registryDir, "owner.json");
  await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
  const events = new CapturingSessionEventHub();
  const registry = new ExternalPermissionBridgeRegistry({ directory: registryDir, events, pollIntervalMs: 60_000 });
  cleanup.push(() => registry.stop());
  return {
    registry,
    events,
    cwd: identity.cwd,
    record,
    recordPath,
    registryDir,
    socketPath,
    answers,
    setPending: (value: typeof pending) => { pending = value; },
    setSnapshotFailure: (value: boolean) => { snapshotFailure = value; },
    setIdentity: (value: typeof identity) => { identity = value; },
  };
}

function presentation() {
  return {
    requestId: "request-1",
    incarnation: "presentation-1",
    title: "Permission Required",
    payload: { kind: "tool", request: { surface: "write", value: "/tmp/effect" } },
    choices: [
      { id: "allow-token", label: "Yes", denialReason: "forbidden" },
      { id: "reason-token", label: "No, provide reason", denialReason: "required" },
      { id: "deny-token", label: "No", denialReason: "forbidden" },
    ],
  };
}

describe("ExternalPermissionBridgeRegistry", () => {
  it("validates a private owner bridge and projects every opaque typed choice", async () => {
    const { registry, cwd } = await fixture();

    const owners = await registry.listForCwd(cwd);

    expect(owners).toHaveLength(1);
    expect(owners[0]?.owner.state).toBe("ready");
    expect(owners[0]?.dialogs).toEqual([
      expect.objectContaining({
        kind: "select",
        message: "write: /tmp/effect",
        options: ["Yes", "No, provide reason", "No"],
        optionValues: ["allow-token", "reason-token", "deny-token"],
        optionDenialReasons: ["forbidden", "required", "forbidden"],
        cancellable: false,
      }),
    ]);
  });

  it("returns accepted only after the original bridge accepts the opaque choice", async () => {
    const { registry, cwd, answers } = await fixture();
    const owner = (await registry.listForCwd(cwd))[0];
    if (owner === undefined) throw new Error("owner missing");
    const dialog = owner.dialogs[0];
    if (dialog === undefined) throw new Error("dialog missing");

    const result = await registry.answer(owner, dialog.dialogId, "allow-token");

    expect(result).toEqual({ result: { outcome: "accepted" }, answerLabel: "Yes" });
    expect(answers).toEqual([{ requestId: "request-1", incarnation: "presentation-1", choiceId: "allow-token" }]);
  });

  it("passes a required denial reason as typed authority input", async () => {
    const { registry, cwd, answers } = await fixture();
    const owner = (await registry.listForCwd(cwd))[0];
    if (owner === undefined) throw new Error("owner missing");
    const dialog = owner.dialogs[0];
    if (dialog === undefined) throw new Error("dialog missing");

    const result = await registry.answer(owner, dialog.dialogId, {
      choiceId: "reason-token",
      denialReason: "unsafe path",
    });

    expect(result).toEqual({ result: { outcome: "accepted" }, answerLabel: "No, provide reason" });
    expect(answers).toEqual([{ requestId: "request-1", incarnation: "presentation-1", choiceId: "reason-token", denialReason: "unsafe path" }]);
  });

  it("rejects a reason-required choice without a reason before transport", async () => {
    const { registry, cwd, answers } = await fixture();
    const owner = (await registry.listForCwd(cwd))[0];
    if (owner === undefined) throw new Error("owner missing");
    const dialog = owner.dialogs[0];
    if (dialog === undefined) throw new Error("dialog missing");

    await expect(registry.answer(owner, dialog.dialogId, "reason-token")).rejects.toThrow("reason is required");
    expect(answers).toEqual([]);
  });

  it("publishes peer withdrawal when the native presenter wins", async () => {
    const { registry, cwd, events, setPending } = await fixture();
    await registry.listForCwd(cwd);
    setPending([]);

    await registry.listForCwd(cwd);

    const closed = events.sessionEvents.find(({ event }) => event.type === "dialog.closed");
    expect(closed?.sessionId).toBe("session-1");
    expect(closed?.event).toMatchObject({ type: "dialog.closed", reason: "peer-answered" });
  });

  it("retains a prior pending card across transient snapshot failure and recovery", async () => {
    const { registry, cwd, events, setPending, setSnapshotFailure } = await fixture();
    const initial = await registry.listForCwd(cwd);
    const dialogId = initial[0]?.dialogs[0]?.dialogId;
    if (dialogId === undefined) throw new Error("initial dialog missing");
    setSnapshotFailure(true);

    const unavailable = await registry.listForCwd(cwd);

    expect(unavailable[0]?.owner.state).toBe("unavailable");
    expect(unavailable[0]?.dialogs.map((dialog) => dialog.dialogId)).toEqual([dialogId]);
    expect(events.sessionEvents.filter(({ event }) => event.type === "dialog.closed")).toEqual([]);

    setSnapshotFailure(false);
    const recovered = await registry.listForCwd(cwd);
    expect(recovered[0]?.owner.state).toBe("ready");
    expect(recovered[0]?.dialogs.map((dialog) => dialog.dialogId)).toEqual([dialogId]);
    expect(events.sessionEvents.filter(({ event }) => event.type === "dialog.opened")).toHaveLength(1);

    setPending([]);
    await registry.listForCwd(cwd);
    const closed = events.sessionEvents.filter(({ event }) => event.type === "dialog.closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.sessionId).toBe("session-1");
    expect(closed[0]?.event).toMatchObject({ dialogId, reason: "peer-answered" });
  });

  it("excludes a stale crashed owner when a replacement live owner claims the same session", async () => {
    const { registry, cwd, events, record, recordPath, registryDir, setIdentity } = await fixture();
    const initial = await registry.listForCwd(cwd);
    const dialogId = initial[0]?.dialogs[0]?.dialogId;
    if (dialogId === undefined) throw new Error("initial dialog missing");
    const replacement = {
      ...record,
      processIncarnation: `test:${String(process.pid)}:20`,
      endpointNonce: "replacement",
      updatedAt: "2026-09-17T00:01:00.000Z",
    };
    setIdentity(replacement);
    await writeFile(recordPath, JSON.stringify({
      ...record,
      processIncarnation: `linux:${String(process.pid)}:0`,
    }), { mode: 0o600 });
    await writeFile(join(registryDir, "replacement.json"), JSON.stringify(replacement), { mode: 0o600 });

    const owners = await registry.listForCwd(cwd);

    expect(owners).toHaveLength(1);
    expect(owners[0]?.owner).toMatchObject({ state: "ready", incarnation: replacement.processIncarnation });
    expect(owners[0]?.dialogs.map((dialog) => dialog.dialogId)).toEqual([dialogId]);
    expect(events.sessionEvents.filter(({ event }) => event.type === "dialog.closed")).toEqual([]);
    expect(events.sessionEvents.filter(({ event }) => event.type === "dialog.opened")).toHaveLength(1);
  });

  it("retains prior pending state when multiple genuinely live or unresolved owners conflict", async () => {
    const { registry, cwd, events, record, registryDir } = await fixture();
    const initial = await registry.listForCwd(cwd);
    const dialogId = initial[0]?.dialogs[0]?.dialogId;
    if (dialogId === undefined) throw new Error("initial dialog missing");
    await writeFile(join(registryDir, "second-live.json"), JSON.stringify({
      ...record,
      processIncarnation: `test:${String(process.pid)}:20`,
      endpointNonce: "second-live",
    }), { mode: 0o600 });

    const owners = await registry.listForCwd(cwd);

    expect(owners[0]?.owner.state).toBe("conflict");
    expect(owners[0]?.dialogs.map((dialog) => dialog.dialogId)).toEqual([dialogId]);
    expect(events.sessionEvents.filter(({ event }) => event.type === "dialog.closed")).toEqual([]);
  });

  it("retains prior pending state when a contender record is encountered first", async () => {
    const { registry, cwd, events, record, registryDir } = await fixture();
    const initial = await registry.listForCwd(cwd);
    const dialogId = initial[0]?.dialogs[0]?.dialogId;
    if (dialogId === undefined) throw new Error("initial dialog missing");
    await writeFile(join(registryDir, "000-contender.json"), JSON.stringify({
      ...record,
      processIncarnation: `test:${String(process.pid)}:20`,
      endpointNonce: "first-contender",
    }), { mode: 0o600 });

    const owners = await registry.listForCwd(cwd);

    expect(owners[0]?.owner).toMatchObject({
      state: "conflict",
      incarnation: record.processIncarnation,
    });
    expect(owners[0]?.dialogs.map((dialog) => dialog.dialogId)).toEqual([dialogId]);
    expect(events.sessionEvents.filter(({ event }) => event.type === "dialog.closed")).toEqual([]);
    expect(events.sessionEvents.filter(({ event }) => event.type === "dialog.opened")).toHaveLength(1);
  });

  it("treats a stale Linux process incarnation as authoritative owner death", async () => {
    const { registry, cwd, events, record, recordPath } = await fixture();
    await registry.listForCwd(cwd);
    await writeFile(recordPath, JSON.stringify({ ...record, processIncarnation: `linux:${String(process.pid)}:0` }), { mode: 0o600 });

    const owners = await registry.listForCwd(cwd);

    expect(owners[0]?.owner.state).toBe("gone");
    expect(owners[0]?.dialogs).toEqual([]);
    expect(events.sessionEvents.find(({ event }) => event.type === "dialog.closed")?.event).toMatchObject({
      reason: "session-ended",
    });
  });

  it("rejects non-private registry records", async () => {
    const { registry, cwd, recordPath } = await fixture();
    await chmod(recordPath, 0o644);

    expect(await registry.listForCwd(cwd)).toEqual([]);
  });

  it("rejects a socket that becomes group-readable", async () => {
    const { registry, cwd, socketPath } = await fixture();
    await chmod(socketPath, 0o660);

    const owners = await registry.listForCwd(cwd);

    expect(owners[0]?.owner.state).toBe("unavailable");
  });

  it("fails closed when two ready owners claim the same full identity", async () => {
    const { registry, cwd, record, registryDir } = await fixture();
    await writeFile(join(registryDir, "second.json"), JSON.stringify({ ...record, endpointNonce: "other" }), { mode: 0o600 });

    const owners = await registry.listForCwd(cwd);

    expect(owners[0]?.owner.state).toBe("conflict");
  });
});

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function readRequest(socket: Socket, handler: (request: unknown) => void): void {
  socket.setEncoding("utf8");
  let input = "";
  socket.on("data", (chunk: string) => {
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const parsed: unknown = JSON.parse(input.slice(0, newline));
    handler(parsed);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
