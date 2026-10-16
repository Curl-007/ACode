// ============================================================
// Skill Live Build Snapshot 采集（specs/guide-live-build-section.md R2/R3）
// ============================================================
// Current Build 快照的事实采集面。来源分层：工具/技能清单来自 handler 上下文的
// runtime truth；自定义命令、agents、MCP 名单、设置键是对 adapters 发现逻辑的
// **磁盘只读近似**（core 不依赖 adapters 包，依赖方向纪律），节内明示 best-effort。
// 全保真来源：version/内置命令表/MCP 连接态已经宿主端口接线（tool/types.ts 的
// LiveBuildSnapshotPort，接线登记 ①②③），缺席时对应子节回落磁盘 best-effort 或
// 标注降级；plugin/bundled agents 清单（登记 ④）仍待 bootstrap 投影。
//
// 纪律：
// - R3 子节互不连坐：任一子节失败仅降级自身（available:false + 原因）；
// - R3 秘密纪律：设置只列**键名**、MCP 只列**名字/scope/transport 类别**，
//   配置文件的任何值（可能含 token/env/命令行秘密）一律不进快照。

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import type { SkillPort } from "@acode/contracts";
import type { LiveBuildMcpConnectionState } from "../types.js";

/** 子节判别联合：available=false 时必须带原因（R3 降级可见性）。 */
export type Subsection<T> = { available: true; value: T } | { available: false; reason: string };

export interface LiveBuildSnapshot {
  generatedAt: string;
  version: Subsection<string>;
  tools: Subsection<readonly string[]>;
  skills: Subsection<string[]>;
  customCommands: Subsection<string[]>;
  /** 宿主接线②：内置 slash 命令表（runtime truth）；available:false = 未接线（渲染降级注记）。 */
  builtInCommands: Subsection<readonly string[]>;
  agents: Subsection<string[]>;
  mcpServers: Subsection<string[]>;
  settingsKeys: Subsection<string[]>;
  /** 宿主接线④：true = agents 子节已含 bundled/plugin 投影，「not visible」注记收起。 */
  agentsIncludeHostProjection: boolean;
  /** 宿主接线③：true = MCP 子节携带 runtime 连接态，标题换连接态措辞。 */
  mcpConnectionStatesVisible: boolean;
}

export interface LiveBuildInjectionInput {
  /** 会话身份：缓存键。缺席时用匿名键（单会话进程仍满足「会话内一次性生成」）。 */
  sessionId?: string;
  workingDirectory: string;
  workspaceRoot: string;
  /** 模型当前可见的工具名（runtime truth，来自 ToolExecutionContext）。 */
  toolNames?: readonly string[];
  /** 技能发现端口（runtime truth）；缺席则技能子节降级。 */
  skillPort?: Pick<SkillPort, "discoverSkills">;
  /** 宿主接线的 CLI 版本；缺席则版本子节降级、缓存失效退化为会话级（接线登记 1）。 */
  version?: string;
  /** 宿主接线②（runtime truth）：内置 slash 命令表只读投影；缺席 = 磁盘 best-effort 面。 */
  builtInCommandNames?: readonly string[];
  /** 宿主接线④：plugin/bundled agents 名单投影（"名 (来源类别)" 行，只列名不泄配置）。 */
  hostAgentNames?: readonly string[];
  /** 宿主接线③（runtime truth）：MCP 连接态 name→state；缺席 = 磁盘「已配置」面。 */
  mcpConnectionStates?: readonly LiveBuildMcpConnectionState[];
  /** 测试可注入；缺省 os.homedir()。 */
  homeDirectory?: string;
  signal?: AbortSignal;
  /** 测试可注入时钟；缺省 new Date()。 */
  now?: () => Date;
}

/** 单个子节最多渲染的条目数：超大安装面不许把技能上下文撑爆。 */
const MAX_LIST_ITEMS = 200;

/** 自定义命令目录递归深度上限：命令嵌套目录以冒号连接，防御性封顶。 */
const MAX_COMMAND_DIR_DEPTH = 4;

export async function collectLiveBuildSnapshot(
  input: LiveBuildInjectionInput,
): Promise<LiveBuildSnapshot> {
  const home = input.homeDirectory ?? homedir();
  const now = input.now?.() ?? new Date();
  return {
    generatedAt: now.toISOString(),
    version: input.version
      ? { available: true, value: input.version }
      : {
          available: false,
          reason: "host has not wired a version source into the Skill tool context",
        },
    tools:
      input.toolNames && input.toolNames.length > 0
        ? { available: true, value: input.toolNames }
        : { available: false, reason: "tool list is not visible in this context" },
    skills: await safe("skill discovery failed", async () => {
      if (!input.skillPort) throw new Error("no SkillPort in this context");
      const outcome = await input.skillPort.discoverSkills(
        { workingDirectory: input.workingDirectory },
        input.signal ? { signal: input.signal } : undefined,
      );
      return capList(
        outcome.skills.map(
          (skill) =>
            `- ${skill.qualifiedName ?? skill.name} (scope: ${skill.scope}, source: ${skill.source})`,
        ),
      );
    }),
    customCommands: await safe("command root scan failed", () =>
      collectCustomCommands(home, input.workingDirectory, input.workspaceRoot),
    ),
    // 宿主接线②：内置命令表是纯投影（无采集动作），在场即 available。
    builtInCommands:
      input.builtInCommandNames && input.builtInCommandNames.length > 0
        ? { available: true, value: input.builtInCommandNames }
        : {
            available: false,
            reason: "host has not wired the command-center registry into this snapshot",
          },
    agents: await safe("agents directory scan failed", () =>
      collectAgents(home, input.workingDirectory, input.workspaceRoot, input.hostAgentNames),
    ),
    mcpServers: await safe("config parse failed", () =>
      collectMcpServers(
        home,
        input.workingDirectory,
        input.workspaceRoot,
        input.mcpConnectionStates,
      ),
    ),
    settingsKeys: await safe("config parse failed", () =>
      collectSettingsKeys(home, input.workingDirectory, input.workspaceRoot),
    ),
    // 渲染面的注记开关（宿主事实在场即收起对应降级注记，接线登记 ③④）。
    agentsIncludeHostProjection: (input.hostAgentNames?.length ?? 0) > 0,
    mcpConnectionStatesVisible: (input.mcpConnectionStates?.length ?? 0) > 0,
  };
}

async function safe<T>(reason: string, fn: () => Promise<T> | T): Promise<Subsection<T>> {
  try {
    return { available: true, value: await fn() };
  } catch (error) {
    return { available: false, reason: `${reason} (${errorMessage(error)})` };
  }
}

/** 配置文件候选：user 层 + 项目层（.acode 强优先，.agents/mcp.json 是最低优先级 fallback）。 */
function configFiles(
  home: string,
  workingDirectory: string,
  workspaceRoot: string,
): { path: string; scope: string }[] {
  const files = [
    { path: join(home, ".acode", "cli", "config.json"), scope: "user" },
    { path: join(workspaceRoot, ".acode", "config.json"), scope: "workspace" },
    { path: join(workspaceRoot, "acode.json"), scope: "workspace" },
    { path: join(workspaceRoot, ".agents", "mcp.json"), scope: "workspace (.agents fallback)" },
  ];
  // cwd 与仓库根不同（子目录会话）时补扫 cwd 侧项目配置，与发现面「逐级向上」近似。
  if (workingDirectory !== workspaceRoot) {
    files.push(
      { path: join(workingDirectory, ".acode", "config.json"), scope: "workspace (cwd)" },
      { path: join(workingDirectory, "acode.json"), scope: "workspace (cwd)" },
      {
        path: join(workingDirectory, ".agents", "mcp.json"),
        scope: "workspace (cwd, .agents fallback)",
      },
    );
  }
  return files;
}

async function collectCustomCommands(
  home: string,
  workingDirectory: string,
  workspaceRoot: string,
): Promise<string[]> {
  const lines: string[] = [];
  const roots = uniquePaths([
    join(home, ".acode", "commands"),
    join(home, ".agents", "commands"),
    join(workspaceRoot, ".acode", "commands"),
    join(workspaceRoot, ".agents", "commands"),
    ...(workingDirectory !== workspaceRoot
      ? [
          join(workingDirectory, ".acode", "commands"),
          join(workingDirectory, ".agents", "commands"),
        ]
      : []),
  ]);
  for (const root of roots) {
    const scope = root.startsWith(home) ? "user" : "workspace";
    for (const rel of await listMarkdownRelative(root, MAX_COMMAND_DIR_DEPTH)) {
      // 嵌套目录以冒号连接：review/code.md → /review:code（与命令发现面约定一致）。
      const name = rel.replace(/\.md$/u, "").split(sep).join(":");
      lines.push(`- /${name} (${scope})`);
    }
  }
  return capList(lines);
}

async function collectAgents(
  home: string,
  workingDirectory: string,
  workspaceRoot: string,
  hostAgentNames?: readonly string[],
): Promise<string[]> {
  // 目录约定与 bootstrap/subagents.ts 一致：<storageRoot 默认 ~/.acode/cli>/agents +
  // <ws>/.acode/agents。plugin/bundled agents 注册面在 bootstrap——宿主接线④已落：
  // hostAgentNames 投影（"名 (来源类别)" 行）排在磁盘面之后，只列名不泄配置。
  const roots = uniquePaths([
    join(home, ".acode", "cli", "agents"),
    join(workspaceRoot, ".acode", "agents"),
    ...(workingDirectory !== workspaceRoot ? [join(workingDirectory, ".acode", "agents")] : []),
  ]);
  const lines: string[] = [];
  for (const root of roots) {
    const scope = root.startsWith(home) ? "user" : "workspace";
    for (const entry of await readDirectorySafe(root)) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      lines.push(`- ${entry.name.replace(/\.md$/u, "")} (${scope})`);
    }
  }
  for (const hostEntry of hostAgentNames ?? []) {
    lines.push(`- ${hostEntry}`);
  }
  return capList(lines);
}

async function collectMcpServers(
  home: string,
  workingDirectory: string,
  workspaceRoot: string,
  connectionStates?: readonly LiveBuildMcpConnectionState[],
): Promise<string[]> {
  const lines: string[] = [];
  // 宿主接线③：runtime 连接态投影（name→state）把磁盘面的「已配置」升级为真实
  // 连接状态；投影缺席的服务器保持既有磁盘行形态（配置面 best-effort 语义不变）。
  const stateByName = new Map((connectionStates ?? []).map((item) => [item.name, item.state]));
  const diskNames = new Set<string>();
  // 「配置文件存在但没配 server」是合法事实（渲染 none discovered）；「一个配置文件都
  // 找不到」才是采集降级——两种语义必须区分，不能都渲染成空清单。
  let sawConfigFile = false;
  for (const file of configFiles(home, workingDirectory, workspaceRoot)) {
    const parsed = await readJsonSafe(file.path);
    if (!parsed) continue;
    sawConfigFile = true;
    // R3 秘密纪律：只取名字与 transport 类别，command/args/env/url 等值一律不渲染。
    const servers =
      readRecord(readRecord(parsed.value.mcp)?.servers) ?? readRecord(parsed.value.mcpServers);
    if (!servers) continue;
    for (const [name, raw] of Object.entries(servers)) {
      diskNames.add(name);
      const state = stateByName.get(name);
      lines.push(
        state === undefined
          ? `- ${name} (${file.scope}, ${transportOf(raw)})`
          : `- ${name} (${file.scope}, ${transportOf(raw)}, runtime: ${state})`,
      );
    }
  }
  // 仅存在于 runtime 投影的服务器（插件注入/磁盘面漂移）如实补充，不猜来源。
  for (const [name, state] of stateByName) {
    if (!diskNames.has(name)) lines.push(`- ${name} (runtime: ${state})`);
  }
  if (!sawConfigFile && stateByName.size === 0) {
    throw new Error("no configuration files found at the well-known user/workspace paths");
  }
  return capList(lines);
}

async function collectSettingsKeys(
  home: string,
  workingDirectory: string,
  workspaceRoot: string,
): Promise<string[]> {
  const lines: string[] = [];
  let sawConfigFile = false;
  for (const file of configFiles(home, workingDirectory, workspaceRoot)) {
    const parsed = await readJsonSafe(file.path);
    if (!parsed) continue;
    sawConfigFile = true;
    // R3 秘密纪律：只列顶层键名，值（可能含 token）绝不进快照。
    const keys = Object.keys(parsed.value).sort();
    if (keys.length === 0) continue;
    lines.push(`- ${parsed.display} → ${keys.join(", ")}`);
  }
  if (!sawConfigFile) {
    throw new Error("no configuration files found at the well-known user/workspace paths");
  }
  return capList(lines);
}

function transportOf(raw: unknown): string {
  const server = readRecord(raw);
  if (!server) return "unknown";
  const type = server.type;
  if (typeof type === "string" && type.length > 0) return type;
  if (typeof server.command === "string") return "stdio";
  if (typeof server.url === "string") return "http";
  return "unknown";
}

// -----------------------------------------------
// 磁盘只读工具（全部 best-effort；异常向上冒泡给 safe()）
// -----------------------------------------------

async function listMarkdownRelative(root: string, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readDirectorySafe(dir)) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(relative(root, full));
      } else if (entry.isDirectory() && depth < maxDepth && !entry.name.startsWith(".")) {
        await walk(full, depth + 1);
      }
    }
  };
  await walk(root, 0);
  return out.sort();
}

async function readDirectorySafe(
  dir: string,
): Promise<{ name: string; isFile: () => boolean; isDirectory: () => boolean }[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: () => entry.isFile(),
      isDirectory: () => entry.isDirectory(),
    }));
  } catch {
    return []; // 目录不存在/不可读是常态（用户没建 commands 目录），不算失败。
  }
}

async function readJsonSafe(
  path: string,
): Promise<{ value: Record<string, unknown>; display: string } | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const value = readRecord(JSON.parse(raw));
    return value ? { value, display: path } : undefined;
  } catch {
    return undefined; // 文件不存在或不是合法 JSON：跳过该来源，其余来源照常。
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

function capList(lines: string[]): string[] {
  if (lines.length <= MAX_LIST_ITEMS) return lines;
  return [
    ...lines.slice(0, MAX_LIST_ITEMS),
    `- … (${lines.length - MAX_LIST_ITEMS} more entries omitted)`,
  ];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
