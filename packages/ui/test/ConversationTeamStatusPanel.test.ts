import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { act, createElement, Suspense } from "react";
import "./helpers/minimal-dom-shim.js";
import { MiniDocument, serializeDom } from "./helpers/minimal-dom-shim.js";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

register(new URL("./helpers/svg-load-hook.mjs", import.meta.url));
const { ConversationStatusPanel } = await import("../src/v4/ConversationStatusPanel.js");
const { ACodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const { TooltipProvider } = await import("../src/components/ui/tooltip.js");
(globalThis as Record<string, unknown>).getComputedStyle = () => ({ animationName: "none" });
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: FrameRequestCallback) =>
  setTimeout(callback, 0);
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);

const team = {
  v: 1,
  teamId: "team-test",
  goal: "Render the team",
  status: "active",
  seq: 1,
  counts: { done: 0, inProgress: 0, todo: 1, failed: 0, blocked: 0 },
  tasks: [{ taskId: "t-1", title: "Test render", status: "todo", kind: "test", dependencies: [] }],
  members: [{ name: "dev-1", role: "developer", status: "bound" }],
};

const stateKey = "agent-teams@acode-plugins-official:agent-teams";

function panel(pluginStates: Record<string, unknown> | null, variant: "panel" | "mini") {
  return createElement(
    Suspense,
    { fallback: null },
    createElement(
      ACodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        TooltipProvider,
        null,
        createElement(ConversationStatusPanel, {
          workspacePath: "/w",
          layoutMode: "inline",
          summaryPanelVariantOverride: variant,
          pluginStates,
        }),
      ),
    ),
  );
}

test("ConversationStatusPanel renders and updates the snapshot pluginStates team", async () => {
  const doc = new MiniDocument();
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => {
      root.render(panel({ [stateKey]: team }, "panel"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.match(serializeDom(container), /Render the team/);
    assert.match(serializeDom(container), /1 members/);
    await act(async () => {
      root.render(panel({ [stateKey]: team }, "mini"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.match(serializeDom(container), /Team/);
    await act(async () => {
      root.render(panel(null, "panel"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.doesNotMatch(serializeDom(container), /Render the team/);
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});
