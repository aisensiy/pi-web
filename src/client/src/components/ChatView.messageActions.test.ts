// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(entryId: string | undefined = "entry-1") {
  const view = new ChatView();
  view.sessionId = "session-1";
  view.messages = [
    { role: "user", entryId, parts: [{ type: "text", text: "Hello" }] },
  ];
  view.onMessageAction = vi.fn(() => Promise.resolve());
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function deferredAction() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function button(view: ChatView, index: number): HTMLButtonElement {
  const result = buttons(view)[index];
  if (result === undefined)
    throw new Error(`Missing message action ${String(index)}`);
  return result;
}

function buttons(view: ChatView) {
  return Array.from(
    view.renderRoot.querySelectorAll<HTMLButtonElement>(".msg-action")
  );
}

describe("chat message history shortcuts", () => {
  it.each([
    [0, "fork", "Are you sure you want to fork this session?"],
    [1, "back", "Are you sure you want to go back to this message?"],
  ] as const)(
    "confirms shortcut %s before changing history",
    async (index, action, copy) => {
      const view = await mount();
      expect(
        buttons(view).map((button) => button.getAttribute("aria-label"))
      ).toEqual([
        "Clone session from this message",
        "Go back to this message",
        "Copy user message",
      ]);
      const confirm = vi.fn(() => false);
      vi.stubGlobal("confirm", confirm);
      button(view, index).click();
      expect(confirm).toHaveBeenCalledWith(copy);
      expect(view.onMessageAction).not.toHaveBeenCalled();
      confirm.mockReturnValue(true);
      button(view, index).click();
      await view.updateComplete;
      expect(view.onMessageAction).toHaveBeenCalledWith("entry-1", action);
    }
  );

  it.each([
    ["session", "resolve"],
    ["session", "reject"],
    ["machine", "resolve"],
    ["machine", "reject"],
  ] as const)(
    "keeps the new %s selection actionable when the old action will %s",
    async (selection, outcome) => {
      const view = await mount();
      const oldAction = deferredAction();
      const newAction = deferredAction();
      vi.stubGlobal("confirm", () => true);
      view.onMessageAction = vi.fn(() => oldAction.promise);
      button(view, 0).click();
      await view.updateComplete;
      expect(button(view, 0).disabled).toBe(true);

      if (selection === "session") view.sessionId = "session-2";
      else view.machineId = "remote";
      view.onMessageAction = vi.fn(() => newAction.promise);
      await view.updateComplete;
      expect(button(view, 0).disabled).toBe(false);
      button(view, 1).click();
      await view.updateComplete;
      expect(view.onMessageAction).toHaveBeenCalledOnce();
      expect(button(view, 0).disabled).toBe(true);

      if (outcome === "resolve") oldAction.resolve();
      else oldAction.reject(new Error("Old session failed"));
      await view.updateComplete;
      await view.updateComplete;
      expect(button(view, 0).disabled).toBe(true);
      expect(view.renderRoot.querySelector('[role="alert"]')).toBeNull();
      newAction.resolve();
      await view.updateComplete;
      await view.updateComplete;
      expect(button(view, 0).disabled).toBe(false);
    }
  );

  it.each(["resolve", "reject"] as const)(
    "prevents duplicate actions and clears pending state after %s",
    async (outcome) => {
      const view = await mount();
      const action = deferredAction();
      vi.stubGlobal("confirm", () => true);
      view.onMessageAction = vi.fn(() => action.promise);
      button(view, 0).click();
      // A second click before Lit renders must also be ignored.
      button(view, 1).click();
      expect(view.onMessageAction).toHaveBeenCalledOnce();
      await view.updateComplete;
      expect(button(view, 0).disabled).toBe(true);
      expect(button(view, 1).disabled).toBe(true);
      expect(button(view, 2).disabled).toBe(false);
      if (outcome === "resolve") action.resolve();
      else action.reject(new Error("Current action failed"));
      await view.updateComplete;
      await view.updateComplete;
      expect(button(view, 0).disabled).toBe(false);
      expect(
        view.renderRoot.querySelector('[role="alert"]')?.textContent ?? ""
      ).toBe(outcome === "reject" ? "Current action failed" : "");
    }
  );

  it("does not revive an old action when navigating A to B to A", async () => {
    const view = await mount();
    const oldAction = deferredAction();
    const newAction = deferredAction();
    vi.stubGlobal("confirm", () => true);
    view.onMessageAction = vi.fn(() => oldAction.promise);
    button(view, 0).click();
    await view.updateComplete;
    view.sessionId = "session-2";
    await view.updateComplete;
    view.sessionId = "session-1";
    view.onMessageAction = vi.fn(() => newAction.promise);
    await view.updateComplete;
    expect(button(view, 0).disabled).toBe(false);
    button(view, 0).click();
    await view.updateComplete;
    oldAction.reject(new Error("Obsolete visit failed"));
    await view.updateComplete;
    await view.updateComplete;
    expect(button(view, 0).disabled).toBe(true);
    expect(view.renderRoot.querySelector('[role="alert"]')).toBeNull();
    newAction.resolve();
    await view.updateComplete;
    await view.updateComplete;
    expect(button(view, 0).disabled).toBe(false);
  });

  it("does not offer history shortcuts for messages without a durable entry", async () => {
    const view = await mount();
    view.messages = [
      { role: "assistant", parts: [{ type: "text", text: "Streaming" }] },
    ];
    await view.updateComplete;
    expect(buttons(view).map((button) => button.title)).toEqual([
      "Copy message",
    ]);
  });

  it("disables history actions while busy and surfaces failures", async () => {
    const view = await mount();
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    view.messageActionsDisabled = true;
    await view.updateComplete;
    button(view, 0).click();
    expect(confirm).not.toHaveBeenCalled();
    expect(button(view, 2).disabled).toBe(false);
    view.messageActionsDisabled = false;
    view.onMessageAction = vi.fn(() =>
      Promise.reject(new Error("History changed"))
    );
    await view.updateComplete;
    button(view, 1).click();
    await view.updateComplete;
    await view.updateComplete;
    expect(view.renderRoot.querySelector('[role="alert"]')?.textContent).toBe(
      "History changed"
    );
  });
});
