import assert from "node:assert/strict";
import test from "node:test";

import type { IACodeSessionService } from "@acode/services";
import type { ACodeProvider } from "@acode/shared";
import { prepareWorkspaceWithACodeSessionService } from "../src/hooks/workspacePrepareRpc.js";

/**
 * `workspacePrepareRpc` 预热期 mode 来源裁决的验收测试（spec:
 * `packages/ui/specs/workspace-prepare-mode-source.md`）。
 *
 * 裁决：mode 从来不是协议事实——legacy `readWorkspacePresentation`
 * （`workspace-model-runtime.ts:26`）硬编码 `mode:"build"`。预热期 UI 直接用 shared
 * 权威 5 档表 + currentValue="build"，不再调 `.mode`。
 *
 * 本文件钉住：
 *   ① configOptions 不依赖协议响应的 mode 字段（即使协议假装返回别的 mode 也不被采信）；
 *   ② configOptions 是 shared 5 档表（含 dontAsk），currentValue 恒为 "build"；
 *   ③ slashCommands 仍来自协议响应（真实协议事实，归 M2 切换，本决策不动）；
 *   ④ preparedSessionId 恒为 ""（预热路径不创建会话）；
 *   ⑤ 协议失败时整体 reject（slashCommands 缺失不构成可用响应）。
 */

const STUB_PROVIDER = "acode" as ACodeProvider;

function makeSessionService(
  impl: () => Promise<{
    mode: "build" | "plan" | "edit" | "yolo" | "dontAsk";
    slashCommands: { name: string; description: string }[];
  }>,
): Pick<IACodeSessionService, "readWorkspacePresentation"> {
  return {
    readWorkspacePresentation: (() => impl()) as IACodeSessionService["readWorkspacePresentation"],
  };
}

test("① configOptions 不采信协议返回的 mode 字段——硬编码 build", async () => {
  // 协议若假装返回 mode="yolo"（实际 legacy 永远硬编码 build），prepare 也不得采用。
  const service = makeSessionService(async () => ({
    mode: "yolo",
    slashCommands: [{ name: "help", description: "Show help" }],
  }));

  const result = await prepareWorkspaceWithACodeSessionService({
    workspacePath: "/tmp/ws",
    provider: STUB_PROVIDER,
    acodeSessionService: service,
  });

  assert.equal(result.configOptions.length, 1);
  assert.equal(result.configOptions[0]!.id, "mode");
  assert.equal(
    result.configOptions[0]!.currentValue,
    "build",
    "currentValue 必须是常量 build——协议返回的 mode 字段不被采信",
  );
});

test("② configOptions 是 shared 5 档表（含 dontAsk）", async () => {
  const service = makeSessionService(async () => ({
    mode: "build",
    slashCommands: [],
  }));

  const result = await prepareWorkspaceWithACodeSessionService({
    workspacePath: "/tmp/ws",
    provider: STUB_PROVIDER,
    acodeSessionService: service,
  });

  const values = result.configOptions[0]!.options?.map((o) => o.value);
  assert.deepEqual(
    values,
    ["build", "edit", "plan", "yolo", "dontAsk"],
    "档位表必须来自 shared 权威 5 档表（含 dontAsk），不是本地副本",
  );
});

test("③ slashCommands 仍从协议响应透传", async () => {
  const slashCommands = [
    { name: "help", description: "Show help" },
    { name: "clear", description: "Clear conversation" },
  ];
  const service = makeSessionService(async () => ({ mode: "build", slashCommands }));

  const result = await prepareWorkspaceWithACodeSessionService({
    workspacePath: "/tmp/ws",
    provider: STUB_PROVIDER,
    acodeSessionService: service,
  });

  assert.deepEqual(
    result.slashCommands,
    slashCommands,
    "slashCommands 是真实协议事实，必须从 readWorkspacePresentation 透传",
  );
});

test("④ preparedSessionId 恒为空串（预热路径不创建会话）", async () => {
  const service = makeSessionService(async () => ({
    mode: "build",
    slashCommands: [],
  }));

  const result = await prepareWorkspaceWithACodeSessionService({
    workspacePath: "/tmp/ws",
    provider: STUB_PROVIDER,
    acodeSessionService: service,
  });

  assert.equal(result.preparedSessionId, "");
});

test("⑤ 协议失败时整体 reject（slashCommands 缺失不构成可用响应）", async () => {
  const service: Pick<IACodeSessionService, "readWorkspacePresentation"> = {
    readWorkspacePresentation: (() =>
      Promise.reject(new Error("socket closed"))) as IACodeSessionService["readWorkspacePresentation"],
  };

  await assert.rejects(
    prepareWorkspaceWithACodeSessionService({
      workspacePath: "/tmp/ws",
      provider: STUB_PROVIDER,
      acodeSessionService: service,
    }),
    /socket closed/,
    "slashCommands 是协议事实；协议失败时 prepare 必须整体失败，不能返回缺 slashCommands 的半成品",
  );
});
