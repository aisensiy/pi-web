// @vitest-environment happy-dom

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "../api";
import { initialAppState } from "../appState";
import { PiWebApp } from "./PiWebApp";

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

describe("PiWebApp external owner surface", () => {
  it("keeps the existing chat and permission cards but removes writable controls", () => {
    const app = new PiWebApp();
    const selectedSession: SessionInfo = {
      id: "session-1",
      path: "/sessions/session-1.jsonl",
      cwd: "/repo",
      created: "2026-09-17T00:00:00.000Z",
      modified: "2026-09-17T00:00:00.000Z",
      messageCount: 1,
      firstMessage: "hello",
      owner: {
        kind: "external-pi",
        source: "herdr",
        state: "ready",
        incarnation: "linux:42:10",
      },
    };
    Reflect.set(app, "state", {
      ...initialAppState(),
      selectedSession,
      pendingDialogs: [{
        dialogId: "permission-1",
        kind: "select",
        title: "Permission Required",
        options: ["Yes", "No"],
        askedAt: "2026-09-17T00:00:00.000Z",
        runScoped: true,
      }],
    });
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);

    render(app.render(), container);

    expect(container.querySelector("chat-view")).not.toBeNull();
    expect(container.querySelector("prompt-editor")).toBeNull();
    expect(container.textContent).toContain("owned by the original Herdr Pi");
    expect(container.textContent).not.toContain("Select a workspace to start a session");
  });
});
