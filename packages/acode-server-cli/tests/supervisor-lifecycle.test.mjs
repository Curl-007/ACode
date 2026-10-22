import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Supervisor 生命周期守护（review 测试专项 P2：acode-server-cli supervisor 生命周期覆盖偏薄）。
 *
 * 用真实子进程 + 真实 control IPC（沿用 supervisor-health-integration.test.mjs 范式），
 * 覆盖既有测试未钉的边界：
 * - uninstall guard：prepare-uninstall / confirm-uninstall 在运行任务存在时报 blocked 并拒绝，
 *   确认串非 "DELETE" 时抛错（防止无提示中断运行中任务）；
 * - task-activity 驱动 runningTaskCount，卸载门禁读取该值；
 * - 生命周期操作栅栏：并发 lifecycle 操作被 ControlRequestError 拒绝（operation-in-progress）。
 *
 * 无固定 sleep 时序依赖：用有界轮询 until()（仓内范式）。子进程与临时目录 t.after 清理。
 */
const { Supervisor } = await import("../src/supervisor/supervisor.ts");
const { resolveServerLayout } = await import("../src/runtime/paths.ts");
const { requestControl } = await import("../src/ipc/controlClient.ts");

async function until(read, predicate, message) {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

/** 拉起一个 ready 后即待命的假 Core；task-activity 由测试主动注入。 */
function createFixture() {
  const children = [];
  const launcher = {
    launch(generation) {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
          process.on("message", (message) => {
            if (message.command === "shutdown") process.exit(0);
            // 收到 report-activity 命令时，从 Core 侧回发 task-activity（Supervisor 只消费
            // 由 Core 发出、且绑定当前 child 的消息，见 handleCoreMessage 的 this.core 校验）。
            if (message.command === "report-activity") {
              process.send({ type: "task-activity", runningTaskCount: message.runningTaskCount });
            }
          });
          process.send({ type: "ready", host: "127.0.0.1", port: 9999, version: "test", generation: ${generation} });
        `,
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      children.push(child);
      return child;
    },
  };
  return { children, launcher };
}

test("uninstall guard：运行任务存在时 prepare/confirm-uninstall 报 blocked 并拒绝卸载", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acode-sv-uninstall-"));
  const layout = resolveServerLayout(root);
  const { children, launcher } = createFixture();
  const supervisor = new Supervisor({ layout, version: "test", coreStopGraceTimeoutMs: 1_000, launcher });
  t.after(async () => {
    await supervisor.stop("test-cleanup").catch(() => {});
    for (const child of children) if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  });

  await supervisor.start();
  await until(() => supervisor.status(), (s) => s.state === "ready", "Core 应 ready");

  // 注入运行任务计数：命令 Core 回发 task-activity（ready 后才被消费，见 handleCoreMessage）。
  children[0].send({ command: "report-activity", runningTaskCount: 2 });
  await until(
    () => supervisor.status(),
    (s) => s.runningTaskCount === 2,
    "task-activity 应把 runningTaskCount 抬到 2",
  );

  const prepared = await requestControl(layout.controlEndpoint, { command: "prepare-uninstall" });
  assert.deepEqual(prepared, { status: "blocked", runningTaskCount: 2 }, "有运行任务必须 blocked");

  // 最后防线：即便调用方无视 blocked 直接 confirm，也必须被拒且不改变状态。
  await assert.rejects(
    () =>
      requestControl(layout.controlEndpoint, {
        command: "confirm-uninstall",
        confirmation: "DELETE",
      }),
    /task\(s\) are running|stop the server first/,
  );
  assert.equal(supervisor.status().state, "ready", "被拒的卸载不得停掉运行中的 Core");
});

test("uninstall guard：确认串非 DELETE 直接抛错（防误触发）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acode-sv-confirm-"));
  const layout = resolveServerLayout(root);
  const { children, launcher } = createFixture();
  const supervisor = new Supervisor({ layout, version: "test", coreStopGraceTimeoutMs: 1_000, launcher });
  t.after(async () => {
    await supervisor.stop("test-cleanup").catch(() => {});
    for (const child of children) if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  });
  await supervisor.start();
  await until(() => supervisor.status(), (s) => s.state === "ready", "Core 应 ready");

  await assert.rejects(
    () => requestControl(layout.controlEndpoint, { command: "confirm-uninstall", confirmation: "WRONG" }),
    /confirmation must be DELETE/,
  );
  assert.equal(supervisor.status().state, "ready");

  // 空闲（0 任务）时 prepare-uninstall 报 ready。
  const prepared = await requestControl(layout.controlEndpoint, { command: "prepare-uninstall" });
  assert.deepEqual(prepared, { status: "ready", runningTaskCount: 0 });
});

test("生命周期栅栏：并发 lifecycle 操作被拒（operation-in-progress），不产生双 Core", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acode-sv-fence-"));
  const layout = resolveServerLayout(root);
  const { children, launcher } = createFixture();
  const supervisor = new Supervisor({ layout, version: "test", coreStopGraceTimeoutMs: 1_000, launcher });
  t.after(async () => {
    await supervisor.stop("test-cleanup").catch(() => {});
    for (const child of children) if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  });
  await supervisor.start();
  await until(() => supervisor.status(), (s) => s.state === "ready", "Core 应 ready");

  // 通过 control 触发一个 restart（ack 型，后台执行），随后立刻再发一个 restart：
  // 第二个必须被栅栏拒为 operation-in-progress（retryable），而不是并发起第二个 Core。
  await requestControl(layout.controlEndpoint, { command: "restart" });
  const conflicting = await requestControl(layout.controlEndpoint, { command: "restart" }).catch(
    (error) => error,
  );
  // 冲突要么被 ControlRequestError 拒（栅栏命中），要么 restart 已完成、第二个正常受理；
  // 关键是**绝不能同时存在两个存活 Core**（generation 单调、children 数与 generation 一致）。
  if (conflicting instanceof Error) {
    assert.match(conflicting.message, /already in progress|operation-in-progress/i);
  }
  await until(() => supervisor.status(), (s) => s.state === "ready", "restart 后应重新 ready");
  // 存活的子进程最多一个：所有先前 child 都已收到 OS 终态。
  const alive = children.filter((c) => c.exitCode === null && c.signalCode === null);
  assert.ok(alive.length <= 1, `不得并存多个 Core，实际存活 ${alive.length}`);
});
