import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

/**
 * jcode-bridge 的 **Level 2 真实客户端栈**验收（specs/jcode-agent-bridge.md 附录 A.5 第 1 项）。
 *
 * 三层保真度递进：
 *   Level 0（apps/acode-cli/tests/jcode-bridge-e2e-smoke.test.mjs）
 *     自写脚本客户端直说 v4 stdio → 验 shim 的协议契约。
 *   Level 1（tests/jcode-bridge-real-client.test.mjs）
 *     ACodeAgentProcessManager + ACodeProtocolClient → 验 spawn/命令解析/帧收发/投影。
 *   **Level 2（本文件）**
 *     `createACodeAgentService()` 完整 service 层 → 验桌面 Host 真正走的那条路：
 *     `sendConversationCommandV4`（provider 就绪门禁 + createSession 的 account 同步分支）、
 *     `subscribeConversationV4`（getReadOnlyClient + SQLite task-index 路径）、
 *     `onDynamicConversationFrame`（service 侧帧 fan-out emitter）。
 *     这三者是 Level 1 未覆盖的面，也是 packages/ui 实际消费的接口。
 *
 * 为什么默认 skip：需本机装有 jcode 且其自身已配好 provider 凭据（spec R4-6：shim 不搬运
 * ACode 凭据，ACP 面无凭据协商；ACode 侧凭据由假 readiness source 提供，仅为过门禁）。跑法：
 *   ACODE_JCODE_E2E=1 [ACODE_JCODE_E2E_BINARY=<path>] pnpm --filter @acode/services test
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
// Windows 上 node 的 ESM 只接受 file/data/node scheme，裸 C:/ 会被当协议 "c:"。
const tsxLoader = pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href;
const cliEntry = join(repoRoot, "apps/acode-cli/packages/cli/src/main.ts");
const agentServiceModule = pathToFileURL(
  join(repoRoot, "packages/services/src/acode-agent/acodeAgentService.ts"),
).href;
const v4ProtocolModule = pathToFileURL(
  join(repoRoot, "packages/shared/src/acode-protocol-v4/index.ts"),
).href;

const { createACodeAgentService } = await import(agentServiceModule);
const { V4_METHODS } = await import(v4ProtocolModule);

const ENABLED = process.env.ACODE_JCODE_E2E === "1";
const JCODE_BINARY = process.env.ACODE_JCODE_E2E_BINARY ?? "jcode";
const TURN_TIMEOUT_MS = 180_000;
const HARD_TIMEOUT_MS = 300_000;
/** 帧停滞判定：真模型跑完即不再产帧，早退避免白等满超时。 */
const STALL_MS = 30_000;

const skipReason = ENABLED
  ? false
  : "需要本机 jcode + 其自身 provider 凭据；设 ACODE_JCODE_E2E=1 开启（见文件头注）";

/** 物理 wire frame 是二级帧：payload 在内层 frame.frame.payload。 */
function logicalPayload(wire) {
  if (!wire || wire.kind === "fragment") return null;
  const inner = wire.frame ?? wire;
  return inner?.payload ?? wire.payload ?? null;
}

/** 归约帧为 row 集合（后到的 upsert 覆盖），复刻 packages/ui 的投影消费语义。 */
function collectRows(frameList) {
  const rows = new Map();
  for (const frame of frameList) {
    const payload = logicalPayload(frame);
    if (!payload) continue;
    if (payload.kind === "snapshot") {
      for (const row of payload.snapshot?.rows?.window ?? []) rows.set(row.rowId, row);
    } else if (payload.kind === "deltas") {
      for (const delta of payload.deltas ?? []) {
        if (delta.op === "row.appended" || delta.op === "row.upserted") {
          rows.set(delta.row.rowId, delta.row);
        } else if (delta.op === "row.removed") {
          rows.delete(delta.fromRowId);
        } else if (delta.op === "row.delta") {
          const existing = rows.get(delta.rowId);
          if (existing && typeof delta.append === "string") {
            rows.set(delta.rowId, { ...existing, text: (existing.text ?? "") + delta.append });
          }
        }
      }
    }
  }
  return [...rows.values()];
}

test(
  "Level 2 真实 service 层：createACodeAgentService 经 sendConversationCommandV4/subscribeConversationV4 驱动 jcode 跑通真模型一轮",
  { skip: skipReason, timeout: HARD_TIMEOUT_MS + 30_000 },
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acode-jcode-l2-"));
    // SQLite 落 temp：subscribeConversationV4 会触发 TaskIndexRepo.ensureReady
    // （getTaskMeta），不设这个会写用户真实 ~/.acode。
    const dataDir = await mkdtemp(join(tmpdir(), "acode-jcode-l2-data-"));
    await writeFile(join(workspace, "probe.txt"), "level two service stack\n", "utf8");

    const savedEnv = { ...process.env };
    // env 覆盖（agent-command-env-gate.md R1：非打包态生效）。
    process.env.ACODE_AGENT_SERVER_COMMAND = process.execPath;
    process.env.ACODE_AGENT_SERVER_ARGS_JSON = JSON.stringify([
      "--import",
      tsxLoader,
      cliEntry,
      "jcode-bridge",
      "--stdio",
      "--jcode-binary",
      JCODE_BINARY,
    ]);
    process.env.ACODE_AGENT_SERVER_CWD = workspace;
    process.env.ACODE_DATA_BASE_DIR = dataDir;
    delete process.env.ACODE_APP_IS_PACKAGED;
    process.env.JCODE_NO_TELEMETRY = "1";
    process.env.DO_NOT_TRACK = "1";

    // 假 provider 就绪源：sendConversationCommandV4 走 getClient，缺它就抛
    // providerNotReady（acodeAgentService.ts:3134/3151）。给 ≥1 provider+model 即 ready。
    const modelSelectionReadinessSource = {
      getView: async () => ({
        revision: 1,
        providers: [{ providerId: "fake-provider", models: [{ modelId: "fake-model" }] }],
      }),
    };
    // 刻意**不**注入 accountProviderConfigSource：注入了会发 legacy
    // provider/updateAccountConfig，而 shim 的 dispatch 只处理 v4 方法 → 回 -32601 且
    // 该错误不被降级（acodeAgentService.ts:1490 原样 rethrow）→ 整个 createSession reject。
    // 省略即整条同步 early-return（:1450），这正是 jcode 后端的诚实配置。
    const service = createACodeAgentService({
      presentationSurface: "desktop",
      modelSelectionReadinessSource,
    });

    const frames = [];
    let frameSubscription = null;

    try {
      // 1. createSession 经 service 层（会过 provider 就绪门禁 + account 同步分支）。
      const createAck = await service.sendConversationCommandV4({
        workspacePath: workspace,
        envelope: {
          commandId: crypto.randomUUID(),
          clientId: "level2-real-service",
          sessionId: null,
          type: "createSession",
          payload: { workspaceId: workspace },
          issuedAt: Date.now(),
        },
      });
      assert.equal(
        createAck?.status,
        "accepted",
        `createSession 应 accepted，实得 ${createAck?.status}/${createAck?.reasonCode ?? "-"}`,
      );
      const v4SessionId = createAck?.result?.sessionId;
      assert.ok(
        typeof v4SessionId === "string" && v4SessionId.startsWith("jcode-"),
        `应返回 shim 自造的 jcode- 前缀 sessionId，实得 ${v4SessionId}`,
      );

      // 2. 先注册 service 侧帧 fan-out 监听器（packages/ui 就是这么收帧的）。
      //    必须在 subscribe **之前**注册：initial snapshot 帧随 subscribe 的 ACK 之后
      //    立即 fire（dispatch 的 post-response outbox 语义），晚注册就会错过首帧。
      //    onDynamicConversationFrame 是 workspace 级（不需 sessionId），故此刻即可挂。
      frameSubscription = service.onDynamicConversationFrame({ workspacePath: workspace })(
        (frame) => {
          frames.push(frame);
        },
      );

      // 3. subscribe 经 service 层（走 getReadOnlyClient，无就绪门禁；触发 SQLite 路径）。
      const subAck = await service.subscribeConversationV4({
        workspacePath: workspace,
        sessionId: v4SessionId,
        connectionId: "conn-level2",
        clientMode: "desktop-continuous",
      });
      assert.equal(
        typeof subAck?.ack?.subscriptionId,
        "string",
        "subscribe 必须返回 subscriptionId",
      );
      assert.equal(subAck?.ack?.mode, "snapshot", "首次订阅应走 snapshot 模式");

      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.ok(
        frames.some((frame) => logicalPayload(frame)?.kind === "snapshot"),
        `service fan-out 必须收到 initial snapshot 帧，实得 ${frames.length} 帧`,
      );

      // 4. sendText 经 service 层（真实 envelope 走 sendConversationCommandV4）。
      const sendAck = await service.sendConversationCommandV4({
        workspacePath: workspace,
        envelope: {
          commandId: crypto.randomUUID(),
          clientId: "level2-real-service",
          sessionId: v4SessionId,
          type: "sendText",
          payload: {
            text: "Read the file probe.txt in the current directory and tell me its exact contents. Use your file-reading tool.",
          },
          issuedAt: Date.now(),
        },
      });
      assert.equal(sendAck?.status, "accepted");
      assert.equal(sendAck?.result?.type, "inputAccepted", "sendText 必须返回 inputAccepted 收据");

      // 5. 等真模型跑完一轮，帧经 service fan-out 到达。
      let rows = [];
      let header = null;
      let lastFrameCount = -1;
      let lastGrowth = Date.now();
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        rows = collectRows(frames);
        header = rows.find((row) => row.kind === "turnHeader");
        if (frames.length !== lastFrameCount) {
          lastFrameCount = frames.length;
          lastGrowth = Date.now();
        }
        if (header && ["completedSuccess", "failed", "completedInterrupted"].includes(header.state))
          break;
        if (Date.now() - lastGrowth > STALL_MS && frames.length > 0) {
          throw new Error(
            `帧停滞 ${STALL_MS}ms（frames=${frames.length}, rows=${rows.length}），轮次未收口`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      // 6. 断言经 service 层收到的投影产物。
      assert.equal(
        header?.state,
        "completedSuccess",
        `turnHeader 应 completedSuccess，实得 ${header?.state ?? "无 turnHeader"}`,
      );
      const kinds = rows.map((row) => row.kind);
      assert.ok(
        kinds.includes("userInput"),
        `应有 userInput row，实得 [${[...new Set(kinds)].join(",")}]`,
      );
      const textRow = rows.find((row) => row.kind === "assistantText");
      assert.ok(textRow, "应有 assistantText row");
      assert.ok(
        (textRow?.text ?? "").includes("level two service stack"),
        `assistantText 应含 probe.txt 真实内容，实得 "${(textRow?.text ?? "").slice(0, 160)}"`,
      );
      const toolRows = rows.filter((row) => row.kind === "toolCall");
      assert.equal(toolRows.length, 1, `工具增量帧应归并成一个 row，实得 ${toolRows.length}`);
      assert.equal(toolRows[0]?.status, "success", `工具应 success，实得 ${toolRows[0]?.status}`);

      // 7. 不支持的命令经 service 层同样显式 failed（spec R5）。
      const renameAck = await service.sendConversationCommandV4({
        workspacePath: workspace,
        envelope: {
          commandId: crypto.randomUUID(),
          clientId: "level2-real-service",
          sessionId: v4SessionId,
          type: "renameSession",
          payload: { title: "level2 renamed" },
          issuedAt: Date.now(),
        },
      });
      assert.equal(renameAck?.status, "failed", `不支持命令应 failed，实得 ${renameAck?.status}`);
      assert.equal(renameAck?.reasonCode, "fault.capability.unsupportedByExternalAgent");

      console.error(
        `[level2] 帧数=${frames.length} rows=${rows.length} kinds=[${[...new Set(kinds)].join(",")}] V4_METHODS.command=${V4_METHODS.command}`,
      );
    } finally {
      frameSubscription?.dispose();
      try {
        await service.disposeAllAndWait();
      } catch {
        // finally 里二次 dispose 可能已关；不影响断言结论。
      }
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
