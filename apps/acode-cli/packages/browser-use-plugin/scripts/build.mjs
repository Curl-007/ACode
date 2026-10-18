import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const defaultPackageRoot = resolve(import.meta.dirname, "..");
const executableFileMode = 0o755;

// esbuild 以 format: "esm" 打包时，会把 CJS 依赖里的 require() 替换成一个 __require shim：
//   typeof require !== "undefined" ? require : (name) => { throw Error('Dynamic require of "' + name + '" is not supported') }
// ESM 模块作用域里没有 require，于是这个 shim 永远走抛错分支。
// @acode/core 从 tool/handlers/write.js -> memory/origin-session.js eager import 了 CJS 的
// yaml，yaml 内部 require("process") 正好命中 shim，导致 dist/mcp/server.js 在**模块求值阶段**
// 就抛 `Dynamic require of "process" is not supported`；plugin host 的 await import() 直接失败，
// 表现为 mcp.server.closed / mcp.server.failed、注册 0 个工具，模型侧彻底看不到 mcp__node_repl__js。
// 这里注入真实的 createRequire，让 shim 落到可用的 require 上（产物仍是 ESM）。
// 两个 bundle 都加：browser-client 目前没有 CJS 依赖，但同样是 ESM 产物，后续被拖进一个
// CJS 依赖就会以同样的方式在加载期炸掉。
const nodeRequireBanner = `import { createRequire as __acodeCreateRequire } from "node:module";
const require = __acodeCreateRequire(import.meta.url);`;

const createBundleOptions = ({ entryPoint, outfile }) => ({
  banner: {
    js: nodeRequireBanner,
  },
  bundle: true,
  entryPoints: [entryPoint],
  format: "esm",
  legalComments: "none",
  outfile,
  platform: "node",
  target: "node24",
});

/**
 * 供 scripts 直跑与 smoke test 复用的构建入口，保证测试校验的产物与发布产物同一套 esbuild 选项。
 */
export const buildBrowserUsePluginBundles = async ({
  packageRoot = defaultPackageRoot,
  browserClientOutfile = resolve(packageRoot, "scripts", "browser-client.mjs"),
  relayServerOutfile = resolve(packageRoot, "scripts", "relay-server.mjs"),
} = {}) => {
  // node_repl 宿主的产物由 @acode/node-repl-host 自己构建与携带；这个包出 browser-client
  // 与 relay-server（browser-relay 独立启动器，specs/browser-relay-inplace-capture.md
  // 「集成与共享桶申请」节：启动面在插件包内，cli 不反向依赖插件）。
  await mkdir(dirname(browserClientOutfile), { recursive: true });
  await build(
    createBundleOptions({
      entryPoint: resolve(packageRoot, "src", "browser-client.ts"),
      outfile: browserClientOutfile,
    }),
  );
  await chmod(browserClientOutfile, executableFileMode);
  await mkdir(dirname(relayServerOutfile), { recursive: true });
  await build(
    createBundleOptions({
      entryPoint: resolve(packageRoot, "src", "relay", "main.ts"),
      outfile: relayServerOutfile,
    }),
  );
  await chmod(relayServerOutfile, executableFileMode);
  return { browserClientOutfile, relayServerOutfile };
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await buildBrowserUsePluginBundles();
}
