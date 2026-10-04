// chat lane 空闲回收的 Host 侧归因测试(spec: packages/services/specs/chat-lane-idle-reclaim.md R3)。
// fixture 用 node -e 模拟两类 CLI 退出:
// A. 宣告帧丢失,仅保留退出码 85 → 兜底归因 expected/cli-idle-exit-code;
// B. 先发 runtime/idleExit 宣告帧再退出 → 主路径归因 expected/cli-idle-exit。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ACODE_AGENT_IDLE_EXIT_CODE } from "@acode/shared";
import { ACodeAgentProcessManager } from "../src/acode-agent/acodeAgentProcessManager.js";
import type {
  RuntimeProcessExitEvent,
  RuntimeProcessSpawnEvent,
} from "../src/process/runtimeProcessLifecycle.js";

const EXIT_WAIT_TIMEOUT_MS = 15_000;

function createHarness(script: string) {
  const exits: RuntimeProcessExitEvent[] = [];
  const spawns: RuntimeProcessSpawnEvent[] = [];
  const manager = new ACodeAgentProcessManager({
    commandResolver: () => ({
      command: process.execPath,
      args: ["--input-type=module", "-e", script],
    }),
    processLifecycleReporter: {
      onSpawn: (event) => spawns.push(event),
      onExit: (event) => exits.push(event),
    },
  });
  return { manager, exits, spawns };
}

async function waitForExit(exits: RuntimeProcessExitEvent[]): Promise<RuntimeProcessExitEvent> {
  const deadline = Date.now() + EXIT_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exits.length > 0) return exits[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for agent process exit event");
}

test("退出码兜底:无宣告帧的 exit 85 归因 expected/cli-idle-exit-code", async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "acode-idle-exit-code-"));
  const { manager, exits } = createHarness(`process.exit(${ACODE_AGENT_IDLE_EXIT_CODE});`);
  t.after(async () => {
    manager.disposeAll();
    await rm(workspacePath, { recursive: true, force: true });
  });

  // 进程立即退出;getClient 允许失败,断言目标是 onExit 归因。
  await manager.getClient({ workspacePath }).catch(() => undefined);
  const exit = await waitForExit(exits);

  assert.equal(exit.exitCode, ACODE_AGENT_IDLE_EXIT_CODE);
  assert.equal(exit.terminationKind, "expected");
  assert.equal(exit.terminationReason, "cli-idle-exit-code");
});

test("宣告帧主路径:runtime/idleExit 后退出归因 expected/cli-idle-exit", async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "acode-idle-exit-announce-"));
  const script = [
    `process.stdout.write(JSON.stringify({`,
    `method: "runtime/idleExit",`,
    `params: { quiescentMs: 900000 }`,
    `}) + "\\n");`,
    `setTimeout(() => process.exit(${ACODE_AGENT_IDLE_EXIT_CODE}), 300);`,
  ].join("");
  const { manager, exits } = createHarness(script);
  t.after(async () => {
    manager.disposeAll();
    await rm(workspacePath, { recursive: true, force: true });
  });

  await manager.getClient({ workspacePath }).catch(() => undefined);
  const exit = await waitForExit(exits);

  assert.equal(exit.exitCode, ACODE_AGENT_IDLE_EXIT_CODE);
  assert.equal(exit.terminationKind, "expected");
  assert.equal(exit.terminationReason, "cli-idle-exit");
});

test("非保留退出码维持 unexpected 归因(回归护栏)", async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "acode-idle-exit-unexpected-"));
  const { manager, exits } = createHarness(`process.exit(3);`);
  t.after(async () => {
    manager.disposeAll();
    await rm(workspacePath, { recursive: true, force: true });
  });

  await manager.getClient({ workspacePath }).catch(() => undefined);
  const exit = await waitForExit(exits);

  assert.equal(exit.exitCode, 3);
  assert.equal(exit.terminationKind, "unexpected");
  assert.notEqual(exit.terminationReason, "cli-idle-exit-code");
});
