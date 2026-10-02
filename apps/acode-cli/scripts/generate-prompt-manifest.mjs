// ============================================================
// Generate Prompt Manifest - 构建期提示词版本清单（P3）
// ============================================================
//
// specs/system-prompt-section-registry.md R6 / 方案 §10.1：读注册表（不读运行时），
// 为每个 persistable: true 的段生成 { id, group, source, owner, hash }，外加顶层
// { version, generatedAt, sections, sectionsHash }，写入 repo 内清单文件。
//
// 用法（apps/acode-cli 目录，或仓库根加 apps/acode-cli/ 前缀）：
//   node --import tsx scripts/generate-prompt-manifest.mjs [--output <file>] [--generated-at <iso>]
//   node --import tsx scripts/generate-prompt-manifest.mjs --check [--output <file>]
//
// - 默认输出：packages/core/src/context/generated/prompt-manifest.json（生成物，随代码提交；
//   先例：scripts/generate-bash-command-registry.mjs 的 generated/ 目录模式）。
// - --check：CI 硬校验「manifest 与代码一致」（R6 阻断项）——repo 内清单缺段、多段、
//   hash/group/source/owner/顺序漂移都判失败退出码 1；generatedAt 不参与判定。
// - manifest 与其 hash 只落本地文件/stdout/debug 日志（运行期 trace 见
//   context/registry.ts emitSectionManifestTrace），不外发（no-telemetry 红线）。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPromptManifest,
  verifyPromptManifest,
} from "../packages/core/src/context/manifest.ts";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const GENERATED_RELATIVE_PATH = "packages/core/src/context/generated/prompt-manifest.json";
const DEFAULT_OUTPUT = join(APP_ROOT, GENERATED_RELATIVE_PATH);

function getArgValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

function serializePromptManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const check = process.argv.includes("--check");
const output = getArgValue("--output") ? resolve(getArgValue("--output")) : DEFAULT_OUTPUT;
const generatedAt = getArgValue("--generated-at");

const manifest = buildPromptManifest(generatedAt ? { generatedAt } : {});

// 生成即自检：刚构建的 manifest 必须通过硬校验（防御注册表/校验器自身的接线错误）。
const selfCheck = verifyPromptManifest(manifest);
if (!selfCheck.ok) {
  console.error("prompt-manifest: internal verification failed:");
  for (const problem of selfCheck.problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

if (check) {
  // 硬校验模式：对照 repo 内清单文件（--output 可重定向到临时文件供测试/演练）。
  let existingRaw;
  try {
    existingRaw = await readFile(output, "utf8");
  } catch {
    console.error(`prompt-manifest --check: manifest file not found: ${output}`);
    console.error("run: node --import tsx scripts/generate-prompt-manifest.mjs");
    process.exit(1);
  }
  let existing;
  try {
    existing = JSON.parse(existingRaw);
  } catch (error) {
    console.error(`prompt-manifest --check: manifest file is not valid JSON: ${error.message}`);
    process.exit(1);
  }
  const verification = verifyPromptManifest(existing);
  if (!verification.ok) {
    console.error(`prompt-manifest --check: manifest is out of sync with the section registry (${output}):`);
    for (const problem of verification.problems) {
      console.error(`  - ${problem}`);
    }
    console.error("regenerate: node --import tsx scripts/generate-prompt-manifest.mjs");
    process.exit(1);
  }
  console.log(
    `prompt-manifest --check: OK (${manifest.sections.length} sections, sectionsHash=${manifest.sectionsHash})`,
  );
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, serializePromptManifest(manifest), "utf8");
  // 本地 stdout 记录（构建脚本的正常输出通道，不出机器）：段数 + 目录摘要 hash。
  console.log(
    `prompt-manifest: wrote ${manifest.sections.length} sections (sectionsHash=${manifest.sectionsHash}) -> ${output}`,
  );
}
