// 深链/argv 入口硬化簇（specs/desktop-startup-hardening.md §4b–4f）测试。
// 覆盖：second-instance 去重、盘符相对拒绝、UNC hop 断言（防 SMB 触网）、
// toast 限频+分类+文案、日志安全 URL 渲染，以及 desktopDeepLinkUrl 提取层与
// desktopSecondInstanceDeepLink 的集成。fs 相关用例在真实临时目录上跑；
// Windows 上创建符号链接可能需要特权，遇 EPERM 时跳过对应子用例。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { transpileModule, ModuleKind } from "typescript";

const nodeRequire = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);

async function readSource(relative) {
  return readFile(new URL(relative, root), "utf8");
}

async function loadMain(relative, imports = {}) {
  const source = await readSource(`src/main/${relative}.ts`);
  const output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function("require", "exports", output)((name) => {
    if (name.startsWith("node:")) {
      return nodeRequire(name);
    }
    assert.ok(name in imports, `unexpected runtime import: ${name}`);
    return imports[name];
  }, exports);
  return exports;
}

// 真实的 desktopDeepLinkUrl（纯模块，无依赖）
const deepLinkUrl = await loadMain("desktopDeepLinkUrl");

// deepLinkHardening 在 isNetworkWorkspacePath 收进本模块后是叶子（仅依赖
// desktopDeepLinkUrl）；UNC 谓词单一事实源（specs/desktop-startup-hardening.md §4d，
// desktopOAuthDeepLink 侧 re-export 保持既有 import 面）。
const deepLinkHardening = await loadMain("deepLinkHardening", {
  "./desktopDeepLinkUrl.js": deepLinkUrl,
});

// 真实 desktopOAuthDeepLink：钉 §4e/§4f 的接线集成面（失败点 → 分类 + 限频 +
// Notification + 安全 URL 渲染）。该模块 import electron，但顶层无 electron 调用
// （toast gate 是纯函数），stub 依赖后可安全加载真实实现；Notification 用捕获型
// 替身、app.isReady 恒 true 放开展示分支。
const notificationCalls = [];
class NotificationStub {
  constructor(options) {
    this.options = options;
  }
  show() {
    notificationCalls.push(this.options);
  }
  static isSupported() {
    return true;
  }
}
const realOAuth = await loadMain("desktopOAuthDeepLink", {
  electron: {
    app: { isReady: () => true },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    dialog: {},
    Notification: NotificationStub,
  },
  "./desktopWindowIds.js": { asWebContentsId: (x) => x },
  "@acode/shared": {
    PlatformChannels: new Proxy({}, { get: (_, k) => String(k) }),
    DEFAULT_LOCALE: "zh-CN",
  },
  "./desktopDeepLinkUrl.js": deepLinkUrl,
  "./deepLinkHardening.js": deepLinkHardening,
  "./desktopLinuxDeepLinkRegistration.js": { registerLinuxDeepLinkProtocol: () => {} },
});

// ══════════════════════════════════════════════════════════════
// §4b second-instance 500ms 同键去重
// ══════════════════════════════════════════════════════════════

test("§4b dedupe: same argv+cwd within 500ms is duplicate; cwd difference and elapsed time are not", async () => {
  const { createSecondInstanceArgvDedupe } = deepLinkHardening;
  let clock = 10_000;
  const dedupe = createSecondInstanceArgvDedupe({ now: () => clock });
  const argv = ["/exe", "acode://oauth/callback?state=x"];

  assert.equal(dedupe.isDuplicate(argv, "/cwd"), false, "first delivery is not duplicate");
  assert.equal(dedupe.isDuplicate(argv, "/cwd"), true, "immediate repeat is duplicate");

  // 窗口从「上次出现」滑动（每次命中都刷新时间戳，与证据 fDa 同构）。
  clock += 499;
  assert.equal(dedupe.isDuplicate(argv, "/cwd"), true, "still within 500ms of last sighting");
  // 一次性跳过窗口：距上次出现 ≥500ms → 视为新事件
  clock += 501;
  assert.equal(dedupe.isDuplicate(argv, "/cwd"), false, "outside window from last sighting is fresh");

  // cwd 不同 → 键不同 → 不重复
  const d2 = createSecondInstanceArgvDedupe({ now: () => 0 });
  assert.equal(d2.isDuplicate(argv, "/a"), false);
  assert.equal(d2.isDuplicate(argv, "/b"), false);
  // argv 不同 → 不重复
  assert.equal(d2.isDuplicate(["/exe", "other"], "/b"), false);
});

// ══════════════════════════════════════════════════════════════
// §4c 盘符相对路径拒绝（谓词 + 提取层）
// ══════════════════════════════════════════════════════════════

test("§4c drive-relative predicate: C:foo rejected, C:\\foo and C:/foo are absolute", async () => {
  const { isDriveRelativeWindowsPath } = deepLinkUrl;
  assert.equal(isDriveRelativeWindowsPath("C:foo"), true);
  assert.equal(isDriveRelativeWindowsPath("c:bar\\baz"), true);
  assert.equal(isDriveRelativeWindowsPath("C:\\foo"), false);
  assert.equal(isDriveRelativeWindowsPath("C:/foo"), false);
  assert.equal(isDriveRelativeWindowsPath("/unix/path"), false);
  assert.equal(isDriveRelativeWindowsPath("relative"), false);
});

test("§4c extractOpenWorkspacePathFromArgs: drops drive-relative, keeps absolute, skips to next valid", async () => {
  const { extractOpenWorkspacePathFromArgs } = deepLinkUrl;
  // 盘符相对 → 提取层直接拒绝
  assert.equal(extractOpenWorkspacePathFromArgs(["--open-workspace=C:foo"]), null);
  assert.equal(extractOpenWorkspacePathFromArgs(["--open-workspace", "C:foo"]), null);
  // 盘符绝对 → 保留
  assert.equal(extractOpenWorkspacePathFromArgs(["--open-workspace=C:\\foo"]), "C:\\foo");
  assert.equal(extractOpenWorkspacePathFromArgs(["--open-workspace=C:/foo"]), "C:/foo");
  // 跳过盘符相对，取下一个合法值
  assert.equal(
    extractOpenWorkspacePathFromArgs(["--open-workspace=C:foo", "--open-workspace=D:\\bar"]),
    "D:\\bar",
  );
});

// ══════════════════════════════════════════════════════════════
// §4d UNC hop 断言
// ══════════════════════════════════════════════════════════════

test("§4d inspect: raw UNC / device namespace / drive-relative rejected before any fs touch", async () => {
  const { inspectDeepLinkWorkspacePath } = deepLinkHardening;

  assert.equal(inspectDeepLinkWorkspacePath("C:foo").reason, "drive_relative");

  for (const unc of ["\\\\remote\\share", "//remote/share", "\\\\?\\UNC\\remote\\share"]) {
    const result = inspectDeepLinkWorkspacePath(unc);
    assert.equal(result.ok, false, `${unc} must be rejected`);
    assert.equal(result.reason, "unsafe_unc", `${unc} → unsafe_unc`);
  }

  // \\.\pipe 属设备命名空间（isNetworkWorkspacePath 先行捕获，reason 为 unc 类），仍必须拒绝
  const pipe = inspectDeepLinkWorkspacePath("\\\\.\\pipe\\evil");
  assert.equal(pipe.ok, false);
  assert.notEqual(pipe.reason, "drive_relative");
});

test("§4d inspect: empty / NUL-byte path fail-closed as unverifiable", async () => {
  const { inspectDeepLinkWorkspacePath } = deepLinkHardening;
  assert.equal(inspectDeepLinkWorkspacePath("").reason, "unverifiable");
  assert.equal(inspectDeepLinkWorkspacePath("C:\\a\0b").reason, "unverifiable");
});

test("§4d inspect: existing local dir and missing path pass (missing handled downstream)", async () => {
  const { inspectDeepLinkWorkspacePath } = deepLinkHardening;
  const tmp = mkdtempSync(join(tmpdir(), "dlh-"));
  try {
    // 真实本地目录：全链无符号链接 → ok
    assert.deepEqual(inspectDeepLinkWorkspacePath(tmp), { ok: true });
    // 不存在的路径：ENOENT → ok（存在性语义交回下游）
    assert.deepEqual(inspectDeepLinkWorkspacePath(join(tmp, "does-not-exist")), { ok: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("§4d inspect: symlink whose target text is UNC → unc_hop without touching the target", async () => {
  const { inspectDeepLinkWorkspacePath } = deepLinkHardening;
  const tmp = mkdtempSync(join(tmpdir(), "dlh-unc-"));
  const linkPath = join(tmp, "link");
  try {
    try {
      symlinkSync("//remote/share", linkPath, "dir");
    } catch (error) {
      // Windows 无特权创建符号链接会 EPERM；POSIX CI 正常执行。
      if (error && (error.code === "EPERM" || error.code === "EACCES")) {
        return; // skip
      }
      throw error;
    }
    const result = inspectDeepLinkWorkspacePath(linkPath);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unc_hop");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("§4d inspect: symlink to a local dir resolves and passes", async () => {
  const { inspectDeepLinkWorkspacePath } = deepLinkHardening;
  const tmp = mkdtempSync(join(tmpdir(), "dlh-local-"));
  const realDir = join(tmp, "real");
  const linkPath = join(tmp, "link");
  try {
    mkdirSync(realDir);
    try {
      symlinkSync(realDir, linkPath, "dir");
    } catch (error) {
      if (error && (error.code === "EPERM" || error.code === "EACCES")) {
        return; // skip on unprivileged Windows
      }
      throw error;
    }
    assert.deepEqual(inspectDeepLinkWorkspacePath(linkPath), { ok: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════
// §4e toast 分类 + 限频 + 文案
// ══════════════════════════════════════════════════════════════

test("§4e classifyDeepLinkFailureCategory: substring → closed set, default other", async () => {
  const { classifyDeepLinkFailureCategory } = deepLinkHardening;
  assert.equal(classifyDeepLinkFailureCategory("登录已过期，请重新登录"), "auth_expired");
  assert.equal(classifyDeepLinkFailureCategory("sign-in has expired"), "auth_expired");
  assert.equal(classifyDeepLinkFailureCategory("network unreachable"), "network");
  assert.equal(classifyDeepLinkFailureCategory("read ECONNREFUSED 1.2.3.4:443"), "network");
  assert.equal(classifyDeepLinkFailureCategory("目标不存在"), "missing");
  assert.equal(classifyDeepLinkFailureCategory("transcript not found"), "missing");
  assert.equal(classifyDeepLinkFailureCategory("some unknown failure"), "other");
  assert.equal(classifyDeepLinkFailureCategory(""), "other");
});

test("§4e toast gate: (key,category) suppressed within 5min, distinct category and elapsed time pass", async () => {
  const { createDeepLinkFailureToastGate } = deepLinkHardening;
  let clock = 0;
  const gate = createDeepLinkFailureToastGate({ now: () => clock });

  const first = gate.recordFailure("k1", "network");
  assert.equal(first.showToast, true);
  assert.equal(first.isRepeat, false);

  const second = gate.recordFailure("k1", "network");
  assert.equal(second.showToast, false, "same (key,category) within window suppressed");
  assert.equal(second.isRepeat, true);

  // 同键不同类别 → 独立放行
  const otherCategory = gate.recordFailure("k1", "auth_expired");
  assert.equal(otherCategory.showToast, true);

  // 过窗口后同 (键,类别) 再放行
  clock += 300_001;
  const afterWindow = gate.recordFailure("k1", "network");
  assert.equal(afterWindow.showToast, true);
});

test("§4e toast copy: zh-CN and en-US cover all four categories", async () => {
  const { resolveDeepLinkFailureToastCopy } = deepLinkHardening;
  for (const category of ["auth_expired", "network", "missing", "other"]) {
    const zh = resolveDeepLinkFailureToastCopy(category, "zh-CN");
    const en = resolveDeepLinkFailureToastCopy(category, "en-US");
    assert.ok(zh.title && zh.body, `zh copy for ${category}`);
    assert.ok(en.title && en.body, `en copy for ${category}`);
    assert.notEqual(zh.title, en.title);
  }
  // 未知 locale 回退英文
  assert.deepEqual(
    resolveDeepLinkFailureToastCopy("other", "fr-FR"),
    resolveDeepLinkFailureToastCopy("other", "en-US"),
  );
});

// ══════════════════════════════════════════════════════════════
// §4f 日志安全 URL 渲染
// ══════════════════════════════════════════════════════════════

test("§4f renderSafeUrlForLog: keeps protocol/host/first segment, masks query/hash, unparseable safe", async () => {
  const { renderSafeUrlForLog } = deepLinkHardening;
  assert.equal(
    renderSafeUrlForLog("acode://oauth/callback?code=SECRET&state=XYZ#frag"),
    "acode://oauth/callback?…#…",
  );
  assert.equal(renderSafeUrlForLog("https://example.com/a/b/c?q=1"), "https://example.com/a?…");
  assert.equal(renderSafeUrlForLog("https://example.com/"), "https://example.com/");
  assert.equal(renderSafeUrlForLog("not a url at all"), "(unparseable)");
  // 遮断保证：secret 不出现在渲染结果
  const rendered = renderSafeUrlForLog("acode://payment/callback?token=SUPERSECRET");
  assert.ok(!rendered.includes("SUPERSECRET"));
});

// ══════════════════════════════════════════════════════════════
// §4e/§4f 接线集成：desktopOAuthDeepLink 失败点 → 安全 URL 渲染 + 分类 + 限频 Notification
// ══════════════════════════════════════════════════════════════

test("§4f wiring: handleDeepLink 不可解析 URL 落安全渲染，原始串不进日志", () => {
  const warns = [];
  const result = realOAuth.handleDeepLink(
    "not a url ?token=SUPERSECRET",
    { info: () => {}, warn: (...args) => warns.push(args.join(" ")) },
    {},
  );
  assert.equal(result, false);
  const line = warns.find((entry) => entry.includes("无法解析"));
  assert.ok(line, "expected the unparseable warn line");
  assert.ok(line.includes("(unparseable)"), "safe rendering replaces the raw garbage string");
  assert.ok(!line.includes("SUPERSECRET"), "raw input must not reach the log");
});

test("§4e wiring: workspace 缺 path 失败 → missing 文案 Notification，同窗第二次限频抑制", () => {
  notificationCalls.length = 0;
  const logger = { info: () => {}, warn: () => {} };
  // acode://workspace/open 不带 path 参数：命中「工作区打开请求缺少 path」失败点。
  const url = "acode://workspace/open";
  assert.equal(realOAuth.handleDeepLink(url, logger, {}), false);
  assert.equal(notificationCalls.length, 1, "首次失败展示 toast");
  // missing 分类 → zh-CN 自撰文案（resolveDeepLinkFailureToastCopy 内置，DEFAULT_LOCALE stub）。
  assert.equal(notificationCalls[0].title, "目标不存在");
  assert.ok(notificationCalls[0].body.length > 0);
  assert.equal(realOAuth.handleDeepLink(url, logger, {}), false);
  assert.equal(notificationCalls.length, 1, "同 (键,类别) 5 分钟窗口内抑制");
});

test("UNC 谓词单一事实源：desktopOAuthDeepLink re-export 与 deepLinkHardening 实现同一", () => {
  assert.equal(realOAuth.isNetworkWorkspacePath, deepLinkHardening.isNetworkWorkspacePath);
  assert.equal(realOAuth.isNetworkWorkspacePath("\\\\remote\\share"), true);
  assert.equal(realOAuth.isNetworkWorkspacePath("//remote/share"), true);
  assert.equal(realOAuth.isNetworkWorkspacePath("/unix/absolute"), false);
});

// ══════════════════════════════════════════════════════════════
// 集成：desktopSecondInstanceDeepLink
// ══════════════════════════════════════════════════════════════

const secondInstance = await loadMain("desktopSecondInstanceDeepLink", {
  "./desktopDeepLinkUrl.js": deepLinkUrl,
  "./deepLinkHardening.js": deepLinkHardening,
});

function makeDeps(overrides = {}) {
  const calls = { deepLink: [], openWorkspace: [], warn: [], info: [] };
  const deps = {
    additionalData: undefined,
    argv: ["/exe"],
    forceUpdateBlocked: false,
    focusForceUpdateGateWindow: () => {},
    handleDeepLink: (url) => {
      calls.deepLink.push(url);
      return overrides.deepLinkResult ?? true;
    },
    handleOpenWorkspacePath: (path) => {
      calls.openWorkspace.push(path);
      return overrides.openWorkspaceResult ?? true;
    },
    logger: {
      info: (...a) => calls.info.push(a),
      warn: (...a) => calls.warn.push(a),
    },
    ...overrides.deps,
  };
  return { deps, calls };
}

test("integration: second-instance suppresses duplicate argv within 500ms (no handler, no focus)", async () => {
  const { handleSecondInstanceWorkspaceRequest } = secondInstance;
  const { deps, calls } = makeDeps();
  // 唯一 argv，避免与其它用例串扰（去重槽是模块级单例）
  const argv = ["/exe", "acode://oauth/callback?state=dedup-unique-1"];
  deps.argv = argv;
  deps.workingDirectory = "/cwd-dedup";

  const first = handleSecondInstanceWorkspaceRequest(deps);
  assert.equal(first, true, "deep link handled");
  assert.equal(calls.deepLink.length, 1);

  const second = handleSecondInstanceWorkspaceRequest(deps);
  assert.equal(second, true, "duplicate suppressed as handled");
  assert.equal(calls.deepLink.length, 1, "handler not invoked again");
  assert.ok(calls.info.some((a) => String(a[0]).includes("去重")), "logs suppression info");
});

test("integration: second-instance rejects UNC workspace path before handleOpenWorkspacePath", async () => {
  const { handleSecondInstanceWorkspaceRequest } = secondInstance;
  const { deps, calls } = makeDeps();
  deps.argv = ["/exe", "--open-workspace=\\\\remote\\share"];
  deps.workingDirectory = "/cwd-unc";

  const result = handleSecondInstanceWorkspaceRequest(deps);
  assert.equal(result, false);
  assert.equal(calls.openWorkspace.length, 0, "must not reach handleOpenWorkspacePath");
  assert.ok(calls.warn.some((a) => String(a[0]).includes("unsafe_unc")));
});

test("integration: second-instance passes a valid local workspace path through", async () => {
  const { handleSecondInstanceWorkspaceRequest } = secondInstance;
  const tmp = mkdtempSync(join(tmpdir(), "dlh-si-"));
  try {
    const { deps, calls } = makeDeps();
    deps.argv = ["/exe", `--open-workspace=${tmp}`];
    deps.workingDirectory = "/cwd-valid";
    const result = handleSecondInstanceWorkspaceRequest(deps);
    assert.equal(result, true);
    assert.deepEqual(calls.openWorkspace, [tmp]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("integration: unhandled deep link is logged with safe URL rendering (no raw query)", async () => {
  const { handleSecondInstanceWorkspaceRequest } = secondInstance;
  const { deps, calls } = makeDeps({ deepLinkResult: false });
  deps.argv = ["/exe", "acode://oauth/callback?code=RAWSECRET&state=s"];
  deps.workingDirectory = "/cwd-safe";

  handleSecondInstanceWorkspaceRequest(deps);
  const warnText = calls.warn.map((a) => a.join(" ")).join("\n");
  assert.ok(warnText.includes("deep link 未处理"), "logs unhandled deep link");
  assert.ok(!warnText.includes("RAWSECRET"), "raw query must not reach logs");
});
