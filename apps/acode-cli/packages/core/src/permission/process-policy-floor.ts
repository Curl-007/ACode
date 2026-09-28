// 托管策略地板的进程级注册点（安全加固 P2 补丁项）。
//
// 为什么需要进程级注册而不是构造参数：Explore 子代理（subagent.ts）与 memory agent
// （project-memory-agent.ts）各自构造 `new PermissionService(defaultPermissionConfig)`，
// 构造参数纪律无法覆盖这些站点——策略地板会对它们的权限决策整体失效（含
// disableBypassPermissionsMode 管不住 Explore 的 yolo）。把地板注册为进程级事实后，
// 任何 PermissionService 实例缺省自动携带，「地板对所有权限决策生效」从构造器纪律
// 变成结构性不变量。
//
// 单例前提与 setOfficialServiceSwitches / CUA broker capture 相同：一个进程一个
// createACodeApp 一份配置。测试用 resetProcessManagedPolicyFloorForTest 隔离。
//
// 规格见 apps/acode-cli/specs/subagent-policy-floor-inheritance.md R1。
import type { ManagedPolicyFloorData } from "@acode/contracts";

let processManagedPolicyFloor: ManagedPolicyFloorData | undefined;

/** 由 create-app 在构造 PermissionService 的同一处调用；undefined = 本机未部署策略文件。 */
export function setProcessManagedPolicyFloor(floor: ManagedPolicyFloorData | undefined): void {
  processManagedPolicyFloor = floor;
}

export function getProcessManagedPolicyFloor(): ManagedPolicyFloorData | undefined {
  return processManagedPolicyFloor;
}

/** 仅供测试重置进程内注册状态。 */
export function resetProcessManagedPolicyFloorForTest(): void {
  processManagedPolicyFloor = undefined;
}
