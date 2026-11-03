// 统一类型门禁（U01）：把根工程引用、Desktop renderer 与 CLI workspace 三个类型入口
// 收敛成单一实现，本地 `pnpm typecheck`、CI 与 release 的每个 job 都只调用它。
//
// 原因：根 package.json 的 typecheck 曾经只是 `tsc -b packages/...`，renderer 与 CLI
// 自身入口靠 ci.yml / release.yml verify 里两条独立步骤补。于是「本地 pnpm typecheck 绿、
// renderer 或 CLI 红」对开发者不可见，而 release.yml 的 build 与 desktop 两个 job 只跑根
// 命令，形成跳过 renderer/CLI 的旁路。规则与验收见
// docs/specs/cli-validation-gates.md 第 3-6 条。
//
// 并发边界：`packages` 阶段用 tsc -b 写出 packages/* 的 .d.ts，renderer 通过 project
// references 读这些声明；两者并发会读到写了一半的声明并产生假失败。所以 packages 是
// barrier，它完成后 desktop-renderer 与 cli 才并行。cli 阶段内部的兄弟包声明顺序由
// turbo 的 `dependsOn: ["^build"]` 负责，本脚本不另建一份顺序事实。
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GateUsageError, runStagedGate } from "./gate-runner.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 逐项照搬迁移前 package.json typecheck 的工程清单：本次只改调用方式，不改检查集合。
const ROOT_PROJECTS = [
  "packages/rpc",
  "packages/provider",
  "packages/provider-node",
  "packages/shared",
  "packages/harness-sdk",
  "packages/services",
  "packages/client",
  "packages/server",
  "packages/acode-server-cli",
  "packages/ui",
  "packages/web",
  "packages/desktop/tsconfig.host.json",
  "packages/desktop/tsconfig.main.json",
  "packages/desktop/tsconfig.preload.json",
  "packages/desktop/tsconfig.scheduler.json",
];

// 相对路径按 cwd=repoRoot 解析；用 node 直接跑 JS 入口，避开 Windows 上 .cmd shim
// 必须 shell 的问题（apps/acode-cli/node_modules/.bin 缺 turbo shim 是既有环境问题）。
const TSC_ENTRY = "node_modules/typescript/bin/tsc";
const TURBO_ENTRY = "node_modules/turbo/bin/turbo";

export const TYPECHECK_STAGES = [
  {
    id: "packages",
    label: "根 workspace 工程引用（tsc -b，产出下游消费的 .d.ts）",
    command: "node",
    args: [TSC_ENTRY, "-b", ...ROOT_PROJECTS],
    dependsOn: [],
  },
  {
    id: "desktop-renderer",
    label: "Desktop renderer（tsconfig.renderer.json，--noEmit）",
    command: "node",
    args: [TSC_ENTRY, "-p", "packages/desktop/tsconfig.renderer.json", "--noEmit"],
    dependsOn: ["packages"],
  },
  {
    id: "cli",
    label: "CLI workspace 全部包（turbo run typecheck，含 @acode/cli 自身入口）",
    command: "node",
    args: [TURBO_ENTRY, "--cwd", "apps/acode-cli", "run", "typecheck"],
    dependsOn: ["packages"],
  },
];

// 保留独立子类：调用方（含本文件 main 的退出码 2 分支）按此类型识别用法错误，
// 提取公共执行器后语义由 GateUsageError 承载，对外契约不变。
export class TypecheckGateUsageError extends GateUsageError {}

/**
 * 按 dependsOn 分波执行阶段；同一波内并行。任一阶段失败后不再启动新阶段，
 * 已在跑的跑完再汇总——失败必须可见，不静默降级。
 * 返回进程退出码：0 全通过，1 有阶段失败，2 用法/清单错误。
 *
 * 执行器本体在 scripts/gate-runner.mjs（与本地验证门禁 verify-local.mjs 共用同一套
 * 输出纪律）；本函数只固定类型门禁的标题、复现命令入口与用法错误类型，
 * 输出文案与提取前逐字一致，受 apps/acode-cli/tests/typecheck-gate.test.mjs 保护。
 */
export async function runTypecheckGate({
  stages = TYPECHECK_STAGES,
  only,
  sequential = false,
  emit = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  return runStagedGate({
    stages,
    only,
    sequential,
    emit,
    repoRoot,
    title: "类型门禁",
    reproScript: "node scripts/typecheck-gate.mjs",
    UsageError: TypecheckGateUsageError,
  });
}

async function loadStagesFile(path) {
  const raw = await readFile(isAbsolute(path) ? path : resolve(repoRoot, path), "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypecheckGateUsageError(`--stages-file 不是合法 JSON：${error.message}`);
  }
  const stages = Array.isArray(parsed) ? parsed : parsed.stages;
  if (!Array.isArray(stages))
    throw new TypecheckGateUsageError("--stages-file 必须是阶段数组或 { stages: [...] }");
  return stages;
}

function parseArgs(argv) {
  const options = { only: [], sequential: false, list: false, help: false, stagesFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--only") {
      const value = argv[++i];
      if (!value) throw new TypecheckGateUsageError("--only 需要阶段 id");
      options.only.push(value);
    } else if (arg === "--stages-file") {
      const value = argv[++i];
      if (!value) throw new TypecheckGateUsageError("--stages-file 需要路径");
      options.stagesFile = value;
    } else if (arg === "--sequential") {
      options.sequential = true;
    } else if (arg === "--list") {
      options.list = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new TypecheckGateUsageError(`未知参数：${arg}`);
    }
  }
  return options;
}

const USAGE = `用法：node scripts/typecheck-gate.mjs [--only <stage>]... [--stages-file <path>] [--sequential] [--list]

阶段：${TYPECHECK_STAGES.map((stage) => stage.id).join(", ")}（packages 是 barrier，desktop-renderer 与 cli 在其后并行）
--only 与 --stages-file 只用于开发快循环和测试装配，CI/release 不得用来缩小门禁范围。`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const stages = options.stagesFile ? await loadStagesFile(options.stagesFile) : TYPECHECK_STAGES;
  if (options.list) {
    process.stdout.write(`${JSON.stringify(stages, null, 2)}\n`);
    return 0;
  }
  return runTypecheckGate({ stages, only: options.only, sequential: options.sequential });
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      if (error instanceof TypecheckGateUsageError) {
        process.stderr.write(`${error.message}\n${USAGE}\n`);
        process.exitCode = 2;
        return;
      }
      throw error;
    },
  );
}
