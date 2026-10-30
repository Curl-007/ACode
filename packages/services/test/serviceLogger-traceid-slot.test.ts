import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createServiceLogger } from "../src/logger/serviceLogger.js";
import { resetServiceLogRedactorForTest } from "../src/logger/logPrivacy.js";

/**
 * traceId 槽守护（specs/log-privacy-redaction.md services R7-R8，review 2026-10-26 §2 R2-04）。
 *
 * 两部分：
 * (a) 源扫描负向门禁——packages/services/src 内不得残留 ServiceLogger-typed logger 的
 *     `.info(`/`.warn(`/`.error(`/`.debug(` 以字面量字符串作首参（= 误把消息塞进 traceId 槽）。
 *     message-first 接口的 logger（AgentSparePoolLogger / TrackerLogger）按文件 allowlist 豁免，
 *     且断言这些文件不 import ServiceLogger（allowlist 自我巡检，防止豁免文件被塞进真误用）。
 * (b) 行为测试——part-1 结构性封堵后，misused 首参（含 Bearer/token 秘密形态）经漏斗脱敏，
 *     sink 收到的**前缀**不残留未脱敏秘密；对照正确形态字符串 arg 仍在源头脱敏。
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const servicesSrc = fileURLToPath(new URL("../src/", import.meta.url));

/** 全仓扫描的目录黑名单（与 scripts/architecture/discovery.mjs 的 SKIP_DIRECTORIES 同旨）。 */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "out",
  ".git",
  ".acode",
  "coverage",
  "build",
]);

/**
 * message-first logger 的文件 allowlist：这些文件里的 `.warn("msg", …)` 首参本就是
 * message（接口签名 `info(message: string, …)`），不是 ServiceLogger 的 traceId 槽，
 * 因此不算误用。豁免以文件为粒度，并配套「不 import ServiceLogger」断言自我巡检。
 */
const MESSAGE_FIRST_LOGGER_FILES = new Set([
  "packages/services/src/acode-agent/acodeAgentSparePrewarm.ts",
  "packages/services/src/acode-agent/cuaOperationTurnTracker.ts",
]);

async function collectSources(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // 目录缺席（例如某些 checkout 没有 apps/）按零文件处理，不让守护因环境差异假红。
    return [];
  }
  const nested = await Promise.all(
    entries.map((e) => {
      // 跳过依赖与构建产物：全仓扫描必须只看源码，否则既慢又会把 dist 里的旧形态
      // 当成违规（且 pnpm 的 node_modules 是符号链接，走进去没有意义）。
      if (SKIP_DIRECTORIES.has(e.name)) return [];
      return e.isDirectory()
        ? collectSources(`${dir}/${e.name}`)
        : /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")
          ? [`${dir}/${e.name}`]
          : [];
    }),
  );
  return nested.flat();
}

/**
 * 匹配「字面量字符串作首参」的分级日志调用（含跨行形态）。
 * 捕获组 1 = 接收者表达式尾部（用于排除裸 console），组 2 = 方法名。
 * `\(\s*[`"']` 命中首参以引号/反引号开头（`\s*` 吃换行，覆盖多行写法）；
 * 正确形态首参是 `undefined`/变量，不会命中。
 */
const MISUSE_CALL = /([A-Za-z0-9_$\].?]+)\s*\.\s*(info|warn|error|debug)\s*\(\s*[`"']/g;

function isBareConsole(receiver: string): boolean {
  // 裸 console 的 fail-closed 诊断（logPrivacy.ts）不是 ServiceLogger，不在本守护范围。
  return /(^|\.)console$/.test(receiver);
}

test("traceId 槽无字面量首参误用残留（ServiceLogger-typed，含跨行）", async () => {
  const offenders: string[] = [];
  for (const file of await collectSources(servicesSrc)) {
    const rel = file
      .slice(repoRoot.length)
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/");
    if (MESSAGE_FIRST_LOGGER_FILES.has(rel)) {
      continue;
    }
    const source = await readFile(file, "utf8");
    MISUSE_CALL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MISUSE_CALL.exec(source)) !== null) {
      const receiver = match[1]!;
      if (isBareConsole(receiver)) {
        continue;
      }
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${rel}:${line} ${receiver}.${match[2]}(...)`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `ServiceLogger 首参是 traceId，消息串必须作为首个正文 arg（正确形态 log.info(undefined, "msg", ctx)）。` +
      `误把字面量塞进 traceId 槽会绕过脱敏漏斗（见 specs/log-privacy-redaction.md R7-R8）。违规调用：\n` +
      offenders.join("\n"),
  );
});

test("message-first logger 豁免文件不 import ServiceLogger（allowlist 自我巡检）", async () => {
  for (const rel of MESSAGE_FIRST_LOGGER_FILES) {
    const source = await readFile(repoRoot + rel, "utf8");
    assert.ok(
      !/ServiceLogger|createServiceLogger/.test(source),
      `${rel} 被 allowlist 豁免为 message-first logger，却 import 了 ServiceLogger——` +
        `豁免可能掩盖真误用，请复核该文件的 logger 接口。`,
    );
  }
});

/**
 * 全仓 receiver-aware 扫描（review 2026-10-26 §5「修一处漏其余」的机械化）。
 *
 * 为什么 part-1 不够：它只扫 `packages/services/src`。而 `createServiceLogger` 经
 * `@acode/services/node` 公开入口被**其它包**消费（acode-server-cli 的 supervisor/
 * updateCommand/http），那些文件里的同类误用不在扫描范围内——fix-status 记载的
 * 「39 处清扫归零」只对 services 成立。2026-10-27 实测 acode-server-cli 仍有 28 处。
 *
 * 为什么用 receiver-aware 而不是「任何 log.xxx("字面量")」：仓库里存在**同名但不同接口**的
 * logger——`packages/desktop/src/host/index.ts:388` 的 `logger` 是本地 message-first 对象
 * （`info: (...args) => writeHostLog("info", ...args)`），它的字面量首参是**正确**形态。
 * 按名字扫描会误报它。故判据是「该名字在本文件内绑定到 createServiceLogger」。
 */
test("全仓：绑定到 createServiceLogger 的 logger 不得有字面量首参误用", async () => {
  const offenders: string[] = [];
  for (const file of await collectSources(repoRoot + "packages")) {
    await scanFileForReceiverAwareMisuse(file, offenders);
  }
  for (const file of await collectSources(repoRoot + "apps")) {
    await scanFileForReceiverAwareMisuse(file, offenders);
  }
  assert.deepEqual(
    offenders,
    [],
    `以下调用把字面量字符串塞进了 ServiceLogger 的 traceId 首参槽（该接口是 traceId-first，` +
      `正确形态 log.info(undefined, "msg", ctx)）。跨包消费方同样受脱敏漏斗契约约束，` +
      `见 specs/log-privacy-redaction.md R7-R8：\n` +
      offenders.join("\n"),
  );
});

/**
 * 扫描单个文件：只对**绑定到 createServiceLogger 的名字**匹配字面量首参。
 * 返回 offenders 追加「相对路径:行 接收者.方法」。
 */
async function scanFileForReceiverAwareMisuse(
  file: string,
  offenders: string[],
): Promise<void> {
  const source = await readFile(file, "utf8");
  if (!source.includes("createServiceLogger")) return;
  const boundNames = [
    ...source.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*createServiceLogger/g),
  ].map((m) => m[1]);
  if (boundNames.length === 0) return;
  const rel = file
    .slice(repoRoot.length)
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  for (const name of boundNames) {
    const receiverCall = new RegExp(
      `\\b${name}\\s*\\.\\s*(info|warn|error|debug)\\s*\\(\\s*[\`"']`,
      "g",
    );
    let match: RegExpExecArray | null;
    while ((match = receiverCall.exec(source)) !== null) {
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${rel}:${line} ${name}.${match[1]}(...)`);
    }
  }
}

interface CapturedCall {
  fn: string;
  args: unknown[];
}

function createCapturingSink() {
  const calls: CapturedCall[] = [];
  const record =
    (fn: string) =>
    (...args: unknown[]) => {
      calls.push({ fn, args });
    };
  return {
    calls,
    sink: {
      log: record("log"),
      warn: record("warn"),
      error: record("error"),
      debug: record("debug"),
    },
  };
}

// 与 serviceLogger.redaction.test.ts 同款、已被证明可脱敏的假秘密形态（不写真实凭据）。
const FAKE_BEARER = "fakeBearerTokenValue12345";
const FAKE_SK = "sk-fake0123456789abcdef";

test("R7 结构性封堵：misused traceId 槽的秘密经漏斗脱敏，不落 sink 前缀", () => {
  resetServiceLogRedactorForTest();
  const { calls, sink } = createCapturingSink();
  const logger = createServiceLogger("guard", { sink });

  // 误用形态：消息串（含 Bearer + access_token 秘密）被塞进 traceId 首参槽。
  // part-1 修复让该槽与前缀同经 redactServiceLogArg，故前缀不得残留原值。
  const misusedTrace = `Bearer ${FAKE_BEARER} access_token=${FAKE_SK}`;
  // 无需 cast：TraceId=string 使「消息串塞进 traceId 槽」类型不可见（R7 根因）。
  logger.info(misusedTrace, "ctx");

  assert.equal(calls.length, 1);
  const prefix = String(calls[0]!.args[0]); // formatLogPrefix 输出 = sink 首参
  assert.ok(prefix.includes("[trace:"), `误用串应进入 [trace:…] 前缀段：${prefix}`);
  assert.ok(!prefix.includes(FAKE_BEARER), `前缀不得残留 Bearer 原值：${prefix}`);
  assert.ok(!prefix.includes(FAKE_SK), `前缀不得残留 sk- token 原值：${prefix}`);
});

test("R7 对照：正确形态 info(undefined, msg, ctx) 的字符串 arg 在源头脱敏、前缀无 trace", () => {
  resetServiceLogRedactorForTest();
  const { calls, sink } = createCapturingSink();
  const logger = createServiceLogger("guard", { sink });

  // 正确形态：traceId 槽传 undefined，秘密作为字符串正文 arg → 源头脱敏（R2）。
  logger.info(undefined, `access_token=${FAKE_SK}`);
  const prefix = String(calls[0]!.args[0]);
  const body = String(calls[0]!.args[1]);
  assert.ok(!prefix.includes("[trace:"), `undefined traceId 不应产出 [trace:] 段：${prefix}`);
  assert.ok(!body.includes(FAKE_SK), `字符串 arg 应源头脱敏：${body}`);

  // 对象 arg 按 R2-04 契约在源头透传（脱敏在终局字符串化漏斗）——这里只断言前缀干净，
  // 不断言对象体脱敏（与 serviceLogger.redaction.test.ts 钉住的透传契约一致）。
  logger.warn(undefined, "ctx:", { token: FAKE_SK });
  const objPrefix = String(calls[1]!.args[0]);
  assert.ok(!objPrefix.includes(FAKE_SK), `前缀不含对象内容：${objPrefix}`);
  assert.equal(
    (calls[1]!.args[2] as { token: string }).token,
    FAKE_SK,
    "对象 arg 按引用透传（R2-04 契约，非本次改动范围）",
  );
});
