import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const defaultEntryPath = join(repoRoot, "apps/acode-cli/packages/cli/dist/acode.cjs");
const runtimeSourcePath = join(import.meta.dirname, "desktop-agent-bytecode-runtime.cjs");
const compilerPath = join(import.meta.dirname, "compile-desktop-agent-bytecode.cjs");

async function publishImmutable(path, contents) {
  try {
    await writeFile(path, contents, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if ((await readFile(path)).equals(contents)) return;
    // J5-L1（对抗复核 F6）：同名但内容不同 = 上次写入被中断的截断残留。内容寻址名下重写是安全的，
    // 自愈而非抛错——旧行为 throw「已有字节码资源损坏」会让此后每次构建都重复失败（本机字节码永久卡死，
    // 需人工删文件）。运行时安全由 loader 的摘要校验 + 优雅回退兜底（截断 .jsc → 回退 JS）。
    await rm(path, { force: true });
    await writeFile(path, contents, { flag: "wx" });
  }
}

/**
 * J5-L1：渲染字节码加载器源码。导出以便测试用 fake metadata/runtime 验证真实回退逻辑。
 * 字节码加载成功 → 执行 bundle；「加载失败」→ 生产（ACODE_BYTECODE_FALLBACK=1，由
 * resolveElectronRuntimeACodeAgentCommand 设置）优雅回退同目录 acode.cjs（metadata.sourceFile）。
 * 对抗复核修复：
 *   F1 —— 同步 require(runtime) 也纳入回退保护：runtime 文件缺失时原 `.catch` 覆盖不到同步 require，
 *         生产会 Cannot find module 硬崩、回退永不触发（P0）。
 *   F4a —— 仅对「加载失败」回退；bundle 已开始执行（error.__acodeBytecodeExecuted，由 runtime.cjs 标记）
 *         则不回退，避免 require(acode.cjs) 二次执行顶层副作用。
 *   F4b —— 回退时写一行 stderr（host 已把 agent stderr 接进诊断），补上「字节码静默失效」的可观测性；
 *         stdout 协议流保持干净。
 * dev 显式试验不设 ACODE_BYTECODE_FALLBACK → 硬失败暴露问题（保留原语义）。
 */
export function renderBytecodeLoader(metadata, runtimeFile) {
  return `#!/usr/bin/env node
"use strict";
const path = require("node:path");
const metadata = ${JSON.stringify(metadata)};
// J5-L1（对抗复核 N7 卫生加固）：捕获回退标志后立即从 env 删除，避免 ACODE_BYTECODE_FALLBACK
// 随 agent 进程继承下渗到 Bash/MCP 子进程（值零机密性，但语义上不应让嵌套调用都带「生产可回退」）。
const fallbackEnabled = process.env.ACODE_BYTECODE_FALLBACK === "1";
delete process.env.ACODE_BYTECODE_FALLBACK;
function hardFail(error) {
  process.stderr.write(String(error && error.stack ? error.stack : error) + "\\n");
  process.exitCode = 1;
}
function tryFallback(error) {
  if (!fallbackEnabled || (error && error.__acodeBytecodeExecuted)) {
    hardFail(error);
    return;
  }
  const reason = error && error.message ? error.message : String(error);
  process.stderr.write("[acode-bytecode] fallback to " + metadata.sourceFile + ": " + reason + "\\n");
  try {
    module.exports = require(path.join(__dirname, metadata.sourceFile));
  } catch (fallbackError) {
    hardFail(fallbackError);
  }
}
let runtime;
try {
  runtime = require(${JSON.stringify(`./${runtimeFile}`)});
} catch (error) {
  tryFallback(error);
  return;
}
runtime.loadBytecode(metadata, module, require).catch(tryFallback);
`;
}

export async function buildDesktopAgentBytecode({
  entryPath = defaultEntryPath,
  electronPath = createRequire(import.meta.url)("electron"),
  env = process.env,
} = {}) {
  if (env.ACODE_E2E_COVERAGE === "1") throw new Error("coverage 构建不能启用字节码试验");
  const directory = dirname(entryPath);
  const temporary = join(directory, `.bytecode-${randomUUID()}`);
  const loaderPath = join(directory, "acode.bytecode.cjs");
  try {
    const { stdout } = await execFileAsync(electronPath, [compilerPath, entryPath, temporary], {
      env: { ...env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "" },
      maxBuffer: 1024 * 1024,
    });
    const metadata = JSON.parse(stdout);
    const bytecodeFile = `acode.bytecode-${metadata.bytecodeSha256}.jsc`;
    const bytecodePath = join(directory, bytecodeFile);
    const runtimeSource = await readFile(runtimeSourcePath);
    const runtimeHash = createHash("sha256").update(runtimeSource).digest("hex");
    const runtimeFile = `acode.bytecode-runtime-${runtimeHash}.cjs`;
    metadata.bytecodeFile = bytecodeFile;
    metadata.sourceFile = basename(entryPath);
    // 先写不可变依赖，最后原子替换入口；失败时上次可用的加载器仍能找到自己的字节码。
    await publishImmutable(bytecodePath, await readFile(temporary));
    await publishImmutable(join(directory, runtimeFile), runtimeSource);
    // J5-L1：loader 内置优雅回退（见 renderBytecodeLoader 注释）。
    const loader = renderBytecodeLoader(metadata, runtimeFile);
    await writeFile(`${temporary}.cjs`, loader, { mode: 0o755 });
    await rename(`${temporary}.cjs`, loaderPath);
    // J5-L1（对抗复核 F2）：构建元数据 sidecar，供 staging 校验字节码与随包 acode.cjs 的新鲜度绑定
    // （sourceSha256）与依赖闭环（bytecodeFile/runtimeFile 是否都被 stage）。.jsc 与 acode.cjs 之间
    // 没有任何运行时新鲜度校验（V8 只看 sourceLength，且长度取自 loader 自身 metadata 恒自洽），
    // 陈旧字节码会静默取代新 JS——staging 端用本 sidecar 做机器可判的拦截。非运行时文件，不随包 stage。
    await writeFile(
      join(directory, "acode.bytecode-meta.json"),
      `${JSON.stringify(
        {
          bytecodeFile: metadata.bytecodeFile,
          runtimeFile,
          sourceFile: metadata.sourceFile,
          sourceSha256: metadata.sourceSha256,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    // J5-L1：清理同目录陈旧的内容寻址字节码产物（多次构建残留的孤儿 .jsc/runtime），
    // 避免 staging 的前缀 glob 把全部孤儿拷进包（本地 dist 会累积；CI 干净检出无此问题）。
    // 仅保留当前 bytecodeFile / runtimeFile / loader；清理失败非致命。
    try {
      const keep = new Set([metadata.bytecodeFile, runtimeFile, basename(loaderPath)]);
      const siblings = await readdir(directory);
      await Promise.all(
        siblings
          .filter(
            (name) =>
              !keep.has(name) &&
              (/^acode\.bytecode-.+\.jsc$/.test(name) ||
                /^acode\.bytecode-runtime-.+\.cjs$/.test(name)),
          )
          .map((name) => rm(join(directory, name), { force: true })),
      );
    } catch {
      // 忽略：陈旧产物只影响本地 dist 体积，不影响正确性（loader 按 metadata 精确找自己的 .jsc）。
    }
    return { loaderPath, bytecodePath, metadata };
  } finally {
    await Promise.all([temporary, `${temporary}.cjs`].map((file) => rm(file, { force: true })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const artifact = await buildDesktopAgentBytecode();
  console.log(JSON.stringify(artifact, null, 2));
}
