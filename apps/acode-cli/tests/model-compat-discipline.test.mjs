import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// spec: apps/acode-cli/specs/model-compat-flags.md R7 —— id 字符串分支纪律守护。
// omp 成文纪律：禁止 TS 里 id.includes("claude") 式分支；per-model 行为差异只准
// 编目为 compat 标志（model-compat-rules.ts）经 classifyModel 结构化消费。
// 本测试是 grep 式断言：扫描 adapters/src/model 全部源文件，allowlist 外命中即 fail。

const here = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = resolve(here, "../packages/adapters/src/model");

/**
 * 基线豁免（只减不增）：存量违例登记于此，迁移一个删一个（spec R7 / 波 3 队列 #1）。
 * strict-tool-schema.ts 的 isAnthropicFirstPartyModelId 是首方 strict 资格判定，
 * 迁移需要 supportsStrictToolSchema 标志 + 网关路由 id 语义对齐，波 2 不动。
 */
const ALLOWLIST = new Set(["strict-tool-schema.ts"]);

const FORBIDDEN_PATTERNS = [
  {
    pattern: /\.startsWith\(\s*["'](claude|gpt-|grok|glm|kimi|deepseek|qwen|minimax|mimo|o1|o3|o4)/i,
    label: "startsWith(模型名前缀)",
  },
  {
    pattern: /\.includes\(\s*["'](claude|gpt-|grok|glm|kimi|deepseek|qwen|minimax|mimo)/i,
    label: "includes(模型名)",
  },
  {
    pattern: /modelId\s*(?:===|!==|==|!=)\s*["'](claude|gpt-|grok|glm|kimi|deepseek|qwen|minimax|mimo)/i,
    label: "modelId 与模型名字面量比较",
  },
  {
    pattern: /\.match\(\s*\/[^/\n]*(claude|gpt-|glm-|kimi-|deepseek|minimax|qwen)/i,
    label: "模型名正则 match",
  },
];

async function listSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

function findHits(source) {
  const hits = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // 注释行不算分支（规则表/分类器的证据注释允许提及模型名）。
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
    for (const { pattern, label } of FORBIDDEN_PATTERNS) {
      if (pattern.test(line)) {
        hits.push({ line: index + 1, label, text: line.trim().slice(0, 120) });
      }
    }
  }
  return hits;
}

test("纪律守护：adapters/src/model 无 allowlist 外的模型 id 字符串分支", async () => {
  const files = await listSourceFiles(MODEL_DIR);
  assert.ok(files.length > 10, "扫描面异常：model 目录源文件过少");

  const violations = [];
  const allowlistHits = new Map();
  for (const file of files) {
    const name = relative(MODEL_DIR, file).replaceAll("\\", "/");
    const hits = findHits(await readFile(file, "utf8"));
    if (hits.length === 0) continue;
    if (ALLOWLIST.has(name)) {
      allowlistHits.set(name, hits);
      continue;
    }
    for (const hit of hits) {
      violations.push(`${name}:${hit.line} [${hit.label}] ${hit.text}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `发现模型 id 字符串分支（应编目为 compat 标志，见 specs/model-compat-flags.md R7）：\n` +
      violations.join("\n"),
  );

  // allowlist 陈旧防护：豁免文件必须仍然存在且仍命中；迁移完成后必须收缩名单。
  for (const name of ALLOWLIST) {
    assert.ok(
      allowlistHits.has(name),
      `allowlist 陈旧：${name} 已无命中，请从守护测试 ALLOWLIST 移除（只减不增）`,
    );
  }
});

test("纪律守护：compat 机制自身文件不含禁止模式（规则表用数据 token，不用分支）", async () => {
  for (const name of [
    "model-compat-identity.ts",
    "model-compat-rules.ts",
    "model-compat-transforms.ts",
    "model-compat-fetch.ts",
  ]) {
    const source = await readFile(join(MODEL_DIR, name), "utf8");
    const hits = findHits(source);
    assert.deepEqual(hits, [], `${name} 不得含 id 字符串分支（数据 token 不算分支）`);
  }
});
