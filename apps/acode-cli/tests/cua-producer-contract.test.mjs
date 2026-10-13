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
import { existsSync, readFileSync } from "node:fs";
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
  assert.match(gyp, /"sources":\s*\["src\/native\/addon\.cc"\]/);
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
