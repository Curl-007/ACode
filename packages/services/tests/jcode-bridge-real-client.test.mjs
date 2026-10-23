import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

/**
 * jcode-bridge 的**真实客户端栈**端到端验收（specs/jcode-agent-bridge.md 附录 A.5 第 1 项）。
 *
 * 与 apps/acode-cli/tests/jcode-bridge-e2e-smoke.test.mjs 的区别：那份用自写脚本客户端直接
 * 说 v4 stdio，验的是 shim 的协议契约；**本文件用 ACode 自己的客户端栈**——
 *   ACodeAgentProcessManager（经 ACODE_AGENT_SERVER_COMMAND env 覆盖 spawn shim）
 *   → ACodeProtocolClient（storage gate、请求关联、通知分发）
 *   → v4 帧消费
 * 即桌面 Host 在非打包态走的同一条路径（agent-command-env-gate.md R1 明确保留 dev/独立
 * CLI/远程 server 的 env 覆盖通道）。这才验证了「ACode 客户端真的能驱动这个 shim」。
 *
 * 为什么默认 skip：需本机装有 jcode 且其自身已配好 provider 凭据（spec R4-6：shim 不搬运
 * ACode 凭据，ACP 面无凭据协商）。跑法：
 *   ACODE_JCODE_E2E=1 [ACODE_JCODE_E2E_BINARY=<path>] pnpm --filter @acode/services test
 */

const { ACodeAgentProcessManager } = await import("../src/acode-agent/acodeAgentProcessManager.ts");
// V4_METHODS = RPC 方法（command / conversation/subscribe / capabilities/query）；
// V4_NOTIFICATIONS = 下行通知（conversationFrame 在这里，不在 METHODS——用错会让通知
// 过滤器静默失配、帧一个都收不到）。
const { V4_METHODS, V4_NOTIFICATIONS } =
  await import("../../../packages/shared/src/acode-protocol-v4/index.ts");
const { acodeProtocolNotifications } =
  await import("../../../packages/shared/src/acode-protocol/index.ts");

const ENABLED = process.env.ACODE_JCODE_E2E === "1";
const JCODE_BINARY = process.env.ACODE_JCODE_E2E_BINARY ?? "jcode";
/** 真模型执行一轮带工具调用的会话，留足余量。 */
const TURN_TIMEOUT_MS = 180_000;
const HARD_TIMEOUT_MS = 300_000;
/** 帧停滞判定：真模型跑完即不再产帧，早退避免白等满超时。 */
const STALL_MS = 30_000;

const skipReason = ENABLED
  ? false
  : "需要本机 jcode + 其自身 provider 凭据；设 ACODE_JCODE_E2E=1 开启（见文件头注）";

/** 仓库根 → apps/acode-cli 的 cli 源入口与根 tsx loader。 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliEntry = join(repoRoot, "apps/acode-cli/packages/cli/src/main.ts");
// Windows 上 node --import 只接受 file/data/node scheme，裸 C:/ 会被当协议 "c:"。
const tsxLoader = pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href;

/** 轮询等待谓词成立。 */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待超时: ${label} (${timeoutMs}ms)`);
}

test(
  "真实客户端栈：ACodeAgentProcessManager 经 env 覆盖 spawn shim，ACodeProtocolClient 收 v4 帧跑通真模型一轮",
  { skip: skipReason, timeout: HARD_TIMEOUT_MS + 30_000 },
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acode-jcode-real-"));
    await writeFile(join(workspace, "probe.txt"), "real client stack\n", "utf8");

    // env 覆盖（agent-command-env-gate.md R1：非打包态生效）。命令 = node + tsx loader +
    // cli 源入口 + jcode-bridge 子命令。cwd 必须是普通 workspace，绝不能是 jcode 源码检出
    // （spec R4-3：jcode 在自己 repo 内启动普通 session 会自动进 self-dev）。
    const savedEnv = { ...process.env };
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
    // 真实客户端栈不该被打包态标记影响；显式清掉以防外部环境残留。
    delete process.env.ACODE_APP_IS_PACKAGED;
    // R4-2：shim 自己会注入这两个给 jcode，此处同时给 shim 进程也带上（无害且一致）。
    process.env.JCODE_NO_TELEMETRY = "1";
    process.env.DO_NOT_TRACK = "1";

    // presentationSurface: "desktop" → 命令解析会追加 --surface desktop（spec R1 要求 shim
    // 接受 native 形态参数不报错）。这条路径正是桌面 Host 走的，故如实设为 desktop。
    const manager = new ACodeAgentProcessManager({ presentationSurface: "desktop" });

    /** 收集 v4 conversation 帧（ACodeProtocolClient 的 onNotification）。 */
    const frames = [];
    const storageFrames = [];
    // onNotification 返回 @acode/rpc 的 IDisposable（VS Code 风格 Emitter.event），
    // 不是取消订阅函数——调 .dispose() 而非直接调用。
    let notificationSubscription = null;

    try {
      // 1. 真实 spawn：getClient 触发 resolveDefaultACodeAgentCommand → env 覆盖 → spawn。
      const client = await manager.getClient({ workspacePath: workspace });
      assert.ok(client, "getClient 必须返回 ACodeProtocolClient");

      notificationSubscription = client.onNotification((notification) => {
        if (notification.method === acodeProtocolNotifications.storageStartup) {
          storageFrames.push(notification.params);
          return;
        }
        if (notification.method === V4_NOTIFICATIONS.conversationFrame) {
          frames.push(notification.params);
        }
      });

      // 2. capabilitiesQuery 经真实 client（会先过 storage gate；shim 发了 phase=ready 帧）。
      const capability = await client.request(V4_METHODS.capabilitiesQuery, {
        capability: "independentPlanState",
      });
      assert.equal(
        capability?.supported,
        false,
        "jcode 后端必须如实申报不支持 independentPlanState（spec R4-1 诚实降级）",
      );

      // 3. createSession（真实 v4/command 信封）。
      const createAck = await client.request(V4_METHODS.command, {
        commandId: crypto.randomUUID(),
        clientId: "real-client-test",
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: workspace },
        issuedAt: Date.now(),
      });
      assert.equal(
        createAck?.status,
        "accepted",
        `createSession 应 accepted，实得 ${createAck?.status}/${createAck?.reasonCode ?? "-"}`,
      );
      const v4SessionId = createAck?.result?.sessionId;
      assert.equal(typeof v4SessionId, "string", "createSession 必须返回 v4 sessionId");
      assert.ok(
        v4SessionId.startsWith("jcode-"),
        `sessionId 应为 shim 自造（jcode- 前缀），实得 ${v4SessionId}`,
      );

      // 4. subscribe：真实 client 走 v4/conversation/subscribe，initialWires 经
      //    post-response outbox 在 ACK 之后送达（dispatch.ts 的 outbox 语义）。
      const subAck = await client.request(V4_METHODS.conversationSubscribe, {
        topic: `conversation/${v4SessionId}`,
        connectionId: "conn-real-client",
        clientMode: "desktop-continuous",
      });
      assert.equal(
        typeof subAck?.ack?.subscriptionId,
        "string",
        "subscribe 必须返回 subscriptionId",
      );
      assert.equal(subAck?.ack?.mode, "snapshot", "首次订阅应走 snapshot 模式");
      await waitFor(
        () => frames.some((f) => logicalPayload(f)?.kind === "snapshot"),
        15_000,
        "initial snapshot 帧",
      );

      // 5. sendText：真实 client 发命令，断言立即拿到 inputAccepted 收据（spec R5）。
      const sendAck = await client.request(V4_METHODS.command, {
        commandId: crypto.randomUUID(),
        clientId: "real-client-test",
        sessionId: v4SessionId,
        type: "sendText",
        payload: {
          text: "Read the file probe.txt in the current directory and tell me its exact contents. Use your file-reading tool.",
        },
        issuedAt: Date.now(),
      });
      assert.equal(sendAck?.status, "accepted");
      assert.equal(sendAck?.result?.type, "inputAccepted", "sendText 必须返回 inputAccepted 收据");

      // 6. 等真模型跑完一轮（经真实 client 的通知流收帧）。
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

      // 7. 断言真实客户端收到的投影产物。
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
        (textRow?.text ?? "").includes("real client stack"),
        `assistantText 应含 probe.txt 真实内容，实得 "${(textRow?.text ?? "").slice(0, 160)}"`,
      );
      const toolRows = rows.filter((row) => row.kind === "toolCall");
      assert.ok(toolRows.length >= 1, "应有 toolCall row（工具卡）");
      assert.ok(
        toolRows.every((row) => row.status === "success" || row.status === "error"),
        `工具 row 应达终态，实得 [${toolRows.map((r) => `${r.toolName}:${r.status}`).join(", ")}]`,
      );
      // jcode 一轮会产生 16–27 个 tool_call_update 增量帧，必须归并成一个 row。
      assert.equal(toolRows.length, 1, `工具增量帧应归并成一个 row，实得 ${toolRows.length}`);

      // 8. 不支持的命令经真实 client 显式 failed（spec R5，不静默 noop）。
      const renameAck = await client.request(V4_METHODS.command, {
        commandId: crypto.randomUUID(),
        clientId: "real-client-test",
        sessionId: v4SessionId,
        type: "renameSession",
        payload: { title: "real client renamed" },
        issuedAt: Date.now(),
      });
      assert.equal(renameAck?.status, "failed", `不支持命令应 failed，实得 ${renameAck?.status}`);
      assert.equal(
        renameAck?.reasonCode,
        "fault.capability.unsupportedByExternalAgent",
        `reasonCode 应为稳定能力码，实得 ${renameAck?.reasonCode ?? "-"}`,
      );

      // 9. 真实 dispose：disposeAllAndWait 必须能收干净进程树（不留孤儿 jcode）。
      await manager.disposeAllAndWait();
      console.error(
        `[real-client] 帧数=${frames.length} rows=${rows.length} kinds=[${[...new Set(kinds)].join(",")}] storage帧=${storageFrames.length}`,
      );
    } finally {
      notificationSubscription?.dispose();
      try {
        await manager.disposeAllAndWait();
      } catch {
        // finally 里二次 dispose 可能已关；不影响断言结论。
      }
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

/**
 * 物理 wire frame 是二级帧：{wireVersion, kind:"complete", topic, subscriptionId,
 * frame: <逻辑帧>}——payload 在内层 frame.frame.payload。
 */
function logicalPayload(wire) {
  if (!wire || wire.kind === "fragment") return null; // 本测试不重组分片
  const inner = wire.frame ?? wire;
  return inner?.payload ?? wire.payload ?? null;
}

/** 归约全部帧为 row 集合（后到的 upsert 覆盖），复刻客户端投影消费语义。 */
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
