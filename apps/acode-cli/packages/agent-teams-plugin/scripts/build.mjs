import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const defaultPackageRoot = resolve(import.meta.dirname, "..");

// 与 browser-use-plugin 相同的教训：esbuild ESM 产物里的 CJS 依赖（zod 等发布为 CJS 时）
// 会被 __require shim 在求值期炸掉；banner 注入真实 createRequire 兜底。
const nodeRequireBanner = `import { createRequire as __zcodeCreateRequire } from "node:module";
const require = __zcodeCreateRequire(import.meta.url);`;

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

export const buildAgentTeamsPluginBundles = async ({
  packageRoot = defaultPackageRoot,
} = {}) => {
  const outfile = resolve(packageRoot, "dist", "mcp", "server.js");
  await mkdir(resolve(packageRoot, "dist", "mcp"), { recursive: true });
  await build(
    createBundleOptions({
      entryPoint: resolve(packageRoot, "src", "server.ts"),
      outfile,
    }),
  );
  return { serverOutfile: outfile };
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await buildAgentTeamsPluginBundles();
}
