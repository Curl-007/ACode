import { defineConfig } from "tsup";

export default defineConfig({
  entry: { relay: "src/main.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  // workspace 包的 exports 指向 .ts 源码，node 运行时无法直接加载，需要 bundle 进来。
  noExternal: ["@acode/shared"],
  // ws 含可选原生依赖（bufferutil / utf-8-validate），外置交给 Node 原生加载。
  external: ["ws", "bufferutil", "utf-8-validate"],
  clean: true,
});
