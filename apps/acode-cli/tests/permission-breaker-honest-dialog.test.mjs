// R5.4/R5.2/R6 验收（spec managed-policy-floor-and-bypass-immune-breakers.md 场景 16/17/19-20）：
// ① 熔断 ask 的弹窗不再携带永远无法生效的持久授权建议——熔断判定在 checkPermission
//    收口处把任何 allow 无条件降级 ask、从不咨询项目/会话规则，「总是允许」持久化的
//    规则永远不被消费（2026-10-11 本机日志实证三连弹）。事件与 broker 请求两个消费点
//    同源置空；非熔断 ask 的建议规则照常携带（对照组）。
// ② getScratchRoot 接缝被 executor 权限链路消费：R6 后 yolo 全面直通 pathEscapeWrite，
//    接缝鉴别力移到「build + allowedTools 放行」形态（非 yolo 的 allow 来源照旧被熔断
//    降级，R5.2 豁免使其不降级）；子代理 spawn 构造点透传 deps.scratchRoot 为单行机械
//    接线，与 subagent-parent-inheritance R1 同先例由 typecheck 钉住。
// ③ R6：yolo 越界写（非豁免根）零弹窗直通；yolo 下熔断 ask 仅剩非 pathEscapeWrite 类
//    （16a 用 sensitiveRead 驱动抑制断言）。
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
const { readToolEntry } = await import("../packages/core/src/tool/handlers/read.ts");

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

/** build 模式下让 Write 经 allowedTools 拿到 allow——熔断降级才可观察（R6 场景 20 形态）。 */
function makeAllowlistedDeps(capture, extra = {}) {
  return makeDeps(capture, {
    permissionService: new PermissionService({
      allowedTools: new Set(["Write"]),
      disallowedTools: new Set(),
      autoApproveHighRisk: false,
      allowMediumRiskInAutoMode: false,
    }),
    ...extra,
  });
}

async function runTool(deps, toolName, entry, input, mode) {
  callCounter += 1;
  return resolveToolPermission(
    deps,
    { id: `call-r5-${callCounter}`, name: toolName, input },
    entry,
    input,
    {},
    mode,
    { traceId: "trace-r5" },
  );
}

const runWrite = (deps, filePath, mode) =>
  runTool(deps, "Write", writeToolEntry, { file_path: filePath, content: "probe" }, mode);

function requestedEvent(capture) {
  return capture.events.find((event) => event?.payload?.requestId !== undefined);
}

test("(16a) 熔断 ask：事件与 broker 请求的授权建议同源置空", async () => {
  // R6 后 yolo 下 pathEscapeWrite 直通，熔断 ask 用 sensitiveRead 类驱动（yolo 仍兜底）。
  const capture = { brokerRequests: [], events: [] };
  const sshKey = join(homedir(), ".ssh", "id_rsa");
  const result = await runTool(
    makeDeps(capture),
    "Read",
    readToolEntry,
    { file_path: sshKey },
    "yolo",
  );
  // fake broker 允许一次 → 本次调用放行；断言的是弹窗携带面，不是裁决结果。
  assert.equal(result.allowed, true);
  assert.equal(capture.brokerRequests.length, 1);
  assert.equal(capture.brokerRequests[0].ruleId, "breaker.sensitiveRead");
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

test("(17-seam) getScratchRoot 被权限链路消费：allow 来源放行时 scratch 内零降级", async () => {
  // R6 后 yolo 全面直通 pathEscapeWrite，接缝鉴别力用「build + allowedTools」形态：
  // allowedTools 给出 allow → 熔断收口决定是否降级（R6 场景 20 的非 yolo allow 来源）。
  const capture = { brokerRequests: [], events: [] };
  const deps = makeAllowlistedDeps(capture, { getScratchRoot: () => SCRATCH });
  const result = await runWrite(deps, join(SCRATCH, "sess-x", "draft.md"), "build");
  assert.equal(result.allowed, true);
  assert.equal(capture.brokerRequests.length, 0, "R5.2 豁免命中 → 零弹窗、零 broker 请求");
  assert.equal(requestedEvent(capture), undefined, "不得发出 permission-requested 事件");
});

test("(17-seam 对照) 无 getScratchRoot 时同一路径被熔断降级且建议置空", async () => {
  const capture = { brokerRequests: [], events: [] };
  await runWrite(makeAllowlistedDeps(capture), join(SCRATCH, "sess-x", "draft.md"), "build");
  assert.equal(capture.brokerRequests.length, 1);
  assert.equal(capture.brokerRequests[0].ruleId, "breaker.pathEscapeWrite");
  assert.deepEqual(
    capture.brokerRequests[0].suggestedPermissionUpdates,
    [],
    "熔断 ask 的无效授权抑制对 pathEscapeWrite 类同样成立（R5.4）",
  );
});

test("(19-flow) R6：yolo 越界写（非豁免根）零弹窗直通", async () => {
  const capture = { brokerRequests: [], events: [] };
  const result = await runWrite(
    makeDeps(capture),
    join(homedir(), "acode-r6-escape", "note.md"),
    "yolo",
  );
  assert.equal(result.allowed, true);
  assert.equal(capture.brokerRequests.length, 0);
  assert.equal(requestedEvent(capture), undefined);
});

test("(13-flow) tmpdir 豁免在 executor 链路同样成立（不依赖 getScratchRoot）", async () => {
  // R6 后 yolo 下本用例经直通放行；换 build + allowedTools 才继续鉴别 R5.1 豁免本体。
  const capture = { brokerRequests: [], events: [] };
  const result = await runWrite(
    makeAllowlistedDeps(capture),
    join(tmpdir(), "acode-r5-agent-out", "result.json"),
    "build",
  );
  assert.equal(result.allowed, true);
  assert.equal(capture.brokerRequests.length, 0);
});
