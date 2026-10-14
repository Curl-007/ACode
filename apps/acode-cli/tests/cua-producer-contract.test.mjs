/**
 * cua-producer 契约防漂移测试（specs/windows-helper-producer.md §6.1 第 1 条）——CI 常驻、
 * 平台无关：只读仓内文本，不需要任何构建产物，ubuntu CI 必跑。
 *
 * 守护的是两条最高风险线（§6.1）：
 * 1. 「契约漂移 = dev 解析 invalid-package 死局」：package.json 冻结区（name/version/
 *    acodeCuaRuntime 键集与值）必须与宿主 requireExpectedPackage 的硬约束精确一致
 *    （windowsCuaDevRuntime.ts:526-572：键恰好 ["schema","windows"] / ["entry","nativeAddon"]、
 *    规范 / 相对路径且互不相等；违反即 invalid-package 汇聚码，底层错误文本被刻意丢弃）。
 * 2. 「工件误入库」：cua-producer/.gitignore 的 build/ 规则漂移会让 Windows MSVC 工件
 *    （binding.sln、vcxproj 系、Release 下 lib/exp——根 .gitignore 零命中，§5.4 实测）
 *    重新暴露给 git add -A，且无 CI 卫生门禁兜底。
 *
 * 另钉 A1 工具链接线的防漂移锚（§4.4/§5.2.1）：NAPI_VERSION=9 的 env 单一来源注入、
 * common.gypi 的 target 级接线、gypfile:false（禁 npm install 隐式裸 node-gyp rebuild 绕过
 * env 注入产出 ABI 漂移工件）。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// 仓库根从 import.meta.url 推导（不依赖 cwd——须能从仓库根或 apps/acode-cli 直跑）。
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const producerRoot = join(repoRoot, "cua-producer");

const pkg = JSON.parse(readFileSync(join(producerRoot, "package.json"), "utf8"));

test("package.json 冻结区：name/version/type 精确（§5.1）", () => {
  assert.equal(pkg.name, "@acode/acode-cua", "宿主 EXPECTED_PACKAGE_NAME 硬编码该名（windowsCuaDevRuntime.ts:9）");
  assert.equal(pkg.version, "0.0.0");
  // "type":"module" 宿主不校验但必须保留：entry 是 ESM，缺失则通过全部解析校验后在 fork
  // 阶段崩、且不在 12 类稳定错误码内（§5.1 / 骨架 README「运行时契约」）。
  assert.equal(pkg.type, "module");
});

test("package.json 冻结区：acodeCuaRuntime 键集与值精确 = §5.1（改动即 dev 解析 invalid-package 死局）", () => {
  const contract = pkg.acodeCuaRuntime;
  assert.ok(contract && typeof contract === "object" && !Array.isArray(contract));
  // requireExpectedPackage: hasExactKeys(contract, ["schema","windows"])（:549）。
  assert.deepEqual(Object.keys(contract).sort(), ["schema", "windows"]);
  assert.equal(contract.schema, 1);
  // hasExactKeys(contract.windows, ["entry","nativeAddon"])（:552）。
  assert.deepEqual(Object.keys(contract.windows).sort(), ["entry", "nativeAddon"]);
  assert.equal(contract.windows.entry, "dist/windows-helper.js");
  assert.equal(contract.windows.nativeAddon, "build/Release/ax_native.node");
  assert.notEqual(contract.windows.entry, contract.windows.nativeAddon, "两路径互不相等（:555）");
});

test("package.json A1 增补区：构建脚本与工具链 devDependencies 声明（§5.1）", () => {
  assert.equal(pkg.scripts.build, "npm run build:js && npm run build:native");
  assert.equal(pkg.scripts["build:js"], "tsc -p tsconfig.json");
  assert.equal(pkg.scripts["build:native"], "node scripts/build-native.mjs");
  assert.equal(pkg.scripts.clean, "node scripts/clean.mjs");
  // node-gyp ^13 = 工具链裁决（handoff §8：node-gyp 11 不认识 VS2026；13 同时覆盖 VS2022 发布链）。
  assert.match(pkg.devDependencies["node-gyp"], /^\^13\./);
  assert.match(pkg.devDependencies["node-addon-api"], /^\^8\./);
  assert.ok(pkg.devDependencies.typescript, "tsc 是 dist 生成链（§5.3）");
  assert.ok(pkg.devDependencies["@types/node"]);
  assert.equal(pkg.private, true);
});

test("package.json gypfile:false——禁 npm install 隐式裸 node-gyp rebuild（§5.2.1 第 2 条）", () => {
  // 包根存在 binding.gyp 时 npm install 会隐式执行裸 node-gyp rebuild，绕过
  // scripts/build-native.mjs 的 NAPI_VERSION=9 env 注入、产出 ABI 漂移的 addon（本机实证）。
  assert.equal(pkg.gypfile, false, "缺 gypfile:false 时 npm install 即产出漂移工件（§4.4 单一来源被绕过）");
});

test("binding.gyp：ax_native target + 异常/标准/编码配套 + NAPI_VERSION 接线（§5.2/§5.2.1）", () => {
  const gyp = readFileSync(join(producerRoot, "binding.gyp"), "utf8");
  // target_name 决定契约路径 build/Release/ax_native.node。
  assert.match(gyp, /"target_name":\s*"ax_native"/);
  assert.match(gyp, /NAPI_CPP_EXCEPTIONS/, "C++ 异常开启（§4.5）");
  assert.match(gyp, /"ExceptionHandling":\s*1/, "/EHsc（§4.5）");
  assert.match(gyp, /\/std:c\+\+17/, "C++/WinRT 地板（§4.5）");
  assert.match(gyp, /_HAS_EXCEPTIONS=1/, "MSVC STL 异常配套宏（§5.2.1 第 4 条）");
  assert.match(gyp, /\/utf-8/, "中文注释源码的 MSVC 编码声明（§5.2.1 第 4 条）");
  // node-addon-api 8.x：.gyp 依赖是空 target，common.gypi（env→NAPI_VERSION 翻译器）必须
  // 在 target 内显式接线——顶层 includes 的 defines 不传播（§5.2.1 第 1 条，本机实证）。
  assert.match(gyp, /"includes":\s*\["node_modules\/node-addon-api\/common\.gypi"\]/);
  // NAPI_VERSION 不进 defines：由 env 注入（§4.4），避免与 common.gypi 的 NAPI_VERSION% 双写冲突。
  assert.doesNotMatch(gyp, /"NAPI_VERSION=/, "NAPI_VERSION 必须由 env 经 common.gypi 翻译，不得在 gyp 内双写");
  // addonVersion = package.json version 的编译期嵌入（§4.1/§5.2.1 第 5 条）。
  assert.match(gyp, /ADDON_VERSION=/);
});

test("binding.gyp A2 增量（§10.10，A2-AC-1）：sources 七件 + libraries 九件 + 编译期地板 defines", () => {
  const gyp = readFileSync(join(producerRoot, "binding.gyp"), "utf8");
  // sources 清单是契约面（§10.10；文件组织可微调、清单漂移即红）。
  for (const source of [
    "src/native/addon.cc",
    "src/native/environment.cc",
    "src/native/foreground.cc",
    "src/native/pointer.cc",
    "src/native/keyboard.cc",
    "src/native/clipboard.cc",
    "src/native/capture.cc",
  ]) {
    assert.ok(gyp.includes(`"${source}"`), `sources 必须含 ${source}`);
  }
  // libraries（§10.10 钉死清单）：d3d11/dxgi = WGC 设备与 surface；windowsapp = C++/WinRT；
  // user32 = SendInput/前台/光标/桌面；gdi32 = EnumDisplayMonitors；windowscodecs = WIC；
  // shcore = DPI；ole32 = COM/流；uuid = IID/GUID。
  for (const lib of [
    "d3d11.lib", "dxgi.lib", "windowsapp.lib", "user32.lib", "gdi32.lib",
    "windowscodecs.lib", "shcore.lib", "ole32.lib", "uuid.lib",
  ]) {
    assert.ok(gyp.includes(`"${lib}"`), `libraries 必须含 ${lib}`);
  }
  // 编译期地板与 §12.3 运行时地板（Win10 1809 / 17763）对齐：低版本系统加载即失败 →
  // exit 2 诚实报告，结构性排除「低版本跑半套」。
  assert.ok(gyp.includes('"_WIN32_WINNT=0x0A00"'), "_WIN32_WINNT 地板（§10.10）");
  assert.ok(gyp.includes('"NTDDI_VERSION=0x0A000006"'), "NTDDI RS5 地板（§10.10）");
  // 实现期增补（A2 批次回写）：NOMINMAX/WIN32_LEAN_AND_MEAN——windows.h 宏污染防护。
  assert.ok(gyp.includes('"NOMINMAX"'), "NOMINMAX（std::min/max 与 windows.h 宏冲突防护）");
  assert.ok(gyp.includes('"WIN32_LEAN_AND_MEAN"'), "WIN32_LEAN_AND_MEAN");
});

test("A2 源布局齐套（§5.3 布局树 A2 增补；模块划分是契约）", () => {
  for (const rel of [
    "src/backend-a2.ts",
    "src/input-session.ts",
    "src/frame-registry.ts",
    "src/native-driver.ts",
    "src/keymap.ts",
    "src/driver-contract.ts",
    "src/param-validation.ts",
    "src/receipts.ts",
    "src/mutating-dispatch.ts",
    "src/native/ax_internal.h",
    "src/native/pointer.cc",
    "src/native/keyboard.cc",
    "src/native/clipboard.cc",
    "src/native/capture.cc",
    "src/native/foreground.cc",
    "src/native/environment.cc",
    "scripts/smoke-real.mjs",
  ]) {
    assert.ok(existsSync(join(producerRoot, rel)), `${rel} 必须存在（§5.3）`);
  }
});

test("A2 模块规则（§10.11 契约，防漂移 = 静态 import 断言）：纯逻辑模块不得 import native-driver；native-driver 只被 entry 组装路径 import", () => {
  const srcDir = join(producerRoot, "src");
  // 规则①：backend/input-session/frame-registry/keymap/param-validation/receipts
  // （+driver-contract 契约面）一律纯 TS + 注入 driver——CI 常驻单测的前提；
  // import native-driver 即红。
  for (const pure of [
    "backend-a2.ts", "input-session.ts", "frame-registry.ts", "keymap.ts",
    "driver-contract.ts", "param-validation.ts", "receipts.ts", "mutating-dispatch.ts",
    "backend-a1.ts", "wire-server.ts",
  ]) {
    const text = readFileSync(join(srcDir, pure), "utf8");
    assert.ok(
      !text.includes("./native-driver"),
      `${pure} 不得 import native-driver（规则①：纯逻辑 + 注入 driver）`,
    );
    assert.ok(
      !text.includes("./uia-driver"),
      `${pure} 不得 import uia-driver（规则①，A3 同律预登记）`,
    );
  }
  // 规则②：native-driver 只被 windows-helper.ts（entry 组装路径）import。
  const importers = [];
  for (const entry of readdirSync(srcDir)) {
    if (!entry.endsWith(".ts")) continue;
    const text = readFileSync(join(srcDir, entry), "utf8");
    if (text.includes(`"./native-driver.js"`)) importers.push(entry);
  }
  assert.deepEqual(importers, ["windows-helper.ts"], "native-driver 的唯一 import 方 = entry 组装路径");
});

test("MISSING_IPC_CHANNEL_MESSAGE 单源（§17.3 裁决）：windows-helper.ts 不再内联字面量", () => {
  const helper = readFileSync(join(producerRoot, "src", "windows-helper.ts"), "utf8");
  const protocol = readFileSync(join(producerRoot, "src", "control-protocol.ts"), "utf8");
  // 单一来源 = control-protocol.ts 常量（§2.7 封闭表第 4 行的字面量事实源）。
  assert.match(protocol, /MISSING_IPC_CHANNEL_MESSAGE = "missing-ipc-channel"/, "常量定义在 control-protocol.ts");
  // windows-helper.ts 引用常量、不再双写内联字面量（防「改一处漏一处」回归）。
  assert.ok(helper.includes("MISSING_IPC_CHANNEL_MESSAGE"), "entry 引用常量");
  assert.ok(
    !helper.includes('"missing-ipc-channel"') && !helper.includes("`missing-ipc-channel"),
    "entry 源文本不再含内联 missing-ipc-channel 字面量（§17.3 静态断言）",
  );
});

test("UTF-8 字节级行缓冲（§17.2 裁决）：两侧 framing 不再逐 chunk toString 累积", () => {
  const helper = readFileSync(join(producerRoot, "src", "windows-helper.ts"), "utf8");
  const broker = readFileSync(join(repoRoot, "packages", "acode-cua", "broker.js"), "utf8");
  // 回归锚：旧缺陷形态 `buffer += chunk.toString("utf8")` 一旦复活即红（多字节跨 chunk
  // 劈裂 → U+FFFD 不可逆损坏；cap 判定对损坏重编码字符串量长 → 与 wire 原始字节漂移）。
  assert.doesNotMatch(helper, /buffer \+= chunk\.toString/, "Helper 侧请求行必须字节级缓冲");
  assert.doesNotMatch(broker, /buffer \+= chunk\.toString/, "角色 B 侧响应行必须字节级缓冲");
  assert.match(helper, /Buffer\.concat/, "Helper 侧 Buffer 累积");
  assert.match(broker, /Buffer\.concat/, "角色 B 侧 Buffer 累积");
  assert.match(helper, /indexOf\(0x0a\)/, "Helper 侧字节域切行");
  assert.match(broker, /indexOf\(0x0a\)/, "角色 B 侧字节域切行");
});

test("watchdog 自适应的事件驱动重臂接线（§10.8，2026-10-14 评审修复）：entry 以 onHeldChange 接 armWatchdog", () => {
  const helper = readFileSync(join(producerRoot, "src", "windows-helper.ts"), "utf8");
  // 结构性主张：held 0↔非空迁移即时重臂（仅 tick 边界重算会让迁移后的最坏检测延迟
  // 仍 ~2000ms，§10.8「≤250ms+释放时长」在角落不成立——评审 medium 发现的回归锚）。
  assert.match(helper, /onHeldChange:\s*armWatchdog/, "createInputSession 必须传 onHeldChange 重臂回调");
  assert.match(helper, /function armWatchdog/, "重臂原语在场（clearTimeout + 按当前 held 状态定间隔）");
  assert.match(helper, /clearTimeout\(watchdogTimer\)/, "重臂先清旧定时器（O(1) 重置，§10.8）");
});

test("wire-server §4.6.1 A2 封闭字面量表齐套（零插值防漂移：逐字面量精确断言）", () => {
  const wireServer = readFileSync(join(producerRoot, "src", "wire-server.ts"), "utf8");
  for (const literal of [
    "Invalid Computer Use method parameters.",
    "Computer Use target app is not running.",
    "Computer Use app_ref requires a pid in this producer slice.",
    "Computer Use input requires the target application to be the only foreground application.",
    "Computer Use is not available on a locked or non-interactive desktop.",
    "Computer Use observation state is stale; observe the application again.",
    "Computer Use element targets require the UIA observation surface.",
    "Computer Use capture target changed or is not capturable.",
    "Computer Use operation timed out.",
    "Computer Use controller is busy; retry after the current action completes.",
    "Computer Use clipboard is busy.",
    "Computer Use clipboard access was denied.",
  ]) {
    assert.ok(wireServer.includes(JSON.stringify(literal)), `§4.6.1 字面量必须在封闭表内：${literal}`);
  }
  // §10.6/§10.9/§10.12.1 收据固定字面量（receipts.ts 的 RECEIPT_MESSAGES 表——单一来源）。
  const receipts = readFileSync(join(producerRoot, "src", "receipts.ts"), "utf8");
  for (const literal of [
    "Computer Use control stopped; held inputs released.",
    "Computer Use action was interrupted by stop_computer_control.",
    "Computer Use clipboard was modified but the paste keystroke was not dispatched.",
    "Computer Use action may have been dispatched; the native outcome could not be verified.",
    "Computer Use paste completed; the clipboard now holds the pasted text.",
    "Computer Use drag completed; all interpolated points were injected.",
    "Computer Use text input was partially injected before the sequence stopped.",
    "Computer Use action completed; modifier key release required cleanup.",
  ]) {
    assert.ok(receipts.includes(JSON.stringify(literal)) || receipts.includes(`"${literal}"`), `收据字面量必须精确（零插值）：${literal}`);
  }
  // isAppNotFound 兼容子串（SDK alternateAppRef 触发器，§4.6.1/§11.3——两侧同审纪律）。
  assert.ok(wireServer.includes("target app is not running"), "SDK isAppNotFound 兼容子串在场");
});

test("smoke-real.mjs 契约面（§15.1/§15.3）：flags 白名单 + --pointer 双保险 + 自证扫描 + 退出码语义", () => {
  const smoke = readFileSync(join(producerRoot, "scripts", "smoke-real.mjs"), "utf8");
  for (const flag of ['"--capture"', '"--uia"', '"--host"', '"--pointer"']) {
    assert.ok(smoke.includes(flag), `flags 白名单必须含 ${flag}`);
  }
  // --pointer 双保险：flag 之外还须 env（门禁脚本永不设该 env，结构上排除误执行）。
  assert.ok(smoke.includes("ACODE_CUA_SMOKE_POINTER_LIVE"), "--pointer opt-in env 双保险");
  assert.ok(smoke.includes("pointer-flag-must-be-alone"), "--pointer 必须单独出现");
  // 输出纪律自证（结构性）：泄漏即失败。
  assert.ok(smoke.includes("smoke-self-leak"), "退出前自证扫描");
  // 非 win32 前置即 exit 2（ubuntu CI 永不执行）。
  assert.match(smoke, /process\.platform !== "win32"/);
  assert.ok(smoke.includes("smoke-requires-win32"), "非 win32 固定结果码");
});

test("tsconfig.json 钉死项精确（§5.3）", () => {
  const tsconfig = JSON.parse(readFileSync(join(producerRoot, "tsconfig.json"), "utf8"));
  const options = tsconfig.compilerOptions;
  assert.equal(options.module, "nodenext");
  assert.equal(options.moduleResolution, "nodenext");
  assert.equal(options.target, "es2023", "Node 24 地板");
  assert.equal(options.rootDir, "src");
  assert.equal(options.outDir, "dist");
  assert.equal(options.strict, true);
  assert.equal(options.sourceMap, true);
  assert.equal(options.declaration, false, "dist 消费者是 fork 运行时与测试，无 .d.ts 需求");
  assert.deepEqual(options.types, ["node"]);
});

test("build-native.mjs：NAPI_VERSION=9 env 单一来源注入 + 非 win32 拒绝（§4.4/§5.2）", () => {
  const script = readFileSync(join(producerRoot, "scripts", "build-native.mjs"), "utf8");
  assert.match(script, /NAPI_VERSION:\s*"9"/, "pin 9 的唯一注入点（防构建机 napi 漂移成 ABI 漂移）");
  assert.match(script, /process\.platform !== "win32"/, "非 win32 构建直接失败退出");
  assert.match(script, /rebuild/);
});

test("cua-producer/.gitignore：存在且含 build/ 规则（§5.4——漂移会让 MSVC 工件重新暴露给 git add -A）", () => {
  const ignorePath = join(producerRoot, ".gitignore");
  assert.ok(existsSync(ignorePath), "本地 .gitignore 必须与工具链接线同批存在（§5.4 原子性）");
  const rules = readFileSync(ignorePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.ok(rules.includes("build/"), "整棵 node-gyp 构建树全量忽略");
});

test("A1 源布局齐套（§5.3——模块划分是契约：wire-server 可独立导入是 §6.3 单测的前提）", () => {
  for (const rel of [
    "src/windows-helper.ts",
    "src/wire-server.ts",
    "src/backend-a1.ts",
    "src/native-loader.ts",
    "src/control-protocol.ts",
    "src/native/addon.cc",
    "scripts/build-native.mjs",
    "scripts/clean.mjs",
    "package-lock.json",
  ]) {
    assert.ok(existsSync(join(producerRoot, rel)), `${rel} 必须存在`);
  }
});

test("package-lock.json 入库且锁的是 producer 自有树（handoff §8：随构建接线一并提交，复现性）", () => {
  const lockText = readFileSync(join(producerRoot, "package-lock.json"), "utf8");
  const lock = JSON.parse(lockText);
  assert.equal(lock.name, "@acode/acode-cua");
  assert.ok(lock.packages && typeof lock.packages === "object");
  assert.ok(lock.packages["node_modules/node-gyp"], "node-gyp 必须在 producer 自有锁内（不触根 pnpm）");
  assert.ok(lock.packages["node_modules/node-addon-api"]);
  // 评审修复（2026-10-14，severity medium）：resolved 必须全部指向官方 registry。
  // 修复依据：仓库 .npmrc 明文 policy 是 registry=https://registry.npmjs.org，而旧 lockfile
  // 24/24 条 resolved 被开发者个人 ~/.npmrc 的镜像偏好固化为 registry.npmmirror.com——根因是
  // npm 的 project 级 .npmrc 取「被安装 package.json 所在目录」，在 cua-producer/ 内跑
  // npm install 时仓库根 .npmrc 不参与，用户级镜像配置生效（且 node_modules/.package-lock.json
  // 隐藏锁会把镜像 URL 带进重生成的可见锁）。结构性修复 = cua-producer/.npmrc 钉定官方源 +
  // 以官方源全新生成；本断言是防漂移门禁：任何人在个人镜像配置下重新生成 lockfile 都会红。
  const resolvedHosts = new Set(
    [...lockText.matchAll(/"resolved": "https:\/\/([^/"]+)/g)].map((match) => match[1]),
  );
  assert.ok(resolvedHosts.size > 0, "lockfile 必须携带 resolved 溯源信息");
  assert.deepEqual([...resolvedHosts], ["registry.npmjs.org"], "resolved 必须全部指向官方 registry");
  // 每条 resolved 都须有 sha512 integrity（内容钉定，防篡改）。
  const resolvedCount = [...lockText.matchAll(/"resolved":/g)].length;
  const integrityCount = [...lockText.matchAll(/"integrity": "sha512-/g)].length;
  assert.equal(integrityCount, resolvedCount, "resolved 与 sha512 integrity 一一对应");
});

test("cua-producer/.npmrc：钉定官方 registry 且绝不含凭据（评审修复 2026-10-14 的结构性防线）", () => {
  const npmrc = readFileSync(join(producerRoot, ".npmrc"), "utf8");
  // 有效配置行（剥掉 # / ; 注释）必须恰好只有官方 registry 钉定这一条。
  const effective = npmrc
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith(";"));
  assert.deepEqual(effective, ["registry=https://registry.npmjs.org"], "producer 自有安装树的 registry 必须与仓库 .npmrc policy 一致（个人 ~/.npmrc 镜像偏好不得渗入）");
  // 凭据纪律（AGENTS.md）：authToken 类只允许存在于用户级配置/密钥服务，绝不入库。
  // 按「赋值形态」判定（key = value），注释里的纪律说明文字不构成误报（本测试初版曾用
  // 裸词匹配，被 .npmrc 注释里的 "authToken" 说明文字误伤——修复为结构性判定）。
  assert.ok(
    !/(authToken|_auth|_password|password)\s*=/.test(npmrc),
    "任何行（含注释）不得出现凭据赋值形态",
  );
});
