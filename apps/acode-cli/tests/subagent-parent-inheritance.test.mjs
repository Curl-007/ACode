import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";

/**
 * 子代理对父会话的继承修正的验收测试：workspaceRoot 锚定 + resume 模式跟随。
 * 覆盖 apps/acode-cli/specs/subagent-parent-inheritance.md 场景 1–3。
 *
 * 守护的性质：
 * - 子运行时的 workspaceRoot 唯一来源 = 父 runtime 构造期锁定的根；Bash cd 漂移
 *   只影响 workingDirectory（相对路径解析），不得改变工作区身份（权限熔断锚点）。
 * - 漂移形态下 yolo 写真实工作区内文件不得命中 breaker.pathEscapeWrite；写真实
 *   工作区外仍必须 ask（安全加固 P2 不变量不回归）。
 * - resume 时非 plan 子模式跟随父当前档（modeOverride 通道）；plan 子代理豁免，
 *   防止 resolveExecutionState 把 planEnabled 归 false 静默拆 plan 地板。
 */

const { PermissionService, defaultPermissionConfig } = await import(
  "../packages/core/src/permission/service.ts"
);
const { resolveRuntimeWorkspaceRoot } = await import(
  "../packages/core/src/runtime/agent-runtime.ts"
);
const { resolveSubagentResumeModeOverride } = await import(
  "../packages/core/src/runtime/methods/subagent.ts"
);

const WRITE_CAPABILITY = {
  readOnly: false,
  destructive: false,
  sideEffectScope: "workspace",
  needsApproval: true,
};

function writeCtx(filePath, { workingDirectory, workspaceRoot }) {
  return {
    toolName: "Write",
    input: { file_path: filePath },
    riskLevel: "medium",
    mode: "yolo",
    workingDirectory,
    workspaceRoot,
  };
}

test("(1) resolveRuntimeWorkspaceRoot：显式 workspaceRoot 优先，缺省/空白回退 workingDirectory", () => {
  assert.equal(
    resolveRuntimeWorkspaceRoot({ workspaceRoot: "/root", workingDirectory: "/root/sub" }),
    "/root",
  );
  assert.equal(resolveRuntimeWorkspaceRoot({ workingDirectory: "/root/sub" }), "/root/sub");
  // 空白字符串不是有效身份：与 trim 后的空 workspaceIdentity 同一处理哲学，回退 cwd。
  assert.equal(
    resolveRuntimeWorkspaceRoot({ workspaceRoot: "   ", workingDirectory: "/root/sub" }),
    "/root/sub",
  );
  assert.equal(resolveRuntimeWorkspaceRoot({ workspaceRoot: "/root" }), "/root");
});

test("(2) cd 漂移形态：yolo 写真实工作区内不弹熔断，写真实工作区外仍 ask", () => {
  const service = new PermissionService(defaultPermissionConfig);
  const root = resolve(join("workspace-anchor", "proj"));
  const driftedCwd = join(root, "sub");
  const insideRootOutsideCwd = join(root, "docs", "note.md");
  const outsideRoot = resolve(join("workspace-anchor", "elsewhere", "note.md"));

  // 修复后形态（child workspaceRoot = 父锁定的 root）：写 root 内、漂移 cwd 外的文件放行。
  const fixed = service.checkPermission(
    writeCtx(insideRootOutsideCwd, { workingDirectory: driftedCwd, workspaceRoot: root }),
    WRITE_CAPABILITY,
  );
  assert.equal(fixed.decision, "allow");
  assert.notEqual(fixed.ruleId, "breaker.pathEscapeWrite");

  // 缺陷形态对照（child workspaceRoot 误锚定漂移 cwd）：同一路径被误报——本项消除的弹窗。
  const buggy = service.checkPermission(
    writeCtx(insideRootOutsideCwd, { workingDirectory: driftedCwd, workspaceRoot: driftedCwd }),
    WRITE_CAPABILITY,
  );
  assert.equal(buggy.decision, "ask");
  assert.equal(buggy.ruleId, "breaker.pathEscapeWrite");

  // 安全不变量不回归：写真实工作区外，任何模式（含 yolo）仍强制 ask。
  const escaped = service.checkPermission(
    writeCtx(outsideRoot, { workingDirectory: driftedCwd, workspaceRoot: root }),
    WRITE_CAPABILITY,
  );
  assert.equal(escaped.decision, "ask");
  assert.equal(escaped.ruleId, "breaker.pathEscapeWrite");
});

test("(3) resolveSubagentResumeModeOverride：非 plan 透出、plan 豁免", () => {
  // 非 plan：override 原样透出，resume 后子模式跟随父当前档（modeOverride 是
  // resume.ts 最高优先级通道，压过创建时刻落库的旧模式）。
  assert.equal(resolveSubagentResumeModeOverride("yolo"), "yolo");
  assert.equal(resolveSubagentResumeModeOverride("build"), "build");
  assert.equal(resolveSubagentResumeModeOverride("auto"), "auto");
  // plan：豁免 override——resolveExecutionState({ mode }) 会把 planEnabled 归 false，
  // 传了会静默拆 plan 地板；plan 状态由创建时刻落库的 execution-state entry 恢复。
  assert.equal(resolveSubagentResumeModeOverride("plan"), undefined);
});
