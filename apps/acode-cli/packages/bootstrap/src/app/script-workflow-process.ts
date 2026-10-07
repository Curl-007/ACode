import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { writeChildEntryFile, type HarnessWarning } from "@acode/dynamic-workflow-runtime";
import type { WorkflowScriptDocument } from "./script-workflow-meta.js";
import { renderScriptWorkflowChildEntry } from "./script-workflow-child-source.js";

const WORKFLOW_CHILD_STDERR_LIMIT = 64 * 1024;

export interface ScriptWorkflowChildRequest {
  id: string;
  payload: unknown;
  type: string;
}

interface ScriptWorkflowChildEvent {
  payload: unknown;
  type: string;
}

interface ScriptWorkflowChildRunResult {
  stderr: string;
  value: unknown;
}

export async function runScriptWorkflowChild(input: {
  args?: unknown;
  budgetTotal?: number;
  document: WorkflowScriptDocument;
  handleEvent(event: ScriptWorkflowChildEvent): Promise<void> | void;
  handleRequest(request: ScriptWorkflowChildRequest): Promise<unknown>;
  /** 入口文件写不进项目目录、回落到临时目录时的非致命告知。 */
  onEntryFileWarning?(warning: HarnessWarning): void;
  /** 入口文件名即 `<runId>.mjs`；与 dwf 共用目录而靠前缀（wf_ vs dwfrun_）不冲突。 */
  runId: string;
  signal?: AbortSignal;
  workingDirectory: string;
}): Promise<ScriptWorkflowChildRunResult> {
  // 入口文件落盘，不再经 argv。契约允许 512KB 脚本（WORKFLOW_SCRIPT_MAX_LENGTH），而 Windows
  // 命令行上限是 32767 字符——旧写法把 base64url 后的 payload 塞进 argv，脚本超过约 24KB
  // 就必然 spawn 失败，且失败信息是操作系统的而不是「脚本太大」。
  // 复用 dwf 的 writeChildEntryFile 而不是自己写一份：`.acode/workflow-runs/` 的落点、
  // 目录内 .gitignore、临时目录回落与失败语义因此只有一个所有者（它用的同步 fs 也是既有的，
  // 一次 run 启动只写一个小文件；再写一份异步实现等于给同一目录开第二条写入路径）。
  const entry = writeChildEntryFile({
    cwd: input.workingDirectory,
    onWarning: input.onEntryFileWarning,
    runId: input.runId,
    source: renderScriptWorkflowChildEntry({
      ...(input.args === undefined ? {} : { args: input.args }),
      ...(input.budgetTotal === undefined ? {} : { budgetTotal: input.budgetTotal }),
      scriptBody: input.document.body,
      scriptUrl: pathToFileURL(input.document.path).href,
    }),
  });
  const child = spawn(process.execPath, [entry.path], {
    cwd: input.workingDirectory,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // stdin 必须挂 error 监听器，否则一次 EPIPE 会打死整个宿主进程。
  //
  // 触发路径（实测撞到，不是推演）：用户 TaskStop → 端口 abort → 上面的 `abort()` kill 子进程
  // → 而在飞的 agent 请求此时正要回写响应 → 往一条对端已关闭的管道写 → EPIPE。
  // Node 的流在没有 'error' 监听器时把它抛成**未捕获异常**，于是 `node:events` throw er，
  // 整个 CLI 进程退出码 1：run 没有结算、没有 run-settled、用户连一句错误都看不到。
  // 也就是说「取消一个脚本工作流」曾等于「崩掉宿主」。
  //
  // 这里吞掉它是正确的而不是掩盖：对端已经没了，这次写本来就无处可去，而 run 的终局
  // 由 kill 之后的 close/exit 路径裁定（signal.aborted → 抛 → runtime 记 cancelled）。
  // 写失败不构成新的事实，只构成一个噪音异常。
  child.stdin?.on("error", () => undefined);

  let stderr = "";
  let completed:
    | {
        error?: string;
        ok: boolean;
        stack?: string;
        value?: unknown;
      }
    | undefined;
  let settled = false;

  const abort = (): void => {
    child.kill();
  };
  input.signal?.addEventListener("abort", abort, { once: true });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr = trimStderr(stderr + chunk.toString("utf8"));
  });

  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    void handleChildLine(line, {
      child,
      complete: (message) => {
        completed = message;
      },
      handleEvent: input.handleEvent,
      handleRequest: input.handleRequest,
    }).catch((error) => {
      completed = {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
      };
      child.kill();
    });
  });

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    settled = true;
    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error("Workflow script run cancelled");
    }
    if (!completed) {
      throw new Error(stderr || `Workflow child exited without completion: ${exitCode}`);
    }
    if (!completed.ok) {
      throw new Error(completed.error || "Workflow script failed", {
        cause: completed.stack,
      });
    }
    if (exitCode !== 0) {
      throw new Error(stderr || `Workflow child exited with code ${exitCode}`);
    }
    return {
      stderr,
      value: completed.value,
    };
  } finally {
    input.signal?.removeEventListener("abort", abort);
    if (!settled) child.kill();
  }
}

async function handleChildLine(
  line: string,
  deps: {
    child: ReturnType<typeof spawn>;
    complete(message: { error?: string; ok: boolean; stack?: string; value?: unknown }): void;
    handleEvent(event: ScriptWorkflowChildEvent): Promise<void> | void;
    handleRequest(request: ScriptWorkflowChildRequest): Promise<unknown>;
  },
): Promise<void> {
  if (!line.trim()) return;
  const message = JSON.parse(line) as
    | {
        id: string;
        kind: "request";
        payload: unknown;
        type: string;
      }
    | {
        kind: "event";
        payload: unknown;
        type: string;
      }
    | {
        error?: string;
        kind: "complete";
        ok: boolean;
        stack?: string;
        value?: unknown;
      };

  if (message.kind === "event") {
    await deps.handleEvent({ payload: message.payload, type: message.type });
    return;
  }
  if (message.kind === "complete") {
    deps.complete(message);
    return;
  }

  try {
    const value = await deps.handleRequest(message);
    writeResponse(deps.child, {
      id: message.id,
      ok: true,
      value,
    });
  } catch (error) {
    writeResponse(deps.child, {
      error: error instanceof Error ? error.message : String(error),
      id: message.id,
      ok: false,
    });
  }
}

function writeResponse(
  child: ReturnType<typeof spawn>,
  message: { error?: string; id: string; ok: boolean; value?: unknown },
): void {
  if (!child.stdin) return;
  // 对端已 gone 就别写了：子进程被 kill（用户取消）或自己崩掉之后，这条响应没有收件人。
  // 判 destroyed/writableEnded 只是少制造一次注定失败的写；真正的兜底是 spawn 处那个
  // stdin 'error' 监听器与这里的回调——两者缺一，EPIPE 就会变成未捕获异常打死宿主进程。
  if (child.stdin.destroyed || child.stdin.writableEnded) return;
  child.stdin.write(`${JSON.stringify({ kind: "response", ...message })}\n`, () => undefined);
}

function trimStderr(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= WORKFLOW_CHILD_STDERR_LIMIT) return value;
  return value.slice(-WORKFLOW_CHILD_STDERR_LIMIT);
}
