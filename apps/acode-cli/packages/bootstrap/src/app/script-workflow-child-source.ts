/**
 * 脚本工作流子进程的入口源码。
 *
 * 形状照 `@acode/dynamic-workflow-runtime` 的 `renderChildEntry`：入口文件是一段自包含 ESM，
 * import 与 payload 字面量由 {@link renderScriptWorkflowChildEntry} 拼进去，其余正文是下面这个
 * 常量。落盘而不是走 argv 的理由见 specs/script-workflow-revival.md R5（Windows 命令行 32767
 * 字符上限 vs 契约允许的 512KB 脚本）。
 *
 * ————————————————————————————————————————————————————————————————
 * 两个 realm，谁看得见什么
 * ————————————————————————————————————————————————————————————————
 * 外层（本文件所在的子进程模块）：有 Node。stdio NDJSON、AsyncLocalStorage（`callPath` 铸造）、
 * 八个 DSL 全局的实现全在这里。
 * 内层（`vm.createContext` 的沙箱）：只有 ES intrinsics + 注入进来的那几个句柄。脚本体在这里跑。
 *
 * 这么分的收益是实打实的：内层没有 `process`/`Buffer`/`require`/模块系统，动态 `import()` 在
 * vm Script 里不可用，realm 内的 `Function("return process")()` 是 ReferenceError。
 * **但没有堵死**：注入的宿主函数是外层 realm 的对象，`agent.constructor.constructor(...)` 这类
 * 原型链上溯仍能拿到外层 Function。dwf 是同一姿态（它只注入一个 `__send`，其确定性测试的证据
 * 清单里就写着这条可绕）。子进程本来就不是安全边界，真正的控制是 RunWorkflow 的 alwaysAsk
 * 确认门。详见 spec R4——那段把「关掉了什么」和「没关掉什么」分开写清了，不要只读一半。
 *
 * 为什么八个全局不能改成在内层定义（那样就能把注入面降到一个 `__send`）：
 * `parallel`/`pipeline` 要给**任意用户 thunk** 传隐式上下文，只有 AsyncLocalStorage 做得到，
 * 而 ALS 是 Node 能力。用了它就必须注入外层对象，于是残余逸出面降不到零。这是取舍，不是疏忽。
 */

/** 子进程入口的载荷。字段与旧 argv 版一致，只是不再经命令行。 */
export interface ScriptWorkflowChildPayload {
  args?: unknown;
  budgetTotal?: number;
  scriptBody: string;
  /** 仅用于 vm 的 filename（栈帧可读），子进程不读这个路径。 */
  scriptUrl?: string;
}

/**
 * 在沙箱 realm 内执行的引导脚本。
 *
 * 纯 JS、不含反引号与 `${}`，以便安全内嵌进 String.raw。职责三件：
 *   1. 把宿主句柄暴露成**裸全局**并冻结（DSL 契约要求 `agent(...)` 而不是 `__host.agent(...)`）；
 *   2. 在 realm **内**用 JSON.parse 构造 `args`——跨 realm 的 intrinsics 不收敛，
 *      把外层对象直接塞进来会让脚本里的原型判定失效（dwf 侧同一约束）；
 *   3. 施加确定性禁令（realm 有自己的 Date/Math，改外层的对它无效）。
 *      `Date.parse` / `Date.UTC` / `new Date(ms)` 刻意保留：禁的是「每次跑都不一样」的那三个源，
 *      不是整个 Date。
 */
const SANDBOX_BOOTSTRAP = String.raw`
"use strict";
var __h = __host;
var __names = ["agent", "parallel", "pipeline", "phase", "log", "workflow"];
for (var __i = 0; __i < __names.length; __i += 1) {
  Object.defineProperty(globalThis, __names[__i], {
    configurable: false,
    enumerable: false,
    value: __h[__names[__i]],
    writable: false,
  });
}
Object.defineProperty(globalThis, "budget", {
  configurable: false,
  enumerable: false,
  value: Object.freeze(__h.budget),
  writable: false,
});
Object.defineProperty(globalThis, "console", {
  configurable: false,
  enumerable: false,
  value: __h.console,
  writable: false,
});
var __args = Object.freeze(JSON.parse(__argsJson));
Object.defineProperty(globalThis, "args", {
  configurable: false,
  enumerable: false,
  value: __args,
  writable: false,
});
delete globalThis.__host;
delete globalThis.__argsJson;

var __NativeDate = Date;
class __WorkflowDate extends __NativeDate {
  constructor(...dateArgs) {
    if (dateArgs.length === 0) throw new Error("argless new Date() is disabled in workflows");
    super(...dateArgs);
  }
  static now() {
    throw new Error("Date.now() is disabled in workflows");
  }
  static parse(value) {
    return __NativeDate.parse(value);
  }
  static UTC(...utcArgs) {
    return __NativeDate.UTC.apply(__NativeDate, utcArgs);
  }
}
Object.defineProperty(globalThis, "Date", {
  configurable: false,
  enumerable: false,
  value: __WorkflowDate,
  writable: false,
});
Math.random = function random() {
  throw new Error("Math.random() is disabled in workflows");
};
`;

/**
 * 入口文件的正文：假定 `payload`、`AsyncLocalStorage`、`Console`、`createInterface`、`vm`
 * 五个绑定已在作用域内（由 {@link renderScriptWorkflowChildEntry} 的 import 与 payload 常量提供）。
 *
 * 这段是**字符串**，esbuild 不会重排或重命名里面的任何东西，所以内层函数可以放心带名字——
 * dwf 那条「内层函数一律不许有名字」的约束针对的是 `childMain.toString()`（真函数被当源码内嵌，
 * `minify + keepNames` 会给它套模块作用域的 `__name` helper），这里不适用。
 */
const SCRIPT_WORKFLOW_CHILD_MAIN = String.raw`
const nodeProcess = process;
const stderrConsole = new Console({ stdout: nodeProcess.stderr, stderr: nodeProcess.stderr });

let nextRequestId = 0;
let currentPhase;
let spentTokens = 0;
const pending = new Map();
const contextStore = new AsyncLocalStorage();
const rootContext = { nextAgent: 0, nextBlock: 0, path: "root" };

const reader = createInterface({ input: nodeProcess.stdin });
reader.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    stderrConsole.error("Invalid workflow runner response", error);
    return;
  }
  if (message.kind !== "response") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.value);
  else waiter.reject(new Error(message.error || "Workflow runner request failed"));
});

function send(message) {
  nodeProcess.stdout.write(JSON.stringify(message) + "\n");
}

function notify(type, payloadValue) {
  send({ kind: "event", type, payload: payloadValue });
}

function callParent(type, payloadValue) {
  const id = "req_" + ++nextRequestId;
  send({ id, kind: "request", payload: payloadValue, type });
  return new Promise((resolve, reject) => {
    pending.set(id, { reject, resolve });
  });
}

function currentContext() {
  return contextStore.getStore() || rootContext;
}

function childContext(parent, label) {
  return { nextAgent: 0, nextBlock: 0, path: parent.path + "/" + label };
}

function nextBlockLabel(kind) {
  const context = currentContext();
  const index = context.nextBlock++;
  return kind + index;
}

// —— 八个 DSL 全局：实现在外层 realm（要 ALS 与 callParent），随后注入沙箱 ——

const agent = async function agent(prompt, opts) {
  const context = currentContext();
  const callPath = context.path + "/agent" + context.nextAgent++;
  const result = await callParent("agent", {
    callPath,
    opts,
    phase: opts?.phase || currentPhase,
    prompt,
  });
  spentTokens += Number(result?.stats?.tokens?.total || 0);
  return result?.value;
};

const parallel = async function parallel(thunks) {
  if (!Array.isArray(thunks)) throw new Error("parallel() expects an array of thunks");
  const parent = currentContext();
  const block = nextBlockLabel("parallel");
  return Promise.all(
    thunks.map((thunk, index) =>
      contextStore
        .run(childContext(parent, block + "/item" + index), async () => thunk())
        .catch(() => null),
    ),
  );
};

const pipeline = async function pipeline(items, ...stages) {
  if (!Array.isArray(items)) throw new Error("pipeline() expects an array of items");
  const parent = currentContext();
  const block = nextBlockLabel("pipeline");
  return Promise.all(
    items.map((item, index) =>
      contextStore
        .run(childContext(parent, block + "/item" + index), async () => {
          let previous = item;
          for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
            const stage = stages[stageIndex];
            previous = await contextStore.run(
              childContext(currentContext(), "stage" + stageIndex),
              async () => stage(previous, item, index),
            );
          }
          return previous;
        })
        .catch(() => null),
    ),
  );
};

const log = function log(message) {
  notify("log", { message: String(message), phase: currentPhase });
};

const phase = function phase(title) {
  currentPhase = String(title);
  notify("phase", { title: currentPhase });
};

const workflow = async function workflow(nameOrRef, args) {
  return callParent("workflow", { args, nameOrRef });
};

const budget = {
  total: payload.budgetTotal ?? null,
  spent() {
    return spentTokens;
  },
  remaining() {
    if (payload.budgetTotal === undefined || payload.budgetTotal === null) return Infinity;
    return Math.max(0, payload.budgetTotal - spentTokens);
  },
};

// console 转发到 log 通道。沙箱里没有 Node 的 console，不注入的话 console.log 会变成
// ReferenceError——那对一段只想打点调试的脚本是很难懂的失败。
const consoleBridge = {
  debug: log,
  error: log,
  info: log,
  log: log,
  warn: log,
};

// —— 沙箱 realm ——
// sandbox 上只放两样东西：宿主句柄集合与 args 的 JSON 文本。args 刻意以**字符串**过界，
// 由 bootstrap 在 realm 内 JSON.parse，脚本因此拿到的是 realm-native 对象。
const sandbox = {
  __argsJson: JSON.stringify(payload.args ?? null),
  __host: { agent, budget, console: consoleBridge, log, parallel, phase, pipeline, workflow },
};
const context = vm.createContext(sandbox, {
  // 禁掉 realm 内的 eval / new Function / WASM 编译：它们是绕过一切静态检查的第二条执行路径。
  codeGeneration: { strings: false, wasm: false },
  name: "script-workflow-sandbox",
});
vm.runInContext(SANDBOX_BOOTSTRAP, context, { filename: "script-workflow-bootstrap.js" });

// 脚本体包成 async 函数求值：顶层 await 与末尾 return 都合法，与旧 AsyncFunction 形态一致。
// 未提供 importModuleDynamically 回调，所以脚本里的 import() 直接不可用。
const runScript = vm.runInContext(
  "(async function () {\n" + payload.scriptBody + "\n})",
  context,
  { filename: payload.scriptUrl || "script-workflow.js" },
);

try {
  const value = await contextStore.run(rootContext, () => runScript());
  send({ kind: "complete", ok: true, value });
} catch (error) {
  send({
    error: error instanceof Error ? error.message : String(error),
    kind: "complete",
    ok: false,
    stack: error instanceof Error ? error.stack : undefined,
  });
} finally {
  reader.close();
}
`;

/**
 * 渲染一份自包含的 ESM 入口文件源码。
 *
 * payload 以 JSON 字面量内嵌（不走 argv、不走 base64）：JSON 的字符串转义是合法 JS，
 * 且嵌进来的脚本正文**不会被再解析一次**——它是字符串字面量的一部分，不是代码。
 * 顶层刻意不用模板字面量，免得与脚本正文里的 `${}` 打架。
 */
export function renderScriptWorkflowChildEntry(payload: ScriptWorkflowChildPayload): string {
  return `// acode script workflow run
// Generated before every launch; safe to delete once the run has settled.
import { AsyncLocalStorage } from "node:async_hooks";
import { Console } from "node:console";
import { createInterface } from "node:readline";
import vm from "node:vm";

const payload = ${JSON.stringify(payload)};

const SANDBOX_BOOTSTRAP = ${JSON.stringify(SANDBOX_BOOTSTRAP)};

${SCRIPT_WORKFLOW_CHILD_MAIN}`;
}
