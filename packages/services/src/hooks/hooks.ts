import type { Hook, ACodeWorkspaceHookTrustGrantResult } from "@acode/shared";
import type { WorkspaceHookBundleSnapshotData } from "@acode/shared/workspace-hook-discovery";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IHooksService {
  /**
   * 加载 workspace 的 hooks 配置
   */
  loadHooks(params: { workspaceIdentity?: string; workspacePath: string }): Promise<{
    hooks: Hook[];
    hooksEnabled: boolean;
    workspaceHookSnapshot?: WorkspaceHookBundleSnapshotData;
    /** trust store 文件损坏/不可读时为 true（fail-closed：全部 hook 按未持久信任处理） */
    trustStoreCorrupt?: boolean;
  }>;

  /**
   * 保存 hooks 配置
   */
  saveHooks(params: {
    workspaceIdentity?: string;
    workspacePath: string;
    hooks: Hook[];
  }): Promise<void>;

  /**
   * 无 task/session 的 Workspace Hook 预信任。
   * 实现必须转发到 Agent authority 重新发现 canonical snapshot，禁止 service/UI 直接写 store。
   */
  grantWorkspaceHookTrust?(params: {
    workspaceIdentity?: string;
    workspacePath: string;
    bundleDigest: string;
    hookDeclarationDigest: string;
  }): Promise<ACodeWorkspaceHookTrustGrantResult>;
}

export const IHooksService = createServiceDescriptor<IHooksService>(ServiceChannels.Hooks, {
  allowedMethods: ["loadHooks", "saveHooks", "grantWorkspaceHookTrust"],
  argumentValidators: {
    loadHooks: (args) => {
      const params = requireParams(args);
      requireString(params.workspacePath, "workspacePath");
      requireOptionalString(params.workspaceIdentity, "workspaceIdentity");
    },
    saveHooks: (args) => {
      const params = requireParams(args);
      requireString(params.workspacePath, "workspacePath");
      requireOptionalString(params.workspaceIdentity, "workspaceIdentity");
      // hooks 是命令配置写入口：空数组是合法"清空"。边界要求每项为对象且 command 为字符串，
      // 防止非对象条目进入持久化；完整 Hook 成员（event/type/enabled 等）由服务端校验。
      const hooks = params.hooks;
      if (
        !Array.isArray(hooks) ||
        !hooks.every((hook) => isRecord(hook) && typeof hook.command === "string")
      ) {
        throw new Error("invalid hooks");
      }
    },
    grantWorkspaceHookTrust: (args) => {
      const params = requireParams(args);
      requireString(params.workspacePath, "workspacePath");
      requireOptionalString(params.workspaceIdentity, "workspaceIdentity");
      // 信任授予是安全敏感写入：digest 必须为非空字符串；
      // canonical snapshot 复核由 Agent authority 完成，边界不重复业务判定。
      requireNonEmptyString(params.bundleDigest, "bundleDigest");
      requireNonEmptyString(params.hookDeclarationDigest, "hookDeclarationDigest");
    },
  },
});

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 恰好一个参数且必须是非 null、非数组对象。 */
function requireParams(args: readonly unknown[]): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected one params object");
  const value = args[0];
  if (!isRecord(value)) throw new Error("expected one params object");
  return value;
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`invalid ${field}`);
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
}

function requireOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") throw new Error(`invalid ${field}`);
}
