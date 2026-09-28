import { isPackagedACodeDesktopRuntime } from "@acode/shared";
import {
  loadManagedPolicyFile,
  type ManagedPolicyFileLoadResult,
} from "@acode/shared/node";

/**
 * Bot 任务权限「需本机确认」门槛判定（安全加固 P2 / P0-3 诚实边界的真正修法）。
 *
 * 规格见 packages/services/specs/bot-permission-local-approval.md R2.3。门槛 = 用户设置
 * ∨ 管理员策略地板 ∨ 策略文件损坏（fail-closed）。开启后 bot 聊天侧不再提供可交互批准
 * 卡片，只能在桌面本机批准——把「发起执行的人就是批准执行的人」这条 self-approval 旁路收掉。
 *
 * 纯判定与 IO 分离：`resolveBotPermissionLocalApprovalRequired` 无副作用、可单测；
 * `readBotPermissionLocalApprovalGate` 负责读设置与策略文件后调用它。
 */

/** 门槛纯判定（无 IO）。输入为已读取的设置开关与 managed policy 加载结果。 */
export function resolveBotPermissionLocalApprovalRequired(input: {
  settingsEnabled?: boolean | null;
  managed: Pick<ManagedPolicyFileLoadResult, "status" | "policy">;
}): boolean {
  // 用户显式开启 → 收紧。
  if (input.settingsEnabled === true) return true;
  // 策略文件损坏/不可读 → fail-closed：不阻断工作（桌面本机仍可批），只收回较弱的 bot 通道。
  // 与 CLI 侧 MINIMAL_LOCKDOWN 同一克制哲学（管理员部署过策略文件就不能静默当无策略）。
  if (input.managed.status === "invalid") return true;
  // 管理员策略地板强制开启 → 用户设置无法放宽（strictest-wins，∨ 语义天然满足）。
  return input.managed.policy?.requireLocalPermissionApproval === true;
}

export interface BotPermissionLocalApprovalGateDeps {
  /** 最小设置读取面（ISettingService.get 的子集）；缺失视为未开启。 */
  getSettings?(): Promise<{ botPermissionLocalApprovalEnabled?: boolean } | null | undefined>;
  /** 测试注入点；缺省读真实 OS 托管路径（打包态忽略 env 覆盖）。 */
  loadManaged?(): ManagedPolicyFileLoadResult;
  /** 打包态判定与 env 覆盖的来源；缺省 process.env。 */
  env?: Readonly<Record<string, string | undefined>>;
}

/** IO 包装：读用户设置 + 管理员策略地板，返回门槛是否开启。权限事件低频，每次即时判定不缓存。 */
export async function readBotPermissionLocalApprovalGate(
  deps: BotPermissionLocalApprovalGateDeps = {},
): Promise<boolean> {
  const settingsPromise = deps.getSettings?.();
  const settings = settingsPromise ? await settingsPromise.catch(() => null) : null;
  const env = deps.env ?? process.env;
  const managed =
    deps.loadManaged?.() ??
    loadManagedPolicyFile({ env, isPackaged: isPackagedACodeDesktopRuntime(env) });
  return resolveBotPermissionLocalApprovalRequired({
    settingsEnabled: settings?.botPermissionLocalApprovalEnabled,
    managed,
  });
}
