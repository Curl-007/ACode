// workspace hook 预信任授权的 v4 handler（apps/acode-cli/specs/m2-8-workspace-provider-process.md）。
//
// 授权实体自 legacy `acode-protocol/workspace-hook-trust.ts` 逐字迁入（parse 改 v4 schema，
// 形状逐字 parity）；notify 联动自 `acode-protocol/server.ts` 迁入——accepted 后按
// workspaceKey 通知全部活跃 session 重载 trust store（迁移不变量，spec §3.1）。legacy
// case 删除后 server.ts 不再持有该联动（不向待删目录留实体债）。
import { resolve } from "node:path";
import { workspaceHookPolicySchema } from "@acode/contracts";
import type { WorkspaceHookPolicyProvider } from "@acode/core";
import {
  v4WorkspaceHookTrustGrantParamsSchema,
  v4WorkspaceHookTrustGrantReasonCodeSchema,
  v4WorkspaceHookTrustGrantResultSchema,
  type V4WorkspaceHookTrustGrantReasonCode,
  type V4WorkspaceHookTrustGrantResult,
} from "@acode/shared/acode-protocol-v4";
import {
  grantWorkspaceHookTrust,
  type WorkspaceHookTrustCliStatus,
} from "../workspace-hook-trust-cli.js";
import type {
  ACodeProtocolAgentServerContext,
  ACodeProtocolSessionRecord,
} from "../acode-protocol/server-types.js";

type GrantWorkspaceHookTrust = typeof grantWorkspaceHookTrust;

/**
 * 没有 task/session 时的 workspace 级 Trust authority。
 *
 * 可信 Host 只能提交 Settings 看到的精确 bundle/declaration；真正授权前仍由 Agent
 * 重新发现 canonical snapshot。这里不创建隐藏 task，也不接受 UI 直接提供的记录内容。
 */
export async function grantWorkspaceHookTrustForProtocolV4(
  rawParams: unknown,
  dependencies: {
    appVersion?: string;
    grant?: GrantWorkspaceHookTrust;
    policyProvider: WorkspaceHookPolicyProvider;
  },
): Promise<V4WorkspaceHookTrustGrantResult> {
  const params = v4WorkspaceHookTrustGrantParamsSchema.parse(rawParams);
  const grant = dependencies.grant ?? grantWorkspaceHookTrust;
  const workspaceIdentity =
    params.workspace.workspaceIdentity?.trim() || resolve(params.workspace.workspacePath);
  const policyRejection = getPolicyRejectionReason(
    dependencies.policyProvider,
    workspaceIdentity,
  );
  if (policyRejection) {
    return v4WorkspaceHookTrustGrantResultSchema.parse({
      accepted: false,
      reasonCode: policyRejection,
    });
  }
  try {
    const status = await grant({
      workspacePath: params.workspace.workspacePath,
      ...(params.workspace.workspaceIdentity
        ? { workspaceIdentity: params.workspace.workspaceIdentity }
        : {}),
      bundleDigest: params.bundleDigest,
      hookDeclarationDigests: [params.hookDeclarationDigest],
      ...(dependencies.appVersion ? { appVersion: dependencies.appVersion } : {}),
    });
    return v4WorkspaceHookTrustGrantResultSchema.parse(
      didGrantExactDeclaration(status, params.hookDeclarationDigest)
        ? { accepted: true }
        : { accepted: false, reasonCode: toPublicReasonCode(status.reasonCode) },
    );
  } catch (error) {
    return v4WorkspaceHookTrustGrantResultSchema.parse({
      accepted: false,
      reasonCode: toPublicReasonCode(error),
    });
  }
}

/**
 * Trust store 落盘后各 session 的 coordinator
 * 内存镜像（仅创建时 load）不会自动更新，已信任 Hook 继续被拒、banner pendingCount
 * 停留旧值。pretrust 授权成功后按 workspaceKey 通知所有匹配的活跃 session 重载。
 * 独立导出为纯调度函数（不触网、不发事件），便于回归测试直接构造 sessions Map。
 */
export async function notifyWorkspaceHookTrustGrantSessionsV4(input: {
  grantedWorkspaceKey?: string;
  sessions: Map<string, ACodeProtocolSessionRecord>;
}): Promise<void> {
  if (!input.grantedWorkspaceKey) return;
  await Promise.all(
    [...input.sessions.values()]
      .filter((record) => record.workspace.workspaceKey === input.grantedWorkspaceKey)
      .map((record) => record.app.reloadWorkspaceHookTrust()),
  );
}

/**
 * v4 case 实体：授权 + accepted 联动通知（legacy server.ts case 体逐字迁）。
 */
export async function grantWorkspaceHookTrustV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4WorkspaceHookTrustGrantResult> {
  const grantResult = await grantWorkspaceHookTrustForProtocolV4(rawParams, {
    appVersion: context.deps.version,
    policyProvider: context.deps.workspaceHookPolicyProvider,
  });
  if (grantResult.accepted) {
    await notifyWorkspaceHookTrustGrantSessionsV4({
      // dispatch 层的 params 是弱类型；grant 内部已用同一 schema parse 过，这里
      // safeParse 只为取出 workspaceKey 做匹配，失败即跳过通知（防御，正常必成功）。
      grantedWorkspaceKey: v4WorkspaceHookTrustGrantParamsSchema.safeParse(rawParams).success
        ? v4WorkspaceHookTrustGrantParamsSchema.parse(rawParams).workspace.workspaceKey
        : undefined,
      sessions: context.sessions,
    });
  }
  return grantResult;
}

function getPolicyRejectionReason(
  policyProvider: WorkspaceHookPolicyProvider,
  workspaceIdentity: string,
): V4WorkspaceHookTrustGrantReasonCode | undefined {
  try {
    const policy = workspaceHookPolicySchema.parse(policyProvider.getPolicy(workspaceIdentity));
    if (policy.mode === "user_decides") return undefined;
    return policy.mode === "allow_trusted_only"
      ? "workspace_hooks_policy_requires_pretrust"
      : "workspace_hooks_blocked_by_policy";
  } catch {
    // Settings 无 session 路径曾在重新发现后直接写 Trust store，绕过受信
    // embedder policy。policy provider 异常时也必须 fail closed，不能退回默认可授权。
    return "workspace_hooks_blocked_by_policy";
  }
}

function toPublicReasonCode(error: unknown): V4WorkspaceHookTrustGrantReasonCode {
  const candidate = error instanceof Error ? error.message : error;
  const parsed = v4WorkspaceHookTrustGrantReasonCodeSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;

  // 这里曾把底层 Error.message 直接放进 reasonCode，导致配置绝对路径和
  // 用户名越过 Agent/Host/UI 协议边界。未知异常只能收敛到公开稳定码，不能透传文本。
  return "workspace_hooks_config_unreadable";
}

function didGrantExactDeclaration(
  status: WorkspaceHookTrustCliStatus,
  hookDeclarationDigest: string,
): boolean {
  return status.items.some(
    (item) =>
      item.hookDeclarationDigest === hookDeclarationDigest &&
      item.trustState === "trusted_persistent",
  );
}
