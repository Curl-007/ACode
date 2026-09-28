/**
 * Electron fuse 配置解析（安全加固 P2 #3，specs/electron-hardening.md §5）。
 *
 * 设计约束：
 * - 通过 electron-builder 26 的 `electronFuses` 配置键接线（app-builder-lib platformPackager.js
 *   保证 fuse flip 在全部 afterPack hook 之后、签名之前执行），不新增 @electron/fuses 依赖；
 * - 本模块保持纯函数，供 electron-builder.config.js 与 tests/desktop-hardening.test.mjs 共同消费；
 * - 与计划的偏离必须同时体现在本文件的注释与 spec 里，禁止静默改值。
 */

/**
 * 打包版桌面 agent 的唯一启动方式是「宿主 Electron 二进制 + ELECTRON_RUN_AS_NODE=1」执行
 * resources/glm/acode.cjs（packages/services acodeAgentProcessManager.ts
 * resolveElectronRuntimeACodeAgentCommand）。fuse 是二进制级开关：
 * - runAsNode 关闭会直接打断打包版 agent spawn；
 * - enableNodeOptionsEnvironmentVariable 同时控制 NODE_OPTIONS 与 NODE_EXTRA_CA_CERTS，
 *   关闭会让 agentProxyEnv 注入的自定义 CA / app 自签 CA 信任静默失效。
 * 两者共同根因是 agent 依赖宿主二进制的 Node 语义；待「agent 独立 node 二进制」工程落地后
 * 再一并关闭。在此之前这两个 fuse 必须保持 Electron 默认（true），故这里不输出这两个键。
 */
const FUSES_BLOCKED_BY_AGENT_RUNTIME = Object.freeze([
  "runAsNode",
  "enableNodeOptionsEnvironmentVariable",
]);

/**
 * 解析当前打包目标应使用的 electronFuses 配置。
 *
 * @param {{
 *   platformOs: "win32" | "darwin" | "linux" | string,
 *   macSigningEnabled: boolean,
 * }} input
 * @returns {Record<string, boolean>} 仅包含确认要写的 fuse；未写键保持 electron-builder 默认。
 */
export function resolveDesktopElectronFuses(input) {
  const { platformOs, macSigningEnabled } = input;
  const fuses = {
    // 打包态只允许从 app.asar 加载应用代码；配合完整性校验阻止加载未校验代码。
    // 不依赖代码签名，全平台开启。
    onlyLoadAppFromAsar: true,
  };
  if (platformOs === "win32") {
    // Windows 的 asar 完整性校验自 Electron 30 起支持，41 满足；不依赖签名。
    fuses.enableEmbeddedAsarIntegrityValidation = true;
  } else if (platformOs === "darwin" && macSigningEnabled === true) {
    // macOS 的 asar 完整性挂在代码签名上：未签名包开启会无法启动，
    // 因此只在 CI 明确打开签名（ACODE_ENABLE_MAC_SIGN=1 且有身份）时开启；
    // 未开启时直接不写该键，保持 electron-builder 默认（关）。
    fuses.enableEmbeddedAsarIntegrityValidation = true;
  }
  // linux 不支持 asar 完整性校验（macOS>=16 / Windows>=30），不写该键。
  return fuses;
}

/**
 * 平台是否需要 afterPack 末尾刷新 asar 完整性（见 scripts/desktop-asar-integrity-refresh.mjs）：
 * 只有开启了完整性校验 fuse 的平台才需要把最终 app.asar 的 header 哈希回写进产物。
 */
export function shouldRefreshAsarIntegrity(fuses) {
  return fuses.enableEmbeddedAsarIntegrityValidation === true;
}

export const DESKTOP_ELECTRON_FUSES_DOC = Object.freeze({
  blockedByAgentRuntime: FUSES_BLOCKED_BY_AGENT_RUNTIME,
});
