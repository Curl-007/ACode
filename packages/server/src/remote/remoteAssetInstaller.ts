// 拆分说明（满足 400 行架构上限）：安装策略按职责分叶，本文件收敛为公开面（行为不变）：
// - remoteAssetInstallerInterface.ts：RemoteAssetInstaller 公开契约
// - remoteAssetInstallCommands.ts：取消守卫、远端命令构造、路径完整性检查（纯逻辑）
// - remoteDownloadManifest.ts：远端下载 manifest 获取（single-flight + 多 CDN 回退）
// - localUploadAssetInstaller.ts：本地上传实现（本地 release → staging 上传 → 原子替换）
// - remoteDownloadAssetInstaller.ts：远端下载实现（远端 component cache + lock + 校验下载）
export type { RemoteAssetInstaller } from "./remoteAssetInstallerInterface.js";
export {
  buildRemoteArtifactDownloadCommand,
  buildRemoteChecksumCommand,
} from "./remoteAssetInstallCommands.js";
export {
  fetchRemoteDownloadManifest,
  type RemoteDownloadAssetInstallerOptions,
  type RemoteManifestRef,
} from "./remoteDownloadManifest.js";
export { LocalUploadAssetInstaller } from "./localUploadAssetInstaller.js";
export { RemoteDownloadAssetInstaller } from "./remoteDownloadAssetInstaller.js";
