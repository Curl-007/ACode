/**
 * WI-17 零泄漏断言与服务门面单测（specs/transcript-secret-obfuscation.md 验收场景 5、
 * 开关矩阵 R6、key 自保护 R1-4）。全部使用合成秘密；断言出站投影无原值、本地转录
 * 不被改写（UI 面语义）、tools schema 不在投影面内。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelInputMessage } from "@acode/contracts";
import {
  getSecretRedactionService,
  parseSecretRedactionSwitch,
  resetSecretRedactionServiceForTests,
} from "../src/security/secret-redaction/service.js";
import { SECRET_PLACEHOLDER_KEY_FILENAME } from "../src/security/secret-redaction/key.js";

const SYNTH_ENV_SECRET = "synthetic-env-secret-Value-123";
const SYNTH_DB_PASSWORD = "synthetic-db-passw0rd";
const SYNTH_GITHUB = `ghp_${"S1y2N3t4H5e6T7i8C9a0L1b2C3d4E5f6G7h8"}`;
const VALID_TEST_KEY = "synthetic-test-key-0123456789abcdefghijklmn"; // 43 字符合成 key（非真实凭据）

function withTempKeyDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "acode-secret-service-test-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    API_KEY: SYNTH_ENV_SECRET,
    DATABASE_URL: `postgres://dbuser:${SYNTH_DB_PASSWORD}@db.internal:5432/app`,
    ...extra,
  };
}

function buildTranscript(): ModelInputMessage[] {
  return [
    { role: "system", content: "You are ACode. 静态模板不含秘密。" },
    { role: "user", content: `帮我用 key ${SYNTH_ENV_SECRET} 调接口` },
    {
      role: "assistant",
      content: [
        { type: "text", text: `我将运行 curl -H "X-Key: ${SYNTH_ENV_SECRET}"` },
        { type: "reasoning", text: `用户给了 ${SYNTH_DB_PASSWORD} 作为数据库密码` },
        { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" },
      ],
      toolCalls: [
        {
          id: "call_1",
          name: "Bash",
          input: { command: `curl -H "X-Key: ${SYNTH_ENV_SECRET}" https://api.internal` },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "call_1",
      toolName: "Bash",
      content: [
        { type: "text", text: `OK token=${SYNTH_GITHUB} password=${SYNTH_DB_PASSWORD}` },
        {
          type: "file",
          mediaType: "text/plain",
          name: "notes.txt",
          text: `db: ${SYNTH_DB_PASSWORD}`,
        },
      ],
    },
  ];
}

test("零泄漏：出站投影后全文无秘密原值，占位符在场，本地转录不被改写", () => {
  withTempKeyDir((keyDir) => {
    resetSecretRedactionServiceForTests();
    try {
      const service = getSecretRedactionService({ env: baseEnv(), keyDir });
      assert.equal(service.enabled, true);
      const messages = buildTranscript();
      const snapshot = JSON.stringify(messages); // 本地转录原样快照（不可变性对照）

      const projected = service.projectModelMessages(messages);
      const outbound = JSON.stringify(projected);

      // 零泄漏：三种收集面（env 名字模式 / 连接串密码 / 内置正则族）的原值全部不在出站面。
      assert.ok(!outbound.includes(SYNTH_ENV_SECRET), "env 秘密不得出站");
      assert.ok(!outbound.includes(SYNTH_DB_PASSWORD), "连接串密码不得出站");
      assert.ok(!outbound.includes(SYNTH_GITHUB), "内置正则族 token 不得出站");
      // 占位符在场（模型可见的脱敏形态）。
      assert.match(outbound, /\$\$[A-Z0-9]{12}(?::[ULCM])?\$\$/);
      assert.match(outbound, /\$\$CREDENTIAL_[A-Z0-9]{12}(?::[ULCM])?\$\$/);
      // 本地事实面不被改写：原消息数组与内容原样（UI 转录/JSONL 的语义基础，R4）。
      assert.equal(JSON.stringify(messages), snapshot, "投影必须不可变（不改写本地转录）");
      assert.notEqual(projected, messages, "有命中时返回新数组");
      // 二进制载荷不动（image dataUrl 原样）。
      const assistant = projected[2];
      const imageBlock = Array.isArray(assistant.content)
        ? assistant.content.find((block) => block.type === "image")
        : undefined;
      assert.ok(
        imageBlock &&
          "dataUrl" in imageBlock &&
          imageBlock.dataUrl === "data:image/png;base64,aGVsbG8=",
      );
      // toolCalls input 的历史回放同样被投影。
      const toolCallInput = assistant.toolCalls?.[0]?.input as { command: string };
      assert.ok(!toolCallInput.command.includes(SYNTH_ENV_SECRET));
      assert.ok(toolCallInput.command.includes("$$"));
      // 还原面闭环：把投影后的工具参数还原，逐字节回到原文。
      const restored = service.restoreToolInput(toolCallInput);
      assert.deepEqual(restored.value, {
        command: `curl -H "X-Key: ${SYNTH_ENV_SECRET}" https://api.internal`,
      });
      assert.equal(restored.unresolvedPlaceholders, 0);
    } finally {
      resetSecretRedactionServiceForTests();
    }
  });
});

test("identity：干净转录返回原数组引用（性能纪律 + === 恒等判断不破坏）", () => {
  withTempKeyDir((keyDir) => {
    resetSecretRedactionServiceForTests();
    try {
      const service = getSecretRedactionService({ env: baseEnv(), keyDir });
      const clean: ModelInputMessage[] = [
        { role: "system", content: "静态 system 模板，无任何秘密。" },
        { role: "user", content: "解释一下 token_expiry_seconds 这个标识符" },
      ];
      assert.equal(service.projectModelMessages(clean), clean, "同引用");
    } finally {
      resetSecretRedactionServiceForTests();
    }
  });
});

test("key 自保护：已存在 key 文件的内容被注册为 plain 秘密（Read 到也不出站）", () => {
  withTempKeyDir((keyDir) => {
    mkdirSync(keyDir, { recursive: true });
    writeFileSync(join(keyDir, SECRET_PLACEHOLDER_KEY_FILENAME), VALID_TEST_KEY);
    resetSecretRedactionServiceForTests();
    try {
      const service = getSecretRedactionService({ env: baseEnv(), keyDir });
      const messages: ModelInputMessage[] = [
        {
          role: "tool",
          toolCallId: "c",
          toolName: "Read",
          content: `key 文件内容：${VALID_TEST_KEY}`,
        },
      ];
      const projected = service.projectModelMessages(messages);
      const outbound = JSON.stringify(projected);
      assert.ok(!outbound.includes(VALID_TEST_KEY), "HMAC 私钥值绝不出站");
      assert.ok(
        !outbound.includes(readFileSync(join(keyDir, SECRET_PLACEHOLDER_KEY_FILENAME), "utf8")),
      );
    } finally {
      resetSecretRedactionServiceForTests();
    }
  });
});

test("开关矩阵：0/false/off 禁用；未设置/其他值启用；空串启用", () => {
  assert.equal(parseSecretRedactionSwitch(undefined), true);
  assert.equal(parseSecretRedactionSwitch(""), true);
  assert.equal(parseSecretRedactionSwitch("1"), true);
  assert.equal(parseSecretRedactionSwitch("garbage"), true, "脏值宽松失败方向：保持启用");
  assert.equal(parseSecretRedactionSwitch("0"), false);
  assert.equal(parseSecretRedactionSwitch("false"), false);
  assert.equal(parseSecretRedactionSwitch("OFF"), false);
  assert.equal(parseSecretRedactionSwitch(" Off "), false);
});

test("禁用态：投影恒等（同引用），但存量占位符还原仍工作（R6）", () => {
  withTempKeyDir((keyDir) => {
    // 先用启用态铸造一个占位符并记住它（模拟历史转录里的存量占位符）。
    mkdirSync(keyDir, { recursive: true });
    writeFileSync(join(keyDir, SECRET_PLACEHOLDER_KEY_FILENAME), VALID_TEST_KEY);
    resetSecretRedactionServiceForTests();
    const enabledService = getSecretRedactionService({ env: baseEnv(), keyDir });
    const obfuscated = enabledService.projectModelMessages([
      { role: "user", content: SYNTH_ENV_SECRET },
    ])[0].content as string;
    assert.ok(obfuscated.includes("$$"));

    // 同进程重启语义：禁用态 + 既有 key → 预铸造还原表，存量占位符仍可还原。
    resetSecretRedactionServiceForTests();
    try {
      const disabled = getSecretRedactionService({
        env: baseEnv({ ACODE_SECRET_REDACTION: "0" }),
        keyDir,
      });
      assert.equal(disabled.enabled, false);
      const messages: ModelInputMessage[] = [{ role: "user", content: SYNTH_ENV_SECRET }];
      assert.equal(disabled.projectModelMessages(messages), messages, "禁用态投影恒等（原引用）");
      const restored = disabled.restoreToolInput({ command: `use ${obfuscated}` });
      assert.equal((restored.value as { command: string }).command, `use ${SYNTH_ENV_SECRET}`);
    } finally {
      resetSecretRedactionServiceForTests();
    }
  });
});

test("惰性 key 纪律：会话从未铸造占位符则不落 key 文件（R5）", () => {
  withTempKeyDir((keyDir) => {
    resetSecretRedactionServiceForTests();
    try {
      const service = getSecretRedactionService({ env: { PATH: "/usr/bin" }, keyDir });
      service.projectModelMessages([{ role: "user", content: "干净文本，无任何秘密" }]);
      let keyFileExists = true;
      try {
        readFileSync(join(keyDir, SECRET_PLACEHOLDER_KEY_FILENAME));
      } catch {
        keyFileExists = false;
      }
      assert.equal(keyFileExists, false, "无活跃秘密的会话不写 key 文件");
    } finally {
      resetSecretRedactionServiceForTests();
    }
  });
});

test("服务日志红线：stats 只有计数；warn 细节不含秘密值", () => {
  withTempKeyDir((keyDir) => {
    resetSecretRedactionServiceForTests();
    const warnings: Array<{ message: string; details?: Record<string, unknown> }> = [];
    try {
      const service = getSecretRedactionService({
        env: baseEnv(),
        keyDir,
        warn: (message, details) => warnings.push({ message, details }),
      });
      assert.equal(typeof service.stats.plainSecrets, "number");
      assert.ok(service.stats.plainSecrets >= 2);
      assert.equal(service.stats.regexEntries, 12, "内置正则族 12 条");
      const serialized = JSON.stringify({ stats: service.stats, warnings });
      assert.ok(!serialized.includes(SYNTH_ENV_SECRET));
      assert.ok(!serialized.includes(SYNTH_DB_PASSWORD));
    } finally {
      resetSecretRedactionServiceForTests();
    }
  });
});

test("出站插点：createRuntimeModel 包装层投影 messages、透传 tools、bind 链保层", async () => {
  const keyDir = mkdtempSync(join(tmpdir(), "acode-secret-insert-test-"));
  resetSecretRedactionServiceForTests();
  getSecretRedactionService({ env: baseEnv(), keyDir });
  try {
    // 直接测运行时插点本体（假 runtime + 假 modelFactory），验证包装层语义：
    // ①messages 被投影；②tools/其余字段原样；③无命中透传原 request；④bind 后仍在场。
    const seen: Array<{ messages: unknown; tools?: unknown }> = [];
    const fakeInnerModel = {
      providerId: "synthetic-provider",
      modelId: "synthetic-model",
      properties: {},
      optionSpecs: {},
      options: {},
      bind() {
        return fakeInnerModel;
      },
      async generateText(request: { messages: unknown; tools?: unknown }) {
        seen.push({ messages: request.messages, tools: request.tools });
        return { text: "", finishReason: "stop" as const, usage: {} };
      },
      streamText(request: { messages: unknown; tools?: unknown }) {
        seen.push({ messages: request.messages, tools: request.tools });
        return (async function* () {
          // 空流即可：断言面在请求投影。
        })();
      },
    };
    const fakeRuntime = {
      config: { taskType: "interactive" },
      modelRequestAdmission: undefined,
      logger: undefined,
      modelFactory: () => fakeInnerModel,
    };
    // 动态 import：runtime-model 拉起 runtime deps 桶（与 executor 测试同款代价）。
    const { createRuntimeModel } = await import("../src/runtime/methods/runtime-model.js");
    const model = createRuntimeModel(
      fakeRuntime as never,
      {
        selection: { providerId: "synthetic-provider", modelId: "synthetic-model" },
      } as never,
    );

    const tools = [{ name: "Bash", inputSchema: { type: "object" } }] as never;
    const dirtyMessages: ModelInputMessage[] = [
      { role: "user", content: `key=${SYNTH_ENV_SECRET}` },
    ];
    await model.generateText({ messages: dirtyMessages, tools });
    const projected = seen[0].messages as ModelInputMessage[];
    assert.ok(!JSON.stringify(projected).includes(SYNTH_ENV_SECRET), "出站 messages 无原值");
    assert.ok(JSON.stringify(projected).includes("$$"), "占位符在场");
    assert.equal(seen[0].tools, tools, "tools schema 原引用透传（红线：不动 schema）");

    // 无命中 → 原 messages 引用透传（identity，=== 恒等判断不破坏）。
    const cleanMessages: ModelInputMessage[] = [{ role: "user", content: "干净文本" }];
    await model.generateText({ messages: cleanMessages, tools });
    assert.equal(seen[1].messages, cleanMessages, "干净请求同引用");

    // streamText 同款投影 + bind 链保持脱敏层在场。
    const iterable = model.streamText({ messages: dirtyMessages, tools });
    for await (const _event of iterable) {
      // 消费空流
    }
    assert.ok(!JSON.stringify(seen[2].messages).includes(SYNTH_ENV_SECRET), "流式路径同样投影");
    const bound = model.bind({ maxOutputTokens: 128 });
    await bound.generateText({ messages: dirtyMessages, tools });
    assert.ok(!JSON.stringify(seen[3].messages).includes(SYNTH_ENV_SECRET), "bind 链保层");
  } finally {
    resetSecretRedactionServiceForTests();
    rmSync(keyDir, { recursive: true, force: true });
  }
});
