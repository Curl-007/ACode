"use strict";

const v8 = require("node:v8");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { basename, dirname, join } = require("node:path");

function configureBytecodeRuntime() {
  // 字节码不带可重新编译的源码，必须完整编译并保留字节码；编译器和加载器共用这一处配置。
  v8.setFlagsFromString("--no-lazy --no-flush-bytecode");
  return {
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    cachedDataVersionTag: v8.cachedDataVersionTag(),
  };
}

function bytecodeDigest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function loadBytecode(metadata, targetModule, targetRequire) {
  const directory = dirname(targetModule.filename);
  if (basename(metadata.bytecodeFile) !== metadata.bytecodeFile) {
    throw new Error("无效的字节码文件名");
  }
  // J5-L1（对抗复核 N1）：无需 flags 的校验前置。configureBytecodeRuntime() 会全局设
  // --no-lazy --no-flush-bytecode（eager 编译、不刷字节码），若先设 flags 再发现失配，回退的
  // acode.cjs 会在被污染的 V8 状态下运行（实测启动 +20~25%，比现状 JS 还慢），证伪「最坏=回退 JS
  // 无损」承诺。生产最常见的两类回退——Electron/V8 版本漂移、.jsc 损坏/陈旧——只需 5 个稳定字段
  // （无需 flags）与 digest（无需 flags）即可判定，故在设 flags 前拦截，让回退回到干净 JS 现状。
  // 仅同版本下的 cachedDataVersionTag 比较需要 flags（后置设置），该失配概率极低。
  const recorded = metadata.runtime ?? {};
  const stableRuntimeMatches =
    recorded.electron === (process.versions.electron ?? null) &&
    recorded.node === process.versions.node &&
    recorded.v8 === process.versions.v8 &&
    recorded.platform === process.platform &&
    recorded.arch === process.arch;
  if (!stableRuntimeMatches) {
    throw new Error(
      "字节码运行时不匹配，请用当前 Electron 重新运行 pnpm build:desktop-agent:bytecode",
    );
  }
  const cachedData = await readFile(join(directory, metadata.bytecodeFile));
  if (bytecodeDigest(cachedData) !== metadata.bytecodeSha256) {
    throw new Error("字节码摘要不匹配，请重新构建桌面 Agent");
  }
  // 无需 flags 的校验全部通过；现在设 flags 并做权威的全指纹比较（含 cachedDataVersionTag）+ 编译。
  const runtime = configureBytecodeRuntime();
  if (JSON.stringify(runtime) !== JSON.stringify(metadata.runtime)) {
    throw new Error(
      "字节码运行时不匹配，请用当前 Electron 重新运行 pnpm build:desktop-agent:bytecode",
    );
  }
  // 使用 ASCII 空格而非双字节零宽字符。这里只消除明文源码，仍保留等长占位内存。
  const source = " ".repeat(metadata.sourceLength);
  const filename = join(directory, metadata.sourceFile);
  const script = new vm.Script(source, {
    cachedData,
    filename,
    // 动态 import 必须交回 Node，继续按原 bundle 的 URL 解析外置 ESM 与原生依赖。
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  if (script.cachedDataRejected) {
    throw new Error("V8 拒绝字节码缓存，请重新构建桌面 Agent");
  }
  const run = script.runInThisContext();
  if (typeof run !== "function") throw new Error("字节码不是 CommonJS 模块");
  try {
    run.call(
      targetModule.exports,
      targetModule.exports,
      targetRequire,
      targetModule,
      filename,
      directory,
    );
  } catch (error) {
    // J5-L1（对抗复核 F4a）：字节码已成功加载并开始执行 bundle 工厂；此处抛错是 bundle 自身运行
    // 错误，而非「字节码加载失败」。打标记让 loader 不对它回退 require(acode.cjs)——否则会二次执行
    // 顶层副作用。加载失败（指纹/摘要/cachedDataRejected，均在 run.call 之前）不带此标记，可安全回退。
    if (error && typeof error === "object") error.__acodeBytecodeExecuted = true;
    throw error;
  }
}

module.exports = { configureBytecodeRuntime, bytecodeDigest, loadBytecode };
