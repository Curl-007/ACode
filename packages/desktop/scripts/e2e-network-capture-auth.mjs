#!/usr/bin/env node
/**
 * 运行时网络观测开关发送方鉴权的真机验收（补 Fix 5 的真 Electron 缺口）。
 *
 * 为什么需要它：packages/desktop/tests/network-capture-sender-authorization.test.mjs 用
 * loadMain（转译 + 注入 stub）跑真实模块，但发送方 id 是**手挑**的（RM_WINDOW_ID=2 /
 * RM_WEBCONTENTS_ID=3）。原 bug 的本质恰恰是「BrowserWindow.id 与 webContents.id 是两套
 * 独立计数器，真实运行时二者不相等」——手挑的常量能过，却无法证明真实 Electron 里这两套
 * 计数器的关系。本脚本用仓库已有的真 Electron（scripts/e2e-smoke.mjs 同一手法）把
 * **真实的 openResourceManager() 单例 + 真实构建出的 resourceManager.cjs preload + 真实
 * 跨进程 IPC** 串起来，由 Electron 亲自分配两套 id：
 *
 *   F1 前提：真实 RM 窗口的 BrowserWindow.id ≠ webContents.id（计数器已分叉，正是 bug 前提）；
 *   F2 合法 RM 发送方：从真实 RM 窗口经**真实 preload 桥** window.resourceManager.network
 *      .setEnabled(true) 发起 → 真 ipcRenderer.invoke → 真 isResourceManagerSender → 必须
 *      { success:true }，且 GetState 记忆 enabled=true；
 *   F3 越权防护：另一个真实窗口（同样挂真实 RM preload，但不是 RM 单例）发同一开关 →
 *      必须 { success:false, error:"forbidden" }（不同 webContents 不得借道）。
 *
 * 破坏对照（--control）：把**当前源码里的修复机械逆回**旧 WindowId 口径后构建进同一
 * harness、同一真实 Electron 运行时（对照自洽于工作树，不读 `git show HEAD`——修复与本
 * harness 同批提交后 HEAD 就是修复后形态，那种写法会让对照永久抛错而静默烂掉）。修复前
 * isResourceManagerSender 拿 sender.id（WebContents 空间）去比 getResourceManagerWindowId()
 * （WindowId 空间），在 F1 的分叉前提下合法 RM 发送方必被误判 forbidden——F2 必须复现为
 * { success:false, error:"forbidden" }。撤掉产品侧修复即红，与 workflow-worktree-isolation
 * 场景 4b 的对照纪律一致。
 *
 * 用法：node scripts/e2e-network-capture-auth.mjs [--control] [--timeout-ms N] [--json]
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as esbuild from "esbuild";
import {
  createReporter,
  finishReporter,
  parseHarnessArgs,
  randomUUID,
  spawnElectronMain,
  teardownElectron,
} from "./e2e-electron-harness.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");

const { controlMode, jsonOut, timeoutMs: overallTimeoutMs } = parseHarnessArgs();
const { record, logLine, checks, allOk } = createReporter({ tag: "f5-e2e", jsonOut });

const realPreloadPath = join(desktopRoot, "out", "preload", "resourceManager.cjs");
/** 破坏对照用 esbuild 虚拟命名空间 + specifier：HEAD 源码只活在内存，绝不落盘。 */
const CONTROL_NAMESPACE = "control";
const CONTROL_SPECIFIER = "__control_ipc";

/**
 * 取被验收的 IPC 模块源码。--control 时把**当前源码里的修复机械逆回**旧 WindowId 口径后
 * 经 esbuild 插件**在内存里**供出（resolveDir 指向真实 src/main，于是它对
 * ./resourceManagerWindow.js 等相邻导入仍解析到真实实现）——只有被验收的鉴权判定是修复前的。
 *
 * 为什么必须内存供出而不是落一份临时 .ts 到 src/main：src/main 被 tsconfig.main.json 的
 * include 与 oxlint 扫描，若把对照副本写成该目录下的临时 .ts，一旦 harness 被 Ctrl-C /
 * 超时杀进程（清理只在 finally 里，信号中断走不到），下一次 pnpm typecheck / lint /
 * architecture:check 就会编译一份多出来的副本而报错或加违规。内存供出从根上杜绝
 * stray 文件，不依赖清理路径。
 */
function prepareIpcSource() {
  const realPath = join(desktopRoot, "src/main/desktopNetworkCaptureIpc.ts");
  if (!controlMode) {
    return { specifier: realPath, plugins: [] };
  }
  // 破坏对照**自洽于当前工作树**：读现在的源码，机械地把修复逆回去（WebContentsId 口径 →
  // 旧的 WindowId 口径），其余逐字不动。为什么不用 `git show HEAD:`：那要求 HEAD 恰好是
  // 修复前形态，而本 harness 与修复同批提交后 HEAD 就是修复后形态，对照会永久抛错、
  // 静默烂掉——破坏对照必须长期可跑。
  const current = readFileSync(realPath, "utf8");
  const FIXED = `function isResourceManagerSender(event: IpcMainInvokeEvent): boolean {
  const resourceManagerWebContentsId = getResourceManagerWebContentsId();
  return (
    resourceManagerWebContentsId !== null &&
    asWebContentsId(event.sender.id) === resourceManagerWebContentsId
  );
}`;
  // 逆回修复前的旧 bug 形态：拿 sender.id（WebContents 空间）比 BrowserWindow.id（WindowId 空间）。
  const BROKEN = `function isResourceManagerSender(event: IpcMainInvokeEvent): boolean {
  const resourceManagerWindowId = getResourceManagerWindowId();
  return resourceManagerWindowId !== null && event.sender.id === resourceManagerWindowId;
}`;
  if (!current.includes(FIXED)) {
    throw new Error(
      `破坏对照前提不成立：当前 ${realPath} 里找不到修复形态的 isResourceManagerSender。\n` +
        "修复被改动或删除后请同步更新本 harness 的 FIXED/BROKEN 常量。",
    );
  }
  const controlSource = current.replace(FIXED, BROKEN);
  const plugin = {
    name: "control-source",
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${CONTROL_SPECIFIER}$`) }, () => ({
        path: realPath,
        namespace: CONTROL_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: CONTROL_NAMESPACE }, () => ({
        contents: controlSource,
        loader: "ts",
        resolveDir: dirname(realPath),
      }));
    },
  };
  return { specifier: CONTROL_SPECIFIER, plugins: [plugin] };
}

/**
 * 把真实的 resourceManagerWindow.ts + 被验收的 desktopNetworkCaptureIpc.ts 打成单个 ESM，
 * 物理落到 <workDir>/main/，于是真实模块里的 import.meta.dirname 解析到 <workDir>/main，
 * 其 ../preload/resourceManager.cjs 与 ../renderer/resource-manager.html 就是我们布置的
 * 真实构建产物 / 最小 harness 页面。electron 保持 external（Electron 运行时提供）。
 *
 * 异步：esbuild 插件（--control 的内存供源）只能用在 async API，同步 API 会直接拒绝。
 */
async function buildMainBundle(workDir, ipcSpecifier, plugins) {
  const mainDir = join(workDir, "main");
  mkdirSync(mainDir, { recursive: true });
  const result = await esbuild.build({
    stdin: {
      contents: `export {
  openResourceManager,
  getResourceManagerWindowId,
  getResourceManagerWebContentsId,
} from ${JSON.stringify(join(desktopRoot, "src/main/resourceManagerWindow.ts"))};
export {
  registerNetworkCaptureIpc,
  resetNetworkCaptureStateForTest,
} from ${JSON.stringify(ipcSpecifier)};
`,
      resolveDir: desktopRoot,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    external: ["electron"],
    plugins,
    // 与 f9ed896（server-cli ESM bundle 注入 createRequire）同一手法：被内联的 CJS 依赖
    // （yaml 等）会走 esbuild 的 __require 垫片去 require("process")，纯 ESM 里没有
    // require 会抛「Dynamic require of "process" is not supported」。注入 createRequire 兜底。
    banner: {
      js: `import { createRequire as __acodeCreateRequire } from "node:module";
const require = __acodeCreateRequire(import.meta.url);`,
    },
    logLevel: "silent",
  });
  const bundlePath = join(mainDir, "acode-f5.mjs");
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return bundlePath;
}

/**
 * 构建产物新鲜度守护（对齐 apps/acode-cli/evals/runner-report.mjs 的 checkDistFreshness：
 * 「陈旧 dist = 测旧代码 = 基线保真不成立」）。本 harness 拷的是 out/preload/resourceManager.cjs
 * （真实构建产物），若它比 src/preload/resourceManager.ts 旧，就说明桥改了没重建——
 * 继续跑等于拿旧桥验收新代码，必须 fail-loud 并给出重建命令，而不是静默通过。
 */
function checkPreloadFreshness() {
  const sources = [
    join(desktopRoot, "src", "preload", "resourceManager.ts"),
    join(desktopRoot, "src", "preload", "index.ts"),
  ].filter((p) => existsSync(p));
  const distMtimeMs = statSync(realPreloadPath).mtimeMs;
  const stale = sources
    .map((p) => ({ p, mtimeMs: statSync(p).mtimeMs }))
    .filter((s) => s.mtimeMs > distMtimeMs);
  if (stale.length === 0) return { ok: true };
  return {
    ok: false,
    reason:
      `真实 RM preload 产物比源码旧：out/preload/resourceManager.cjs (${new Date(
        distMtimeMs,
      ).toISOString()}) < ${stale
        .map((s) => `${s.p} (${new Date(s.mtimeMs).toISOString()})`)
        .join(", ")}。先重建再跑，否则本 harness 拿旧桥验收新代码。` +
      `重建：pnpm --filter @acode/desktop prepare:runtime-assets`,
  };
}

/** 编排用 Electron main（ESM）：造 id 分叉 → 开真实 RM 单例 → 造越权窗口 → 真 IPC 断言。 */
function writeOrchestratorMain(workDir, bundlePath, reportPath) {
  const mainDir = join(workDir, "main");
  const mainPath = join(mainDir, "electron-main.mjs");
  writeFileSync(
    mainPath,
    `import { app, BrowserWindow, webContents as electronWebContents } from "electron";
import path from "node:path";
import fs from "node:fs";

const REPORT = ${JSON.stringify(reportPath)};
const PRELOAD = path.join(import.meta.dirname, "../preload/resourceManager.cjs");
const RM_HTML = path.join(import.meta.dirname, "../renderer/resource-manager.html");

process.stderr.write("[f5-main] loaded\\n");
app.disableHardwareAcceleration();

function writeReport(payload) {
  try { fs.writeFileSync(REPORT, JSON.stringify(payload, null, 2), "utf8"); } catch {}
}

// 在 RM 渲染进程里经真实 preload 桥发起开关（真跨进程 IPC）。
async function toggleViaRealBridge(win, enabled) {
  return win.webContents.executeJavaScript(
    \`(async () => {
       if (!window.resourceManager?.network?.setEnabled) return { error: "no-bridge" };
       return await window.resourceManager.network.setEnabled(\${enabled});
     })()\`,
    true,
  );
}

app.whenReady().then(async () => {
  process.stderr.write("[f5-main] ready\\n");
  // 动态 import 真实模块：加载失败（如内联 CJS 的 require 垫片问题）时写进报告并退出，
  // 而不是让 Electron 停在「App threw an error during load」空转到 harness 超时。
  let mod;
  try {
    mod = await import("./acode-f5.mjs");
  } catch (error) {
    process.stderr.write("[f5-main] bundle import failed: " + String(error && error.stack || error) + "\\n");
    writeReport({ ok: false, stage: "bundle-import", error: String(error && error.stack || error) });
    app.exit(1);
    return;
  }
  const {
    openResourceManager,
    getResourceManagerWindowId,
    getResourceManagerWebContentsId,
    registerNetworkCaptureIpc,
    resetNetworkCaptureStateForTest,
  } = mod;

  resetNetworkCaptureStateForTest();
  registerNetworkCaptureIpc({ warn: () => {}, info: () => {}, error: () => {} });

  // 造 id 分叉：先建若干 offscreen webContents（消耗 webContents 计数器但不消耗 window
  // 计数器），复现真实 App 里 guest/辅助 renderer 让 RM 的 webContents.id 超前 BrowserWindow.id。
  const offscreen = [];
  for (let i = 0; i < 3; i += 1) {
    try { offscreen.push(electronWebContents.create({ offscreen: true })); } catch {}
  }

  openResourceManager();
  // 找到真实 RM 单例窗口（标题 Resource Manager）。
  let rmWin = null;
  for (let i = 0; i < 100; i += 1) {
    rmWin = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Resource Manager") ?? null;
    if (rmWin) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!rmWin) { writeReport({ ok:false, stage:"no-rm-window" }); app.exit(1); return; }

  // 等真实 preload 桥就绪。
  let bridgeReady = false;
  for (let i = 0; i < 200; i += 1) {
    bridgeReady = await rmWin.webContents
      .executeJavaScript("Boolean(window.resourceManager?.network?.setEnabled)", true)
      .catch(() => false);
    if (bridgeReady) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  const rmWindowId = getResourceManagerWindowId();
  const rmWebContentsId = getResourceManagerWebContentsId();
  const senderId = rmWin.webContents.id;
  process.stderr.write(\`[f5-main] RM winId=\${rmWindowId} wcId=\${rmWebContentsId} sender.id=\${senderId} bridge=\${bridgeReady}\\n\`);

  // F2：合法 RM 发送方经真实桥开关。
  const legitResult = await toggleViaRealBridge(rmWin, true);
  const stateAfter = await rmWin.webContents
    .executeJavaScript("window.resourceManager.network.getState()", true)
    .catch((e) => ({ error: String(e) }));

  // F3：另一个真实窗口（挂同一真实 preload，但非 RM 单例）发同一开关 → 必须 forbidden。
  const attacker = new BrowserWindow({
    width: 300, height: 200, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: PRELOAD },
  });
  await attacker.loadFile(RM_HTML);
  let attackerBridge = false;
  for (let i = 0; i < 200; i += 1) {
    attackerBridge = await attacker.webContents
      .executeJavaScript("Boolean(window.resourceManager?.network?.setEnabled)", true)
      .catch(() => false);
    if (attackerBridge) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const attackerResult = await toggleViaRealBridge(attacker, true);

  writeReport({
    ok: true,
    precondition: {
      rmWindowId, rmWebContentsId, senderId,
      countersDiverge: rmWindowId !== rmWebContentsId,
      bridgeReady, attackerBridge,
      offscreenCreated: offscreen.length,
    },
    legitResult,
    stateAfter,
    attackerResult,
  });
  for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch {} }
  app.exit(0);
});

app.on("window-all-closed", () => {});
process.on("uncaughtException", (error) => {
  process.stderr.write("[f5-main] uncaught: " + String(error && error.stack || error) + "\\n");
  writeReport({ ok: false, stage: "uncaughtException", error: String(error && error.stack || error) });
  app.exit(1);
});
`,
    "utf8",
  );
  return mainPath;
}

async function main() {
  const runId = randomUUID();
  const workDir = mkdtempSync(join(tmpdir(), "acode-f5-e2e-"));
  const electronUserData = join(workDir, "ud");
  const preloadDir = join(workDir, "preload");
  const rendererDir = join(workDir, "renderer");
  for (const dir of [electronUserData, preloadDir, rendererDir]) mkdirSync(dir, { recursive: true });
  const reportPath = join(workDir, "report.json");

  const prepared = prepareIpcSource();
  let child = null;
  try {
    if (!existsSync(realPreloadPath)) {
      throw new Error(
        `真实构建的 RM preload 不存在：${realPreloadPath}。先跑 pnpm --filter @acode/desktop build（或 prepare:runtime-assets）。`,
      );
    }
    // 新鲜度守护：产物比源码旧 = 桥改了没重建，继续跑等于拿旧桥验收新代码（fail-loud）。
    const freshness = checkPreloadFreshness();
    if (!freshness.ok) throw new Error(freshness.reason);
    // 用真实构建出的 preload（真 contextBridge 桥），不自己伪造。
    copyFileSync(realPreloadPath, join(preloadDir, "resourceManager.cjs"));
    // openResourceManager 会 loadFile ../renderer/resource-manager.html；给最小页面即可
    // （真实桥由 preload 提供，与页面内容无关）。
    writeFileSync(
      join(rendererDir, "resource-manager.html"),
      `<!doctype html><html><head><meta charset="utf-8"></head><body>rm-harness</body></html>`,
      "utf8",
    );

    const bundlePath = await buildMainBundle(workDir, prepared.specifier, prepared.plugins);
    const mainPath = writeOrchestratorMain(workDir, bundlePath, reportPath);
    logLine(
      `[f5-e2e] mode=${controlMode ? "CONTROL(HEAD 修复前)" : "FIXED(工作树)"} bundle=${(
        readFileSync(bundlePath).length / 1024 / 1024
      ).toFixed(1)}MiB`,
    );

    const spawned = await spawnElectronMain({
      mainPath,
      workDir,
      userDataDir: electronUserData,
      runId,
      timeoutMs: overallTimeoutMs,
    });
    child = spawned.child;
    const { outcome, stdioText } = spawned;

    if (outcome.signal === "timeout") {
      record("electron-run", false, `timeout after ${overallTimeoutMs}ms\n${stdioText.slice(-1500)}`);
      throw new Error("timeout");
    }

    let report = null;
    if (existsSync(reportPath)) {
      try {
        report = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch {}
    }
    if (!report || report.ok !== true) {
      record(
        "electron-run",
        false,
        `no usable report (exit=${outcome.code}) ${report?.error ?? ""}\n--- stdio ---\n${stdioText.slice(-2000)}`,
      );
      throw new Error("electron run produced no report");
    }
    record("electron-run", true, `real Electron + real RM singleton + real preload bridge (exit=${outcome.code})`);

    const pre = report.precondition ?? {};
    logLine(
      `[f5-e2e] precondition rmWindowId=${pre.rmWindowId} rmWebContentsId=${pre.rmWebContentsId} sender.id=${pre.senderId} diverge=${pre.countersDiverge} bridge=${pre.bridgeReady}`,
    );
    logLine(
      `[f5-e2e] legitResult=${JSON.stringify(report.legitResult)} stateAfter=${JSON.stringify(report.stateAfter)} attackerResult=${JSON.stringify(report.attackerResult)}`,
    );

    // F1 前提在两种模式下都必须成立：真实 Electron 里两套 id 计数器已分叉，且真实桥就绪。
    record(
      "F1-counters-diverge",
      pre.countersDiverge === true && pre.bridgeReady === true,
      `BrowserWindow.id=${pre.rmWindowId} ≠ webContents.id=${pre.rmWebContentsId}（offscreen ${pre.offscreenCreated} 个推高 wc 计数器）；真实 preload 桥就绪=${pre.bridgeReady}`,
    );
    record(
      "F1b-sender-is-webcontents",
      pre.senderId === pre.rmWebContentsId && pre.senderId !== pre.rmWindowId,
      `真实 event.sender.id=${pre.senderId} == RM webContents.id（≠ RM BrowserWindow.id=${pre.rmWindowId}）——鉴权比对的正是这个值`,
    );
    // 越权窗口的真实桥必须真起来，否则 F3/C2 的 forbidden 会掩盖「桥根本没加载」——
    // 断言前置条件，让失败指向前置条件而不是鉴权判定。
    record(
      "F1c-attacker-bridge-ready",
      pre.attackerBridge === true,
      `越权窗口的真实 preload 桥就绪=${pre.attackerBridge}（否则 F3 的 forbidden 无法归因于鉴权）`,
    );

    const legit = report.legitResult ?? {};
    if (controlMode) {
      // 破坏对照：修复前拿 sender.id(WebContents) 比 WindowId，分叉前提下合法 RM 必被误拒。
      record(
        "C2-legit-forbidden-bug-reproduced",
        legit.success === false && legit.error === "forbidden",
        `合法 RM 开关返回 ${JSON.stringify(legit)}（修复前误判 forbidden，bug 复现）`,
      );
    } else {
      record(
        "F2-legit-allowed",
        legit.success === true && !("error" in legit),
        `合法 RM 经真实桥开关返回 ${JSON.stringify(legit)}`,
      );
      record(
        "F2b-state-remembered",
        report.stateAfter?.enabled === true && typeof report.stateAfter?.captureId === "string",
        `开关放行后 main 记忆 enabled=${report.stateAfter?.enabled} captureId=${report.stateAfter?.captureId ? "set" : "null"}`,
      );
      const attacker = report.attackerResult ?? {};
      record(
        "F3-attacker-forbidden",
        attacker.success === false && attacker.error === "forbidden",
        `非 RM 单例的真实窗口（挂同一真实 preload）发同一开关返回 ${JSON.stringify(attacker)}（不借道）`,
      );
    }
  } catch (error) {
    record("unexpected", false, String(error?.stack ?? error));
  } finally {
    await teardownElectron({ child, workDir, record });
  }

  finishReporter({
    runId,
    mode: controlMode ? "control" : "fixed",
    checks,
    allOk: allOk(),
    jsonOut,
  });
}

await main();
