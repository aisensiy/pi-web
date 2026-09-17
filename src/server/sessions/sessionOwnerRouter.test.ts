import { describe, expect, it, vi } from "vitest";
import type { PendingExtensionDialog } from "../../shared/apiTypes.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, sessionGateway, sessionRecord, sessionRef, testModelRuntime, type RuntimeCreator } from "./piSessionService.testSupport.js";
import { SessionOwnerRouter, type ExternalPermissionOwners } from "./sessionOwnerRouter.js";
import type { ExternalPermissionOwner } from "./externalPermissionBridgeRegistry.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

function pendingDialog(): PendingExtensionDialog {
  return {
    dialogId: "permission-dialog",
    kind: "select",
    title: "Permission Required",
    message: "write file",
    options: ["Yes", "No"],
    optionValues: ["allow-token", "deny-token"],
    cancellable: false,
    askedAt: "2026-09-17T00:00:00.000Z",
    runScoped: true,
  };
}

function externalOwner(state: ExternalPermissionOwner["owner"]["state"] = "ready"): ExternalPermissionOwner {
  return {
    identity: {
      protocolVersion: 1,
      machineId: "local",
      source: "herdr",
      sessionId: "session-1",
      cwd: "/workspace",
      transcriptPath: "/sessions/session-1.jsonl",
      pid: 42,
      processIncarnation: "linux:42:100",
      endpointNonce: "nonce",
    },
    owner: { kind: "external-pi", source: "herdr", state, incarnation: "linux:42:100" },
    socketPath: state === "ready" ? "/run/bridge.sock" : undefined,
    dialogs: state === "ready" ? [pendingDialog()] : [],
    revision: 1,
  };
}

function setup(owner: ExternalPermissionOwner | null = externalOwner(), ownerTranscriptPath = `${process.cwd()}/package.json`) {
  const transcriptPath = `${process.cwd()}/package.json`;
  const resolvedOwner = owner === null ? null : { ...owner, identity: { ...owner.identity, transcriptPath: ownerTranscriptPath } };
  const fake = fakeRuntime("session-1");
  const createAgentRuntime = vi.fn<RuntimeCreator>(() => Promise.resolve(fake.runtime));
  const gateway = sessionGateway([{ ...sessionRecord("session-1"), path: transcriptPath }]);
  gateway.readBranch = () => Promise.resolve([
    { type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
  ]);
  const events = new CapturingSessionEventHub();
  events.setSeq("session-1", 9);
  const local = new PiSessionService(events, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    createAgentRuntime,
    sessionManager: gateway,
    heartbeatIntervalMs: 60_000,
  });
  const answer = vi.fn<ExternalPermissionOwners["answer"]>(() => Promise.resolve({ result: { outcome: "accepted" }, answerLabel: "Yes" }));
  const external: ExternalPermissionOwners = {
    hasAnyOwner: () => Promise.resolve(resolvedOwner !== null),
    listForCwd: () => Promise.resolve(resolvedOwner === null ? [] : [resolvedOwner]),
    resolve: () => Promise.resolve(resolvedOwner ?? undefined),
    status: (resolved) => ({
      sessionId: resolved.identity.sessionId,
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      pendingDialogs: [...resolved.dialogs],
    }),
    answer,
  };
  return { router: new SessionOwnerRouter(local, external, gateway, events), local, createAgentRuntime, answer };
}

describe("SessionOwnerRouter", () => {
  it("marks matching list rows and serves every passive selected-session read without opening a runtime", async () => {
    const { router, local, createAgentRuntime } = setup();

    const listed = await router.list("/workspace");
    const messages = await router.messages(sessionRef("session-1"));
    const status = await router.status(sessionRef("session-1"));
    const stream = await router.streamSnapshot(sessionRef("session-1"));
    const media = await router.media(sessionRef("session-1"), "missing");

    expect(listed[0]?.owner).toEqual({ kind: "external-pi", source: "herdr", state: "ready", incarnation: "linux:42:100" });
    expect(messages.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    expect(status.pendingDialogs).toEqual([pendingDialog()]);
    expect(stream).toEqual({ seq: 9, partial: null });
    expect(media).toBeUndefined();
    expect(createAgentRuntime).not.toHaveBeenCalled();
    await local.dispose();
  });

  it("answers through the original owner and returns stale without manufacturing a local waiter", async () => {
    const { router, local, answer, createAgentRuntime } = setup();

    const response = await router.answerDialog(sessionRef("session-1"), "permission-dialog", "allow-token");

    expect(answer.mock.calls[0]?.[0].identity.sessionId).toBe("session-1");
    expect(answer.mock.calls[0]?.slice(1)).toEqual(["permission-dialog", "allow-token"]);
    expect(response).toMatchObject({ result: "closed", outcome: { reason: "answered", answer: "Yes" } });
    expect(createAgentRuntime).not.toHaveBeenCalled();
    await local.dispose();
  });

  it("forwards a typed denial reason without interpreting its label", async () => {
    const { router, local, answer } = setup();

    await router.answerDialog(sessionRef("session-1"), "permission-dialog", {
      choiceId: "reason-token",
      denialReason: "unsafe path",
    });

    expect(answer.mock.calls[0]?.slice(1)).toEqual([
      "permission-dialog",
      { choiceId: "reason-token", denialReason: "unsafe path" },
    ]);
    await local.dispose();
  });

  it("reconciles stale answers and keeps transport failures visible without a fake close", async () => {
    const { router, local, answer, createAgentRuntime } = setup();
    answer.mockResolvedValueOnce({ result: { outcome: "stale" } });

    await expect(router.answerDialog(sessionRef("session-1"), "permission-dialog", "allow-token"))
      .resolves.toMatchObject({ result: "stale", sessionStatus: { pendingDialogs: [expect.objectContaining({ dialogId: "permission-dialog" })] } });

    answer.mockRejectedValueOnce(new Error("bridge disconnected"));
    await expect(router.answerDialog(sessionRef("session-1"), "permission-dialog", "allow-token"))
      .rejects.toThrow("bridge disconnected");
    expect(createAgentRuntime).not.toHaveBeenCalled();
    await local.dispose();
  });

  it("rejects invalid bridge answers without closing the authoritative card", async () => {
    const { router, local, answer } = setup();
    answer.mockResolvedValueOnce({ result: { outcome: "invalid", reason: "choice does not match incarnation" } });

    await expect(router.answerDialog(sessionRef("session-1"), "permission-dialog", "wrong-token"))
      .rejects.toThrow("choice does not match incarnation");
    await local.dispose();
  });

  it("fails closed when the bridge transcript identity differs from the persisted session", async () => {
    const { router, local, createAgentRuntime } = setup(externalOwner(), `${process.cwd()}/README.md`);

    await expect(router.messages(sessionRef("session-1"))).rejects.toThrow("identity conflicts");
    expect(createAgentRuntime).not.toHaveBeenCalled();
    await local.dispose();
  });

  it("fails closed for unavailable owners instead of delegating a mutation", async () => {
    const { router, local, createAgentRuntime } = setup(externalOwner("unavailable"));

    await expect(router.prompt(sessionRef("session-1"), "continue")).rejects.toThrow("owned by the original Herdr Pi");
    await expect(router.cancelDialog(sessionRef("session-1"), "permission-dialog")).rejects.toThrow("owned by the original Herdr Pi");
    expect(createAgentRuntime).not.toHaveBeenCalled();
    await local.dispose();
  });

  it("delegates ordinary sessions unchanged", async () => {
    const { router, local, createAgentRuntime } = setup(null);

    await router.status(sessionRef("session-1"));

    expect(createAgentRuntime).toHaveBeenCalledOnce();
    await local.dispose();
  });
});
