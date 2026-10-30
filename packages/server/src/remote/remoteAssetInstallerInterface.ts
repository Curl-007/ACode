// 拆分依据：remoteAssetInstaller.ts 超 400 行架构上限。RemoteAssetInstaller 是部署入口与
// 两种安装实现（本地上传 / 远端下载）共享的公开契约，独立成叶避免契约与实现互相成环。
import type { RemoteAssetInstallMode } from "@acode/shared";

export interface RemoteAssetInstaller {
  readonly mode: RemoteAssetInstallMode;
  resolveComponentVersion?(componentId: string): Promise<string | null>;
  resolveComponentSha256?(componentId: string): Promise<string | null>;
  installFile(params: {
    componentId: string;
    sourceRelativePath: string;
    remotePath: string;
    executable?: boolean;
    forceRefresh?: boolean;
  }): Promise<void>;
  installDirectory(params: {
    componentId: string;
    sourceRelativePath: string;
    remoteDir: string;
    requiredRelativePaths?: string[];
    forceRefresh?: boolean;
  }): Promise<void>;
}
