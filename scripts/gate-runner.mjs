// 通用阶段执行器：按 dependsOn 分波跑一组 shell 阶段，失败即停、逐条打印跳过、
// 汇总给出复现命令。
//
// 提取自 scripts/typecheck-gate.mjs，供类型门禁与本地验证门禁（scripts/verify-local.mjs）
// 共用。两者承担同一职责且应同步演进（同一套「不静默降级」的输出纪律），故只保留一份实现；
// 提取不改变 typecheck-gate 的对外契约——TYPECHECK_STAGES、runTypecheckGate、
// TypecheckGateUsageError 与全部输出文案逐字保持，受
// apps/acode-cli/tests/typecheck-gate.test.mjs 保护。
//
// 规则与验收见 docs/specs/cli-validation-gates.md（类型门禁）与
// docs/specs/local-verify-gates.md R1（本地门禁复用本执行器）。
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

export class GateUsageError extends Error {}

export function resolveCommand(command, repoRoot, { fromPath = false } = {}) {
  // node 走当前解释器，避开 Windows 上 .cmd shim 必须 shell 的问题；
  // fromPath 表示命令是 PATH 上的可执行（如 Windows 的 pnpm.cmd），不按仓库根解析；
  // 其余相对路径按 repoRoot 解析。
  if (command === "node") return process.execPath;
  if (fromPath) return command;
  return isAbsolute(command) ? command : resolve(repoRoot, command);
}

export function describeCommand(stage) {
  return [stage.command === "node" ? "node" : stage.command, ...(stage.args ?? [])].join(" ");
}

// 并发输出会交错，按行加阶段前缀后才写出去，保证失败定位得到的是完整行。
export function createLineWriter(prefix, emit) {
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

export function runStage(stage, { emit, repoRoot, env }) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const writer = createLineWriter(`[${stage.id}]`, emit);
    // stage.shell 用于 Windows 上的 .cmd shim（pnpm.cmd 无 shell 不能被 Node spawn，
    // 与 scripts/mise-run.mjs 同因）。此时把参数拼进命令串而非交给 args 数组：
    // Node 对 shell:true + args 会发 DEP0190 警告且不转义。因此本路径要求
    // 各参数自身不含空格（flag 用 --k=v 形式），调用方负责遵守。
    const resolved = resolveCommand(stage.command, repoRoot, { fromPath: stage.fromPath });
    const args = stage.args ?? [];
    const useShell = stage.shell === true;
    let child;
    try {
      child = spawn(useShell ? [resolved, ...args].join(" ") : resolved, useShell ? [] : args, {
        cwd: stage.cwd ? resolve(repoRoot, stage.cwd) : repoRoot,
        shell: useShell,
        env: env ? { ...env, ...(stage.env ?? {}) } : stage.env,
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

export function assertManifest(stages, UsageError = GateUsageError) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new UsageError("阶段清单不能为空");
  }
  const ids = new Set();
  for (const stage of stages) {
    if (!stage?.id || typeof stage.id !== "string") {
      throw new UsageError("每个阶段必须有字符串 id");
    }
    if (ids.has(stage.id)) throw new UsageError(`阶段 id 重复：${stage.id}`);
    ids.add(stage.id);
    if (!stage.command || typeof stage.command !== "string") {
      throw new UsageError(`阶段 ${stage.id} 缺少 command`);
    }
  }
  for (const stage of stages) {
    for (const dep of stage.dependsOn ?? []) {
      if (!ids.has(dep)) throw new UsageError(`阶段 ${stage.id} 依赖不存在的 ${dep}`);
    }
  }
}

/**
 * 按 dependsOn 分波执行阶段；同一波内并行。任一阶段失败后不再启动新阶段，
 * 已在跑的跑完再汇总——失败必须可见，不静默降级。
 * 返回进程退出码：0 全通过，1 有阶段失败，2 由调用方按 UsageError 处理。
 */
export async function runStagedGate({
  stages,
  repoRoot,
  title,
  reproScript,
  only,
  sequential = false,
  emit = (line) => process.stdout.write(`${line}\n`),
  env,
  UsageError = GateUsageError,
}) {
  assertManifest(stages, UsageError);

  let selected = stages;
  if (only && only.length > 0) {
    const known = new Set(stages.map((stage) => stage.id));
    for (const id of only) {
      if (!known.has(id)) throw new UsageError(`未知阶段：${id}（可用：${[...known].join(", ")}）`);
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
    `${title}：${selected.map((stage) => stage.id).join(" -> ")}${sequential ? "（串行）" : ""}`,
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
        const promise = runStage(stage, { emit, repoRoot, env }).then((result) => {
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
      throw new UsageError(`阶段依赖存在环：${pending.map((stage) => stage.id).join(", ")}`);
    }
    await Promise.race(running.values());
  }

  emit("");
  emit(`${title}汇总：`);
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
      emit(`  ${entry.stage.id}: ${reproScript} --only ${entry.stage.id}`);
    }
    return 1;
  }
  return 0;
}
