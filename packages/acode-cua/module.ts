/**
 * acode-cua 模块清单（架构治理工件）。
 *
 * 本包是 Computer Use 的 fail-closed 占位构建：运行时表面全部是包根下的扁平
 * .js/.d.ts 文件（无 src/ 目录、无构建步骤），公开面即 package.json exports
 * 的 12 个子路径。跨模块消费者（services / desktop / acode-cli）只能经由这些
 * 导出子路径访问；架构检查器通过 architecture-policy.yaml 的 global.aliasRules
 * 把每个子路径映射到实际文件（workspace 解析器的 <pkgRoot>/src/<subpath> 约定
 * 对扁平布局不适用）。
 *
 * 注意：本文件与 contract.ts / contract.example.ts 均为治理与阅读用途，
 * 不参与包运行时，也不被根 typecheck（tsc -b 清单）或任何构建脚本编译。
 */
export const acodeCuaModule = {
  id: "acode-cua",
  // 包内运行时只 import node 内建模块（node:crypto / node:os / node:path），
  // 不依赖任何 workspace 模块，因此 requires 为空。
  requires: [],
  provides: ["cua-fail-closed-surface"],
  publicEntrypoints: [
    "index.js",
    "frame-contract.js",
    "host-display-contract.js",
    "request-access-contract.js",
    "pip-session.js",
    "pip-session-node.js",
    "broker.js",
    "broker-server.js",
    "broker-ports.js",
    "broker-socket-path.js",
    "broker-helper-constants.js",
    "broker-helper-health.js",
  ],
} as const;
