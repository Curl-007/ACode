import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { CAPTAIN_ADDRESS, TEAM_ID_PATTERN, TeamError } from "../state/helpers.js";

const sendSchema = z
  .object({
    teamId: z.string().regex(TEAM_ID_PATTERN).optional(),
    to: z.string().min(1).max(64),
    message: z
      .string()
      .min(1)
      .max(16 * 1024),
    summary: z.string().max(120).optional(),
  })
  .strict();

export const messageTools: readonly ToolDefinition[] = [
  {
    name: "agent_teams_send_message",
    description:
      "Send a direct message to any member or the captain. The from address is derived from your identity and cannot be spoofed. Messages are durable in the recipient's mailbox; a running recipient is woken by the captain per next_actions, a busy one reads them via agent_teams_status.",
    schema: sendSchema,
    memberAllowed: true,
    async handler(input, context): Promise<ToolResult> {
      const parsed = sendSchema.parse(input);
      const team = context.resolveTeamContext(parsed.teamId);
      const memberName = context.requireMember(team, { allowCaptain: true });
      const from = memberName === "captain" ? CAPTAIN_ADDRESS : memberName;
      if (team.status === "archived") {
        throw new TeamError(
          "team_archived",
          "Team has ended. Stop now: do not retry, do not continue the task, end your turn.",
        );
      }
      if (parsed.to !== CAPTAIN_ADDRESS) {
        const recipient = team.members.find((item) => item.name === parsed.to);
        if (!recipient || recipient.status === "removed") {
          throw new TeamError("member_not_found", `Recipient ${parsed.to} is not in the roster.`);
        }
      }
      const delivered = context.store.deliverMessage(team.teamId, parsed.to, {
        from,
        to: parsed.to,
        ...(parsed.summary ? { summary: parsed.summary } : {}),
        message: parsed.message,
      });
      const notes: string[] = [
        `Delivered to ${parsed.to}'s mailbox (id ${delivered.id}). A member waiting in agent_teams_wait_for_work picks it up right away; otherwise they read it on their next wake or via agent_teams_status.`,
      ];
      const wake: Array<{ to: string; member: string; message: string; taskId?: string }> = [];
      const next_actions = { wake, notes, report_to_captain: false };
      return {
        ok: true,
        teamId: team.teamId,
        message_id: delivered.id,
        to: parsed.to,
        from,
        next_actions,
        ...context.identityWarning(),
      };
    },
  },
];
