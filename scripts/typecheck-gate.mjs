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
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export class TypecheckGateUsageError extends Error {}

function resolveCommand(command) {
  if (command === "node") return process.execPath;
  return isAbsolute(command) ? command : resolve(repoRoot, command);
}

function describeCommand(stage) {
  return [stage.command === "node" ? "node" : stage.command, ...(stage.args ?? [])].join(" ");
}

// 并发输出会交错，按行加阶段前缀后才写出去，保证失败定位得到的是完整行。
function createLineWriter(prefix, emit) {
  let residual = "";
  return {
    write(chunk) {
      residual += chunk.toString("utf8");
      const lines = residual.split("\n");
      residual = lines.pop() ?? "";
      for (const line of lines) emit(`${prefix} ${line}`.trimEnd());
    },
    flush() {
      if (residual.length === 0) return;
      emit(`${prefix} ${residual}`.trimEnd());
      residual = "";
    },
  };
}

function runStage(stage, emit) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const writer = createLineWriter(`[${stage.id}]`, emit);
    let child;
    try {
      child = spawn(resolveCommand(stage.command), stage.args ?? [], {
        cwd: stage.cwd ? resolve(repoRoot, stage.cwd) : repoRoot,
        shell: false,
      });
    } catch (error) {
      resolvePromise({ ok: false, code: null, durationMs: 0, error: error.message });
      return;
    }
    child.stdout.on("data", (chunk) => writer.write(chunk));
    child.stderr.on("data", (chunk) => writer.write(chunk));
    child.on("error", (error) => {
      writer.flush();
      resolvePromise({
        ok: false,
        code: null,
        durationMs: Date.now() - startedAt,
        error: error.message,
      });
    });
    child.on("close", (code) => {
      writer.flush();
      resolvePromise({ ok: code === 0, code, durationMs: Date.now() - startedAt });
    });
  });
}

function assertManifest(stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new TypecheckGateUsageError("阶段清单不能为空");
  }
  const ids = new Set();
  for (const stage of stages) {
    if (!stage?.id || typeof stage.id !== "string") {
      throw new TypecheckGateUsageError("每个阶段必须有字符串 id");
    }
    if (ids.has(stage.id)) throw new TypecheckGateUsageError(`阶段 id 重复：${stage.id}`);
    ids.add(stage.id);
    if (!stage.command || typeof stage.command !== "string") {
      throw new TypecheckGateUsageError(`阶段 ${stage.id} 缺少 command`);
    }
  }
  for (const stage of stages) {
    for (const dep of stage.dependsOn ?? []) {
      if (!ids.has(dep)) throw new TypecheckGateUsageError(`阶段 ${stage.id} 依赖不存在的 ${dep}`);
    }
  }
}

/**
 * 按 dependsOn 分波执行阶段；同一波内并行。任一阶段失败后不再启动新阶段，
 * 已在跑的跑完再汇总——失败必须可见，不静默降级。
 * 返回进程退出码：0 全通过，1 有阶段失败，2 用法/清单错误。
 */
export async function runTypecheckGate({
  stages = TYPECHECK_STAGES,
  only,
  sequential = false,
  emit = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  assertManifest(stages);

  let selected = stages;
  if (only && only.length > 0) {
    const known = new Set(stages.map((stage) => stage.id));
    for (const id of only) {
      if (!known.has(id))
        throw new TypecheckGateUsageError(`未知阶段：${id}（可用：${[...known].join(", ")}）`);
    }
    selected = stages.filter((stage) => only.includes(stage.id));
  }
  const selectedIds = new Set(selected.map((stage) => stage.id));
  // --only 是开发快循环：未选中的依赖视为已满足，但明确说出来，避免把
  // 「没重建声明」误读成「类型没问题」。
  const externalDeps = new Set();
  for (const stage of selected) {
    for (const dep of stage.dependsOn ?? [])
      if (!selectedIds.has(dep)) externalDeps.add(`${stage.id}←${dep}`);
  }

  emit(
    `类型门禁：${selected.map((stage) => stage.id).join(" -> ")}${sequential ? "（串行）" : ""}`,
  );
  if (externalDeps.size > 0) {
    emit(`注意：以下依赖未被选中，按已满足处理：${[...externalDeps].join(", ")}`);
  }

  const status = new Map(stages.map((stage) => [stage.id, "pending"]));
  const running = new Map();
  const results = [];
  let aborted = false;

  const depsDone = (stage) =>
    (stage.dependsOn ?? []).every((dep) => !selectedIds.has(dep) || status.get(dep) === "done");

  for (;;) {
    if (!aborted) {
      for (const stage of selected) {
        if (status.get(stage.id) !== "pending") continue;
        if (!depsDone(stage)) continue;
        if (sequential && running.size > 0) continue;
        status.set(stage.id, "running");
        emit(`[${stage.id}] 开始：${stage.label ?? describeCommand(stage)}`);
        const promise = runStage(stage, emit).then((result) => {
          running.delete(stage.id);
          results.push({ stage, ...result });
          status.set(stage.id, result.ok ? "done" : "failed");
          if (!result.ok) aborted = true;
          const suffix = result.ok
            ? "通过"
            : `失败（exit ${result.code ?? "n/a"}${result.error ? `：${result.error}` : ""}）`;
          emit(`[${stage.id}] ${suffix}，用时 ${(result.durationMs / 1000).toFixed(1)}s`);
          return result;
        });
        running.set(stage.id, promise);
        if (sequential) break;
      }
    }

    if (running.size === 0) {
      const pending = selected.filter((stage) => status.get(stage.id) === "pending");
      if (pending.length === 0) break;
      if (aborted) {
        // 跳过必须逐阶段说出来：只在汇总里写 skipped 等于静默降级，
        // 读日志的人会以为这些阶段跑过了。
        for (const stage of pending) {
          status.set(stage.id, "skipped");
          emit(`[${stage.id}] 跳过：门禁已失败，未执行`);
        }
        break;
      }
      throw new TypecheckGateUsageError(
        `阶段依赖存在环：${pending.map((stage) => stage.id).join(", ")}`,
      );
    }
    await Promise.race(running.values());
  }

  emit("");
  emit("类型门禁汇总：");
  for (const stage of selected) {
    const result = results.find((entry) => entry.stage.id === stage.id);
    const state = status.get(stage.id);
    const duration = result ? `${(result.durationMs / 1000).toFixed(1)}s` : "-";
    emit(`  ${state.padEnd(8)} ${stage.id.padEnd(18)} ${duration}`);
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    emit("");
    emit("失败阶段的复现命令：");
    for (const entry of failed) {
      emit(`  ${entry.stage.id}: ${describeCommand(entry.stage)}`);
      emit(`  ${entry.stage.id}: node scripts/typecheck-gate.mjs --only ${entry.stage.id}`);
    }
    return 1;
  }
  return 0;
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
