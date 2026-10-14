#!/usr/bin/env node
/**
 * 第三方台账可复现性校验的单一实现（docs/upgrades/quality-and-release-2026-10.md U13）。
 *
 * 为什么需要它：台账（third-party/inventory.json + THIRD-PARTY-NOTICES.md）只有在规范平台
 * 重生成能得到同样字节时才有意义。此前「重生成 → diff → 非空即失败」的判定内联在
 * licenses-notices.yml 的三步 YAML 里，scripts/licenses.mjs 只有 notices/check 两个子命令，
 * 没有可复用入口——于是 ci.yml 想跑、release.yml 想跑都只能各抄一份逻辑，与 U01 收敛前
 * 「三处内联类型检查命令」是同一形状。本模块是那三步的唯一实现，CLI 与 workflow 都经
 * scripts/licenses.mjs reproducibility 派发到这里。
 *
 * 两种模式，能力边界不可混淆（L06 专门验这条边界）：
 *   inputs-only  只重算台账 inputs 的源文件 sha256，零 install、秒级，可在开发期任意分支跑；
 *                看不见 packages / notInstalled / noticesSha256 这些依赖树派生字段。
 *   full         调生成器全量重生成后与已入库台账 diff，需要已安装依赖树与 CI Linux 口径，
 *                是发布权威。
 *
 * 哈希口径必须与生成器逐字一致：third-party-npm.mjs 的 hashBytes + CRLF→LF 归一化
 * （generate-third-party-notices.mjs:14）。归一化不是可选优化——仓库 core.autocrlf=true 时
 * Windows 检出必然带 CRLF，不归一会让 inputs-only 在 Windows 上恒红。
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hashBytes } from "./third-party-npm.mjs";

/** inputs-only 的耗时上界：实测 1.6s / 2869 项，留足慢盘余量但不许退化成分钟级。 */
export const INPUTS_ONLY_ELAPSED_BUDGET_MS = 10_000;

/**
 * 台账相对仓库根的位置；full / diff-only 模式 diff 的就是这两个文件。
 * 导出而非各处重列：licenses-notices.yml 的产物上传步骤与本清单必须指同一对文件，
 * 测试也据此断言——两份手列清单正是 U13 要消灭的漂移来源（缺口二同型）。
 */
export const LEDGER_FILES = ["THIRD-PARTY-NOTICES.md", "third-party/inventory.json"];

/** 并发读文件的上界：Windows 下一次性打开数千 fd 会撞句柄限制。 */
const READ_CONCURRENCY = 64;

/** 台账 inputs 是「相对仓库根 → sha256」映射，键本身就是被追踪的源文件清单。 */
async function readLedgerInputs(root) {
  const raw = await readFile(join(root, "third-party/inventory.json"), "utf8");
  const ledger = JSON.parse(raw);
  if (!ledger.inputs || typeof ledger.inputs !== "object") {
    throw new Error(
      "third-party/inventory.json 缺少 inputs 映射：台账 schema 变更时本模块需同步，不得静默当作零项通过",
    );
  }
  return ledger.inputs;
}

/** 与生成器同一口径：UTF-8 读出后把 CRLF 归一为 LF，再 sha256。 */
function hashSourceText(text) {
  return hashBytes(Buffer.from(text.replaceAll("\r\n", "\n"), "utf8"));
}

async function mapWithConcurrency(items, limit, worker) {
  const results = Array.from({ length: items.length });
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/**
 * 校验台账 inputs 与工作树是否一致。
 *
 * 返回体自带 mode 与 coversDependencyTree，调用方与人类读者都必须能区分
 * 「inputs-only 绿」与「full 绿」：前者看不到依赖树派生字段，把它当发布权威会导致
 * 依赖漂移被漏过（这正是 U13 立项时 0.0.8 发布踩到的坑的镜像面）。
 */
export async function verifyInputsFreshness(root, { inputsOnly = false, diffOnly = false } = {}) {
  const startedAt = Date.now();
  if (!inputsOnly) {
    return verifyFullReproducibility(root, startedAt, diffOnly);
  }
  const inputs = await readLedgerInputs(root);
  const entries = Object.entries(inputs);
  const drift = await mapWithConcurrency(entries, READ_CONCURRENCY, async ([file, recorded]) => {
    let text;
    try {
      text = await readFile(join(root, file), "utf8");
    } catch (error) {
      // 文件消失与哈希不符是两种事实：前者要提示删台账条目，后者要提示重生成。
      if (error.code === "ENOENT") return { file, kind: "missing", recorded, actual: null };
      throw error;
    }
    const actual = hashSourceText(text);
    return actual === recorded ? null : { file, kind: "mismatch", recorded, actual };
  });
  const found = drift.filter(Boolean);
  return {
    ok: found.length === 0,
    mode: "inputs-only",
    coversDependencyTree: false,
    checked: entries.length,
    drift: found,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * full 模式：调生成器全量重生成，再与已入库台账 diff。
 * 需要已安装依赖树与 CI Linux 口径（musl libc 变体），本机通常跑不通——这是设计内的，
 * 该模式的权威地位来自它能看到依赖树派生字段，代价就是只能在 CI 上跑。
 *
 * diffOnly=true 时跳过重生成，只 diff 当前工作树与已入库台账：供 licenses-notices.yml
 * 使用——那个工作流已在前一步（带 musl 补丁的 install）重生成过，重复生成会翻倍 CI 成本，
 * 且 musl 补丁只有它自己能打。这样「重生成」的所有权留在 workflow，「漂移判定」（比哪些
 * 文件、什么算差异、如何报告）收敛到本模块一处，YAML 不再保留第二份判定逻辑。
 */
export async function verifyFullReproducibility(root, startedAt = Date.now(), diffOnly = false) {
  if (!diffOnly) {
    await runProcess(process.execPath, [join(root, "scripts", "licenses.mjs"), "notices"], root);
  }
  const { stdout } = await runProcess(
    "git",
    ["--no-pager", "diff", "--numstat", "--", ...LEDGER_FILES],
    root,
  );
  const changed = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/).pop())
    .filter(Boolean);
  return {
    ok: changed.length === 0,
    mode: diffOnly ? "full-diff-only" : "full",
    coversDependencyTree: true,
    changedFiles: changed,
    elapsedMs: Date.now() - startedAt,
  };
}

/** 以参数数组形式起子进程，不用 shell 字符串拼接（跨平台纪律）。 */
function runProcess(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} 退出码 ${code}\n${(stderr || stdout).trim().slice(-2000)}`,
          ),
        );
    });
  });
}

/**
 * 从台账 inputs 归纳出 workflow 的 paths 过滤清单。
 *
 * 目的：workflow 的 pull_request.paths 与台账 inputs 是两条必须一致的清单，此前各自手工
 * 维护并漂移到手写只覆盖 15.9%。让其中一条由另一条生成，漂移就不可能发生。
 *
 * 取「最小目录覆盖集」：把每个被追踪文件的父目录收成 `dir/**`，再剪掉被祖先目录包含的
 * 后代目录，根目录文件单独列为精确路径。实测 2869 项 → 27 条，且未覆盖项为 0。
 * 输出按字典序稳定排序，便于在 YAML 里 diff 审阅。
 */
export async function derivePathsFilter(root) {
  const inputs = await readLedgerInputs(root);
  const dirs = new Set();
  const rootFiles = [];
  for (const file of Object.keys(inputs)) {
    const slash = file.lastIndexOf("/");
    if (slash < 0) rootFiles.push(file);
    else dirs.add(file.slice(0, slash));
  }
  const sorted = [...dirs].sort();
  const collapsed = sorted.filter((dir) => !sorted.some((other) => dir.startsWith(`${other}/`)));
  return [...collapsed.map((dir) => `${dir}/**`), ...rootFiles.sort()];
}

/**
 * 覆盖率：清单对台账 inputs 的命中比例，外加未命中清单。
 * 这是 U13 的 L04 断言面——生成的清单必须 100%，手写清单当前 15.9%。
 */
export async function measurePathsFilterCoverage(root, { patterns }) {
  const inputs = await readLedgerInputs(root);
  const files = Object.keys(inputs);
  const uncovered = files.filter((file) => !matchesPathsPattern(file, patterns));
  return {
    total: files.length,
    covered: files.length - uncovered.length,
    coverageRatio: files.length === 0 ? 0 : (files.length - uncovered.length) / files.length,
    uncovered,
  };
}

/**
 * 支持 workflow paths 的三种形态：精确路径、目录通配（dir 加双星）、以及以双星开头的
 * 文件名通配。注意不要在块注释里写出后者的字面量——其中的星号加斜杠会提前终止注释。
 */
function matchesPathsPattern(file, patterns) {
  return patterns.some((pattern) => {
    if (pattern === file) return true;
    if (pattern.endsWith("/**")) return file.startsWith(`${pattern.slice(0, -3)}/`);
    if (pattern.startsWith("**/")) {
      const suffix = pattern.slice(3);
      return file === suffix || file.endsWith(`/${suffix}`);
    }
    return false;
  });
}

/** 人类可读的漂移摘要：指名文件与种类，失败必须可定位到具体条目。 */
export function formatDrift(result) {
  if (result.mode === "full" || result.mode === "full-diff-only") {
    return result.ok
      ? "重生成结果与已入库台账一致：生成可复现 ✓"
      : `重生成结果与已入库台账不一致（${result.changedFiles.length} 个文件有差异）：\n${result.changedFiles
          .map((file) => `  - ${file}`)
          .join("\n")}`;
  }
  if (result.ok) {
    return `台账 inputs 与工作树一致：${result.checked} 项源文件哈希全部相符（${result.elapsedMs}ms，mode=inputs-only，不含依赖树派生字段）✓`;
  }
  const lines = result.drift.map((item) =>
    item.kind === "missing"
      ? `  - ${item.file}：文件不存在（台账仍登记该输入）`
      : `  - ${item.file}：哈希不符\n      台账 ${item.recorded}\n      实际 ${item.actual}`,
  );
  return `台账 inputs 与工作树不一致：${result.checked} 项中 ${result.drift.length} 项漂移（mode=inputs-only）\n${lines.join("\n")}`;
}
