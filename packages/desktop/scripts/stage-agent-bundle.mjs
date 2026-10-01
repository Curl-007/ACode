// Agent bundle 的暂存动作：把 apps/acode-cli/packages/cli/dist/acode.cjs 放进
// bundled-agents/<平台>/glm，并写 meta。
//
// dev 与打包**必须**用同一份暂存实现。
// 只有打包链（prepare-agent-node-bundle.mjs）会暂存是不够的，dev 链
// （scripts/build-desktop-agent-cli.mjs）不会；而 dev 未打包时的 agent 二进制由
// desktopRuntimeEnv.ts 的 resolveBundledACodeAgentBinaryPath() 解析，候选**只有**
// bundled-agents/，没有 cli/dist/。于是 dev 一直跑着上一次打包时留下的那份 ——
// 实测陈旧 3 天，任何 agent CLI 侧改动在 dev 里静默不生效，排查时会把「改动没生效」
// 误判成「代码没起作用」。两边共用这一份，dev 与打包不可能再各自漂移。
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const AGENT_BUNDLE_SOURCE_RELATIVE = "apps/acode-cli/packages/cli/dist/acode.cjs";

// J5-L1：字节码 loader（固定名）+ 构建元数据 sidecar（build-desktop-agent-bytecode.mjs 产出，
// 含 sourceSha256/bytecodeFile/runtimeFile，供本 staging 做新鲜度 + 依赖闭环校验；非运行时文件，不随包）。
const BYTECODE_LOADER_FILE = "acode.bytecode.cjs";
const BYTECODE_META_FILE = "acode.bytecode-meta.json";

export function resolveAgentBundlePaths({ repoRoot, platformKey }) {
  const glmDir = resolve(repoRoot, "packages", "desktop", "bundled-agents", platformKey, "glm");
  return {
    cliBundlePath: resolve(repoRoot, AGENT_BUNDLE_SOURCE_RELATIVE),
    glmDir,
    stagedBundlePath: resolve(glmDir, "acode.cjs"),
    stagedMetaPath: resolve(glmDir, ".node-bundle-meta.json"),
  };
}

/**
 * J5-L1：解析「应当 stage」的字节码产物（loader + meta 引用的 .jsc + runtime），并做安全校验。
 * 返回 null 表示放弃字节码、只发 JS（安全态）。放弃条件（对抗复核 F1/F2）：
 *   - E2E coverage：覆盖率插桩必须走 JS 路径，字节码是已压缩未插桩的旧码会让覆盖率静默归零；
 *   - meta 缺失/损坏：无法证明字节码与本次 acode.cjs 的关系；
 *   - sourceSha256 失配（F2 新鲜度）：.jsc 与 acode.cjs 之间无运行时新鲜度校验（V8 只看 sourceLength
 *     且长度取自 loader 自身 metadata 恒自洽），陈旧字节码会静默取代新 JS（甚至版本劈叉：agent 跑旧码、
 *     storagePreparationEntry 用新码操作同一存储）。staging 端用 sourceSha256 做机器可判拦截；
 *   - 依赖不闭环（F1）：loader 引用的 .jsc / runtime 任一缺失，生产 loader 的同步 require 会失败。
 */
function resolveValidatedBytecodeArtifacts({ cliDistDir, bundleSha256, coverage, log }) {
  if (coverage) {
    log("[stage:agent-bundle] skip bytecode under E2E coverage (JS path required for instrumentation)");
    return null;
  }
  let meta;
  try {
    meta = JSON.parse(readFileSync(resolve(cliDistDir, BYTECODE_META_FILE), "utf8"));
  } catch {
    log("[stage:agent-bundle] bytecode meta unavailable → JS only");
    return null;
  }
  if (!meta.sourceSha256 || meta.sourceSha256 !== bundleSha256) {
    log("[stage:agent-bundle] bytecode sourceSha256 mismatch (stale bytecode) → JS only");
    return null;
  }
  const artifacts = [BYTECODE_LOADER_FILE, meta.bytecodeFile, meta.runtimeFile].filter(
    (name) => typeof name === "string" && name.length > 0,
  );
  // loader 必须在；.jsc 与 runtime 是 loader 的硬依赖，缺一即放弃字节码。
  if (artifacts.length < 3) {
    log("[stage:agent-bundle] bytecode meta incomplete (loader/jsc/runtime) → JS only");
    return null;
  }
  for (const name of artifacts) {
    if (!existsSync(resolve(cliDistDir, name))) {
      log(`[stage:agent-bundle] bytecode artifact missing (${name}) → JS only`);
      return null;
    }
  }
  return artifacts;
}

/**
 * 干净重建 glm 目录再拷贝。清空是刻意的：electron-builder 整目录拷贝
 * bundled-agents/<平台>/glm → resources/glm，本地工作树里上一次构建残留的原生二进制
 * （acode-agent / acode-acp 等）和旧 meta 会被一并打进安装包（CI 干净检出不会有，本地会）。
 */
export function stageAgentBundle({
  repoRoot,
  platformKey,
  log = console.log,
  coverage = process.env.ACODE_E2E_COVERAGE === "1",
}) {
  const { cliBundlePath, glmDir, stagedBundlePath, stagedMetaPath } = resolveAgentBundlePaths({
    repoRoot,
    platformKey,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[stage:agent-bundle] agent bundle 源产物不存在：${cliBundlePath}`);
  }
  rmSync(glmDir, { recursive: true, force: true });
  mkdirSync(glmDir, { recursive: true });
  copyFileSync(cliBundlePath, stagedBundlePath);

  // J5-L1：字节码产物经校验（新鲜度 + 依赖闭环）后随 acode.cjs 一起 stage；任一不过 → JS only（安全）。
  // sha256 用 utf8→Buffer 与编译器同源（compile-desktop-agent-bytecode.cjs:28 bytecodeDigest(Buffer.from(source))），
  // 避免编码差异导致校验恒失配。
  const cliDistDir = resolve(cliBundlePath, "..");
  const bundleSha256 = createHash("sha256")
    .update(Buffer.from(readFileSync(stagedBundlePath, "utf8")))
    .digest("hex");
  const bytecodeArtifacts =
    resolveValidatedBytecodeArtifacts({ cliDistDir, bundleSha256, coverage, log }) ?? [];
  for (const name of bytecodeArtifacts) {
    copyFileSync(resolve(cliDistDir, name), resolve(glmDir, name));
  }

  const meta = {
    runtime: "electron-node",
    entry: "acode.cjs",
    platform: platformKey,
    source: AGENT_BUNDLE_SOURCE_RELATIVE,
    // 字节码入口是否随包（纯信息字段，供诊断/发布核对）：生产 resolver 不读本 meta，而是用
    // existsSync 探测 acode.cjs 的同目录兄弟 acode.bytecode.cjs（见 acodeAgentProcessManager 兄弟派生）。
    bytecodeEntry: bytecodeArtifacts.includes(BYTECODE_LOADER_FILE) ? BYTECODE_LOADER_FILE : null,
  };
  writeFileSync(stagedMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);
  if (bytecodeArtifacts.length > 0) {
    log(`[stage:agent-bundle] staged bytecode artifacts: ${bytecodeArtifacts.join(", ")}`);
  }
  return { stagedBundlePath, stagedMetaPath, bytecodeArtifacts };
}
