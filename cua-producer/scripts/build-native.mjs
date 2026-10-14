// A1 native 构建脚本（specs/windows-helper-producer.md §5.2/§4.4）。
// 职责：设 env NAPI_VERSION="9"（单一来源，防「构建机 Node 的 napi」漂移成 ABI 漂移，§4.4）
// 后 spawn producer 自有 node-gyp `rebuild`。只用 node 内建（跨平台 env 注入不引第三方包）；
// node-gyp 用 producer 自有安装树，不触根 pnpm（工具链裁决：禁根 override，z-work/u14-handoff.md §8）。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const producerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 非 win32 构建直接失败退出（§5.2：本 addon 仅 Windows 目标；ubuntu CI 不构建 producer，§6.1）。
if (process.platform !== "win32") {
  console.error("[cua-producer] build:native targets win32 only; refusing to build on this platform.");
  process.exit(1);
}

// 以 process.execPath 直跑本地 node-gyp 的 JS 入口：Windows 下 node_modules/.bin/node-gyp 是
// shell shim，直跑 JS 入口是「spawn 本地 node-gyp」的跨平台等价形态（§5.2），且不依赖 PATH。
const nodeGypEntry = join(producerRoot, "node_modules", "node-gyp", "bin", "node-gyp.js");
if (!existsSync(nodeGypEntry)) {
  console.error("[cua-producer] local node-gyp is missing; run `npm install` inside cua-producer first.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [nodeGypEntry, "rebuild"], {
  cwd: producerRoot,
  stdio: "inherit",
  // NAPI_VERSION 单一来源（§4.4）：binding.gyp 刻意不写该 define，此处注入是唯一入口。
  env: { ...process.env, NAPI_VERSION: "9" },
});
if (result.error) {
  // 只报稳定错误类别，不插值底层文本（构建脚本无凭据面，但保持与 Helper 同纪律）。
  console.error(`[cua-producer] failed to spawn node-gyp: ${result.error.name}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
