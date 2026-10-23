// jcode-bridge 全链真进程端到端冒烟（specs/jcode-agent-bridge.md 附录 A.4）。
//
// 覆盖 in-process 单测（jcode-bridge-event-translator.test.mjs）与 spike 裸 ACP 实测
// 之间缺的最后一环：**真 v4 客户端 → 真 shim 进程（v4 stdio）→ 真 jcode 子进程（ACP）
// → 真模型**，断言客户端确实收到网关产出的 snapshot/delta 帧与正确的 row 投影。
//
// 为什么默认 skip：需要本机装有 jcode，且 jcode 自身已配好 provider 凭据
// （spec R4-6：shim 不搬运 ACode 凭据，ACP 面无凭据协商）。CI 无这两者，故默认跳过，
// 显式 opt-in 才跑。跑法：
//   ACODE_JCODE_E2E=1 pnpm --dir apps/acode-cli test
// 可选 ACODE_JCODE_E2E_BINARY=<path> 指定 jcode 路径（缺省从 PATH 解析）。
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const ENABLED = process.env.ACODE_JCODE_E2E === "1";
const JCODE_BINARY = process.env.ACODE_JCODE_E2E_BINARY ?? "jcode";
const TURN_TIMEOUT_MS = 180_000;
const HARD_TIMEOUT_MS = 240_000;
/** 帧停滞判定：真模型跑完后不再产帧，早退避免白等满超时。 */
const STALL_MS = 25_000;

const skipReason = ENABLED
  ? false
  : "需要本机 jcode + 其自身 provider 凭据；设 ACODE_JCODE_E2E=1 开启（见文件头注）";

test(
  "jcode-bridge 端到端：真 v4 客户端经真 shim 驱动真 jcode 跑完一轮带工具调用的会话",
  { skip: skipReason, timeout: HARD_TIMEOUT_MS + 30_000 },
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "acode-jcode-e2e-"));
    writeFileSync(join(workspace, "probe.txt"), "hello e2e\n", "utf8");

    // cli 包的源入口 + tsx loader 都必须用绝对 file:// URL：spawn 的 cwd 是 temp
    // workspace（不在仓库下），裸 `--import tsx` 无法从 cwd 解析；且 Windows 上
    // node --import 只接受 file/data/node scheme，裸 C:/ 路径会被当成协议 "c:"
    // 报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
    const cliEntry = fileURLToPath(new URL("../packages/cli/src/main.ts", import.meta.url));
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const tsxLoader = pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href;

    const child = spawn(
      process.execPath,
      ["--import", tsxLoader, cliEntry, "jcode-bridge", "--stdio", "--jcode-binary", JCODE_BINARY],
      {
        // R4-3：cwd 绝不能是 jcode 源码检出（否则 jcode 自动进 self-dev）。
        cwd: workspace,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, JCODE_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" },
      },
    );

    const stderrTail = [];
    child.stderr.setEncoding("utf8");
    createInterface({ input: child.stderr }).on("line", (line) => {
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
    });

    let nextId = 1;
    const pending = new Map();
    const frames = [];
    let storageFrame = null;
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // 非协议行（三方依赖噪音）：忽略，同 acp-client 的容错纪律
      }
      if (msg.method === "startup/storageState") {
        storageFrame = msg.params;
        return;
      }
      if (msg.method === "v4/conversation/frame") {
        frames.push(msg.params);
        return;
      }
      if (msg.method) return;
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    });

    const request = (method, params, timeoutMs = 60_000) => {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`v4 request timed out: ${method}`));
        }, timeoutMs);
        timer.unref?.();
      });
    };
    const envelope = (type, sessionId, payload) => ({
      commandId: randomUUID(),
      clientId: "e2e-smoke-client",
      sessionId,
      type,
      payload,
      issuedAt: Date.now(),
    });

    /**
     * 物理 wire frame 是二级帧：{wireVersion, kind:"complete", topic, subscriptionId,
     * frame: <逻辑帧>}——payload 在内层 frame.frame.payload（同 repro 测试的
     * `frame.payload ?? frame.frame?.payload` 双形态兜底）。
     */
    const logicalPayload = (wire) => {
      if (!wire || wire.kind === "fragment") return null; // 冒烟不重组分片
      const inner = wire.frame ?? wire;
      return inner?.payload ?? wire.payload ?? null;
    };

    /** 归约全部帧为 row 集合（后到的 upsert 覆盖），复刻客户端投影消费语义。 */
    const collectRows = () => {
      const rows = new Map();
      for (const frame of frames) {
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
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    try {
      // 1. storage 首帧（spec 验收场景 1）。
      for (let i = 0; i < 120 && !storageFrame; i++) await sleep(250);
      assert.equal(storageFrame?.phase, "ready", "storage 首帧必须 phase=ready");

      // 2. capabilitiesQuery 诚实降级（spec R4-1：jcode 后端无 plan 一等状态）。
      const capability = await request("v4/capabilities/query", {
        capability: "independentPlanState",
      });
      assert.equal(
        capability?.supported,
        false,
        "jcode 后端必须如实申报不支持 independentPlanState",
      );

      // 3. createSession（spec R2：ACP session/new；返回 shim 自造的 v4 sessionId）。
      const createAck = await request(
        "v4/command",
        envelope("createSession", null, { workspaceId: workspace }),
      );
      assert.equal(
        createAck?.status,
        "accepted",
        `createSession 应 accepted，实得 ${createAck?.status}/${createAck?.reasonCode ?? "-"}`,
      );
      const v4SessionId = createAck?.result?.sessionId;
      assert.equal(typeof v4SessionId, "string", "createSession 必须返回 v4 sessionId");
      assert.ok(
        v4SessionId.startsWith("jcode-"),
        `v4 sessionId 应为 shim 自造（jcode- 前缀），实得 ${v4SessionId}`,
      );

      // 4. subscribe：拿到 initial snapshot 帧。
      const subAck = await request("v4/conversation/subscribe", {
        topic: `conversation/${v4SessionId}`,
        connectionId: "conn-e2e",
        clientMode: "desktop-continuous",
      });
      assert.equal(
        typeof subAck?.ack?.subscriptionId,
        "string",
        "subscribe 必须返回 subscriptionId",
      );
      assert.equal(subAck?.ack?.mode, "snapshot", "首次订阅应走 snapshot 模式");
      await sleep(1500);
      assert.ok(
        frames.some((f) => logicalPayload(f)?.kind === "snapshot"),
        "必须收到 initial snapshot 帧",
      );

      // 5. sendText：立即返回 inputAccepted 收据（spec R5：不 await 整轮）。
      const sendAck = await request(
        "v4/command",
        envelope("sendText", v4SessionId, {
          text: "Read the file probe.txt in the current directory and tell me its exact contents. Use your file-reading tool.",
        }),
      );
      assert.equal(sendAck?.status, "accepted");
      assert.equal(sendAck?.result?.type, "inputAccepted", "sendText 必须返回 inputAccepted 收据");
      assert.equal(sendAck?.result?.delivery, "startNow");

      // 6. 等轮次收口（真模型执行 + 真工具调用）。
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      let lastFrameCount = -1;
      let lastGrowth = Date.now();
      let rows = [];
      let header = null;
      while (Date.now() < deadline) {
        rows = collectRows();
        header = rows.find((r) => r.kind === "turnHeader");
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
        await sleep(500);
      }

      // 7. 断言投影产物（spec 验收场景 2/3/4）。
      assert.equal(
        header?.state,
        "completedSuccess",
        `turnHeader 应 completedSuccess，实得 ${header?.state ?? "无 turnHeader"}`,
      );
      const kinds = rows.map((r) => r.kind);
      assert.ok(
        kinds.includes("userInput"),
        `应有 userInput row，实得 kinds=[${[...new Set(kinds)].join(",")}]`,
      );
      assert.ok(kinds.includes("assistantText"), "应有 assistantText row");
      const textRow = rows.find((r) => r.kind === "assistantText");
      assert.ok(
        (textRow?.text ?? "").includes("hello e2e"),
        `assistantText 应含 probe.txt 真实内容，实得 "${(textRow?.text ?? "").slice(0, 160)}"`,
      );
      // 工具卡：jcode 的 16–27 个 tool_call_update 增量帧必须归并成**一个** row。
      const toolRows = rows.filter((r) => r.kind === "toolCall");
      assert.ok(toolRows.length >= 1, "应有 toolCall row（工具卡）");
      assert.ok(
        toolRows.every((r) => r.status === "success" || r.status === "error"),
        `工具 row 应达终态，实得 [${toolRows.map((r) => `${r.toolName}:${r.status}`).join(", ")}]`,
      );

      // 8. stop 幂等（spike §4.3：空闲会话 cancel 返回 {} 无错）。
      const stopAck = await request("v4/command", envelope("stop", v4SessionId, {}));
      assert.notEqual(stopAck?.status, "failed", `stop 应幂等不失败，实得 ${stopAck?.status}`);

      // 9. 不支持的命令显式 failed（spec R5：不静默 noop 骗客户端）。
      //    用 renameSession：payload 仅 {title}，不在 CAS 清单、非 row-targeting，
      //    故能穿过 inbox 校验直达 executeCommand 的 unsupported 分支。
      const renameAck = await request(
        "v4/command",
        envelope("renameSession", v4SessionId, { title: "e2e renamed" }),
      );
      assert.equal(renameAck?.status, "failed", `不支持命令应 failed，实得 ${renameAck?.status}`);
      assert.equal(
        renameAck?.reasonCode,
        "fault.capability.unsupportedByExternalAgent",
        `reasonCode 应为稳定能力码，实得 ${renameAck?.reasonCode ?? "-"}`,
      );
    } finally {
      child.kill();
      await sleep(300);
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        // 临时目录清理失败不影响断言结论。
      }
      if (stderrTail.length > 0) {
        // 留痕：失败时 shim 侧诊断是首要线索（含 spawn 参数与遥测关闭状态）。
        console.error(
          "[jcode-bridge e2e] shim stderr tail:\n" +
            stderrTail
              .slice(-10)
              .map((l) => `  ${l}`)
              .join("\n"),
        );
      }
    }
  },
);
