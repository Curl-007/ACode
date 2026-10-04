// Harness SDK parity 测试：SDK 面 vs 直接 NDJSON 逐方法对照（jcode TS/Rust parity 同款方法论）
// + launch 隔离断言 + Unknown 兜底/seq gap/权限 fail-closed/结构化输出/断连归因。
// 子进程与 server 测试共用同一桩件入口（packages/server/tests/harness-stub-services-entry.mjs）：
// 协议/翻译桥/SDK 行为全部真实，services 层公开接口脚本化。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { z } from "zod";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const stubEntry = join(repoRoot, "packages", "server", "tests", "harness-stub-services-entry.mjs");

const {
  AcodeHarnessClient,
  HarnessStructuredOutputError,
  HarnessDisconnectError,
  HarnessRpcError,
  HarnessLaunchError,
  describeDisconnect,
  prepareLaunchRuntime,
} = await import("../src/index.ts");
const harnessApi = await import("@acode/shared/harness-api");

const WORKSPACE = "C:\\workspace\\sdk-parity";

function spawnArgs() {
  return { command: process.execPath, args: ["--import", "tsx", stubEntry] };
}

/** 直接 NDJSON 客户端（不经 SDK）——parity 对照的另一面。 */
class RawNdjson {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.frames = [];
    this.waiters = [];
    child.stdout.on("data", (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        const frame = JSON.parse(line);
        this.frames.push(frame);
        if (frame.kind === "response" && this.pending.has(frame.id)) {
          const { resolve } = this.pending.get(frame.id);
          this.pending.delete(frame.id);
          resolve(frame);
        }
        for (const waiter of this.waiters.splice(0)) waiter(frame);
      }
      index = this.buffer.indexOf("\n");
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve) => this.pending.set(id, { resolve }));
    this.child.stdin.write(`${JSON.stringify({ v: 1, kind: "request", id, method, params })}\n`);
    return promise;
  }

  waitFor(predicate, timeoutMs = 8_000) {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`frame wait timeout; frames=${JSON.stringify(this.frames.slice(-6))}`)),
        timeoutMs,
      );
      const check = (frame) => {
        if (predicate(frame)) {
          clearTimeout(timer);
          resolve(frame);
        } else {
          this.waiters.push(check);
        }
      };
      this.waiters.push(check);
    });
  }

  async close() {
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 3_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function launchRaw(env = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", stubEntry], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const raw = new RawNdjson(child);
  child.stdin.write(
    `${JSON.stringify({ v: 1, kind: "hello", client: "raw-parity", capabilities: [] })}\n`,
  );
  await raw.waitFor((frame) => frame.kind === "hello_ack", 15_000);
  return raw;
}

test("SDK 面与直接 NDJSON 逐方法 parity（run 结果一致 / list / models / 文件面）", async () => {
  const sdk = await AcodeHarnessClient.connect({ transport: "stdio", ...spawnArgs() });
  const raw = await launchRaw();
  try {
    assert.equal(sdk.serverInfo.server, "acode-harness-stub");
    assert.ok(sdk.serverInfo.protocolMinor >= 0);

    // list 空（SDK vs raw）。
    const sdkListEmpty = await sdk.listSessions({ workspacePath: WORKSPACE });
    const rawListEmpty = (await raw.request("list_sessions", { workspacePath: WORKSPACE })).result;
    assert.deepEqual(sdkListEmpty, rawListEmpty.sessions);

    // create（SDK）→ run vs raw create+run 相同输入相同结果。
    const session = await sdk.createSession({ cwd: WORKSPACE, mode: "build" });
    const runViaSdk = await session.run("ping");
    const rawCreated = await raw.request("create_session", {
      workspacePath: WORKSPACE,
      mode: "build",
    });
    const runViaRaw = (
      await raw.request("run", {
        workspacePath: WORKSPACE,
        sessionId: rawCreated.result.sessionId,
        content: "ping",
      })
    ).result;
    assert.equal(runViaSdk.resultType, runViaRaw.resultType);
    assert.equal(runViaSdk.response, runViaRaw.response);
    assert.deepEqual(runViaSdk.usage, runViaRaw.usage);

    // run 与 send+事件等待一致（SDK 内 parity）。
    const session2 = await sdk.createSession({ cwd: WORKSPACE });
    const iterator = session2.events();
    const donePromise = (async () => {
      for await (const { event } of iterator) {
        if (event.kind === "turn_done") return event;
      }
      return undefined;
    })();
    await session2.send("ping");
    const doneEvent = await donePromise;
    const runDirect = await session2.run("ping");
    assert.equal(doneEvent.resultType, runDirect.resultType);
    assert.equal(doneEvent.response, runDirect.response);

    // get_models / 文件面 parity。
    const models = await sdk.getModels();
    const rawModels = (await raw.request("get_models", {})).result;
    assert.deepEqual(models, rawModels);

    const tempDir = await mkdtemp(join(tmpdir(), "sdk-parity-"));
    const filePath = join(tempDir, "note.txt");
    await writeFile(filePath, "hello sdk parity", "utf8");
    const readViaSdk = await sdk.readFile({ path: filePath });
    const readViaRaw = (await raw.request("read_file", { path: filePath })).result;
    assert.deepEqual(readViaSdk, readViaRaw);
    const findViaSdk = await sdk.findFiles({ rootPath: tempDir, query: "note" });
    assert.equal(findViaSdk.entries.length, 1);

    // fork / rewind / configure_tools 语义一致（rewind/configure_tools 如实降级）。
    const forked = await session.fork();
    assert.notEqual(forked.sessionId, session.sessionId);
    await assert.rejects(
      session.rewind(),
      (error) => error instanceof HarnessRpcError && error.code === "not_supported",
    );
    await assert.rejects(
      session.configureTools({ disable: ["Bash"] }),
      (error) => error instanceof HarnessRpcError && error.code === "not_supported",
    );

    await iterator.return?.();
  } finally {
    await sdk.close();
    await raw.close();
  }
});

test("SDK 事件迭代器：seq 单调、text_delta 关联 id、turn 终态", async () => {
  const gaps = [];
  const sdk = await AcodeHarnessClient.connect(
    { transport: "stdio", ...spawnArgs() },
    { onGap: (info) => gaps.push(info) },
  );
  try {
    const session = await sdk.createSession({ cwd: WORKSPACE });
    const iterator = session.events();
    const collected = [];
    const donePromise = (async () => {
      for await (const item of iterator) {
        collected.push(item);
        if (item.event.kind === "turn_done") break;
      }
    })();
    await session.send("stream me");
    await donePromise;
    const kinds = collected.map((item) => item.event.kind);
    assert.ok(kinds.includes("turn_started"), `kinds: ${kinds.join(",")}`);
    assert.ok(kinds.includes("text_delta"), `kinds: ${kinds.join(",")}`);
    assert.ok(kinds.includes("turn_done"), `kinds: ${kinds.join(",")}`);
    for (let i = 1; i < collected.length; i += 1) {
      assert.ok(collected[i].seq > collected[i - 1].seq, "event seq must be monotonic");
    }
    assert.equal(gaps.length, 0);
    await iterator.return?.();
  } finally {
    await sdk.close();
  }
});

test("seq gap：桥测试钩子丢帧 → SDK onGap（expected/received seq）", async () => {
  const gaps = [];
  const sdk = await AcodeHarnessClient.connect(
    {
      transport: "stdio",
      ...spawnArgs(),
      env: { ...process.env, ACODE_HARNESS_TEST_DROP_EVENT_SEQ: "2" },
    },
    { onGap: (info) => gaps.push(info) },
  );
  try {
    const session = await sdk.createSession({ cwd: WORKSPACE });
    const iterator = session.events();
    const donePromise = (async () => {
      for await (const item of iterator) {
        if (item.event.kind === "turn_done") break;
      }
    })();
    await session.send("ping");
    await donePromise;
    assert.equal(gaps.length, 1, `expected one gap, got ${JSON.stringify(gaps)}`);
    assert.equal(gaps[0].expectedSeq, 2);
    assert.equal(gaps[0].receivedSeq, 3);
    await iterator.return?.();
  } finally {
    await sdk.close();
  }
});

test("权限 fail-closed：无应答超时=拒绝（turn 收口 cancelled 而非挂死）；allow 应答继续", async () => {
  // 超时路径：permissionTimeoutMs 压短，SDK 自动回执 deny 选项。
  const timeoutClient = await AcodeHarnessClient.connect(
    { transport: "stdio", ...spawnArgs() },
    { permissionTimeoutMs: 600 },
  );
  try {
    const session = await timeoutClient.createSession({ cwd: WORKSPACE });
    const result = await session.run("NEEDS_PERMISSION gate");
    assert.equal(result.resultType, "cancelled");
  } finally {
    await timeoutClient.close();
  }
  // allow 路径：消费方在超时前应答 allow_once。
  const allowClient = await AcodeHarnessClient.connect(
    { transport: "stdio", ...spawnArgs() },
    { permissionTimeoutMs: 60_000 },
  );
  try {
    const session = await allowClient.createSession({ cwd: WORKSPACE });
    const iterator = session.events();
    const permissionPromise = (async () => {
      for await (const item of iterator) {
        if (item.event.kind === "permission_requested") return item.event;
      }
      return undefined;
    })();
    const runPromise = session.run("NEEDS_PERMISSION gate");
    const permission = await permissionPromise;
    assert.equal(permission.options.length, 2);
    const allow = permission.options.find((option) => option.optionId === "allow_once");
    const accepted = await session.respondPermission(permission.requestId, allow.optionId);
    assert.equal(accepted.accepted, true);
    const result = await runPromise;
    assert.equal(result.resultType, "success");
    await iterator.return?.();
  } finally {
    await allowClient.close();
  }
});

test("结构化输出：违例重试（第 2 次合法）；连续违例 → 含输出摘要的失败", async () => {
  const sdk = await AcodeHarnessClient.connect({ transport: "stdio", ...spawnArgs() });
  try {
    const session = await sdk.createSession({ cwd: WORKSPACE });
    const schema = z.object({ answer: z.number() });
    const result = await session.ask(schema, "STRUCTURED question");
    assert.deepEqual(result, { answer: 42 });

    const badSession = await sdk.createSession({ cwd: WORKSPACE });
    await assert.rejects(
      badSession.ask(z.object({ answer: z.number() }), "STRUCTURED_ALWAYS_BAD question"),
      (error) => {
        assert.ok(error instanceof HarnessStructuredOutputError);
        assert.ok(error.attempts.length >= 2, `attempts: ${error.attempts.length}`);
        assert.ok(error.message.includes("not json"));
        return true;
      },
    );
  } finally {
    await sdk.close();
  }
});

test("Unknown 兜底：未知枚举事件 kind → unknown 成员不抛；未知字段剥离 round-trip", async () => {
  // 协议契约是 SDK 与服务端共享的 wire 语义，直接对 loose 解析器断言（同一实现驱动连接层）。
  const unknownEvent = harnessApi.parseEventLoose({
    kind: "future_event_kind",
    delta: "x",
    brandNewField: 1,
  });
  assert.equal(unknownEvent.kind, "unknown");
  assert.equal(unknownEvent.rawKind, "future_event_kind");

  const frame = harnessApi.parseFrameLoose({
    v: 1,
    kind: "event",
    sessionId: "s",
    seq: 5,
    event: { kind: "text_delta", messageId: "m", delta: "d", unknownExtra: "stripped" },
    unknownTopField: true,
  });
  assert.equal(frame.kind, "event");
  assert.equal(frame.seq, 5);
  // 未知字段剥离发生在两层：帧层剥未知顶层字段；事件体经 parseEventLoose 剥未知事件字段。
  assert.equal(frame.unknownTopField, undefined);
  const parsedEvent = harnessApi.parseEventLoose(frame.event);
  assert.equal(parsedEvent.kind, "text_delta");
  assert.equal(parsedEvent.delta, "d");
  const roundTrip = JSON.parse(JSON.stringify(parsedEvent));
  assert.equal(roundTrip.unknownExtra, undefined);
  // 已知枚举值的正常解析不受影响。
  const normal = harnessApi.parseEventLoose({ kind: "text_delta", messageId: "m", delta: "d" });
  assert.equal(normal.kind, "text_delta");
});

test("断连归因：kill 子进程 / 握手中断 / 版本不符 三类人话", async () => {
  // 1) kill 子进程 → process-exit。
  const sdk = await AcodeHarnessClient.connect({ transport: "stdio", ...spawnArgs() });
  const session = await sdk.createSession({ cwd: WORKSPACE });
  const runPromise = session.run("SLOW operation");
  // 等 turn 开始（订阅已建立）后 kill。
  await new Promise((resolve) => setTimeout(resolve, 300));
  sdk.kill();
  const killed = await runPromise.catch((error) => error);
  const killAttribution = describeDisconnect(killed);
  // kill 的管道关闭与进程退出几乎同时到达，先触发者可能是任一归类；
  // 断言点是人话归因落在 kill 语义类（进程退出/流关闭）且带可读描述与建议。
  assert.ok(
    killAttribution.reason === "process-exit" || killAttribution.reason === "stream-closed",
    `unexpected reason: ${killAttribution.reason}`,
  );
  assert.ok(killAttribution.description.length > 0);
  assert.ok(killAttribution.suggestion.length > 0);

  // 2) 握手中断（子进程启动即退出，等不到 hello_ack）→ handshake-failed 或 process-exit。
  const exitNow = join(tmpdir(), `harness-exit-now-${Date.now()}.mjs`);
  await writeFile(exitNow, "process.exit(0);\n", "utf8");
  const handshakeError = await AcodeHarnessClient.connect({
    transport: "stdio",
    command: process.execPath,
    args: [exitNow],
  }).catch((error) => error);
  const handshakeAttribution = describeDisconnect(handshakeError);
  assert.ok(
    handshakeAttribution.reason === "handshake-failed" ||
      handshakeAttribution.reason === "process-exit",
    `unexpected reason: ${handshakeAttribution.reason}`,
  );

  // 3) 版本不符 → version-mismatch（连接层错误类 + describeDisconnect 映射）。
  const mismatch = new HarnessDisconnectError(
    "version-mismatch",
    "client harness api major version 2 is incompatible with server 1",
  );
  const mismatchAttribution = describeDisconnect(mismatch);
  assert.equal(mismatchAttribution.reason, "version-mismatch");
  assert.match(mismatchAttribution.description, /主版本/);
  assert.match(mismatchAttribution.suggestion, /升级/);
});

test("launch 隔离：runtime 目录独立、加密凭据成对拷贝零明文、无密钥文件时如实 fail", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "harness-launch-"));
  const userHome = join(tempRoot, "user-home");
  const userConfig = join(userHome, ".acode", "v2");
  await mkdir(userConfig, { recursive: true });
  // 密文形态 fixture：enc 前缀模拟 enc:v2 密文（测试不生成真实密钥材料）。
  const encryptedPayload = JSON.stringify({ "oauth:zai": "enc:v2:AAABBBCCC==" }, null, 2);
  await writeFile(join(userConfig, "credentials.json"), encryptedPayload, "utf8");
  await writeFile(
    join(userConfig, "credential-key.json"),
    JSON.stringify({ version: 1, material: "base64-test-only" }),
    "utf8",
  );

  // prepareLaunchRuntime 单元断言（launch 内部同一实现）。
  const runtimeDir = join(tempRoot, "runtime-a");
  const prepared = await prepareLaunchRuntime({
    runtimeDir,
    env: { ...process.env, HOME: userHome },
  });
  assert.equal(prepared.credentialInheritance.status, "inherited");
  assert.deepEqual(prepared.credentialInheritance.copiedFiles.sort(), [
    "credential-key.json",
    "credentials.json",
  ]);
  // 零明文：runtime 内凭据与源文件字节一致（未解密未改写），不存在明文副本。
  const copiedCredentials = await readFile(
    join(runtimeDir, ".acode", "v2", "credentials.json"),
    "utf8",
  );
  assert.equal(copiedCredentials, encryptedPayload);
  const runtimeFiles = await readdir(join(runtimeDir, ".acode", "v2"));
  assert.ok(runtimeFiles.includes("credentials.json"));
  assert.ok(runtimeFiles.includes("credential-key.json"));
  // 主库不被污染：user config 目录没有新增会话/运行时产物（两库文件集分离）。
  const userFiles = await readdir(userConfig);
  assert.deepEqual(userFiles.sort(), ["credential-key.json", "credentials.json"]);
  // 桌面主库目录（.acode/sdk 不存在于 user home——runtime 只落在显式 runtimeDir）。
  assert.equal(prepared.envPatch.ACODE_DATA_BASE_DIR, runtimeDir);

  // 密钥在钥匙串（无随行密钥文件且无 env 密钥）→ 如实 failed，不降级明文拷贝。
  // 显式清空 ACODE_CREDENTIAL_SECRET：防宿主环境恰好设置了 env 密钥时误走 env 分支。
  const keychainConfig = join(tempRoot, "keychain-home", ".acode", "v2");
  await mkdir(keychainConfig, { recursive: true });
  await writeFile(join(keychainConfig, "credentials.json"), encryptedPayload, "utf8");
  const keychainPrepared = await prepareLaunchRuntime({
    runtimeDir: join(tempRoot, "runtime-b"),
    env: { ...process.env, HOME: join(tempRoot, "keychain-home"), ACODE_CREDENTIAL_SECRET: "" },
  });
  assert.equal(keychainPrepared.credentialInheritance.status, "failed");
  assert.match(keychainPrepared.credentialInheritance.reason, /keychain/i);

  // M7(2)：ACODE_CREDENTIAL_SECRET env 模式不是「钥匙串持有」——env 随 launch 传子进程，
  // 凭据可继承（此前误报 keychain failed）。只拷密文 credentials.json，零明文。
  const envKeyPrepared = await prepareLaunchRuntime({
    runtimeDir: join(tempRoot, "runtime-env-key"),
    env: { ...process.env, HOME: join(tempRoot, "keychain-home"), ACODE_CREDENTIAL_SECRET: "test-secret" },
  });
  assert.equal(envKeyPrepared.credentialInheritance.status, "inherited");
  assert.deepEqual(envKeyPrepared.credentialInheritance.copiedFiles, ["credentials.json"]);
  assert.equal(
    (await readFile(join(tempRoot, "runtime-env-key", ".acode", "v2", "credentials.json"), "utf8")),
    encryptedPayload,
    "byte-identical ciphertext copy",
  );

  // M7(1)：凭据继承 fail 时 launch 必须整体失败（可读错误），不再静默继续。
  await assert.rejects(
    AcodeHarnessClient.launch({
      runtimeDir: join(tempRoot, "runtime-launch-fail"),
      inheritCredentials: true,
      harnessCommand: spawnArgs(),
      env: { ...process.env, HOME: join(tempRoot, "keychain-home"), ACODE_CREDENTIAL_SECRET: "" },
    }),
    (error) => {
      assert.ok(error instanceof HarnessLaunchError, `HarnessLaunchError expected, got ${error}`);
      assert.match(error.message, /credential inheritance failed/);
      assert.match(error.message, /keychain/i);
      return true;
    },
  );

  // inheritCredentials:false → 不拷贝。
  const noInherit = await prepareLaunchRuntime({
    runtimeDir: join(tempRoot, "runtime-c"),
    inheritCredentials: false,
    env: { ...process.env, HOME: userHome },
  });
  assert.equal(noInherit.credentialInheritance.status, "none");
  const noInheritFiles = await readdir(join(tempRoot, "runtime-c", ".acode", "v2"));
  assert.equal(noInheritFiles.includes("credentials.json"), false);

  // launch 全链路：spawn（桩件入口）+ 隔离 env + 握手 + 会话往返。
  const client = await AcodeHarnessClient.launch({
    runtimeDir: join(tempRoot, "runtime-d"),
    inheritCredentials: true,
    harnessCommand: spawnArgs(),
    env: { ...process.env, HOME: userHome },
  });
  try {
    assert.equal(client.launchInfo.credentialInheritance.status, "inherited");
    const session = await client.createSession({ cwd: WORKSPACE });
    const result = await session.run("ping");
    assert.equal(result.resultType, "success");
    // launch runtime 的 .acode/v2 独立存在（会话数据走 ACODE_DATA_BASE_DIR 隔离面）。
    const runtimeDFiles = await readdir(join(tempRoot, "runtime-d", ".acode", "v2"));
    assert.ok(runtimeDFiles.includes("credentials.json"));
  } finally {
    await client.close();
  }
});

test("M1 SDK 侧 UTF-8 跨 chunk：握手期与稳态的帧在多字节字符内切开仍完整解码", async () => {
  const { HarnessConnection } = await import("../src/index.ts");
  // 假服务端：hello_ack 后把含中文的 response 在「你」的 3 字节序列中间切开分两次写。
  const fakeServer = join(tmpdir(), `harness-fake-utf8-${Date.now()}.mjs`);
  await writeFile(
    fakeServer,
    [
      "const ack = JSON.stringify({ v: 1, kind: 'hello_ack', server: 'fake-utf8', protocolMinor: 0, capabilities: [] });",
      "process.stdout.write(ack + '\\n');",
      "const response = JSON.stringify({ v: 1, kind: 'response', id: 0, ok: true, result: { text: '你好，世界' } });",
      "const bytes = Buffer.from(response + '\\n', 'utf8');",
      "const cut = bytes.indexOf(Buffer.from([0xe4, 0xbd, 0xa0]));", // 「你」的首字节
      "process.stdout.write(bytes.subarray(0, cut + 1));",
      "setTimeout(() => process.stdout.write(bytes.subarray(cut + 1)), 120);",
      "process.stdin.on('data', () => {});",
    ].join("\n"),
    "utf8",
  );
  const connection = await HarnessConnection.connect({
    command: process.execPath,
    args: [fakeServer],
  });
  try {
    // 旧实现 chunk.toString("utf8") 在切点产生 U+FFFD → JSON 仍可解析但文本损坏。
    const result = await connection.request("get_models", {});
    assert.equal(result.text, "你好，世界");
    assert.ok(!result.text.includes("\uFFFD"));
  } finally {
    await connection.close();
  }
});

test("M4 SDK 侧行长上限：服务端输出超 4 MiB 单行 → frame-too-large 断连归因", async () => {
  const { HarnessConnection, HarnessDisconnectError, describeDisconnect } = await import(
    "../src/index.ts"
  );
  const fakeServer = join(tmpdir(), `harness-fake-oversize-${Date.now()}.mjs`);
  await writeFile(
    fakeServer,
    [
      "const ack = JSON.stringify({ v: 1, kind: 'hello_ack', server: 'fake-oversize', protocolMinor: 0, capabilities: [] });",
      "process.stdout.write(ack + '\\n');",
      "const huge = JSON.stringify({ v: 1, kind: 'response', id: 0, ok: true, result: { pad: 'x'.repeat(4 * 1024 * 1024 + 256) } });",
      "process.stdout.write(huge + '\\n');",
      "process.stdin.on('data', () => {});",
    ].join("\n"),
    "utf8",
  );
  const connection = await HarnessConnection.connect({
    command: process.execPath,
    args: [fakeServer],
  });
  const error = await connection.request("get_models", {}).catch((err) => err);
  assert.ok(error instanceof HarnessDisconnectError, `disconnect error expected, got ${error}`);
  assert.equal(error.reason, "frame-too-large");
  const attribution = describeDisconnect(error);
  assert.equal(attribution.reason, "frame-too-large");
  assert.ok(attribution.description.length > 0 && attribution.suggestion.length > 0);
});

test("M2 send-only：send() 先确保订阅——权限事件必达 SDK 且超时自动拒绝收口 turn", async () => {
  const observed = [];
  const sdk = await AcodeHarnessClient.connect(
    { transport: "stdio", ...spawnArgs() },
    { permissionTimeoutMs: 700 },
  );
  try {
    const session = await sdk.createSession({ cwd: WORKSPACE });
    // 连接级监听观察事件帧（不经 session.events()——那会自行建订阅掩盖本回归点）。
    sdk.addEventListener((frame) => {
      if (frame.event.kind === "permission_requested" || frame.event.kind === "turn_done") {
        observed.push(frame.event);
      }
    });
    // 纯 send（不 run 不 events）：旧实现不建订阅 → 事件帧永远不到 → fail-closed 挂死。
    await session.send("NEEDS_PERMISSION gate");
    const deadline = Date.now() + 8_000;
    while (
      Date.now() < deadline &&
      !observed.some((event) => event.kind === "turn_done")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const permission = observed.find((event) => event.kind === "permission_requested");
    assert.ok(permission, "permission_requested must reach SDK via send-only subscription");
    const done = observed.find((event) => event.kind === "turn_done");
    assert.ok(done, "timeout deny must close the turn instead of hanging");
    assert.equal(done.resultType, "cancelled");
  } finally {
    await sdk.close();
  }
});

test("M3 监听器与队列回落：session.close / events return / client.close 后无泄漏", async () => {
  const sdk = await AcodeHarnessClient.connect({ transport: "stdio", ...spawnArgs() });
  try {
    const base = sdk.connectionListenerCount;
    const s1 = await sdk.createSession({ cwd: WORKSPACE });
    const s2 = await sdk.createSession({ cwd: WORKSPACE });
    assert.equal(sdk.connectionListenerCount, base + 2, "one listener per session");

    const it1 = s1.events();
    const it2 = s1.events();
    const it3 = s2.events();
    assert.ok(it1 && it2 && it3, "events() iterators must be created");
    assert.equal(s1.eventQueueCount, 2);
    assert.equal(s2.eventQueueCount, 1);

    await it1.return?.();
    assert.equal(s1.eventQueueCount, 1, "iterator return must remove its queue entry");

    await s1.close();
    assert.equal(s1.eventQueueCount, 0, "close must end all remaining iterators");
    assert.equal(sdk.connectionListenerCount, base + 1, "session.close removes its listener");

    // it3 随 client.close 统一收口；s2 的监听器/队列同步回落。
    await sdk.close();
    assert.equal(s2.eventQueueCount, 0);
    assert.equal(sdk.connectionListenerCount, base, "client.close clears all session listeners");
  } finally {
    await sdk.close().catch(() => undefined);
  }
});

test("M8 ask schema 描述：标量类型/枚举值列表/optional 标记不丢失", async () => {
  const { describeZodSchema } = await import("../src/session.ts");
  const desc = describeZodSchema(
    z.object({
      answer: z.number(),
      tag: z.enum(["a", "b"]),
      note: z.string().optional(),
      ok: z.boolean(),
      nested: z.object({ inner: z.string() }),
    }),
  );
  assert.equal(desc.type, "object");
  assert.deepEqual(desc.properties.answer, { type: "number" });
  assert.deepEqual(desc.properties.tag, { type: "string", enum: ["a", "b"] });
  assert.deepEqual(desc.properties.note, { type: "string", optional: true });
  assert.deepEqual(desc.properties.ok, { type: "boolean" });
  // object shape 递归保持。
  assert.deepEqual(desc.properties.nested, {
    type: "object",
    properties: { inner: { type: "string" } },
  });
  // ask() 注入 prompt 的 requirement 文本包含字段与类型信息。
  const text = JSON.stringify(desc);
  assert.ok(text.includes('"answer"') && text.includes('"number"'));
  assert.ok(text.includes('"a"') && text.includes('"b"'));
});

test("L1 harness 命令覆盖：JSON 数组形态优先（含空格路径），旧空格格式兼容", async () => {
  const { resolveHarnessCommand } = await import("../src/client.ts");
  const jsonForm = resolveHarnessCommand({
    ACODE_HARNESS_COMMAND_JSON: JSON.stringify([
      "C:\\Program Files\\node\\node.exe",
      "--import",
      "tsx",
      "C:\\sp ace\\entry.ts",
    ]),
  });
  assert.equal(jsonForm.command, "C:\\Program Files\\node\\node.exe");
  assert.deepEqual(jsonForm.args, ["--import", "tsx", "C:\\sp ace\\entry.ts"]);
  const legacy = resolveHarnessCommand({ ACODE_HARNESS_COMMAND: "node --import tsx entry.ts" });
  assert.equal(legacy.command, "node");
  assert.deepEqual(legacy.args, ["--import", "tsx", "entry.ts"]);
  // JSON 优先于旧格式。
  const both = resolveHarnessCommand({
    ACODE_HARNESS_COMMAND: "legacy-command",
    ACODE_HARNESS_COMMAND_JSON: JSON.stringify(["json-command"]),
  });
  assert.equal(both.command, "json-command");
  // 非法 JSON 数组给出可读错误（不静默回退掩盖配置错误）。
  assert.throws(
    () => resolveHarnessCommand({ ACODE_HARNESS_COMMAND_JSON: "{not json" }),
    /ACODE_HARNESS_COMMAND_JSON/,
  );
  assert.throws(
    () => resolveHarnessCommand({ ACODE_HARNESS_COMMAND_JSON: JSON.stringify({ command: "x" }) }),
    /ACODE_HARNESS_COMMAND_JSON/,
  );
});

test("L2 pickDenyOption：显式 deny/reject 匹配（optionId/kind/name）；无匹配兜底末项", async () => {
  const { pickDenyOption } = await import("../src/session.ts");
  const optionsOf = (ids) => ids.map((optionId) => ({ optionId }));
  // optionId 显式匹配。
  assert.equal(pickDenyOption({ options: optionsOf(["allow_once", "deny"]) }).optionId, "deny");
  // optionId 含 reject。
  assert.equal(pickDenyOption({ options: optionsOf(["allow", "reject_all"]) }).optionId, "reject_all");
  // name 字段匹配。
  assert.equal(
    pickDenyOption({
      options: [
        { optionId: "1", name: "Allow" },
        { optionId: "2", name: "Deny everything" },
      ],
    }).optionId,
    "2",
  );
  // 无 deny 语义选项 → 兜底末项（契约假设：权限选项按风险升序、末项最保守）。
  assert.equal(pickDenyOption({ options: optionsOf(["allow_once", "ask_again"]) }).optionId, "ask_again");
  // 词边界：不带 deny 语义的词不误报。
  assert.equal(
    pickDenyOption({ options: [{ optionId: "1", name: "Allow" }] }).optionId,
    "1",
  );
});
