/**
 * AgentTeams 成员行的投影叶子：TeamPanelState.members[] 的受检收窄。
 *
 * 从 teamPanelModel.ts 外迁的理由：该文件逼近 400 行 ratchet，且
 * team-acceptance-visualization spec R10 要求「新增投影必须外迁叶子」。语义与主模块
 * 的收窄口径一致：字段白名单（未知字段忽略）、坏条只丢该条不丢整卡、additive 字段
 * （currentTaskId / childSessionId / roleRef）缺席即无键，不参与形状判定。
 */

/** AgentTeams 团队卡/面板的成员行。字段即插件 TeamPanelState.members 的投影。 */
export interface ConversationStatusPanelTeamMember {
  name: string;
  role: string;
  status: string;
  currentTaskId?: string;
  /** 已绑定成员的子会话 id（插件 0.3 additive）；缺席 = 不可打开成员会话。 */
  childSessionId?: string;
  /**
   * 角色包引用（插件 0.6 additive；agent-teams-role-packs spec R1/R5）。不透明
   * AgentProfile 标识，UI 逐字显示不做映射（R5.1）；缺席 = 不渲染角色徽标。
   */
  roleRef?: string;
}

/** members[] 白名单收窄：非数组 → 空列表；单条形状坏（无 name）→ 丢该条。 */
export function projectTeamMembers(rawMembers: unknown): ConversationStatusPanelTeamMember[] {
  if (!Array.isArray(rawMembers)) return [];
  return rawMembers.flatMap((raw): ConversationStatusPanelTeamMember[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const member = raw as Record<string, unknown>;
    if (typeof member.name !== "string" || !member.name) return [];
    return [
      {
        name: member.name,
        role: typeof member.role === "string" ? member.role : "",
        status: typeof member.status === "string" ? member.status : "registered",
        ...(typeof member.currentTaskId === "string" ? { currentTaskId: member.currentTaskId } : {}),
        ...(typeof member.childSessionId === "string" && member.childSessionId
          ? { childSessionId: member.childSessionId }
          : {}),
        // roleRef 空串按缺席处理（R5.1）：徽标不渲染，也不留空键。
        ...(typeof member.roleRef === "string" && member.roleRef ? { roleRef: member.roleRef } : {}),
      },
    ];
  });
}
