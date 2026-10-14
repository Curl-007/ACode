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
 * - 锚定正确性钉在熔断器纯函数层（模式无关）：R6（2026-10-14，spec
 *   managed-policy-floor-and-bypass-immune-breakers.md）裁决 yolo 直通
 *   pathEscapeWrite 后，误锚不再表现为 yolo 弹窗，但对非 yolo allow 来源与
 *   projectId/memory 根推导仍 load-bearing。
 * - resume 时非 plan 子模式跟随父当前档（modeOverride 通道）；plan 子代理豁免，
 *   防止 resolveExecutionState 把 planEnabled 归 false 静默拆 plan 地板。
 */

const { PermissionService, defaultPermissionConfig } = await import(
  "../packages/core/src/permission/service.ts"
);
const breakerModule = await import(
  "../packages/core/src/permission/bypass-immune-breakers.ts"
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

test("(2) cd 漂移形态：锚定鉴别在纯熔断层钉住；yolo 服务层按 R6 直通", () => {
  const service = new PermissionService(defaultPermissionConfig);
  const root = resolve(join("workspace-anchor", "proj"));
  const driftedCwd = join(root, "sub");
  const insideRootOutsideCwd = join(root, "docs", "note.md");
  const outsideRoot = resolve(join("workspace-anchor", "elsewhere", "note.md"));

  // 锚定正确性的回归钉（熔断器纯函数层，模式无关）：workspaceRoot 误锚到漂移 cwd 时，
  // root 内路径被误判逃逸；锚定真实 root 则不命中。R6（2026-10-14）后该鉴别不再
  // 表现为 yolo 弹窗差异，但对非 yolo 的 allow 来源（项目 allow 规则/allowedTools）
  // 与 projectId/memory 根推导等 workspaceRoot 消费方仍 load-bearing。
  const { evaluateBypassImmuneBreakers } = breakerModule;
  const anchored = evaluateBypassImmuneBreakers({
    toolName: "Write",
    input: { file_path: insideRootOutsideCwd },
    workingDirectory: driftedCwd,
    workspaceRoot: root,
  });
  assert.equal(anchored, undefined, "锚定真实 root：root 内写入不命中熔断");
  const misAnchored = evaluateBypassImmuneBreakers({
    toolName: "Write",
    input: { file_path: insideRootOutsideCwd },
    workingDirectory: driftedCwd,
    workspaceRoot: driftedCwd,
  });
  assert.equal(
    misAnchored?.ruleId,
    "breaker.pathEscapeWrite",
    "缺陷形态（误锚漂移 cwd）：同一路径被误判逃逸——本项消除的误报",
  );
  assert.equal(
    evaluateBypassImmuneBreakers({
      toolName: "Write",
      input: { file_path: outsideRoot },
      workingDirectory: driftedCwd,
      workspaceRoot: root,
    })?.ruleId,
    "breaker.pathEscapeWrite",
    "真实越界在纯熔断层仍命中（非 yolo allow 来源照旧降级）",
  );

  // 服务层（yolo）：R6 裁决后 pathEscapeWrite 不再降级 allow——三种锚定形态在 yolo
  // 下一律直通（漂移误报的 yolo 可见症状随之消失；锚定正确性由上面的纯函数层钉住）。
  const fixed = service.checkPermission(
    writeCtx(insideRootOutsideCwd, { workingDirectory: driftedCwd, workspaceRoot: root }),
    WRITE_CAPABILITY,
  );
  assert.equal(fixed.decision, "allow");
  assert.notEqual(fixed.ruleId, "breaker.pathEscapeWrite");
  const buggy = service.checkPermission(
    writeCtx(insideRootOutsideCwd, { workingDirectory: driftedCwd, workspaceRoot: driftedCwd }),
    WRITE_CAPABILITY,
  );
  assert.equal(buggy.decision, "allow", "R6：yolo 下误锚形态也不再弹窗");
  const escaped = service.checkPermission(
    writeCtx(outsideRoot, { workingDirectory: driftedCwd, workspaceRoot: root }),
    WRITE_CAPABILITY,
  );
  assert.equal(escaped.decision, "allow", "R6：yolo = 字面完全访问，越界写直通");
  assert.equal(escaped.ruleId, "mode.yolo");
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
