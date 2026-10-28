// ============================================================
// world-read 基础叶：deps 契约、路径安全原语、实参校验器与 files.read
// ============================================================
// 拆分自 workflow-world-read.ts（649 行，超出 400 行文件级门禁）。按职责切面：
// 本叶承载 world-read 的"文件面 + 公共原语"——WorldReadDeps 契约、工作区路径安全原语
// （resolveWithinWorkspace / toWorkspaceRelative）、位置实参形状校验器、以及 files.read。
//
// 依赖方向：本叶是基础叶，被 world-read-search.ts 与 world-read-git-exec.ts 单向依赖；
// 本叶不 import 任何兄弟叶，原桶文件（workflow-world-read.ts）只 re-export，不成环。

import {
  isAbsolute as isAbsolutePath,
  relative as relativePath,
  resolve as resolvePath,
  sep,
} from "node:path";
import type { ExecutionPort, FileSystemPort } from "@acode/contracts";
import { WORLD_READ_CAPS, WorkflowError, type WorldReadOp } from "@acode/dynamic-workflow";

/** 世界读取需要的端口与基准目录（driver deps 的一个子集）。 */
export interface WorldReadDeps {
  /** files.glob / files.read / files.grep 落到的文件系统端口。 */
  readonly fileSystemPort: FileSystemPort;
  /** git.* 落到的子进程执行端口（cwd = 工作区根）。 */
  readonly executionPort: ExecutionPort;
  /** 路径解析与相对化的基准目录（workspace 根）。 */
  readonly cwd: string;
  /** 本次 run 的取消信号；world.run 必须把它交给 ExecutionPort。 */
  readonly signal?: AbortSignal;
  /**
   * world.run 的已批准命令集（编译期从字面量 cmd 收集、确认窗展示过的那一份）。**缺席即拒绝一切 world.run**（fail-closed）：
   * 授权面的空集与「忘了接线」必须同样安全，而复验在这里只是纵深防御——真正的授权
   * 发生在编译期字面量 + 提交确认。
   */
  readonly declaredRunCommands?: ReadonlySet<string>;
}

/**
 * `files.read(path)`：解析到绝对路径后**先确认它仍在工作区之内**，再交给端口。
 *
 * 为什么这道检查现在才补上：在 `git.*` 落地之前，能进到这里的路径都是脚本自己写出来的字面量，
 * 越界是一次显式的越界。`git.*` 是第一个**能生产出**路径的原语——`changedFiles() → files.read(p)`
 * 是那个最显然的两行组合，而 git 的原生输出在工作区是仓库子目录时会带 `../` 前缀。git 那一侧
 * 已经用 pathspec 把范围收在工作区内了，这道检查是同一条不变式在另一端的落点：一个原语的
 * 显然组合不该是个陷阱。
 */
export async function worldRead(deps: WorldReadDeps, arg: string): Promise<string> {
  const path = assertWithinWorkspace("read", deps.cwd, arg);
  const result = await deps.fileSystemPort.readTextFile(
    { path },
    deps.signal === undefined ? undefined : { signal: deps.signal },
  );
  return result.content;
}

/**
 * 从 world-read 的位置实参数组里取出 `names` 所描述的**必填 string 实参**，形状不符即抛结构化
 * `DriverError`（node 级失败，脚本可 `catch`）。元数按 `names.length` 精确校验：多传的实参只可能
 * 来自接线错误——facade 的类型签名在编译期就拦住了多余实参，所以运行期出现就是 lowering /
 * 线协议出了岔子，静默忽略等于把一个可定位的 bug 藏成一次语义不明的读取。
 *
 * 为什么校验而不强转：Boundary A 的 `args: unknown[]` 是**原样透传**的脚本实参，这一侧是第一个
 * 也是唯一一个知道每个 op 元数的地方。
 * `String(args[0])` 会把 `undefined` 变成路径 `"undefined"`，报出的 ENOENT 指不回真正的错处。
 *
 * 带可选实参的多参 op（`files.grep(pattern, glob?)`、`git.diff(base?, path?)`）走的是允许尾部
 * 缺省的变体 {@link worldReadOptionalStringArgs}；接缝在这两个函数里，不在调用点。
 */
export function worldReadStringArgs(op: WorldReadOp, args: unknown[], names: readonly string[]): string[] {
  if (args.length !== names.length) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op} takes ${names.length} arguments (${names.join(", ")}), got ${args.length}.`,
    );
  }
  return names.map((name, index) => requireStringArg(op, args[index], name, index));
}

/**
 * {@link worldReadStringArgs} 的**尾部可选**变体：`required` 是必填前缀，`optional` 是可选尾部。
 * 返回定长 `required.length + optional.length` 的数组，缺席的可选位是 `undefined`。
 *
 * 三条规则，都是"大声失败"的一面：
 *   1. 实参数少于必填数、或多于总数 → 结构化 `DriverError`。多传仍然拒绝，理由与精确变体
 *      相同：facade 的签名在编译期就拦住了多余实参，运行期出现只可能是 lowering / 线协议的
 *      接线错误，静默忽略等于把一个可定位的 bug 藏成一次语义不明的读取。
 *   2. 必填位必须是 string。
 *   3. **可选位允许显式 `undefined`**，因为它在脚本里是可写的：`git.diff(undefined, "a.ts")`
 *      在 `base?: string` 下合法，lowering 原样按位置打包，于是 driver 真的会收到一个
 *      `undefined` 前缀。把它当成"缺席"是唯一说得通的读法。
 *
 * 注意 lowering 对**尾部**缺省打包的是**更短的数组**（不是 undefined 洞），而
 * `inputHash({op, args})` 是 journal 键——所以 `["TODO"]` 与 `["TODO", "*.ts"]` 天然是两个键。
 * 本函数只把两种到达形态都归一成同一个调用形状，不去改写 args。
 */
export function worldReadOptionalStringArgs(
  op: WorldReadOp,
  args: unknown[],
  required: readonly string[],
  optional: readonly string[],
): (string | undefined)[] {
  const max = required.length + optional.length;
  if (args.length < required.length || args.length > max) {
    const range = required.length === max ? `${max}` : `${required.length}~${max}`;
    throw new WorkflowError(
      "DriverError",
      `world-read ${op} takes ${range} arguments ` +
        `(${[...required, ...optional.map((n) => `${n}?`)].join(", ")}), got ${args.length}.`,
    );
  }
  const out: (string | undefined)[] = [];
  required.forEach((name, index) => out.push(requireStringArg(op, args[index], name, index)));
  optional.forEach((name, offset) => {
    const index = required.length + offset;
    if (index >= args.length) {
      out.push(undefined);
      return;
    }
    const value = args[index];
    if (value === undefined) {
      out.push(undefined);
      return;
    }
    out.push(requireStringArg(op, value, name, index));
  });
  return out;
}

/**
 * `git.log(count?)` 的实参：0 或 1 个，必须是正整数且不超过上限。缺席取
 * {@link WORLD_READ_CAPS.gitLogDefaultCount}。
 *
 * 超上限**拒绝**而不是静默夹到上限：脚本请求 500 条却拿到 100 条，会在它自己的逻辑里变成
 * 一个查不明白的"历史怎么这么短"。一条指名上限的错误让脚本能直接改对。
 */
export function worldReadOptionalCount(op: WorldReadOp, args: unknown[], name: string): number {
  const max = WORLD_READ_CAPS.gitLogMaxCount;
  if (args.length > 1) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op} takes at most 1 argument (${name}?), got ${args.length}.`,
    );
  }
  const raw = args[0];
  if (raw === undefined) return WORLD_READ_CAPS.gitLogDefaultCount;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: argument '${name}' must be an integer >= 1, got ${describeArg(raw)}.`,
    );
  }
  if (raw > max) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: argument '${name}'=${raw} is over the cap of ${max}; pass at most ${max}.`,
    );
  }
  return raw;
}

/** 取一个必须是 string 的位置实参，否则结构化拒绝（绝不 `String(...)` 强转）。 */
export function requireStringArg(op: WorldReadOp, value: unknown, name: string, index: number): string {
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: arg ${index + 1} (${name}) must be a string, got ${describeArg(value)}.`,
    );
  }
  return value;
}

/**
 * 上限溢出的结构化拒绝。message 一律带**可操作的下一步**（"缩窄 pattern 或加一个 glob"）：
 * 上限是脚本可以据以重写自己的契约，一条只说"超了"的错误把这一点浪费掉。
 */
export function capExceeded(message: string): WorkflowError {
  return new WorkflowError("WorldReadCapExceeded", message);
}

/**
 * 把一个脚本给的相对路径解析成绝对路径，并**词法上**判定它是否仍在工作区之内；越界返回
 * `undefined`（错误的措辞与结构化码归调用方——世界读取报 `DriverError`，产物发布报
 * `ArtifactPathOutsideWorkspace`）。
 *
 * 判据用 `relative(cwd, resolved)`：它的输出已经规范化，`..` 只可能出现在开头，所以
 * "不以 `..` 段开头且不是绝对路径"就等价于"仍在工作区内"。第二个条件在 windows 上是必需的
 * ——跨盘符时 `relative` 会返回一个绝对路径而不是一串 `..`。
 *
 * **只做词法检查，不追符号链接**：工作区内一个指向外部的软链在这一层仍然通过。世界读取
 * 接受这条已知边界（读出来的字节就是脚本自己看到的值）；产物发布不接受它，因为它把字节
 * **拷进一个持久 store 交给用户**，所以那一侧在本函数之上再做一次 realpath 复核
 * （见 workflow-artifact-publish.ts）。
 *
 * **导出是有意的**：越界的定义必须只有一个实现。两处各写一遍，就会有一天两处对同一个
 * 路径给出不同答案，而其中一处是安全边界。
 */
export function resolveWithinWorkspace(cwd: string, arg: string): string | undefined {
  const resolved = resolvePath(cwd, arg);
  const rel = relativePath(cwd, resolved);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../");
  return escapes || isAbsolutePath(rel) ? undefined : resolved;
}

/** {@link resolveWithinWorkspace} 的世界读取包装：越界即结构化 `DriverError`（脚本可 `catch`）。 */
function assertWithinWorkspace(op: string, cwd: string, arg: string): string {
  const resolved = resolveWithinWorkspace(cwd, arg);
  if (resolved === undefined) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${arg}' is outside the workspace; pass a path inside it.`,
    );
  }
  return resolved;
}

/**
 * 端口返回的路径归一成**工作区相对**路径（facade 承诺的形状）。端口可能给绝对路径也可能
 * 已经给相对路径，两种都接。分隔符统一成 `/`：这个值会进 journal、也会被插值进模型提示，
 * 所以它不该随宿主平台变形（同一份脚本在 windows 与 mac 上应当读出同样的 path）。
 *
 * **导出是有意的**（同 {@link resolveWithinWorkspace}）：产物记录里的 `sourcePath` 是同一种
 * 值——工作区相对、正斜杠——而"同一种值"必须只有一处定义，否则两处迟早会在 windows 上分叉。
 */
export function toWorkspaceRelative(cwd: string, path: string): string {
  const rel = resolvePath(cwd, path) === path ? relativePath(cwd, path) : path;
  return rel.replace(/\\/g, "/");
}

/** stderr / stdout 的首行（错误消息用，不回显整段输出）。 */
export function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

/** 实参形状的简短描述（只用于错误消息，不回显完整内容）。 */
export function describeArg(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}
