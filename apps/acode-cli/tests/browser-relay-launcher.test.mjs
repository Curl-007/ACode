// relay 独立启动器测试：parseRelayArgs 纯函数矩阵 + runRelayLauncher 启动/信号关停/端口占用三路径。
// 启动面归属见 specs/browser-relay-inplace-capture.md「集成与共享桶申请」节。
import assert from "node:assert/strict";
import { test } from "node:test";

const { parseRelayArgs, runRelayLauncher, DEFAULT_RELAY_PORT } = await import(
  "../packages/browser-use-plugin/src/relay/main.ts"
);

test("parseRelayArgs：缺省 port=9224、group 开、无 token", () => {
  const parsed = parseRelayArgs([]);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.options, { port: DEFAULT_RELAY_PORT, group: true });
});

test("parseRelayArgs：--port 值与 = 双形态、0 临时端口", () => {
  assert.deepEqual(parseRelayArgs(["--port", "9333"]).options.port, 9333);
  assert.deepEqual(parseRelayArgs(["--port=9333"]).options.port, 9333);
  assert.deepEqual(parseRelayArgs(["--port", "0"]).options.port, 0);
});

test("parseRelayArgs：坏 port 拒绝（非数字/超界/缺值）", () => {
  for (const argv of [["--port", "abc"], ["--port", "70000"], ["--port"]]) {
    const parsed = parseRelayArgs(argv);
    assert.equal(parsed.ok, false, JSON.stringify(argv));
    assert.match(parsed.error, /--port/);
  }
});

test("parseRelayArgs：--token 收下但错误信息不回显值（安全红线）", () => {
  const parsed = parseRelayArgs(["--token", "s3cret"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.options.token, "s3cret");
  const empty = parseRelayArgs(["--token", "  "]);
  assert.equal(empty.ok, false);
  assert.ok(!empty.error.includes("s3cret"));
});

test("parseRelayArgs：--no-group 关组、带值拒绝；--help；未知旗标", () => {
  assert.equal(parseRelayArgs(["--no-group"]).options.group, false);
  assert.equal(parseRelayArgs(["--no-group=1"]).ok, false);
  assert.equal(parseRelayArgs(["--help"]).help, true);
  const unknown = parseRelayArgs(["--wat"]);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /未知参数/);
});

/** 收集输出的 io 桩；onSignal 由测试握柄触发。 */
function createIoHarness() {
  const stdoutLines = [];
  const stderrLines = [];
  let fireSignal = () => {};
  return {
    stdoutLines,
    stderrLines,
    io: {
      stdout: (line) => stdoutLines.push(line),
      stderr: (line) => stderrLines.push(line),
      onSignal: (handler) => {
        fireSignal = handler;
        return () => {};
      },
    },
    fireSignal: () => fireSignal(),
  };
}

test("runRelayLauncher：port 0 启动→listening 行含实际端口→信号关停退出码 0", async () => {
  const harness = createIoHarness();
  const exitPromise = runRelayLauncher({ port: 0, group: true }, harness.io);
  // 轮询等待 listening 行（无事件面可挂，桩 io 只有行回调）。
  for (let attempt = 0; attempt < 200 && harness.stdoutLines.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const listening = harness.stdoutLines.find((line) => line.includes("listening on 127.0.0.1:"));
  assert.ok(listening, `未出现 listening 行：${JSON.stringify(harness.stdoutLines)}`);
  assert.ok(!harness.stdoutLines.join("\n").includes("undefined"));
  harness.fireSignal();
  assert.equal(await exitPromise, 0);
});

test("runRelayLauncher：token 值不进任何输出行", async () => {
  const harness = createIoHarness();
  const exitPromise = runRelayLauncher({ port: 0, token: "sup3r-secret", group: false }, harness.io);
  for (let attempt = 0; attempt < 200 && harness.stdoutLines.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const all = [...harness.stdoutLines, ...harness.stderrLines].join("\n");
  assert.ok(!all.includes("sup3r-secret"));
  assert.match(all, /token auth: on/);
  assert.match(all, /tab group: off/);
  harness.fireSignal();
  assert.equal(await exitPromise, 0);
});

test("runRelayLauncher：端口被占→显式报端口占用并退出码 1（不静默抢占）", async () => {
  const first = createIoHarness();
  const firstExit = runRelayLauncher({ port: 0, group: true }, first.io);
  for (let attempt = 0; attempt < 200 && first.stdoutLines.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const listening = first.stdoutLines.find((line) => line.includes("listening on 127.0.0.1:"));
  assert.ok(listening);
  const busyPort = Number(listening.split("127.0.0.1:")[1]);
  const second = createIoHarness();
  const secondExit = await runRelayLauncher({ port: busyPort, group: true }, second.io);
  assert.equal(secondExit, 1);
  assert.match(second.stderrLines.join("\n"), /端口可能已被另一个 relay/);
  first.fireSignal();
  assert.equal(await firstExit, 0);
});
