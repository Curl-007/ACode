// ============================================================
// PowerShell 工具注册（specs/powershell-tool.md R8① 接线；
// specs/auto-mode-risk-classifier.md R8 注记的装配层落点）
// ============================================================
// 注册门：win32 且可解析到 pwsh / Windows PowerShell 才进 builtInTools——
// fail-closed：解析不到就不注册，工具描述不向模型承诺一个跑不起来的工具
//（handler 侧另有同款 fail-closed 兜底，双层不冲突）。timeout 策略与 Bash
// 同源：分支工厂重铸 entry 时透传 options.bashTimeoutPolicy（与
// createBashToolEntry 在 resolveBuiltInToolEntryForBranch 的既有形状同款）。
//
// 裁决注记（harm/recoverability/persistence）在本装配模块装载期灌入注册表——
// 静态语料库已覆盖 17 个主工具（corpus 模块自装载），PowerShell 是后落地
// 工具，按 corpus 头注「装配层可随工具 entry 注册追加」的既定缝在此接入；
// 注记正文自撰英文（模型面，prompt-language-policy R3）。

import { registerToolAdjudicationAnnotation } from "../../permission/tool-adjudication-corpus.js";
import type { BashTimeoutPolicy } from "../bash-timeout-policy.js";
import type { ToolEntry } from "../types.js";
import { resolvePowerShellLaunch, type PowerShellLaunch } from "./powershell-launch.js";
import { createPowerShellToolEntry, POWER_SHELL_TOOL_NAME } from "./powershell.js";

// 注册门事实：非 win32 直接短路（不付文件系统扫描成本）；win32 走
// pwsh → System32 → PATH 的解析序（powershell-launch.ts，spec R2）。
const powerShellLaunch: PowerShellLaunch | undefined =
  process.platform === "win32" ? resolvePowerShellLaunch() : undefined;

/** builtInTools 的注册条目：门不放行时为空数组（展开处零副作用）。 */
export const powerShellToolEntries: readonly ToolEntry[] = powerShellLaunch
  ? [createPowerShellToolEntry({ launch: powerShellLaunch })]
  : [];

/**
 * 分支重铸（resolveBuiltInToolEntryForBranch 消费）：Bash 同源的 timeout 策略
 * 进描述与超时预算；launch 传解析期快照（未解析到时 entry 根本不在清单里，
 * null 分支只是类型完备性兜底）。
 */
export function resolvePowerShellEntryForBranch(
  entry: ToolEntry,
  bashTimeoutPolicy: BashTimeoutPolicy | undefined,
): ToolEntry | undefined {
  if (entry.metadata.name !== POWER_SHELL_TOOL_NAME) return undefined;
  return createPowerShellToolEntry({
    ...(bashTimeoutPolicy ? { bashTimeoutPolicy } : {}),
    launch: powerShellLaunch ?? null,
  });
}

// 裁决注记（auto 分类器 <tool-dossier> 块的输入面）。可恢复性挂 transcript
// 来源台账语义（与 Bash 条目同款条件表述）；注册表写覆盖安全（进程级单例）。
registerToolAdjudicationAnnotation("PowerShell", {
  harm: "Runs Windows-native shell commands through PowerShell with the user's credentials, files, registry and network. Command text is code: cmdlets, encoded payloads and pipeline content must be judged by what they execute, not by how innocuous they read.",
  recoverability: "conditional",
  recoverabilityNote:
    "Read-only cmdlets are recoverable; Remove-Item/overwrite/publish/push/install and registry or service changes can be irreversible - judge by the specific command and whether its targets appear in the transcript provenance.",
  persistence: "durable",
  persistenceNote:
    "Spawned processes keep running after the turn; file, registry and network changes cannot be taken back.",
});
