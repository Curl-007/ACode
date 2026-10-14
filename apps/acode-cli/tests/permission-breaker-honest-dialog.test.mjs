// R5.4/R5.2 验收（spec managed-policy-floor-and-bypass-immune-breakers.md 场景 16/17）：
// ① 熔断 ask 的弹窗不再携带永远无法生效的持久授权建议——熔断判定在 checkPermission
//    收口处把任何 allow 无条件降级 ask、从不咨询项目/会话规则，「总是允许」持久化的
//    规则永远不被消费（2026-10-11 本机日志实证三连弹）。事件与 broker 请求两个消费点
//    同源置空；非熔断 ask 的建议规则照常携带（对照组）。
// ② getScratchRoot 接缝被 executor 权限链路消费：yolo 写 scratch 根内路径零弹窗直通
//    （子代理 spawn 构造点透传 deps.scratchRoot 为单行机械接线，与 subagent-parent-
//    inheritance R1 同先例由 typecheck 钉住；本文件钉住链路消费端语义）。
// 全部使用虚拟路径（homedir 系拼接），零文件系统副作用。
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { resolveToolPermission } = await import(
  "../packages/core/src/tool/executor/permission-flow.ts"
);
const { PermissionService } = await import("../packages/core/src/permission/service.ts");
const { writeToolEntry } = await import("../packages/core/src/tool/handlers/write.ts");

const PROJECT = join(homedir(), "acode-r5-honesty-project");
const SCRATCH = join(homedir(), ".acode", "cli", "scratch");

let callCounter = 0;

function makeDeps(capture, extra = {}) {
  return {
    permissionService: new PermissionService(),
    permissionBroker: {
      requestPermission: async (request) => {
        capture.brokerRequests.push(request);
        return { decision: "allow", resolvedAt: new Date() };
      },
    },
    emitEvent: async (event) => {
      capture.events.push(event);
    },
    sessionId: "sess-r5-honesty",
    getWorkingDirectory: () => PROJECT,
    getWorkspaceRoot: () => PROJECT,
    runtimeScope: "main",
    ...extra,
  };
}

async function runWrite(deps, filePath, mode) {
  callCounter += 1;
  const input = { file_path: filePath, content: "probe" };
  return resolveToolPermission(
    deps,
    { id: `call-r5-${callCounter}`, name: "Write", input },
    writeToolEntry,
    input,
    {},
    mode,
    { traceId: "trace-r5" },
  );
}

function requestedEvent(capture) {
  return capture.events.find((event) => event?.payload?.requestId !== undefined);
}

test("(16a) 熔断 ask：事件与 broker 请求的授权建议同源置空", async () => {
  const capture = { brokerRequests: [], events: [] };
  const outside = join(homedir(), "acode-r5-escape", "note.md");
  const result = await runWrite(makeDeps(capture), outside, "yolo");
  // fake broker 允许一次 → 本次调用放行；断言的是弹窗携带面，不是裁决结果。
  assert.equal(result.allowed, true);
  assert.equal(capture.brokerRequests.length, 1);
  assert.equal(capture.brokerRequests[0].ruleId, "breaker.pathEscapeWrite");
  assert.deepEqual(capture.brokerRequests[0].suggestedPermissionUpdates, []);
  const event = requestedEvent(capture);
  assert.ok(event, "permission-requested 事件已发出");
  assert.deepEqual(event.payload.suggestedPermissionUpdates, []);
});

test("(16b) 非熔断 ask：建议规则照常携带（对照组，防过度抑制）", async () => {
  const capture = { brokerRequests: [], events: [] };
  // build 模式写工作区内文件 → mode.build 副作用 ask（非 breaker 路径）。
  const inside = join(PROJECT, "src", "note.md");
  await runWrite(makeDeps(capture), inside, "build");
  assert.equal(capture.brokerRequests.length, 1);
  const request = capture.brokerRequests[0];
  assert.ok(!String(request.ruleId).startsWith("breaker."), `对照组不得走熔断路径：${request.ruleId}`);
  const updates = request.suggestedPermissionUpdates;
  assert.ok(Array.isArray(updates) && updates.length > 0, "非熔断 ask 仍携带持久授权建议");
  assert.equal(updates[0].rules[0].toolName, "Write");
  const event = requestedEvent(capture);
  assert.deepEqual(event.payload.suggestedPermissionUpdates, updates);
});

test("(17-seam) getScratchRoot 被权限链路消费：yolo 写 scratch 根内零弹窗", async () => {
  const capture = { brokerRequests: [], events: [] };
  const deps = makeDeps(capture, { getScratchRoot: () => SCRATCH });
  const result = await runWrite(deps, join(SCRATCH, "sess-x", "draft.md"), "yolo");
  assert.equal(result.allowed, true);
  assert.equal(capture.brokerRequests.length, 0, "豁免命中 → 零弹窗、零 broker 请求");
  assert.equal(requestedEvent(capture), undefined, "不得发出 permission-requested 事件");
});

test("(17-seam 对照) 无 getScratchRoot 时同一路径照旧弹窗", async () => {
  const capture = { brokerRequests: [], events: [] };
  await runWrite(makeDeps(capture), join(SCRATCH, "sess-x", "draft.md"), "yolo");
  assert.equal(capture.brokerRequests.length, 1);
  assert.equal(capture.brokerRequests[0].ruleId, "breaker.pathEscapeWrite");
});

test("(13-flow) tmpdir 豁免在 executor 链路同样成立（不依赖 getScratchRoot）", async () => {
  const capture = { brokerRequests: [], events: [] };
  const result = await runWrite(
    makeDeps(capture),
    join(tmpdir(), "acode-r5-agent-out", "result.json"),
    "yolo",
  );
  assert.equal(result.allowed, true);
  assert.equal(capture.brokerRequests.length, 0);
});
