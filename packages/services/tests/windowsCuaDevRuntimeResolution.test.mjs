/**
 * Windows CUA 产品运行时解析边界的不变量测试（U14 阶段 0 · T1）。
 *
 * 被测对象：packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts
 * 支撑验收：docs/upgrades/product-and-support-2026-10.md §7.7 阶段 0 门槛的 C01/C02/C03/C04。
 *
 * 本文件锁定的四组不变量：
 * 1. 12 类 WindowsCuaDevRuntimeResolutionReason 全部可达（纯内存夹具，零真实磁盘、零 Windows 依赖），
 *    且「已观测 reason 集合」与硬编码的 12 个字面量严格相等（该联合类型未导出，故用集合相等代替类型穷尽）。
 * 2. invalid-package 是**汇聚码**：requireExpectedPackage 的 catch（:564-566）为空，
 *    文件缺失 / 是目录 / 是 symlink / realpath 逃逸 / 非文本 / 非对象 / name 不符 / version 未 trim /
 *    契约键不精确 / 路径非规范 / entry===addon 等 ≥11 类根因映射到同一 (reason, message, artifact)
 *    三元组，错误对象**无法**区分根因。故每个根因独立成一个 test case，绝不参数化后只断一次码。
 * 3. 同一逻辑错误在 dev / packaged 两链报**不同码**（C03 必须按模式分列期望码）：
 *    entry 含 ".." 在 dev 报 invalid-package（:553 前置校验），在 packaged 报 invalid-artifact-path
 *    （:372 推迟到 resolveManifestArtifact）；root 是 symlink 在 dev 报 development-root-not-found，
 *    在 packaged 报 invalid-runtime-manifest。
 * 4. C04 无回退：dev 链失败时零次访问 packaged 资源路径（:94-96 是无 try/catch 的裸 return）。
 *    断言写成「夹具记录的全部访问路径中不存在任何 packaged 前缀」，而非只看错误码——若不给
 *    resourcesPath，回退也会因 missing-resources-path 失败，掩盖真实行为。
 *
 * 夹具纪律（plan1 §1.1 陷阱 A/B，二者都会让夹具**静默**失效并折叠成看似合法的稳定错误码）：
 * - 陷阱 A：必须注入 lstat / realpath / readFile。fileSystem.stat 是接口里唯一必填成员（:23）
 *   但模块**从不调用**它（:457-466 只走 lstat/realpath，且对缺失字段 fallback 到真实 fs）。
 *   本夹具给 stat 一个 throw 占位，并在收尾断言它从未被调用（钉住这条死约束不被误当成活约束）。
 *   readFile 按 :26 双模式：传 "utf8" 返 string，不传返 Uint8Array（:494 读 artifact 字节时不传）。
 * - 陷阱 B：夹具路径键必须用与模块**相同**的 node:path API 计算（devRootKey 镜像 :105-116，
 *   artifactKey 镜像 :375-378，packaged root 镜像 :188/:190），绝不硬编码分隔符。
 *   写错的症状是全部 packaged 用例统一落到 invalid-runtime-manifest（含 happy path）。
 *
 * 隐私门槛：全部负样本统一断言错误文本不含 ENOENT/EACCES/EPERM、不含宿主绝对路径，
 * 并断言 err.artifact 携带稳定 artifact 标识。
 */
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath as fsRealpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep, win32 as windowsPath } from "node:path";
import { after, test } from "node:test";

const { resolveWindowsCuaRuntime } = await import(
  "../src/cua-permission-broker/windowsCuaDevRuntime.ts"
);

// ── 与源码同名的稳定字面量（源码 :8-12） ──────────────────────────────────
const DEV_ROOT_ENV = "ACODE_CUA_DEV_ROOT";
const EXPECTED_PACKAGE_NAME = "@acode/acode-cua";
const PACKAGE_JSON = "package.json";
const RUNTIME_MANIFEST = "runtime-manifest.json";
const PRODUCT_RUNTIME_SEGMENTS = ["tools", "cua-helper"];

// ── 夹具常量 ────────────────────────────────────────────────────────────────
const ENTRY_REL = "dist/windows-helper.js";
const ADDON_REL = "build/Release/ax_native.node";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const ARCH = "x64";
const ELECTRON_VERSION = "33.0.0";

/** 宿主绝对 dev root（跨平台：win32 → C:\acode-cua-dev，POSIX → /acode-cua-dev）。 */
const DEV_ROOT_RAW = resolve("/acode-cua-dev");
/** Windows 绝对但**非**宿主绝对的 dev root，用于覆盖 :116 的 windowsPath.normalize 分支。 */
const WIN_DEV_ROOT_RAW = "C:" + "\\" + "acode-cua-dev";
/** 宿主绝对 resourcesPath（packaged 链）。 */
const RESOURCES_RAW = resolve("/acode-res");

/**
 * C01 的穷尽性锚点：12 个字面量硬编码在测试内。
 * WindowsCuaDevRuntimeResolutionReason（:39-51）**未导出**，无法写类型层穷尽断言；
 * 也不为此改源码导出（本模块不在 cua-permission-broker/index.ts barrel 内，
 * 新增无消费者的导出会被 pnpm knip 判未使用，且属公开面改动需先改 spec）。
 */
const EXPECTED_REASONS = [
  "unsupported-platform",
  "development-root-not-absolute",
  "development-root-not-found",
  "invalid-package",
  "missing-helper-entry",
  "missing-native-addon",
  "missing-resources-path",
  "resources-path-not-absolute",
  "invalid-runtime-manifest",
  "incompatible-runtime-manifest",
  "invalid-artifact-path",
  "artifact-integrity-mismatch",
];

/** 已观测 reason 集合（由 expectFailure 收集，收尾做集合相等断言）。 */
const observedReasons = new Set();
/** 全局记录 fileSystem.stat 调用，用于钉住「stat 必填却从不被调用」这条死约束。 */
const statCalls = [];

// ── 路径键计算（陷阱 B：必须镜像源码的计算方式） ────────────────────────────

/** 镜像源码 :105-116：env 里的原始字符串 → 模块内部使用的 dev root 键。 */
function devRootKey(raw) {
  return isAbsolute(raw) ? resolve(raw) : windowsPath.normalize(raw);
}

/** 镜像源码 :375-378：artifact 相对路径 → 夹具绝对键。 */
function artifactKey(root, artifact) {
  return windowsPath.isAbsolute(root) && !isAbsolute(root)
    ? join(root, ...artifact.split("/"))
    : resolve(root, ...artifact.split("/"));
}

/** 镜像源码 :188：packaged runtime root。 */
function packagedRootKey(resourcesPath) {
  return resolve(resourcesPath, ...PRODUCT_RUNTIME_SEGMENTS);
}

// ── 正样本载荷（plan1 §4.2） ────────────────────────────────────────────────

function validDevPackage() {
  return {
    name: EXPECTED_PACKAGE_NAME,
    version: "1.0.0",
    type: "module",
    acodeCuaRuntime: {
      schema: 1,
      windows: { entry: ENTRY_REL, nativeAddon: ADDON_REL },
    },
  };
}

function validManifest() {
  return {
    schemaVersion: 1,
    packageName: EXPECTED_PACKAGE_NAME,
    packageVersion: "1.0.0",
    platform: "win32",
    arch: ARCH,
    electronVersion: ELECTRON_VERSION,
    entry: ENTRY_REL,
    addon: ADDON_REL,
    sha256: { entry: HASH_A, addon: HASH_A },
  };
}

/** 尽力从 package.json 文本里读出契约声明的 artifact 相对路径（读不出就用正样本默认值）。 */
function readDevArtifacts(text) {
  try {
    const windows = JSON.parse(text)?.acodeCuaRuntime?.windows;
    return {
      entry: typeof windows?.entry === "string" ? windows.entry : ENTRY_REL,
      addon: typeof windows?.nativeAddon === "string" ? windows.nativeAddon : ADDON_REL,
    };
  } catch {
    return { entry: ENTRY_REL, addon: ADDON_REL };
  }
}

/** 尽力从 runtime-manifest.json 文本里读出 entry/addon 相对路径。 */
function readPackagedArtifacts(text) {
  try {
    const manifest = JSON.parse(text);
    return {
      entry: typeof manifest?.entry === "string" ? manifest.entry : ENTRY_REL,
      addon: typeof manifest?.addon === "string" ? manifest.addon : ADDON_REL,
    };
  } catch {
    return { entry: ENTRY_REL, addon: ADDON_REL };
  }
}

// ── 内存 fileSystem 夹具（陷阱 A） ──────────────────────────────────────────

/**
 * 节点形状：{ kind: "dir"|"file"|"symlink", text?, realpath?, forceBytes? }
 * realpath 缺省等于节点自身的键（即「不逃逸」）；forceBytes 让 readFile 即使传 "utf8"
 * 也返回 Uint8Array，用于覆盖 :250/:541 的「非文本」根因。
 */
function makeMemoryFs(nodes) {
  const visited = [];
  const nodeOf = (path) => {
    const node = nodes.get(path);
    if (!node) {
      // 夹具未命中即等价于真实磁盘上的「不存在」。模块所有 catch 都会把它折叠成稳定诊断，
      // 因此这条文本永远不会出现在被测错误里（隐私断言会验证这一点）。
      throw Object.assign(new Error(`ENOENT fixture miss: ${path}`), { code: "ENOENT" });
    }
    return node;
  };
  const statsOf = (node) => ({
    isDirectory: () => node.kind === "dir",
    isFile: () => node.kind === "file",
    isSymbolicLink: () => node.kind === "symlink",
  });
  return {
    visited,
    fs: {
      // 接口要求 stat 必填（:23），但模块从不调用它（:457-466）；给 throw 占位以暴露未来回归。
      stat: async (path) => {
        visited.push(["stat", path]);
        statCalls.push(path);
        throw new Error(`fileSystem.stat must not be called by the module: ${path}`);
      },
      lstat: async (path) => {
        visited.push(["lstat", path]);
        return statsOf(nodeOf(path));
      },
      realpath: async (path) => {
        visited.push(["realpath", path]);
        const node = nodeOf(path);
        return node.realpath ?? path;
      },
      readFile: async (path, encoding) => {
        visited.push(["readFile", path, encoding ?? "bytes"]);
        const node = nodeOf(path);
        if (node.kind === "dir") {
          throw Object.assign(new Error(`EISDIR fixture: ${path}`), { code: "EISDIR" });
        }
        // unreadable：节点对 lstat 存在（是文件）但读取抛 IO 错，模拟 :493-502 注释描述的
        // 「stat 与 read 之间文件被替换/删除」竞态。
        if (node.unreadable) {
          throw Object.assign(new Error(`ENOENT race fixture: ${path}`), { code: "ENOENT" });
        }
        const text = node.text ?? "";
        if (node.forceBytes || encoding !== "utf8") return new TextEncoder().encode(text);
        return text;
      },
    },
  };
}

// ── 两套树构造器 ────────────────────────────────────────────────────────────

/**
 * dev 链夹具树：root(dir) + package.json + 契约声明的 entry/addon 文件。
 * @param rootRaw        env ACODE_CUA_DEV_ROOT 的原始值
 * @param pkgText        package.json 文本（缺省为正样本）
 * @param pkgNode        覆盖 package.json 节点形状（dir / symlink / realpath 逃逸 / forceBytes）；
 *                       传 null 表示**该节点不存在**（注意 `null ?? x` 会吞掉缺省值，故显式分支）
 * @param rootNode       覆盖 root 节点形状（symlink / realpath 逃逸）；传 null 表示 root 不存在
 * @param omitArtifacts  不建的 artifact 相对路径（覆盖 missing-* 根因）
 * @param artifactNodes  按相对路径覆盖 artifact 节点形状
 */
function devFixture({
  rootRaw = DEV_ROOT_RAW,
  pkgText,
  pkgNode,
  rootNode,
  omitArtifacts = [],
  artifactNodes = {},
} = {}) {
  const root = devRootKey(rootRaw);
  const pkgPath = join(root, PACKAGE_JSON);
  const text = pkgText ?? JSON.stringify(validDevPackage());
  const nodes = new Map();
  if (rootNode !== null) nodes.set(root, rootNode ?? { kind: "dir" });
  if (pkgNode !== null) nodes.set(pkgPath, pkgNode ?? { kind: "file", text });
  const declared = readDevArtifacts(text);
  const keys = {
    root,
    pkgPath,
    entry: artifactKey(root, declared.entry),
    addon: artifactKey(root, declared.addon),
  };
  for (const [rel, key] of [
    [declared.entry, keys.entry],
    [declared.addon, keys.addon],
  ]) {
    if (omitArtifacts.includes(rel) || nodes.has(key)) continue;
    nodes.set(key, artifactNodes[rel] ?? { kind: "file", text: `// ${rel}\n` });
  }
  return {
    nodes,
    keys,
    leakGuards: [root, rootRaw],
    options: {
      platform: "win32",
      env: { [DEV_ROOT_ENV]: rootRaw },
      arch: ARCH,
      electronVersion: ELECTRON_VERSION,
    },
  };
}

/**
 * packaged 链夹具树：resources/tools/cua-helper(dir) + runtime-manifest.json + entry/addon 文件。
 * hashBytes 是 happy path 的**必需**注入（plan1 §4.2）：默认 defaultHashBytes（:71-72）
 * 对夹具假字节算真 sha256，与 manifest 里的 a×64 不等 → 落 artifact-integrity-mismatch。
 */
function packagedFixture({
  resourcesPath = RESOURCES_RAW,
  manifest,
  manifestText,
  manifestNode,
  rootNode,
  omitArtifacts = [],
  artifactNodes = {},
  arch = ARCH,
  electronVersion = ELECTRON_VERSION,
  hash = HASH_A,
  injectHashBytes = true,
} = {}) {
  const root = packagedRootKey(resourcesPath);
  const manifestPath = join(root, RUNTIME_MANIFEST);
  const text = manifestText ?? JSON.stringify(manifest ?? validManifest());
  const nodes = new Map();
  if (rootNode !== null) nodes.set(root, rootNode ?? { kind: "dir" });
  if (manifestNode !== null) nodes.set(manifestPath, manifestNode ?? { kind: "file", text });
  const declared = readPackagedArtifacts(text);
  const keys = {
    root,
    manifestPath,
    entry: artifactKey(root, declared.entry),
    addon: artifactKey(root, declared.addon),
  };
  for (const [rel, key] of [
    [declared.entry, keys.entry],
    [declared.addon, keys.addon],
  ]) {
    if (omitArtifacts.includes(rel) || nodes.has(key)) continue;
    nodes.set(key, artifactNodes[rel] ?? { kind: "file", text: `// ${rel}\n` });
  }
  const options = {
    platform: "win32",
    env: {},
    resourcesPath,
    arch,
    electronVersion,
  };
  if (injectHashBytes) options.hashBytes = async () => hash;
  return { nodes, keys, leakGuards: [root, resourcesPath], options };
}

// ── 运行器 ──────────────────────────────────────────────────────────────────

function launch(fixture, extraNodes) {
  const nodes = extraNodes ? new Map([...extraNodes, ...fixture.nodes]) : fixture.nodes;
  const { fs, visited } = makeMemoryFs(nodes);
  const promise = resolveWindowsCuaRuntime({ ...fixture.options, fileSystem: fs });
  // 预先挂一个 no-op handler，避免断言前产生 unhandled rejection 噪声；
  // 真实结果仍由 expectFailure / expectResolved 从同一个 promise 读取。
  promise.catch(() => {});
  return {
    promise,
    visited,
    keys: fixture.keys,
    leakGuards: fixture.leakGuards,
    nodes,
  };
}

function runDev(config) {
  return launch(devFixture(config));
}

function runPackaged(config) {
  return launch(packagedFixture(config));
}

/** 断言解析失败：reason/artifact 精确匹配 + 隐私门槛，并登记已观测 reason。 */
async function expectFailure(run, { reason, artifact }) {
  const err = await run.promise.then(
    () => null,
    (error) => error,
  );
  assert.ok(err, `期望解析失败（${reason}），实际解析成功`);
  assert.equal(err.name, "WindowsCuaDevRuntimeResolutionError");
  assert.equal(err.reason, reason, `reason 不符（期望 ${reason}）`);
  assert.equal(err.artifact, artifact, `artifact 不符（期望 ${String(artifact)}）`);
  assert.ok(err.message.length > 0, "错误文本不应为空");
  // 隐私门槛：底层 IO 错误码与宿主绝对路径都不得进入诊断文本。
  assert.doesNotMatch(err.message, /ENOENT|EACCES|EPERM/u, `错误文本泄漏底层 IO 细节: ${err.message}`);
  for (const leak of run.leakGuards) {
    // 只对**绝对**路径做泄漏断言：相对路径（如 resourcesPath: "resources"）会与模块自己的
    // 稳定文案（"resourcesPath must be absolute"）产生子串巧合，属断言自身缺陷而非泄漏。
    if (!isAbsolute(leak) && !windowsPath.isAbsolute(leak)) continue;
    assert.ok(!err.message.includes(leak), `错误文本泄漏宿主绝对路径: ${leak}`);
  }
  observedReasons.add(err.reason);
  return err;
}

/** dev 链便捷断言：以给定 package.json 对象跑解析并断言 invalid-package（汇聚码）。 */
function expectInvalidPackage(pkgObject) {
  return expectFailure(runDev({ pkgText: JSON.stringify(pkgObject) }), {
    reason: "invalid-package",
    artifact: PACKAGE_JSON,
  });
}

/** 断言解析成功，并顺带钉住「stat 从不被调用」。 */
async function expectResolved(run, { root, entryPath, addonPath }) {
  const runtime = await run.promise;
  assert.equal(runtime.root, root);
  assert.equal(runtime.entryPath, entryPath);
  assert.equal(runtime.addonPath, addonPath);
  assert.equal(runtime.command, process.execPath);
  assert.deepEqual(runtime.commandEnv, { ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(
    run.visited.some(([op]) => op === "stat"),
    false,
    "模块不应调用 fileSystem.stat（:457-466 只用 lstat/realpath）",
  );
  return runtime;
}

// ════════════════════════════════════════════════════════════════════════════
// P 组：两条 happy path（plan1 步 1 阻塞步 2 —— 先跑通再铺负样本）
// ════════════════════════════════════════════════════════════════════════════

test("P1 dev happy path：注入内存夹具即可解析成功（零真实磁盘）", async () => {
  const run = runDev();
  await expectResolved(run, {
    root: run.keys.root,
    entryPath: run.keys.entry,
    addonPath: run.keys.addon,
  });
  // 夹具确实被消费（否则 happy path 可能是「打到真实磁盘」的假绿）。
  assert.ok(run.visited.some(([op, path]) => op === "readFile" && path === run.keys.pkgPath));
  // dev 链只 lstat artifact、从不读其字节（hash 链路只存在于 packaged 模式，见 D15）。
  assert.ok(run.visited.some(([op, path]) => op === "lstat" && path === run.keys.entry));
  assert.ok(run.visited.some(([op, path]) => op === "lstat" && path === run.keys.addon));
  assert.equal(
    run.visited.filter(([op, path]) => op === "readFile" && path !== run.keys.pkgPath).length,
    0,
    "dev 链不应读取 artifact 字节",
  );
});

test("P2 packaged happy path：注入 hashBytes 后解析成功（不注入会落 integrity-mismatch）", async () => {
  const run = runPackaged();
  await expectResolved(run, {
    root: run.keys.root,
    entryPath: run.keys.entry,
    addonPath: run.keys.addon,
  });
  assert.equal(run.keys.root, packagedRootKey(RESOURCES_RAW));
  // artifact 字节读取走 :494 的无 encoding 分支 → 夹具必须返回 Uint8Array。
  const bytesReads = run.visited.filter(([op, , enc]) => op === "readFile" && enc === "bytes");
  assert.equal(bytesReads.length, 2, "entry 与 addon 各应有一次无 encoding 的字节读取");
});

test("P3 dev happy path（Windows 绝对但非宿主绝对的 root）：POSIX 宿主上走 :116 normalize 与 :376 join 分支；win32 宿主上与 P1 等价", async () => {
  // 本用例的区分性只在 POSIX 宿主成立：那里 WIN_DEV_ROOT_RAW（C:\...）不是宿主绝对路径，
  // resolveWindowsCuaRuntime 会走 :116 的 windowsPath.normalize 分支与 :376 的 join(root, ...split("/"))
  // 分支，且 normalize 结果与原始串不同、断言非平凡。在 win32 宿主上该 root 本就是宿主绝对路径，
  // normalize 近似恒等，P3 退化为 P1 的字面重复、下方断言成为恒真式——这是已知且可接受的：
  // win32 侧的分支由 P1/真实 fixture 覆盖，POSIX 侧（ubuntu CI）才由 P3 覆盖。author 未在 POSIX 实跑，
  // 故此处只声明「POSIX 上覆盖该分支」，不声明「本宿主已覆盖」。
  const run = runDev({ rootRaw: WIN_DEV_ROOT_RAW });
  await expectResolved(run, {
    root: run.keys.root,
    entryPath: run.keys.entry,
    addonPath: run.keys.addon,
  });
  assert.equal(run.keys.root, windowsPath.normalize(WIN_DEV_ROOT_RAW));
});

// ════════════════════════════════════════════════════════════════════════════
// A 组：平台与 env 门控（reason 1/2/7）
// ════════════════════════════════════════════════════════════════════════════

test("A1 非 win32 平台 → unsupported-platform（linux 与 darwin 各自拒绝）", async () => {
  for (const platform of ["linux", "darwin"]) {
    const promise = resolveWindowsCuaRuntime({
      platform,
      env: { [DEV_ROOT_ENV]: DEV_ROOT_RAW },
      resourcesPath: RESOURCES_RAW,
    });
    promise.catch(() => {});
    await expectFailure({ promise, leakGuards: [DEV_ROOT_RAW, RESOURCES_RAW] }, {
      reason: "unsupported-platform",
      artifact: undefined,
    });
  }
});

test("A2 dev root 是相对路径 → development-root-not-absolute", async () => {
  await expectFailure(runDev({ rootRaw: "acode-cua-dev" }), {
    reason: "development-root-not-absolute",
    artifact: undefined,
  });
});

test("A2b dev root 是 ./ 形式相对路径 → development-root-not-absolute", async () => {
  await expectFailure(runDev({ rootRaw: "./acode-cua-dev" }), {
    reason: "development-root-not-absolute",
    artifact: undefined,
  });
});

test("A3 dev-root env 为纯空白 → trim 后为空 → 走 packaged 链（missing-resources-path）", async () => {
  const fixture = packagedFixture({ resourcesPath: "" });
  fixture.options.env = { [DEV_ROOT_ENV]: "   " };
  delete fixture.options.resourcesPath;
  await expectFailure(launch(fixture), {
    reason: "missing-resources-path",
    artifact: undefined,
  });
});

test("A4 打包态标记下 dev-root 被忽略 → packaged 链（R4 门禁，密封夹具版）", async () => {
  const fixture = devFixture();
  fixture.options.env = { ACODE_APP_IS_PACKAGED: "1", [DEV_ROOT_ENV]: DEV_ROOT_RAW };
  delete fixture.options.resourcesPath;
  // 门禁生效的证据：错误来自 packaged 链（无 resourcesPath），而非任何 development-* 分支。
  await expectFailure(launch(fixture), {
    reason: "missing-resources-path",
    artifact: undefined,
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C04 组：symlink/junction 拒绝且**不回退**安装包资源
// ════════════════════════════════════════════════════════════════════════════

test("C04a dev root 是 symlink（夹具层）→ development-root-not-found", async () => {
  const root = devRootKey(DEV_ROOT_RAW);
  await expectFailure(runDev({ rootNode: { kind: "symlink", realpath: root } }), {
    reason: "development-root-not-found",
    artifact: undefined,
  });
});

test("C04b dev root realpath 逃逸配置路径（夹具层）→ development-root-not-found", async () => {
  // :344 samePhysicalPath 要求严格相等，故 realpath 指向别处即拒绝。
  await expectFailure(
    runDev({ rootNode: { kind: "dir", realpath: resolve("/somewhere-else") } }),
    { reason: "development-root-not-found", artifact: undefined },
  );
});

test("C04b2 dev root 不存在（夹具层）→ development-root-not-found", async () => {
  await expectFailure(runDev({ rootNode: null }), {
    reason: "development-root-not-found",
    artifact: undefined,
  });
});

test("C04c dev 链失败时**不回退**安装包资源：visited 中零个 packaged 前缀路径", async () => {
  // 同时注入**合法**的 resourcesPath 与一棵完整可用的 packaged 树，再让 dev root 是 symlink。
  // 若存在回退，夹具会记录到 tools/cua-helper 下的访问；断言必须写成「记录数组中不存在任何
  // packaged 前缀路径」，而非只看错误码。
  const packaged = packagedFixture();
  const dev = devFixture({ rootNode: { kind: "symlink" } });
  const run = launch(dev, packaged.nodes);
  await expectFailure(run, {
    reason: "development-root-not-found",
    artifact: undefined,
  });

  const packagedRoot = packaged.keys.root;
  const prefixes = [packagedRoot, packagedRoot + sep, RESOURCES_RAW, RESOURCES_RAW + sep];
  const touchedPackaged = run.visited.filter(([, path]) =>
    prefixes.some((prefix) => path === prefix || path.startsWith(prefix)),
  );
  assert.deepEqual(
    touchedPackaged.map((entry) => entry.join(":")),
    [],
    "dev 链失败后回退到了安装包资源（:94-96 的裸 return 被破坏）",
  );
  // 反向守卫：夹具确实被调用过，否则上面的「零访问」是空洞断言。
  assert.ok(
    run.visited.some(([op, path]) => op === "lstat" && path === dev.keys.root),
    "夹具未被消费：无回退断言会变成空洞断言",
  );
  assert.ok(run.visited.length >= 1, "夹具应至少记录一次访问");
  assert.equal(
    run.visited.filter(([, path]) => path.includes(join("tools", "cua-helper"))).length,
    0,
    "visited 中出现了 tools/cua-helper 段",
  );
});

test("C04d 同形 symlink 的码不对称：dev → development-root-not-found，packaged → invalid-runtime-manifest", async () => {
  await expectFailure(runDev({ rootNode: { kind: "symlink" } }), {
    reason: "development-root-not-found",
    artifact: undefined,
  });
  await expectFailure(runPackaged({ rootNode: { kind: "symlink" } }), {
    reason: "invalid-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  });
});

test("C04e 真实链接层：宿主上真 symlink/junction 的 dev root 被拒（无特权时 skip）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acode-cua-t1-reallink-"));
  try {
    const target = join(dir, "real-dev-root");
    await mkdir(target);
    const linkPath = join(dir, "linked-dev-root");
    let linkKind = "symlink";
    try {
      await symlink(target, linkPath, "dir");
    } catch (err) {
      // Windows 无 SeCreateSymbolicLinkPrivilege 时 symlink() 报 EPERM；junction 不需要特权，
      // 且 libuv 把 IO_REPARSE_TAG_MOUNT_POINT 归入 symlink 语义（本机实测 isSymbolicLink()===true）。
      if (process.platform !== "win32" || !["EPERM", "ENOTSUP", "EACCES"].includes(err.code)) {
        throw err;
      }
      try {
        await symlink(target, linkPath, "junction");
        linkKind = "junction";
      } catch (junctionErr) {
        t.skip(
          `real-symlink unavailable on this host (symlink ${err.code} / junction ${junctionErr.code}); ` +
            "夹具层（C04a/C04b）已覆盖 isSymbolicLink 与 realpath 两个判定谓词",
        );
        return;
      }
    }
    if (typeof t.diagnostic === "function") {
      t.diagnostic(`real ${linkKind} created at ${linkPath} → ${target}`);
    }

    // 真机事实核验：libuv 对该链接报 isSymbolicLink()===true，且 realpath 指向 target 而非链接自身。
    const realStats = await lstat(linkPath);
    assert.equal(realStats.isSymbolicLink(), true, `${linkKind} 未被识别为符号链接`);
    assert.equal(await fsRealpath(linkPath), target);

    // 不注入 fileSystem → 模块走真实 fs（defaultFileSystem），这是本用例的全部意义。
    // 同时注入**不存在**的 resourcesPath：若存在回退，reason 会变成 invalid-runtime-manifest。
    const promise = resolveWindowsCuaRuntime({
      platform: "win32",
      env: { [DEV_ROOT_ENV]: linkPath },
      resourcesPath: RESOURCES_RAW,
      arch: ARCH,
      electronVersion: ELECTRON_VERSION,
    });
    promise.catch(() => {});
    await expectFailure(
      { promise, leakGuards: [linkPath, dir, RESOURCES_RAW] },
      { reason: "development-root-not-found", artifact: undefined },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// B / C02 组：missing-helper-entry 与 missing-native-addon（reason 5/6）
// ════════════════════════════════════════════════════════════════════════════

test("B1 dev：entry 文件缺失 → missing-helper-entry（artifact 为契约声明的相对路径）", async () => {
  await expectFailure(runDev({ omitArtifacts: [ENTRY_REL] }), {
    reason: "missing-helper-entry",
    artifact: ENTRY_REL,
  });
});

test("B1b dev：entry 是目录而非文件 → missing-helper-entry", async () => {
  await expectFailure(runDev({ artifactNodes: { [ENTRY_REL]: { kind: "dir" } } }), {
    reason: "missing-helper-entry",
    artifact: ENTRY_REL,
  });
});

test("C02 dev：nativeAddon 文件缺失 → missing-native-addon", async () => {
  await expectFailure(runDev({ omitArtifacts: [ADDON_REL] }), {
    reason: "missing-native-addon",
    artifact: ADDON_REL,
  });
});

test("C02b dev：nativeAddon 是目录而非文件 → missing-native-addon", async () => {
  await expectFailure(runDev({ artifactNodes: { [ADDON_REL]: { kind: "dir" } } }), {
    reason: "missing-native-addon",
    artifact: ADDON_REL,
  });
});

test("C02c dev：entry 是 symlink → invalid-artifact-path（dev 链也能产出该码，:429）", async () => {
  await expectFailure(runDev({ artifactNodes: { [ENTRY_REL]: { kind: "symlink" } } }), {
    reason: "invalid-artifact-path",
    artifact: "entry",
  });
});

test("C02d dev：entry realpath 逃逸 root → invalid-artifact-path（:436-437）", async () => {
  await expectFailure(
    runDev({
      artifactNodes: { [ENTRY_REL]: { kind: "file", text: "x", realpath: resolve("/outside/x.js") } },
    }),
    { reason: "invalid-artifact-path", artifact: "entry" },
  );
});

test("C02e dev：nativeAddon realpath 逃逸 root → invalid-artifact-path", async () => {
  await expectFailure(
    runDev({
      artifactNodes: {
        [ADDON_REL]: { kind: "file", text: "x", realpath: resolve("/outside/ax.node") },
      },
    }),
    { reason: "invalid-artifact-path", artifact: "addon" },
  );
});

test("B1p packaged：entry 文件缺失 → missing-helper-entry", async () => {
  await expectFailure(runPackaged({ omitArtifacts: [ENTRY_REL] }), {
    reason: "missing-helper-entry",
    artifact: ENTRY_REL,
  });
});

test("B2p packaged：addon 文件缺失 → missing-native-addon", async () => {
  await expectFailure(runPackaged({ omitArtifacts: [ADDON_REL] }), {
    reason: "missing-native-addon",
    artifact: ADDON_REL,
  });
});

test("B3p packaged：stat 与 read 之间文件被删除（readFile 抛 IO 错）→ missing-helper-entry（:493-502）", async () => {
  // entry 节点对 lstat 仍是合法文件（通过 :199-216 的包含性校验），但字节读取抛 ENOENT，
  // 覆盖 readRequiredArtifact 的 catch —— 它把竞态 IO 失败折叠成与「文件缺失」相同的稳定诊断。
  await expectFailure(
    runPackaged({ artifactNodes: { [ENTRY_REL]: { kind: "file", text: "x", unreadable: true } } }),
    { reason: "missing-helper-entry", artifact: ENTRY_REL },
  );
});

test("B4p packaged：addon 字节读取抛 IO 错 → missing-native-addon", async () => {
  await expectFailure(
    runPackaged({ artifactNodes: { [ADDON_REL]: { kind: "file", text: "y", unreadable: true } } }),
    { reason: "missing-native-addon", artifact: ADDON_REL },
  );
});

// ════════════════════════════════════════════════════════════════════════════
// C03a 组：dev 链 invalid-package 的根因变体（汇聚码，每个根因独立成 case）
// plan1 §3.3 表逐行落地 + ADDENDUM 裁决 2 第 20 条列举的 ≥11 类根因
// ════════════════════════════════════════════════════════════════════════════

test("C03a-0 dev 根因①：package.json 文件缺失 → invalid-package", async () => {
  await expectFailure(runDev({ pkgNode: null }), {
    reason: "invalid-package",
    artifact: PACKAGE_JSON,
  });
});

test("C03a-0b dev 根因②：package.json 是目录 → invalid-package", () =>
  expectFailure(runDev({ pkgNode: { kind: "dir" } }), {
    reason: "invalid-package",
    artifact: PACKAGE_JSON,
  }));

test("C03a-0c dev 根因③：package.json 是 symlink → invalid-package", () =>
  expectFailure(runDev({ pkgNode: { kind: "symlink" } }), {
    reason: "invalid-package",
    artifact: PACKAGE_JSON,
  }));

test("C03a-0d dev 根因④：package.json realpath 逃逸 dev root → invalid-package", () =>
  expectFailure(
    runDev({
      pkgNode: { kind: "file", text: JSON.stringify(validDevPackage()), realpath: resolve("/etc/package.json") },
    }),
    { reason: "invalid-package", artifact: PACKAGE_JSON },
  ));

test("C03a-0e dev 根因⑤：package.json 非文本（readFile 返 Uint8Array）→ invalid-package", () =>
  expectFailure(runDev({ pkgNode: { kind: "file", text: "{}", forceBytes: true } }), {
    reason: "invalid-package",
    artifact: PACKAGE_JSON,
  }));

test("C03a-0f dev 根因⑥：package.json 不是对象（JSON 数组）→ invalid-package", () =>
  expectFailure(runDev({ pkgText: JSON.stringify([{ name: EXPECTED_PACKAGE_NAME }]) }), {
    reason: "invalid-package",
    artifact: PACKAGE_JSON,
  }));

test("C03a-0g dev 根因⑥b：package.json 非法 JSON → invalid-package", () =>
  expectFailure(runDev({ pkgText: "{ not json" }), {
    reason: "invalid-package",
    artifact: PACKAGE_JSON,
  }));

test("C03a-12 dev 根因⑦：name 不符（:546 运行时校验之一）→ invalid-package", () =>
  expectInvalidPackage({ ...validDevPackage(), name: "@acode/something-else" }));

test("C03a-12b dev 根因⑦b：name 缺失 → invalid-package", () => {
  const pkg = validDevPackage();
  delete pkg.name;
  return expectInvalidPackage(pkg);
});

test("C03a-11 dev 根因⑧：version 未 trim（\" 1.0.0 \"）→ invalid-package（plan1 §3.1 补充边界）", () =>
  expectInvalidPackage({ ...validDevPackage(), version: " 1.0.0 " }));

test("C03a-11b dev 根因⑧b：version 为空串 → invalid-package", () =>
  expectInvalidPackage({ ...validDevPackage(), version: "" }));

test("C03a-11c dev 根因⑧c：version 非字符串 → invalid-package", () =>
  expectInvalidPackage({ ...validDevPackage(), version: 1 }));

test("C03a-13 dev 根因⑨：acodeCuaRuntime 缺失 → invalid-package", () => {
  const pkg = validDevPackage();
  delete pkg.acodeCuaRuntime;
  return expectInvalidPackage(pkg);
});

test("C03a-13b dev 根因⑨b：acodeCuaRuntime 非对象（字符串）→ invalid-package", () =>
  expectInvalidPackage({ ...validDevPackage(), acodeCuaRuntime: "1" }));

test("C03a-2 dev 根因⑩：contract 顶层多一个键（键精确匹配）→ invalid-package", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: {
      schema: 1,
      windows: { entry: ENTRY_REL, nativeAddon: ADDON_REL },
      linux: { entry: "dist/linux-helper.js" },
    },
  }));

test("C03a-2b dev 根因⑩b：contract 顶层少一个键（缺 windows）→ invalid-package", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: { schema: 1 },
  }));

test("C03a-3 dev 根因⑪：contract.schema === 2 → invalid-package", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: { schema: 2, windows: { entry: ENTRY_REL, nativeAddon: ADDON_REL } },
  }));

test("C03a-3b dev 根因⑪b：contract.schema 是字符串 \"1\" → invalid-package", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: { schema: "1", windows: { entry: ENTRY_REL, nativeAddon: ADDON_REL } },
  }));

test("C03a-1 dev 根因⑫：windows 多一个键 → invalid-package", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: {
      schema: 1,
      windows: { entry: ENTRY_REL, nativeAddon: ADDON_REL, extra: "nope" },
    },
  }));

test("C03a-1b dev 根因⑫b：windows 少一个键（缺 nativeAddon）→ invalid-package", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: { schema: 1, windows: { entry: ENTRY_REL } },
  }));

test("C03a-1c dev 根因⑫c：windows 非对象 → invalid-package", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: { schema: 1, windows: ENTRY_REL },
  }));

test("C03a-4 dev 根因⑬：entry === nativeAddon → invalid-package（:555）", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: { schema: 1, windows: { entry: ENTRY_REL, nativeAddon: ENTRY_REL } },
  }));

test("C03a-5 dev 根因⑭：entry 含 .. → invalid-package（:553 前置校验）", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: { schema: 1, windows: { entry: "../evil.js", nativeAddon: ADDON_REL } },
  }));

test("C03a-5n dev 根因⑭b：nativeAddon 含 .. → invalid-package（:554 同样前置校验）", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: { schema: 1, windows: { entry: ENTRY_REL, nativeAddon: "../../evil.node" } },
  }));

test("C03a-6 dev 根因⑮：entry 含反斜杠 → invalid-package（:395）", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: {
      schema: 1,
      windows: { entry: "dist" + "\\" + "windows-helper.js", nativeAddon: ADDON_REL },
    },
  }));

test("C03a-7 dev 根因⑯：entry 是宿主绝对路径 → invalid-package（:396）", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: { schema: 1, windows: { entry: "/etc/passwd", nativeAddon: ADDON_REL } },
  }));

test("C03a-7b dev 根因⑯b：entry 是 Windows 绝对路径 → invalid-package（:397 windowsPath.isAbsolute）", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: {
      schema: 1,
      windows: { entry: "C:/Windows/System32/evil.js", nativeAddon: ADDON_REL },
    },
  }));

test("C03a-8 dev 根因⑰：entry 含 ADS 冒号 → invalid-package（:409）", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: {
      schema: 1,
      windows: { entry: "dist/windows-helper.js:evil", nativeAddon: ADDON_REL },
    },
  }));

test("C03a-9 dev 根因⑱：entry 含 NUL → invalid-package（:410）", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: {
      schema: 1,
      windows: { entry: "dist/win\0dows-helper.js", nativeAddon: ADDON_REL },
    },
  }));

test("C03a-10 dev 根因⑲：entry 含空段（双斜杠）→ invalid-package（:406）", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: {
      schema: 1,
      windows: { entry: "dist//windows-helper.js", nativeAddon: ADDON_REL },
    },
  }));

test("C03a-10b dev 根因⑳：entry 含 . 段 → invalid-package（:407）", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: {
      schema: 1,
      windows: { entry: "./dist/windows-helper.js", nativeAddon: ADDON_REL },
    },
  }));

test("C03a-10c dev 根因㉑：entry 是空串 → invalid-package（:394）", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: { schema: 1, windows: { entry: "", nativeAddon: ADDON_REL } },
  }));

test("C03a-10d dev 根因㉒：entry 非字符串 → invalid-package（:393）", () =>
  expectInvalidPackage({
    ...validDevPackage(),
    acodeCuaRuntime: { schema: 1, windows: { entry: 1, nativeAddon: ADDON_REL } },
  }));

// ════════════════════════════════════════════════════════════════════════════
// C03b 组：packaged 链的路径变体（同一逻辑错误 → invalid-artifact-path）
// ════════════════════════════════════════════════════════════════════════════

test("C03b-1 packaged：manifest.entry 含 .. → invalid-artifact-path[entry]（:372 推迟校验）", () =>
  expectFailure(runPackaged({ manifest: validManifestWith({ entry: "../evil.js" }) }), {
    reason: "invalid-artifact-path",
    artifact: "entry",
  }));

test("C03b-2 packaged：manifest.entry 含反斜杠 → invalid-artifact-path[entry]", () =>
  expectFailure(
    runPackaged({ manifest: validManifestWith({ entry: "dist" + "\\" + "windows-helper.js" }) }),
    { reason: "invalid-artifact-path", artifact: "entry" },
  ));

test("C03b-3 packaged：manifest.entry 是绝对路径 → invalid-artifact-path[entry]", () =>
  expectFailure(runPackaged({ manifest: validManifestWith({ entry: "C:/Windows/evil.js" }) }), {
    reason: "invalid-artifact-path",
    artifact: "entry",
  }));

test("C03b-4 packaged：manifest.entry 含 ADS 冒号 → invalid-artifact-path[entry]", () =>
  expectFailure(
    runPackaged({ manifest: validManifestWith({ entry: "dist/windows-helper.js:evil" }) }),
    { reason: "invalid-artifact-path", artifact: "entry" },
  ));

test("C03b-5 packaged：manifest.entry 含 NUL → invalid-artifact-path[entry]", () =>
  expectFailure(runPackaged({ manifest: validManifestWith({ entry: "dist/win\0dows.js" }) }), {
    reason: "invalid-artifact-path",
    artifact: "entry",
  }));

test("C03b-6 packaged：manifest.entry 含空段与 . 段 → invalid-artifact-path[entry]", () =>
  expectFailure(runPackaged({ manifest: validManifestWith({ entry: "./dist//helper.js" }) }), {
    reason: "invalid-artifact-path",
    artifact: "entry",
  }));

test("C03b-7 packaged：manifest.addon 含 .. → invalid-artifact-path[addon]", () =>
  expectFailure(runPackaged({ manifest: validManifestWith({ addon: "../../evil.node" }) }), {
    reason: "invalid-artifact-path",
    artifact: "addon",
  }));

test("C03-asym 同一 entry 含 ..：dev 报 invalid-package，packaged 报 invalid-artifact-path（ADDENDUM 裁决 2 第 6 条）", async () => {
  const devPkg = {
    ...validDevPackage(),
    acodeCuaRuntime: { schema: 1, windows: { entry: "../evil.js", nativeAddon: ADDON_REL } },
  };
  await expectFailure(runDev({ pkgText: JSON.stringify(devPkg) }), {
    reason: "invalid-package",
    artifact: PACKAGE_JSON,
  });
  await expectFailure(runPackaged({ manifest: validManifestWith({ entry: "../evil.js" }) }), {
    reason: "invalid-artifact-path",
    artifact: "entry",
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D 组：packaged 链（reason 7/8/9/10/11/12）
// ════════════════════════════════════════════════════════════════════════════

test("D0 packaged：未提供 resourcesPath → missing-resources-path", async () => {
  const fixture = packagedFixture();
  delete fixture.options.resourcesPath;
  await expectFailure(launch(fixture), {
    reason: "missing-resources-path",
    artifact: undefined,
  });
});

test("D1 packaged：resourcesPath 是相对路径 → resources-path-not-absolute", async () => {
  await expectFailure(runPackaged({ resourcesPath: "resources" }), {
    reason: "resources-path-not-absolute",
    artifact: undefined,
  });
});

test("D2 packaged：manifest 非法 JSON → invalid-runtime-manifest", () =>
  expectFailure(runPackaged({ manifestText: "{ not json" }), {
    reason: "invalid-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D2b packaged：manifest 节点缺失 → invalid-runtime-manifest", () =>
  expectFailure(runPackaged({ manifestNode: null }), {
    reason: "invalid-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D2c packaged：manifest 是 symlink → invalid-runtime-manifest（:242）", () =>
  expectFailure(runPackaged({ manifestNode: { kind: "symlink" } }), {
    reason: "invalid-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D2d packaged：manifest 是 JSON 数组（非对象）→ invalid-runtime-manifest（:252）", () =>
  expectFailure(runPackaged({ manifestText: JSON.stringify([validManifest()]) }), {
    reason: "invalid-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D2e packaged：manifest 非文本（readFile 返 Uint8Array）→ invalid-runtime-manifest（:250）", () =>
  expectFailure(runPackaged({ manifestNode: { kind: "file", text: "{}", forceBytes: true } }), {
    reason: "invalid-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D2f packaged：manifest realpath 逃逸 root → invalid-runtime-manifest（:246）", () =>
  expectFailure(
    runPackaged({
      manifestNode: {
        kind: "file",
        text: JSON.stringify(validManifest()),
        realpath: resolve("/elsewhere/runtime-manifest.json"),
      },
    }),
    { reason: "invalid-runtime-manifest", artifact: RUNTIME_MANIFEST },
  ));

test("D3 packaged：root 是 symlink → invalid-runtime-manifest（跨语义复用，:280-285）", () =>
  expectFailure(runPackaged({ rootNode: { kind: "symlink" } }), {
    reason: "invalid-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D4 packaged：root realpath 逃逸安装位置 → invalid-runtime-manifest（:275-277）", () =>
  expectFailure(runPackaged({ rootNode: { kind: "dir", realpath: resolve("/tmp/evil-helper") } }), {
    reason: "invalid-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D4b packaged：root 目录缺失 → invalid-runtime-manifest", () =>
  expectFailure(runPackaged({ rootNode: null }), {
    reason: "invalid-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D5 packaged：manifest.arch 与宿主 arch 不符 → incompatible-runtime-manifest（:315）", () =>
  expectFailure(runPackaged({ arch: "arm64" }), {
    reason: "incompatible-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D5b packaged：manifest.arch 是非法取值（ia32）→ incompatible-runtime-manifest（:314）", () =>
  expectFailure(runPackaged({ manifest: validManifestWith({ arch: "ia32" }) }), {
    reason: "incompatible-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D6 packaged：sha256 大写摘要 → incompatible-runtime-manifest（:292 只接受小写，**不是** integrity-mismatch）", () =>
  expectFailure(runPackaged({ manifest: validManifestWith({ sha256: { entry: "A".repeat(64), addon: HASH_A } }) }), {
    reason: "incompatible-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D6b packaged：sha256 长度不足 64 → incompatible-runtime-manifest", () =>
  expectFailure(runPackaged({ manifest: validManifestWith({ sha256: { entry: "abc", addon: HASH_A } }) }), {
    reason: "incompatible-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D7 packaged：manifest 多一个键 → incompatible-runtime-manifest（:293-303 键精确匹配）", () =>
  expectFailure(runPackaged({ manifest: { ...validManifest(), extra: "x" } }), {
    reason: "incompatible-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D7b packaged：sha256 子对象多一个键 → incompatible-runtime-manifest（:304-307）", () =>
  expectFailure(
    runPackaged({ manifest: validManifestWith({ sha256: { entry: HASH_A, addon: HASH_A, extra: HASH_A } }) }),
    { reason: "incompatible-runtime-manifest", artifact: RUNTIME_MANIFEST },
  ));

test("D8 packaged：entry === addon → incompatible-runtime-manifest（:321，dev 侧同情形报 invalid-package）", () =>
  expectFailure(runPackaged({ manifest: validManifestWith({ addon: ENTRY_REL }) }), {
    reason: "incompatible-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D9 packaged：electronVersion 不符 → incompatible-runtime-manifest（:318）", () =>
  expectFailure(runPackaged({ electronVersion: "34.0.0" }), {
    reason: "incompatible-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D9b packaged：未注入 electronVersion（宿主非 Electron，process.versions.electron 为空）→ incompatible-runtime-manifest（:316-317）", async () => {
  const fixture = packagedFixture();
  delete fixture.options.electronVersion;
  await expectFailure(launch(fixture), {
    reason: "incompatible-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  });
});

test("D10 packaged：schemaVersion === 2 → incompatible-runtime-manifest（:310）", () =>
  expectFailure(runPackaged({ manifest: validManifestWith({ schemaVersion: 2 }) }), {
    reason: "incompatible-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D11 packaged：packageName 不符 → incompatible-runtime-manifest（:311 运行时校验之二）", () =>
  expectFailure(runPackaged({ manifest: validManifestWith({ packageName: "@acode/other" }) }), {
    reason: "incompatible-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D11b packaged：packageVersion 未 trim → incompatible-runtime-manifest（:312）", () =>
  expectFailure(runPackaged({ manifest: validManifestWith({ packageVersion: " 1.0.0 " }) }), {
    reason: "incompatible-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D11c packaged：platform 非 win32 → incompatible-runtime-manifest（:313）", () =>
  expectFailure(runPackaged({ manifest: validManifestWith({ platform: "darwin" }) }), {
    reason: "incompatible-runtime-manifest",
    artifact: RUNTIME_MANIFEST,
  }));

test("D12 packaged：entry 是 symlink → invalid-artifact-path[entry]（:428-429）", () =>
  expectFailure(runPackaged({ artifactNodes: { [ENTRY_REL]: { kind: "symlink" } } }), {
    reason: "invalid-artifact-path",
    artifact: "entry",
  }));

test("D13 packaged：entry realpath 逃逸 root → invalid-artifact-path[entry]（:436-437）", () =>
  expectFailure(
    runPackaged({
      artifactNodes: {
        [ENTRY_REL]: { kind: "file", text: "x", realpath: resolve("/outside/helper.js") },
      },
    }),
    { reason: "invalid-artifact-path", artifact: "entry" },
  ));

test("D13b packaged：addon realpath 逃逸 root → invalid-artifact-path[addon]", () =>
  expectFailure(
    runPackaged({
      artifactNodes: {
        [ADDON_REL]: { kind: "file", text: "x", realpath: resolve("/outside/ax.node") },
      },
    }),
    { reason: "invalid-artifact-path", artifact: "addon" },
  ));

test("D14 packaged：entry 摘要不匹配 → artifact-integrity-mismatch[entry]（:519-523）", () =>
  expectFailure(runPackaged({ hash: HASH_B }), {
    reason: "artifact-integrity-mismatch",
    artifact: "entry",
  }));

test("D14b packaged：addon 摘要不匹配 → artifact-integrity-mismatch[addon]", () =>
  expectFailure(
    runPackaged({ manifest: validManifestWith({ sha256: { entry: HASH_A, addon: HASH_B } }) }),
    { reason: "artifact-integrity-mismatch", artifact: "addon" },
  ));

test("D14c packaged：不注入 hashBytes 时默认真 sha256 对夹具字节必然不匹配 → artifact-integrity-mismatch（证实 plan1 §4.2 的「hashBytes 是必需注入」）", async () => {
  await expectFailure(runPackaged({ injectHashBytes: false }), {
    reason: "artifact-integrity-mismatch",
    artifact: "entry",
  });
});

test("D15 dev 链不可达 artifact-integrity-mismatch：resolveDevelopmentRuntime 全程无 readRequiredArtifact/hashBytes 调用", async () => {
  // ADDENDUM 裁决 2 第 19 条：hash 链路只存在于 packaged 模式（:217-224）。
  // 用一棵「entry 内容与摘要声明不符」的 dev 树证明：dev 链根本不校验内容，仍解析成功。
  const run = runDev({
    artifactNodes: {
      [ENTRY_REL]: { kind: "file", text: "completely different bytes" },
      [ADDON_REL]: { kind: "file", text: "also different" },
    },
  });
  await expectResolved(run, {
    root: run.keys.root,
    entryPath: run.keys.entry,
    addonPath: run.keys.addon,
  });
  assert.equal(
    run.visited.filter(([op]) => op === "readFile").length,
    1,
    "dev 链只应读 package.json 一次，不应读取 artifact 字节",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// E 组：汇聚码语义与 12 码穷尽性
// ════════════════════════════════════════════════════════════════════════════

test("E1 invalid-package 是汇聚码：三个完全不同的根因产出**完全相同**的 (name, message, artifact)", async () => {
  const roots = [
    runDev({ omitArtifacts: [], pkgNode: null, pkgText: JSON.stringify(validDevPackage()) }), // 文件缺失
    runDev({ pkgText: JSON.stringify({ ...validDevPackage(), name: "@acode/wrong" }) }), // name 不符
    runDev({ pkgText: JSON.stringify({ ...validDevPackage(), version: " 1.0.0 " }) }), // version 未 trim
  ];
  const errors = [];
  for (const run of roots) {
    errors.push(
      await expectFailure(run, { reason: "invalid-package", artifact: PACKAGE_JSON }),
    );
  }
  const [first, ...rest] = errors;
  for (const other of rest) {
    assert.equal(other.message, first.message, "汇聚码的错误文本必须与根因无关");
    assert.equal(other.artifact, first.artifact);
    assert.equal(other.reason, first.reason);
  }
  // 错误文本刻意不含任何根因提示（:564-566 的空 catch），故消费侧无法据此分流。
  assert.doesNotMatch(first.message, /version|schema|symlink|ENOTDIR|EISDIR/iu, first.message);
});

test("E2 12 码穷尽性：已观测 reason 集合与硬编码的 12 个字面量集合严格相等", () => {
  assert.equal(EXPECTED_REASONS.length, 12, "锚点数组本身必须是 12 项");
  assert.equal(new Set(EXPECTED_REASONS).size, 12, "锚点数组不得有重复");
  const observed = [...observedReasons].sort();
  assert.deepEqual(observed, [...EXPECTED_REASONS].sort());
  const missing = EXPECTED_REASONS.filter((reason) => !observedReasons.has(reason));
  const unexpected = observed.filter((reason) => !EXPECTED_REASONS.includes(reason));
  assert.deepEqual(missing, [], "存在未被任何用例覆盖的 reason");
  assert.deepEqual(unexpected, [], "观测到锚点数组之外的 reason（源码可能新增了失败码）");
});

after(() => {
  // 收尾不变量①：12 码全部被观测到（与 E2 互为冗余，保证即使 E2 被删也有兜底）。
  assert.deepEqual([...observedReasons].sort(), [...EXPECTED_REASONS].sort());
  // 收尾不变量②：模块从未调用 fileSystem.stat（:23 必填却 :457-466 从不使用）。
  assert.deepEqual(statCalls, [], "模块调用了 fileSystem.stat，死约束已变成活约束，需同步更新 spec");
});

// ── 末位辅助（放在文件尾以保持用例区可读；被 C03b/D 组使用） ────────────────

/** 以正样本 manifest 为基线覆盖若干字段（sha256 需整体传入）。 */
function validManifestWith(patch) {
  return { ...validManifest(), ...patch };
}
