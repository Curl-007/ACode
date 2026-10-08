// `acode mcp trust` —— 项目作用域 stdio MCP server 的信任管理（specs/project-mcp-trust-gate.md R9）。
// 形态与 hooks-trust-command.ts 对称：status/review 展示 digest 与信任态，grant 按
// 当前配置内容钉 digest，revoke 撤销；底层实现全部在 @acode/bootstrap（可注入以便测试）。
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import type {
  ProjectMcpTrustCliStatus,
  ProjectMcpTrustCliTarget,
  grantProjectMcpTrust,
  inspectProjectMcpTrust,
  revokeProjectMcpTrustCli,
} from "@acode/bootstrap";
import type { RunContext } from "@acode/shared-types";
import type { RunDependencies } from "./cli-types.js";

const USAGE = `Usage:
  acode mcp trust status [--workspace <path-or-identity>] [--json]
  acode mcp trust review [--workspace <path-or-identity>] [--json]
  acode mcp trust grant [--workspace <path-or-identity>] (--server <name> ... | --all)
  acode mcp trust revoke [--workspace <path-or-identity>] (--server <name> ... | --all)
`;

type Inspect = typeof inspectProjectMcpTrust;
type Grant = typeof grantProjectMcpTrust;
type Revoke = typeof revokeProjectMcpTrustCli;

type McpTrustCommandDependencies = RunDependencies & {
  loadBootstrapModule?: () => Promise<typeof import("@acode/bootstrap")>;
  inspectProjectMcpTrust?: Inspect;
  grantProjectMcpTrust?: Grant;
  revokeProjectMcpTrustCli?: Revoke;
};

export async function runMcpCommand(
  ctx: RunContext,
  deps: McpTrustCommandDependencies,
  version: string,
): Promise<number> {
  if (ctx.argv[1] !== "trust") {
    return fail(ctx, `Unknown mcp command: ${ctx.argv[1] ?? ""}`);
  }
  let parsed: ReturnType<typeof parseTrustArgs>;
  try {
    parsed = parseTrustArgs(ctx.argv.slice(2));
  } catch (error) {
    return fail(ctx, error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help) {
    ctx.stdout.write(USAGE);
    return 0;
  }
  const action = parsed.positionals[0] ?? "status";
  if (!isAction(action) || parsed.positionals.length > 1) {
    return fail(ctx, `Unknown mcp trust command: ${action}`);
  }
  const target = resolveTarget(
    parsed.values.workspace as string | undefined,
    (deps.cwd ?? process.cwd)(),
    deps.userConfigPath,
  );
  const bootstrap = deps.loadBootstrapModule ?? (() => import("@acode/bootstrap"));
  try {
    let status: ProjectMcpTrustCliStatus;
    if (action === "status" || action === "review") {
      const inspect = deps.inspectProjectMcpTrust ?? (await bootstrap()).inspectProjectMcpTrust;
      status = await inspect(target);
    } else if (action === "grant") {
      const grant = deps.grantProjectMcpTrust ?? (await bootstrap()).grantProjectMcpTrust;
      status = await grant({
        ...target,
        serverNames: parsed.values.server as string[] | undefined,
        all: parsed.values.all === true,
        appVersion: version,
      });
    } else {
      const revoke = deps.revokeProjectMcpTrustCli ?? (await bootstrap()).revokeProjectMcpTrustCli;
      status = await revoke({
        ...target,
        serverNames: parsed.values.server as string[] | undefined,
        all: parsed.values.all === true,
      });
    }
    ctx.stdout.write(
      parsed.values.json ? `${JSON.stringify(status, null, 2)}\n` : formatHuman(status, action),
    );
    return 0;
  } catch (error) {
    const reasonCode = error instanceof Error ? error.message : String(error);
    if (parsed.values.json) {
      ctx.stdout.write(`${JSON.stringify({ accepted: false, reasonCode }, null, 2)}\n`);
    } else {
      ctx.stderr.write(`Error: ${reasonCode}\n`);
    }
    return 1;
  }
}

function parseTrustArgs(args: string[]) {
  return parseArgs({
    allowPositionals: true,
    args,
    options: {
      workspace: { type: "string" },
      server: { type: "string", multiple: true },
      all: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function resolveTarget(
  value: string | undefined,
  cwd: string,
  userConfigPath: string | undefined,
): ProjectMcpTrustCliTarget {
  const selected = value?.trim();
  const identity = selected && looksLikeWorkspaceIdentity(selected) ? selected : undefined;
  return {
    workspacePath: identity ? resolve(cwd) : selected ? resolve(cwd, selected) : resolve(cwd),
    ...(identity ? { workspaceIdentity: identity } : {}),
    ...(userConfigPath ? { userConfigPath } : {}),
  };
}

function looksLikeWorkspaceIdentity(value: string): boolean {
  return /^(?:local|remote|ssh|container|wsl):/u.test(value);
}

function formatHuman(status: ProjectMcpTrustCliStatus, action: string): string {
  const lines = [
    `Project MCP Trust (${action})`,
    `workspace: ${status.workspaceIdentity}`,
    `path: ${status.workspacePath}`,
    `state: ${status.reasonCode}`,
  ];
  if (status.items.length === 0) {
    lines.push("No project-scoped stdio MCP servers found.");
  }
  for (const [index, item] of status.items.entries()) {
    lines.push(
      `${index + 1}. [${item.trustState}] ${item.serverName}`,
      `   ${item.displayCommand}`,
      `   digest: ${item.digest}`,
    );
  }
  if (status.reasonCode === "project_mcp_pending_trust") {
    lines.push(
      "Trust the exact current content of selected servers with:",
      `  acode mcp trust grant --workspace ${quote(status.workspaceIdentity)} --server <name>`,
      "Or trust every currently declared project stdio server with:",
      `  acode mcp trust grant --workspace ${quote(status.workspaceIdentity)} --all`,
    );
  }
  if (status.reasonCode === "project_mcp_trust_store_corrupt") {
    // 损坏 store 下 grant/revoke 都会被拒绝；恢复指引必须是修复文件本身（与 hooks 同款）。
    lines.push(
      "The persistent trust store is corrupt; grant/revoke are rejected until it is fixed.",
      "The corrupted file was moved aside as workspace-mcp-trust-v1.json.corrupt-<timestamp>.",
      "Recovery: restore it from backup, or remove the leftover *.corrupt-* file so a fresh store is created, then re-run grant.",
    );
  }
  return `${lines.join("\n")}\n`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function isAction(value: string): value is "status" | "review" | "grant" | "revoke" {
  return value === "status" || value === "review" || value === "grant" || value === "revoke";
}

function fail(ctx: RunContext, message: string): number {
  ctx.stderr.write(`${message}\n${USAGE}`);
  return 1;
}
