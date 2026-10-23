// ============================================================
// Host storage 准备的 CLI bundle 入口解析（R6，叶子模块）
// spec: packages/desktop/specs/host-startup-storage-cwd.md R6
//
// 为什么独立于会话 agent 命令解析：
// prepareSessionStorage 起的 Worker 跑的是 **ACode CLI bundle 的 SQLite 迁移**
// （argv 恒为 `app-server --stdio --prepare-storage`，见 desktop/src/host/
// storagePreparationProcesses.ts:131），与用户在设置里选了哪个 agent 引擎**无关**。
// 此前它复用 resolveDefaultACodeAgentCommand 的返回值取 storagePreparationEntry，
// 于是 env 覆盖（ACODE_AGENT_SERVER_COMMAND）一生效，返回的外部 agent 命令不带
// storage 字段 → host 存储启动以 unsupported_runtime 失败（2026-10-23 受控对照实证：
// 同一 bundle 下无覆盖计数 0、有覆盖计数 1）。
//
// **安全理由比可用性更硬**：storage worker 在 Host 进程内持有会话库 SQLite 连接。
// 若 env 覆盖能决定它的入口，launchctl setenv / shell profile / Windows 用户环境变量
// 注入 ACODE_AGENT_SERVER_COMMAND=/tmp/evil 就能让攻击者代码跑在该 worker 里——
// 与 agent-command-env-gate.md R1 同一威胁模型。故本模块**刻意不读** ACODE_AGENT_SERVER_*
// 族 env，只从可信候选链解析。
//
// 与 R1 的 --cwd 校验正交：R6 管「跑哪个 bundle」，R1–R4 管「以哪个 cwd 跑」。
// ============================================================

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";

import { getEngineRuntime } from "@acode/shared";

import { findUpwardRepoFile } from "./repoUpwardLookup.js";

/**
 * 打包态可信资源根：Electron 的 process.resourcesPath（只读签名区）。
 * 与 providerRuntimeResolver 同源同判定，避免两处对「什么是打包态资源根」产生分歧。
 */
const packagedResourcesPath =
  typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === "string"
    ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    : null;

/** monorepo dev 态的 CLI bundle 相对路径（与 command resolver 的 bundled 分支同源）。 */
const MONOREPO_CLI_BUNDLE_RELATIVE = "apps/acode-cli/packages/cli/dist/acode.cjs";

/** storage worker 的启动目录缺省值：会话命令未给 cwd 时的兜底。 */
export interface ACodeStoragePreparationEntry {
  /** ACode CLI bundle 绝对路径（Worker 的入口，恒为 JS bundle 不用字节码）。 */
  entry: string;
  /** Worker 的 --cwd（沿用 command resolver 既有的 workspacePath 语义）。 */
  cwd: string;
  /**
   * Worker 的补充 env。桌面态 Host 跑在 Electron utility process 里，必须显式开
   * ELECTRON_RUN_AS_NODE，否则 worker 被当成 Chromium 子进程卡在 GPU 初始化
   * （沿用 resolveBundledWorkspaceACodeAgentCommand / resolveElectronRuntimeACodeAgentCommand
   * 的既有语义，解耦不改行为）。
   */
  env: Record<string, string>;
  /** 命中了哪条候选链，供诊断与测试断言（不读 env 的证据）。 */
  source: "packaged-resources" | "deployed-agents" | "monorepo-dist";
}

/**
 * 解析 host storage 准备要跑的 ACode CLI bundle 入口。
 *
 * 候选链顺序（打包态优先，与 providerRuntimeResolver.findACodeAgentRuntimeNodeBundle
 * 的可信度排序一致）：
 *   1. 打包态 `<resourcesPath>/glm/acode.cjs`（只读签名区，最可信）
 *   2. 已部署 `~/.acode/server/agents/glm/acode.cjs`（远端 SSH 部署形态）
 *   3. monorepo dev `apps/acode-cli/packages/cli/dist/acode.cjs`（向上查找）
 *
 * **不读任何 env**：既不接受 env 入参，也不读 process.env 的 ACODE_AGENT_SERVER_* 族。
 * 引擎入参只用于取 bundle 目录名（当前恒为 native glm，见 acode-agent-runtime.ts），
 * 不用于选外部引擎二进制——storage 迁移永远由 ACode CLI 自己跑。
 *
 * @returns 命中候选返回入口描述；全部落空返回 null（调用方保持 fail-loud，
 *          照旧报 unsupported_runtime，不静默跳过存储准备）。
 */
export function resolveACodeStoragePreparationEntry(context: {
  workspacePath: string;
  engineId?: string | null;
}): ACodeStoragePreparationEntry | null {
  const runtime = getEngineRuntime(context.engineId);
  // resolveNodeBundleSegments() 返回 [nodeBundleEntryFile]（当前 = ["acode.cjs"]）。
  const entrySegments = runtime.resolveNodeBundleSegments();
  const resourceSegments = [runtime.bundledResourceDir, ...entrySegments];

  const packaged = packagedResourcesPath
    ? resolvePath(packagedResourcesPath, ...resourceSegments)
    : null;
  const deployed = resolvePath(homedir(), ".acode", "server", "agents", ...resourceSegments);
  const monorepo = findUpwardRepoFile(MONOREPO_CLI_BUNDLE_RELATIVE);

  // 桌面 Host 跑在 Electron utility process 里：worker 必须以纯 Node 模式启动，
  // 否则被当成 Chromium 子进程卡在 GPU 初始化。与两个 command resolver 的既有 env 一致。
  const workerEnv: Record<string, string> = process.versions.electron
    ? { ELECTRON_RUN_AS_NODE: "1" }
    : {};

  if (packaged && existsSync(packaged)) {
    return {
      entry: packaged,
      cwd: context.workspacePath,
      env: workerEnv,
      source: "packaged-resources",
    };
  }
  if (existsSync(deployed)) {
    return {
      entry: deployed,
      cwd: context.workspacePath,
      env: workerEnv,
      source: "deployed-agents",
    };
  }
  if (monorepo) {
    return {
      entry: monorepo,
      cwd: context.workspacePath,
      env: workerEnv,
      source: "monorepo-dist",
    };
  }
  return null;
}

/**
 * 诊断辅助：说明为何没解析到入口（bundle 未构建是最常见原因）。
 * 刻意不含任何 env 值——本模块的不变量就是不吃 env，诊断信息也不应暗示它会。
 */
export function describeStorageEntryResolutionFailure(): string {
  const checked = [
    packagedResourcesPath
      ? `<resourcesPath>/${packagedResourcesPath}`
      : "<resourcesPath> (非打包态，跳过)",
    join(homedir(), ".acode", "server", "agents"),
    `${MONOREPO_CLI_BUNDLE_RELATIVE}（从 ${process.cwd()} 向上查找）`,
  ];
  return (
    `ACode CLI bundle not found for storage preparation. Checked: ${checked.join("; ")}. ` +
    `In a monorepo checkout run \`pnpm --filter @acode/desktop prepare:agent-bundle\` ` +
    `to build ${dirname(MONOREPO_CLI_BUNDLE_RELATIVE)}/acode.cjs.`
  );
}
