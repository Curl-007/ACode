// ============================================================
// PowerShell 风险关键词面与 capability（specs/powershell-tool.md R4）
// ============================================================
// bash 同款权限面的一期形态：复用 assessBashCommandTargetRisk 已覆盖的 PS 文本
// 形态（remove-item/del/rd/format、$env: 展开），叠加 PS 专属 confirm 关键词；
// 无 readonly 快径——未命中命令回落 entry 默认 high+needsApproval（fail-closed）。
// PS 完整语法风险文法过大，登记后置（spec 登记项）。

import { homedir } from "node:os";
import type { ToolRuntimePermissionCapability, ToolRuntimePermissionCapabilityContext } from "../types.js";
import { readStringProperty } from "./bash-metadata.js";
import {
  assessBashCommandTargetRisk,
  type TargetRiskContext,
} from "./bash-target-risk/index.js";

/** R4.2 一期 deny/ask 关键词面：命中升 confirm 档（critical capability）。 */
const POWERSHELL_CONFIRM_PATTERNS: readonly RegExp[] = [
  // -EncodedCommand（含前缀缩写）+ base64 载荷：目标不可静态确定。
  /(?:^|\s)-e[a-z]*\s+[A-Za-z0-9+/=]{24,}/i,
  // -File 脚本文件载荷（全名形态；`-FilePath` 因词边界不误中。缩写形态登记缺口）。
  /(?:^|\s)-File\b/i,
  /\b(?:Invoke-Expression|iex)\b/i,
  // 点源/调用操作符 + 动态（变量计算）目标：与 bash 面「未解析变量 → confirm」同旨。
  /(?:^|[;|&({]\s*)[.&]\s+\$/u,
  /\bInvoke-Item\b/i,
  /\b(?:Stop-Computer|Restart-Computer|Format-Volume|Clear-Disk|diskpart|Set-ExecutionPolicy)\b/i,
  // 注册表 PSDrive 的写/删动词（读动词走 entry 默认 high+ask，不在此升档）。
  /\b(?:Remove-Item|Remove-ItemProperty|Set-ItemProperty|New-ItemProperty|Clear-ItemProperty|Set-Item|New-Item|Remove-PSDrive)\b[^|;\n]*\b(?:HKLM|HKCU|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER):/i,
  // 引擎/调试钩子与 profile、PSReadLine 历史植入（还原工程对交互 shell 的同款封锁面）。
  /\b(?:Register-EngineEvent|Register-ObjectEvent|Set-PSBreakpoint|Update-TypeData|Update-FormatData|Set-PSDebug|Enable-RunspaceDebug)\b/i,
  /\$PROFILE\b|\bAdd-History\b|\bPSReadLine\b|ConsoleHost_history/i,
];

export function isPowerShellConfirmKeywordCommand(command: string): boolean {
  return POWERSHELL_CONFIRM_PATTERNS.some((pattern) => pattern.test(command));
}

function powerShellTargetRiskContext(
  context?: ToolRuntimePermissionCapabilityContext,
): TargetRiskContext {
  return {
    workingDirectory: context?.workingDirectory,
    workspaceRoot: context?.workspaceRoot,
    homeDirectory: homedir(),
    platform: process.platform,
    ...(context?.packageScripts ? { packageScripts: context.packageScripts } : {}),
    ...(context?.scannedDirectories ? { scannedDirectories: context.scannedDirectories } : {}),
  };
}

/**
 * capability 解析（R4）：confirm/catastrophic（目标维度或关键词面）→ critical +
 * needsApproval + destructive（autoApproveHighRisk 不能自动批准）。catastrophic 的
 * 「直接 deny」通道在 bypass-immune-breakers（其 toolName 门现只认 "Bash"，
 * PowerShell 的补位是接线需求，见 spec R8.2）；capability 没有 deny 通道，这里
 * 只能完成纵深防御的 critical 半边。一期无 readonly 快径 → 其余回落 entry 默认。
 */
export function resolvePowerShellPermissionCapability(
  input: unknown,
  context?: ToolRuntimePermissionCapabilityContext,
): ToolRuntimePermissionCapability | undefined {
  const command = readStringProperty(input, "command");
  if (!command) return undefined;
  const assessment = assessBashCommandTargetRisk(command, powerShellTargetRiskContext(context));
  const confirmed =
    assessment.level === "confirm" ||
    assessment.level === "catastrophic" ||
    isPowerShellConfirmKeywordCommand(command);
  if (!confirmed) return undefined;
  return {
    destructive: true,
    needsApproval: true,
    readOnly: false,
    riskLevel: "critical",
    sideEffectScope: "system",
    permission: {
      needsApproval: true,
      riskLevel: "critical",
      sideEffectScope: "system",
    },
  };
}
