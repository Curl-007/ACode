// ============================================================
// 双 shell 联动警告 detector（specs/powershell-tool.md R5）
// ============================================================

/**
 * Bash 与 PowerShell **同时**被 bare deny（disallowedTools 含名，或 deny 规则集中
 * 存在无 ruleContent 的同名规则）→「无任何 shell 工具可用」显式警告。单边 deny、
 * 带 ruleContent 的 scoped deny 都不触发。事实（配置/规则集）由接线方投影传入，
 * 本函数只读、不持有状态；启动诊断落点在 bootstrap 装配面（接线需求，spec R8）。
 * 返回结构化字面量（code 供 UI 本地化映射，message 为模型面英文兜底）。
 */
export function detectNoShellToolWarning(facts: {
  denyRules?: Iterable<{ ruleContent?: string; toolName: string }>;
  disallowedTools?: Iterable<string>;
}): { code: "no_shell_tools"; message: string } | undefined {
  const denied = new Set<string>();
  for (const name of facts.disallowedTools ?? []) denied.add(name);
  for (const rule of facts.denyRules ?? []) {
    if (!rule.ruleContent) denied.add(rule.toolName);
  }
  // 工具名字面量与 permission 规则域的 toolName 事实对齐（"Bash" = bashToolEntry，
  // "PowerShell" = POWER_SHELL_TOOL_NAME）；detector 读的是配置事实投影，按名字匹配。
  if (!denied.has("Bash") || !denied.has("PowerShell")) return undefined;
  return {
    code: "no_shell_tools",
    message:
      "No shell tool is available: both Bash and PowerShell are denied by the permission configuration. The agent cannot run any terminal commands until one of the denials is lifted.",
  };
}
