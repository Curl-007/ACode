#!/usr/bin/env node
/**
 * gen-ui 可视化卡片的真机渲染验收（补 Fix 1 的真 DOM 缺口）。
 *
 * 为什么需要它：packages/ui/test/genUiVisualizeCard.test.ts 只能做两件事——对组件源码做
 * 正则结构守卫、以及手写一个 React commit-loop **仿真**来演示活锁机制。仓库没有 DOM 测试
 * 工具链（无 jsdom / react-test-renderer / happy-dom），所以「真实 React 调度器 + 真实
 * Chromium DOM 下这张卡到底收不收敛」从未被真跑过。本脚本用仓库已有的真 Electron
 * （scripts/e2e-smoke.mjs 同一手法：本仓安装的 Electron 二进制 + 隔离身份）把**真实组件**
 * 挂进**真实 Chromium**，观测三个 live 事实：
 *
 *   R1 渲染次数收敛      —— displayName 的 getter 每次渲染被读一次，即真实 render 计数；
 *   R2 读取 RPC 有界     —— readVisualization 调用次数。活锁时以渲染速率无界洪泛；
 *   R3 在途读取不被中断  —— 每个 signal 被 abort 的次数。活锁时 cleanup 每轮中断在途读；
 *   R4 卡片真出现在 DOM  —— [data-v4-visualization-card] 内含 iframe[sandbox="allow-scripts"]，
 *                           且不再停留于 aria-busy 的 loading 占位。
 *
 * 破坏对照（--control）：把**当前源码里的 useMemo 修复机械逆回**裸调用（对照自洽于工作树，
 * 不读 `git show HEAD`——修复与本 harness 同批提交后 HEAD 就是修复后形态，那种写法会让对照
 * 永久抛错而静默烂掉），在同一 harness、同一真实 DOM 里跑一遍，必须复现活锁（渲染/RPC 无界、
 * 卡片永不出现）。撤掉产品侧修复即红——与 workflow-worktree-isolation 场景 4b 的对照纪律一致。
 *
 * 用法：node scripts/e2e-visualization-card-render.mjs [--control] [--timeout-ms N] [--json]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const repoRoot = resolve(desktopRoot, "..", "..");
const uiRoot = join(repoRoot, "packages", "ui");

const { controlMode, jsonOut, timeoutMs: overallTimeoutMs } = parseHarnessArgs();
const { record, logLine, checks, allOk } = createReporter({ tag: "genui-e2e", jsonOut });

/** 活锁判据：真实 DOM 里 2.5s 内渲染超过这个数即认定没有不动点。 */
const LIVELOCK_RENDER_FLOOR = 20;
const OBSERVE_MS = 2_500;
/** 破坏对照用 esbuild 虚拟命名空间 + specifier：HEAD 源码只活在内存，绝不落盘。 */
const CONTROL_NAMESPACE = "control";
const CONTROL_SPECIFIER = "__control_component";

/**
 * 取被验收的组件源码。
 * --control 时把当前源码里的修复机械逆回旧形态后经 esbuild 插件在内存里供出
 * （resolveDir 指向真实 src/v4，其 `@/` 别名与相邻导入仍解析到真实实现）——只有被验收那
 * 一行是修复前的。
 */
function prepareComponentSource() {
  const realPath = join(uiRoot, "src", "v4", "VisualizationArtifactRow.tsx");
  if (!controlMode) {
    return { specifier: "@/v4/VisualizationArtifactRow.js", plugins: [] };
  }
  // 破坏对照**自洽于当前工作树**：读现在的源码，机械地把修复逆回去（useMemo 包裹 → 裸调用），
  // 其余逐字不动。为什么不用 `git show HEAD:`：那要求 HEAD 恰好是修复前的形态，而本 harness
  // 与修复同批提交后 HEAD 就是修复后形态，对照会永久抛错、静默烂掉——破坏对照必须长期可跑。
  const current = readFileSync(realPath, "utf8");
  const FIXED = "const identity = useMemo(() => parseVisualizationArtifactRef(row.ref), [row.ref]);";
  const BROKEN = "const identity = parseVisualizationArtifactRef(row.ref);";
  if (!current.includes(FIXED)) {
    throw new Error(
      `破坏对照前提不成立：当前 ${realPath} 里找不到修复形态\n  ${FIXED}\n` +
        "修复被改动或删除后请同步更新本 harness 的 FIXED/BROKEN 常量。",
    );
  }
  const controlSource = current.replace(FIXED, BROKEN);
  // 对照源码经 esbuild 插件在内存里供出（resolveDir 指向真实 src/v4，其 `@/` 别名与相邻
  // 导入照旧解析到真实实现），全程绝不落盘。理由：src/v4 被 packages/ui/tsconfig.json 的
  // include 与 oxlint 扫描，若把对照副本写成 src 下的临时 .tsx，一旦 harness 被 Ctrl-C /
  // 超时杀进程（清理只在 finally 里，信号中断走不到），下次 typecheck / lint / architecture
  // 就会编译一份多出来的副本而报错或加违规。内存供出从根上杜绝 stray 文件。
  const plugin = {
    name: "control-source",
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${CONTROL_SPECIFIER}$`) }, () => ({
        path: realPath,
        namespace: CONTROL_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: CONTROL_NAMESPACE }, () => ({
        contents: controlSource,
        loader: "tsx",
        resolveDir: dirname(realPath),
      }));
    },
  };
  return { specifier: CONTROL_SPECIFIER, plugins: [plugin] };
}

async function buildHarnessBundle(workDir, componentSpecifier, plugins) {
  const entryPath = join(workDir, "harness-entry.tsx");
  writeFileSync(
    entryPath,
    `// 自动生成：真机 DOM harness 入口（由 e2e-visualization-card-render.mjs 写入，勿手改）。
import * as React from "react";
import { createRoot } from "react-dom/client";
import { VisualizationArtifactRow } from ${JSON.stringify(componentSpecifier)};
import { ACodeIntlProvider } from "@/i18n/IntlProvider.js";

// 三个 live 计数器：renders 由 displayName 的 getter 每次渲染递增（组件渲染体里
// \`row.displayName.trim()\` 恰读一次），rpcCalls / abortedCalls 由注入的读取通道记录。
let renders = 0;
let rpcCalls = 0;
let abortedCalls = 0;

const FRAGMENT = "<!doctype html><html><body><h1>real-dom-card</h1></body></html>";

const row: any = {
  rowId: 7,
  kind: "artifact",
  artifactVersionId: "av-1",
  logicalArtifactKey: "card",
  get displayName() {
    renders += 1;
    return "实机卡片";
  },
  artifactType: "html",
  mimeType: "text/html",
  sizeBytes: FRAGMENT.length,
  sha256: "0".repeat(64),
  ref: "acode-visualization://sess-real/card.html",
  state: "current",
  meta: { visualization: { mode: "wide" } },
};

// 真实读取通道替身：形状与 ConversationVisualizationReadChunk 逐字对齐（单块到尾），
// 50ms 延迟模拟 stdio/IPC 时序——活锁的 abort 只有在读取在途时才看得见。
const readVisualization = async (params: any) => {
  rpcCalls += 1;
  const signal: AbortSignal | undefined = params?.signal;
  if (signal?.aborted) {
    abortedCalls += 1;
  } else if (signal) {
    signal.addEventListener("abort", () => { abortedCalls += 1; }, { once: true });
  }
  await new Promise((r) => setTimeout(r, 50));
  if (signal?.aborted) throw new Error("aborted-by-cleanup");
  const bytes = new TextEncoder().encode(FRAGMENT);
  return { bytes, mediaType: "text/html" as const, totalBytes: bytes.byteLength, nextOffset: null };
};

const context: any = {
  workspacePath: "/tmp/e2e-ws",
  theme: "dark",
  codePreviewSettings: { lineNumbers: true, wordWrap: false, maxLines: 2000 },
  readVisualization,
};

const host = document.getElementById("host");
if (!host) throw new Error("harness host missing");
const root = createRoot(host);
root.render(
  React.createElement(
    ACodeIntlProvider as any,
    { initialLocale: "zh-CN" },
    React.createElement(VisualizationArtifactRow as any, { row, context }),
  ),
);

// 从真实 DOM 读相位：aria-busy 占位 = loading；iframe 在场 = ready；重试按钮 = failed。
function observePhase(): string {
  const card = document.querySelector('[data-v4-visualization-card="true"]');
  if (!card) return "no-card";
  if (card.querySelector("iframe")) return "ready";
  if (card.querySelector('[aria-busy="true"]')) return "loading";
  if (card.querySelector('[data-testid^="v4-visualization-retry-"]')) return "failed";
  return "other";
}

(globalThis as any).__harnessStats = () => ({
  renders,
  rpcCalls,
  abortedCalls,
  phase: observePhase(),
  iframeSandbox: document.querySelector('[data-v4-visualization-card="true"] iframe')?.getAttribute("sandbox") ?? null,
  cardMode: document.querySelector('[data-v4-visualization-card="true"]')?.getAttribute("data-v4-visualization-mode") ?? null,
});
(globalThis as any).__harnessReady = true;
`,
    "utf8",
  );

  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    target: "chrome120",
    // `@/*` → packages/ui/src/*（与 packages/ui/tsconfig.json 的 paths 同源）。
    alias: { "@": join(uiRoot, "src") },
    // entry 落在仓库外的临时目录，bare 依赖（react/react-dom）需显式给出 node 解析根，
    // 否则会沿临时目录向上找不到 pnpm 提升在仓库根的包。
    nodePaths: [join(repoRoot, "node_modules"), join(uiRoot, "node_modules")],
    plugins,
    logLevel: "silent",
  });
  const bundlePath = join(workDir, "harness-bundle.js");
  writeFileSync(bundlePath, result.outputFiles[0].contents);
  return bundlePath;
}

function writeHarnessHtml(workDir) {
  const htmlPath = join(workDir, "harness.html");
  writeFileSync(
    htmlPath,
    `<!doctype html><html><head><meta charset="utf-8"><title>genui-e2e</title></head>
<body><div id="host"></div><script src="./harness-bundle.js"></script></body></html>`,
    "utf8",
  );
  return htmlPath;
}

function writeElectronMain(workDir, htmlPath, reportPath) {
  const mainPath = join(workDir, "electron-main.cjs");
  writeFileSync(
    mainPath,
    `// 自动生成：最小 Electron main，只负责开窗 + 加载真实组件 harness + 回写观测结果。
const { app, BrowserWindow } = require("electron");
const fs = require("fs");

const HTML = ${JSON.stringify(htmlPath)};
const REPORT = ${JSON.stringify(reportPath)};
const OBSERVE_MS = ${OBSERVE_MS};

process.stderr.write("[genui-main] module loaded\\n");
app.disableHardwareAcceleration();

function writeReport(payload) {
  try { fs.writeFileSync(REPORT, JSON.stringify(payload, null, 2), "utf8"); } catch {}
}

app.whenReady().then(async () => {
  process.stderr.write("[genui-main] app ready\\n");
  const win = new BrowserWindow({
    width: 1100, height: 800, show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false },
  });
  process.stderr.write("[genui-main] window created id=" + win.id + "\\n");
  await win.loadFile(HTML);
  const evalIn = (expr) => win.webContents.executeJavaScript(expr, true);
  // 等 harness 挂载完成（bundle 是同步 IIFE，通常一次即就绪）。
  for (let i = 0; i < 200; i += 1) {
    const ready = await evalIn("Boolean(globalThis.__harnessReady)").catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const early = await evalIn("globalThis.__harnessStats()").catch((e) => ({ error: String(e) }));
  await new Promise((r) => setTimeout(r, OBSERVE_MS));
  const late = await evalIn("globalThis.__harnessStats()").catch((e) => ({ error: String(e) }));
  writeReport({ ok: true, early, late, observeMs: OBSERVE_MS });
  app.exit(0);
});

app.on("window-all-closed", () => app.exit(0));
process.on("uncaughtException", (error) => {
  process.stderr.write("[genui-main] uncaught: " + String(error && error.stack || error) + "\\n");
  writeReport({ ok: false, stage: "uncaughtException", error: String(error && error.stack || error) });
  app.exit(1);
});
`,
    "utf8",
  );
  // Electron 靠 app 目录里的 package.json 定位 main 入口；缺它时会退回默认 app 并静默崩。
  writeFileSync(
    join(workDir, "package.json"),
    JSON.stringify({ name: "genui-e2e", version: "1.0.0", main: "electron-main.cjs" }, null, 2),
    "utf8",
  );
  return mainPath;
}

async function main() {
  const runId = randomUUID();
  const workDir = mkdtempSync(join(tmpdir(), "acode-genui-e2e-"));
  const electronUserData = join(workDir, "userData");
  mkdirSync(electronUserData, { recursive: true });
  const reportPath = join(workDir, "report.json");

  const prepared = prepareComponentSource();
  let child = null;
  try {
    const bundlePath = await buildHarnessBundle(workDir, prepared.specifier, prepared.plugins);
    const htmlPath = writeHarnessHtml(workDir);
    writeElectronMain(workDir, htmlPath, reportPath);
    logLine(
      `[genui-e2e] mode=${controlMode ? "CONTROL(HEAD 修复前)" : "FIXED(工作树)"} bundle=${(
        readFileSync(bundlePath).length / 1024
      ).toFixed(0)}KiB`,
    );

    // 这里把 workDir 当作 Electron app 入口（其 package.json 的 main 指向 electron-main.cjs）。
    const spawned = await spawnElectronMain({
      mainPath: workDir,
      workDir,
      userDataDir: electronUserData,
      runId,
      timeoutMs: overallTimeoutMs,
    });
    child = spawned.child;
    const { outcome, stdioText } = spawned;

    if (outcome.signal === "timeout") {
      record("electron-run", false, `timeout after ${overallTimeoutMs}ms`);
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
    record(
      "electron-run",
      true,
      `real Chromium mount ok, observed ${report.observeMs}ms (exit=${outcome.code})`,
    );

    const early = report.early ?? {};
    const late = report.late ?? {};
    logLine(
      `[genui-e2e] stats early=${JSON.stringify(early)}\n[genui-e2e] stats late =${JSON.stringify(late)}`,
    );

    if (controlMode) {
      // 破坏对照：修复前的组件必须在真实 DOM 里复现活锁——渲染与 RPC 无界、卡片永不 ready。
      record(
        "C1-livelock-reproduced",
        Number(late.renders) >= LIVELOCK_RENDER_FLOOR && Number(late.rpcCalls) >= LIVELOCK_RENDER_FLOOR,
        `renders=${late.renders} rpcCalls=${late.rpcCalls}（阈值 ${LIVELOCK_RENDER_FLOOR}）`,
      );
      record(
        "C2-inflight-reads-aborted",
        Number(late.abortedCalls) > 0 && Number(late.abortedCalls) >= Number(late.rpcCalls) - 1,
        `abortedCalls=${late.abortedCalls} / rpcCalls=${late.rpcCalls}（cleanup 每轮中断在途读）`,
      );
      record("C3-card-never-ready", late.phase !== "ready", `phase=${late.phase}（活锁下永不到 ready）`);
    } else {
      // 修复后：真实 React 调度器下必须有不动点。
      record(
        "R1-renders-converge",
        Number(late.renders) < LIVELOCK_RENDER_FLOOR,
        `renders=${late.renders}（< ${LIVELOCK_RENDER_FLOOR}；活锁时会在 ${OBSERVE_MS}ms 内无界增长）`,
      );
      record("R2-read-bounded", Number(late.rpcCalls) === 1, `rpcCalls=${late.rpcCalls}（恰一次分块读取）`);
      record("R3-no-abort", Number(late.abortedCalls) === 0, `abortedCalls=${late.abortedCalls}`);
      record("R4-card-ready-in-dom", late.phase === "ready", `phase=${late.phase}`);
      record(
        "R5-iframe-sandbox",
        late.iframeSandbox === "allow-scripts",
        `sandbox="${late.iframeSandbox}"（specs/gen-ui-visualize-card.md 要求 allow-scripts）`,
      );
      record(
        "R6-wide-mode-honored",
        late.cardMode === "wide",
        `data-v4-visualization-mode="${late.cardMode}"`,
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
