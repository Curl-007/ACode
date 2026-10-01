// npm/pnpm/yarn/bun run 的 script 体评估（R6 边界⑥收口）。
// 规格见 apps/acode-cli/specs/npm-script-body-scan.md；母层规格
// apps/acode-cli/specs/bash-target-blast-radius.md R4/R6。
//
// 背景：`npm run <script>` 解包后只看到动词 `run`，package.json script 体内容不可见
// ——`"clean": "rimraf ~"` 时 `npm run clean` 判 safe、yolo 静默放行。收口方式遵守
// 模块宪法（types.ts：纯函数、零 IO）：script 体由调用方异步预解析后经
// `TargetRiskContext.packageScripts` 注入，本文件只做纯查表与递归评估。
//
// 语义要点（spec R2/R3）：
// - `run`/`run-script` + npm 别名（test/start/stop/restart）+ pnpm/yarn/bun 裸名直呼；
// - pre<name>/post<name> 存在时一并评估（npm 生命周期，recall 偏向）；
// - body 以 package.json 所在目录为 trackedCwd（npm scripts 以包根为 cwd）；
// - body 内嵌套 `npm run other` 经同一 map 递归，深度守卫沿用 MAX_RECURSION_DEPTH；
// - `--filter`/`--dir`/`-C`/`--prefix`/`--cwd` 静态可解析时切到目标包的 scripts；
// - 动态 script 名/不可解析选择器/未知旗标/递归或名字形范围 → confirm（fail-closed）；
// - map 未注入（legacy）→ 维持收口前行为（safe 直通），spec R6 登记该边界；
// - 静态名不在 map、无 package.json、`npm run`（无名）→ safe（命令天然失败）。

import {
  SHELL_CONTROL_WORDS,
  WRAPPER_PROGRAMS,
  isFlagToken,
  programBasename,
  pushFinding,
  type ScriptAssessor,
} from "./grammar.js";
import { initialTrackedCwd, normalizeRuntimePath } from "./paths.js";
import type { PackageScriptSource, TargetRiskContext, TargetRiskFinding } from "./types.js";

/** 解包到该词时进入 run 族语义的包管理器（grammar.ts WRAPPER_PROGRAMS 的子集）。 */
export const PACKAGE_MANAGER_PROGRAMS: ReadonlySet<string> = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
]);

/** npm 的 run 别名：`npm test` = `npm run test`（npm 裸名只认这四个）。 */
const NPM_RUN_ALIASES: ReadonlySet<string> = new Set(["test", "start", "stop", "restart"]);

/** 包管理器 native 动词（不是 script 直呼）：`pnpm install` 执行的是依赖树生命周期
 * 钩子，不是本包 scripts map 的字面查找——npm install 供应链面在 spec R7 明确范围外。
 * 注意不含 test/start/stop/restart：pnpm/yarn 里它们是 script 别名。 */
const NATIVE_MANAGER_VERBS_BASE: readonly string[] = [
  "install",
  "add",
  "remove",
  "uninstall",
  "update",
  "upgrade",
  "link",
  "unlink",
  "publish",
  "unpublish",
  "pack",
  "init",
  "create",
  "exec",
  "x",
  "dlx",
  "login",
  "logout",
  "whoami",
  "owner",
  "access",
  "team",
  "info",
  "view",
  "search",
  "cache",
  "config",
  "bin",
  "ls",
  "list",
  "outdated",
  "why",
  "audit",
  "dedupe",
  "prune",
  "store",
  "import",
  "rebuild",
  "ci",
  "help",
  "completion",
  "ping",
  "org",
  "deprecate",
  "dist-tag",
  "docs",
  "edit",
  "explore",
  "fund",
  "hook",
  "pkg",
  "prefix",
  "repo",
  "root",
  "shrinkwrap",
  "star",
  "stars",
  "token",
  "unstar",
  "version",
  "set",
  "unset",
  "profile",
  "bugs",
];
const NATIVE_MANAGER_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(NATIVE_MANAGER_VERBS_BASE),
  pnpm: new Set([...NATIVE_MANAGER_VERBS_BASE, "env", "setup", "patch", "patch-commit"]),
  yarn: new Set([...NATIVE_MANAGER_VERBS_BASE, "npm", "global", "unplug"]),
  bun: new Set([...NATIVE_MANAGER_VERBS_BASE, "test", "build", "repl", "pm"]),
};

/** 取值的目标包选择器（值 = 目录，cwd 基准）。 */
const DIR_SELECTOR_FLAGS: ReadonlySet<string> = new Set(["--prefix", "-C", "--dir", "--cwd"]);
/** 取值的包选择器（值按 workspaceRoot/cwd 双基准解析，pnpm --filter 语义）。 */
const FILTER_SELECTOR_FLAGS: ReadonlySet<string> = new Set(["--filter", "-F"]);
/** 名字形工作区选择器 / bare -w：目标包集合静态不可界。 */
const WORKSPACE_NAME_FLAGS: ReadonlySet<string> = new Set(["--workspace", "-w"]);
/** 递归范围旗标（`pnpm -r run x` 在所有工作区包里跑）：范围不可静态界。 */
const RECURSIVE_SCOPE_FLAGS: ReadonlySet<string> = new Set(["--recursive", "-r"]);
/** 取值但不改变目标包解析的常用旗标（避免把它的值错位成位置参数）。 */
const MISC_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--registry",
  "--cache",
  "--userconfig",
  "--proxy",
  "--https-proxy",
  "--tag",
  "--scope",
]);
/** 常用布尔旗标。 */
const MISC_BOOL_FLAGS: ReadonlySet<string> = new Set([
  "--silent",
  "-s",
  "--if-present",
  "--verbose",
  "-d",
  "--stream",
  "--ignore-scripts",
  "--offline",
  "--prefer-offline",
  "--frozen-lockfile",
  "--color",
  "--no-color",
  "--progress",
  "--unsafe-perm",
  "--dev",
  "--production",
  "-D",
]);

// ── finding 文案（模型可见，英文与母层一致） ──────────────────────────

const DYNAMIC_NAME_REASON =
  "the package script name is computed at runtime, so the script body that would execute cannot be verified statically";
const UNKNOWN_FLAG_REASON =
  "package manager arguments could not be parsed statically (unrecognized flag), so the script body that would execute is unknown";
const UNBOUNDED_SCOPE_REASON =
  "the set of packages whose scripts would run could not be bounded statically (recursive or name-based package selection)";
const DYNAMIC_SELECTOR_REASON =
  "the package selected by a directory flag is computed at runtime, so the script body that would execute cannot be verified statically";
const SELECTOR_UNREAD_REASON =
  "the scripts of the targeted package could not be read before execution, so the commands it would run are unknown";
const CWD_UNKNOWN_REASON =
  "the working directory was changed dynamically, so the nearest package.json (and the script body that would run) cannot be determined";
const CWD_MOVED_REASON =
  "after the working directory changed, no scanned package.json encloses the new directory, so the script body that would run is unknown";
/** 对抗验证 F1②：目标目录的最近包未被扫描覆盖，enclosing 命中可能是充数。 */
const NEAREST_UNSCANNED_REASON =
  "the nearest package.json for the target directory was not covered by the prefetch scan, so the script body that would run is unknown";
/** 对抗验证 F3：xargs payload 位/管道喂入的无名 run——名字来自 stdin。 */
const STDIN_NAME_REASON =
  "the package script name would be supplied via stdin (xargs or a pipe), so the script body that would execute cannot be verified statically";

/** 包管理器包运行子命令（payload 是另一个程序，按文本重新递归评估）。 */
const PACKAGE_RUNNER_SUBCOMMANDS: ReadonlySet<string> = new Set(["x", "exec", "dlx"]);

/**
 * run 族调用的管道语境（对抗验证 F3）：解包链是否含 xargs、该 invocation 是否
 * 处于管道喂入位。`echo clean | xargs npm run` 的无名 run 真会执行 `npm run clean`
 *（stdin 提供名字）——「无名 = 天然失败」只对裸命令成立。调用方传结构化字面量，
 * 类型不必导出（knip：未消费导出）。
 */
interface RunPipelineContext {
  readonly throughXargs: boolean;
  readonly receivesPipe: boolean;
}

// ── 入口 ─────────────────────────────────────────────────────────────

/**
 * AST 路径入口：`args` 是包管理器名之后的 token（`npm run clean` → ["run","clean"]）。
 * map 未注入（legacy）时维持收口前行为：不产生任何 finding（外层把 `run` 当普通
 * 程序继续评估，与收口前逐字节一致）。
 */
export function assessPackageManagerScriptRun(
  manager: string,
  args: readonly string[],
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
  depth: number,
  assessText: ScriptAssessor,
  pipeline?: RunPipelineContext,
): void {
  if (context.packageScripts === undefined) return;
  const invocation = parseManagerInvocation(manager, args);
  if (invocation.kind === "other") {
    // `bun x rimraf ~`：包运行器的 payload 是另一个程序——wrapper 解包循环不认 `x`
    //（exec/dlx 已在 WRAPPER_PROGRAMS，到不了这里），把剩余 token 拼成文本重新
    // 递归评估，堵住 `bun x rimraf ~` 的 safe 直通缺口；深度守卫由 assessText 负责
    //（超深时它产出 "nesting too deep" confirm，不静默）。
    if (invocation.runnerPayload !== undefined && invocation.runnerPayload.trim().length > 0) {
      assessText(invocation.runnerPayload, context, findings, depth + 1);
    }
    return;
  }
  if (invocation.unknownFlag) {
    // 未知旗标：解析可能错位（取值旗标的值会被误认成 script 名/子命令），任何
    // 「找到了 body」的结论都不可信——认不出来就升级（recall 偏向）。
    pushFinding(findings, { level: "confirm", reason: UNKNOWN_FLAG_REASON });
    return;
  }
  // 对抗验证 F3：`npm run`（无名）/`{}` 名在裸命令位是「用法错误、天然失败」，
  // 但 xargs payload 位与管道喂入位由 stdin 提供名字（`echo clean | xargs npm run`
  // 真实执行 `npm run clean`）——此刻静默放行就是 fail-open，升级 confirm。
  const stdinFedName = pipeline?.throughXargs === true || pipeline?.receivesPipe === true;
  if (invocation.scriptName === undefined) {
    if (stdinFedName) {
      pushFinding(findings, { level: "confirm", reason: STDIN_NAME_REASON });
    }
    return;
  }
  if (stdinFedName && invocation.scriptName.includes("{}")) {
    // `xargs -I{} npm run {}`：静态名落空（DYNAMIC_TOKEN_PATTERN 不含 {}），
    // xargs 会把 {} 替换成 stdin 行——按动态名口径 confirm。
    pushFinding(findings, { level: "confirm", reason: DYNAMIC_NAME_REASON });
    return;
  }

  if (DYNAMIC_TOKEN_PATTERN.test(invocation.scriptName)) {
    pushFinding(findings, { level: "confirm", reason: DYNAMIC_NAME_REASON });
    return;
  }

  const selection = selectScriptSources(invocation, context);
  if (selection.reason !== undefined) {
    pushFinding(findings, { level: "confirm", reason: selection.reason });
    return;
  }
  if (selection.sources.length === 0) return; // 命令天然失败（无包/无脚本）

  assessScriptBodies(invocation, selection.sources, context, findings, depth, assessText);
}

/** fallback token 的最小结构视图（fallback.ts 的 FallbackToken 未导出，结构兼容即可）。 */
interface FallbackTokenView {
  readonly text: string;
  readonly segmentStart: boolean;
  readonly redirect: string;
  /** 该段操作数来自上游管道输出（对抗验证 F3 的 fallback 口径需要）。 */
  readonly pipeFed?: boolean;
}

/**
 * 词法 fallback 路径入口：`tokens` 是 fallback token 流，`managerIndex` 指向包管理器
 * 词。subshell/if/while 包裹的 `npm run x` 不得因一层括号降级（母层 F-1 哲学）。
 * caller 已保证 manager 处于命令位（或其前是 wrapper 词）。
 */
export function assessPackageManagerScriptInFallback(
  tokens: readonly FallbackTokenView[],
  managerIndex: number,
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
  depth: number,
  assessText: ScriptAssessor,
  pipeline?: RunPipelineContext,
): void {
  if (context.packageScripts === undefined) return;
  const manager = programBasename(tokens[managerIndex]!.text);
  if (!PACKAGE_MANAGER_PROGRAMS.has(manager)) return;
  // 本段边界（`; && || |`、重定向目标、控制词）即止：后续是另一条命令的 token。
  const segment: string[] = [];
  for (let i = managerIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.segmentStart) break;
    if (token.redirect !== "none") break;
    if (SHELL_CONTROL_WORDS.has(token.text)) break;
    segment.push(token.text);
  }
  assessPackageManagerScriptRun(manager, segment, context, findings, depth, assessText, pipeline);
}

// ── 解析 ─────────────────────────────────────────────────────────────

const DYNAMIC_TOKEN_PATTERN = /[$`%*?]/;

interface ManagerInvocation {
  /** run 族 = 要查 scripts map；other = install/init 等 native 行为或无子命令。 */
  readonly kind: "run" | "other";
  /** 认不出的旗标（解析可能错位）→ fail-closed confirm。 */
  readonly unknownFlag: boolean;
  /** cwd 基准目录选择器值（--prefix/-C/--dir/--cwd，向上走语义）。 */
  readonly cwdSelectors: readonly string[];
  /** --filter/-F 的路径形值（workspaceRoot/cwd 双基准、精确匹配语义）。 */
  readonly filterPathSelectors: readonly string[];
  /** bare `-w`（pnpm/yarn/bun 工作区根包）：按 workspaceRoot 目录选择器解析。 */
  readonly workspaceRootSelector: boolean;
  /** 名字形工作区选择器/递归范围：目标包集合不可界。 */
  readonly unboundedScope: boolean;
  readonly scriptName?: string;
  /** script 名之后的转发参数（npm 把它们拼到 script 命令尾部）。 */
  readonly scriptArgs: readonly string[];
  /** 包运行子命令（x/exec/dlx）的 payload 文本。 */
  readonly runnerPayload?: string;
  /** 对抗验证 F6：带 `--if-present` 时 main 缺失仍评估 pre/post（npm 真会跑钩子）。 */
  readonly ifPresent: boolean;
}

interface ParsedInvocation extends ManagerInvocation {
  readonly cwdSelectors: string[];
  readonly filterPathSelectors: string[];
}

function parseManagerInvocation(manager: string, args: readonly string[]): ParsedInvocation {
  const cwdSelectors: string[] = [];
  const filterPathSelectors: string[] = [];
  let unknownFlag = false;
  let unboundedScope = false;
  let workspaceRootSelector = false;
  // 对抗验证 F6：`npm run x --if-present` 在 x 缺失时静默跳过（钩子仍跑）。
  let ifPresent = false;
  let index = 0;
  let subcommand: string | undefined;

  // 前缀旗标区（到第一个位置参数或 `--` 为止）。
  while (index < args.length) {
    const token = args[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (!isFlagToken(token)) {
      subcommand = token;
      index += 1;
      break;
    }
    const eq = token.indexOf("=");
    if (eq > 0) {
      const name = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (DIR_SELECTOR_FLAGS.has(name)) cwdSelectors.push(value);
      else if (FILTER_SELECTOR_FLAGS.has(name)) {
        if (isPathLikeFilterValue(value)) filterPathSelectors.push(value);
        else unboundedScope = true; // `--filter=web`（包名字形）：目标包静态不可界
      } else if (WORKSPACE_NAME_FLAGS.has(name)) unboundedScope = true;
      else if (!MISC_VALUE_FLAGS.has(name) && !MISC_BOOL_FLAGS.has(name)) unknownFlag = true;
      index += 1;
      continue;
    }
    if (DIR_SELECTOR_FLAGS.has(token)) {
      const value = args[index + 1];
      if (value === undefined) {
        unknownFlag = true;
      } else {
        cwdSelectors.push(value);
        index += 1;
      }
    } else if (FILTER_SELECTOR_FLAGS.has(token)) {
      const value = args[index + 1];
      if (value === undefined) {
        unknownFlag = true;
      } else {
        if (isPathLikeFilterValue(value)) filterPathSelectors.push(value);
        else unboundedScope = true; // `--filter web`（包名字形）：目标包静态不可界
        index += 1;
      }
    } else if (token.startsWith("-C") && token.length > 2) {
      // 对抗验证 F5：`pnpm -Cpackages/x run evil` 的粘连形与空格形同口径拆值——
      // 预取端正则本就支持粘连，模块端只认精确 token 会让同一形态两侧结论漂移。
      cwdSelectors.push(token.slice(2));
    } else if (token.startsWith("-F") && token.length > 2) {
      // 粘连形 `pnpm -F./packages/x run evil`：与 `--filter` 空格形同一双语义。
      const value = token.slice(2);
      if (isPathLikeFilterValue(value)) filterPathSelectors.push(value);
      else unboundedScope = true; // `--filter web`（包名字形）：目标包静态不可界
    } else if (token === "-w" && manager !== "npm") {
      // pnpm/yarn/bun 的 bare `-w` = 工作区根包（不取值）：按 workspaceRoot 目录
      // 选择器解析（selectScriptSources 内做 enclosing 匹配）；workspaceRoot 不可知
      // 时按范围不可界 confirm。
      workspaceRootSelector = true;
    } else if (WORKSPACE_NAME_FLAGS.has(token)) {
      // `--workspace <name>` / `npm -w <name>`：名字形选择器，目标包集合静态不可界。
      unboundedScope = true;
      if (args[index + 1] !== undefined && !isFlagToken(args[index + 1]!)) index += 1;
    } else if (RECURSIVE_SCOPE_FLAGS.has(token)) {
      // `pnpm -r run x` 在所有工作区包里跑：范围不可静态界（fail-closed）。
      unboundedScope = true;
    } else if (MISC_VALUE_FLAGS.has(token)) {
      if (args[index + 1] === undefined) unknownFlag = true;
      else index += 1;
    } else if (MISC_BOOL_FLAGS.has(token)) {
      // 布尔旗标；--if-present 另行登记（对抗验证 F6：main 缺失时钩子是否评估）。
      if (token === "--if-present") ifPresent = true;
    } else {
      unknownFlag = true;
    }
    index += 1;
  }

  const scriptArgs: string[] = [];
  let runnerPayload: string | undefined;
  let kind: "run" | "other" = "other";
  let scriptName: string | undefined;

  if (subcommand !== undefined) {
    if (subcommand === "run" || (manager === "npm" && subcommand === "run-script")) {
      // run 级旗标区（`npm run --silent clean`）——认不出的旗标同样 fail-closed。
      while (index < args.length) {
        const token = args[index]!;
        if (token === "--") {
          index += 1;
          break;
        }
        if (!isFlagToken(token)) break;
        if (token.includes("=") || MISC_BOOL_FLAGS.has(token)) {
          if (token === "--if-present") ifPresent = true; // 对抗验证 F6
          index += 1;
          continue;
        }
        unknownFlag = true;
        index += 1;
      }
      // 对抗验证 F3：run 后无名字也按 run 族登记（kind=run + scriptName=undefined）
      // ——无名在裸命令位是「用法错误天然失败」，但 xargs/管道位由 stdin 提供名字
      //（见 assessPackageManagerScriptRun）；留在 kind=other 会提前返回、漏掉该升级。
      kind = "run";
      if (index < args.length) {
        scriptName = args[index]!;
        scriptArgs.push(...args.slice(index + 1));
        // 对抗验证 F6：`npm run x --if-present` 的旗标在名字之后（npm 选项可任意
        // 位置）；`--` 之后是转发给 script 的参数，不再算 npm 旗标。
        for (const token of scriptArgs) {
          if (token === "--") break;
          if (token === "--if-present") ifPresent = true;
        }
      }
    } else if (manager === "npm" && NPM_RUN_ALIASES.has(subcommand)) {
      scriptName = subcommand;
      scriptArgs.push(...args.slice(index));
      kind = "run";
    } else if (PACKAGE_RUNNER_SUBCOMMANDS.has(subcommand)) {
      // 包运行器 payload（`bun x rimraf ~`；exec/dlx 通常已被 wrapper 解包消费，
      // 这里兜底覆盖「包管理器 + 运行子命令」的全部拼写）。
      runnerPayload = args.slice(index).join(" ");
    } else if (
      (manager === "pnpm" || manager === "yarn" || manager === "bun") &&
      !NATIVE_MANAGER_VERBS[manager]?.has(subcommand)
    ) {
      // pnpm/yarn/bun 裸名直呼 = `run <名>`（native 动词除外）。
      scriptName = subcommand;
      scriptArgs.push(...args.slice(index));
      kind = "run";
    }
  }

  return {
    kind,
    unknownFlag,
    cwdSelectors,
    filterPathSelectors,
    workspaceRootSelector,
    unboundedScope,
    scriptName,
    scriptArgs,
    runnerPayload,
    ifPresent,
  };
}

function isPathLikeFilterValue(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.includes("/") ||
    value.includes("\\")
  );
}

// ── 目标包选择（纯查表，无 IO） ──────────────────────────────────────

interface ScriptSourceSelection {
  /** 要评估 body 的 source；空 = 命令天然失败（safe 直通）。 */
  readonly sources: readonly PackageScriptSource[];
  /** 非 undefined = fail-closed confirm 的理由。 */
  readonly reason?: string;
}

function selectScriptSources(
  invocation: ParsedInvocation,
  context: TargetRiskContext,
): ScriptSourceSelection {
  const sources = context.packageScripts ?? [];
  if (context.trackedCwd?.unresolved === true) {
    return { sources: [], reason: CWD_UNKNOWN_REASON };
  }
  const effectiveCwd = effectiveTrackedCwd(context);

  if (
    invocation.cwdSelectors.length === 0 &&
    invocation.filterPathSelectors.length === 0 &&
    !invocation.workspaceRootSelector
  ) {
    if (invocation.unboundedScope) return { sources: [], reason: UNBOUNDED_SCOPE_REASON };
    // 无选择器：按 npm 向上走语义取「包住当前 cwd 的最深已注入包」。
    if (effectiveCwd === undefined) return { sources: [], reason: CWD_UNKNOWN_REASON };
    const enclosing = deepestEnclosingSource(sources, effectiveCwd, context.platform);
    if (enclosing !== undefined) {
      // 对抗验证 F1②：enclosing 只是「已扫描 source 中最近」，不必然是「npm 真实
      // 最近」——`cd sub` 落进未扫描子包时拿根包 map 充数会静默放行 body 灾难命令。
      // 无法证明没有更近的 package.json 时不放行。
      if (!scanCoverageProven(context, effectiveCwd, enclosing)) {
        return { sources: [], reason: NEAREST_UNSCANNED_REASON };
      }
      return { sources: [enclosing] };
    }
    // cwd 未离开预取基准且预取确认向上无包 → npm run 天然失败（safe）；
    // cwd 被 cd 到未扫描区域 → 最近 package.json 不可知（fail-closed）。
    const initial = initialTrackedCwd(context).resolved;
    if (initial === undefined || initial !== effectiveCwd) {
      return { sources: [], reason: CWD_MOVED_REASON };
    }
    return { sources: [] };
  }

  // 选择器形态：任何动态值/不可解析基准 → confirm；静态值逐个解析后取命中的 source。
  const allSelectors = [...invocation.cwdSelectors, ...invocation.filterPathSelectors];
  if (allSelectors.some((value) => DYNAMIC_TOKEN_PATTERN.test(value))) {
    return { sources: [], reason: DYNAMIC_SELECTOR_REASON };
  }
  if (effectiveCwd === undefined) return { sources: [], reason: CWD_UNKNOWN_REASON };

  const matched: PackageScriptSource[] = [];
  let nearestUnproven = false;
  const addMatch = (source: PackageScriptSource | undefined): void => {
    if (source !== undefined && !matched.includes(source)) matched.push(source);
  };

  // 目录选择器（-C/--dir/--prefix/--cwd，bare -w）：「在该目录启动包管理器」，
  // npm/pnpm 从那里向上走找 package.json → enclosing（最深）语义。
  const dirSelectors = invocation.workspaceRootSelector
    ? invocation.cwdSelectors.concat(
        context.workspaceRoot?.trim() ? [context.workspaceRoot.trim()] : [],
      )
    : invocation.cwdSelectors;
  if (invocation.workspaceRootSelector && !context.workspaceRoot?.trim()) {
    return { sources: [], reason: UNBOUNDED_SCOPE_REASON };
  }
  for (const value of dirSelectors) {
    const target = joinDirectory(effectiveCwd, value, context.platform);
    const enclosing = deepestEnclosingSource(sources, target, context.platform);
    if (enclosing === undefined) continue; // → matched 为空 → SELECTOR_UNREAD confirm
    // 对抗验证 F1②：选择器目标目录的 enclosing 命中同样需要扫描覆盖证明；
    // 目标不匹配任何 source 且未被覆盖时**禁止回落 enclosing**（嵌套 body 错位的
    // 根因：`--dir sub` 评成根包 map 的同名 script）。宁多 confirm 不误评错 body。
    if (!scanCoverageProven(context, target, enclosing)) {
      nearestUnproven = true;
      continue;
    }
    addMatch(enclosing);
  }
  // `--filter ./x`（pnpm）：按「包目录 = 该路径」精确匹配（相对基准存在 cwd/
  // workspaceRoot 双口径，双基准都试——宁多不少，误读方向只是多评一次 body）。
  for (const value of invocation.filterPathSelectors) {
    if (context.workspaceRoot?.trim()) {
      addMatch(
        exactSource(
          sources,
          joinDirectory(normalizeRuntimePath(context.workspaceRoot, context.platform), value, context.platform),
          context.platform,
        ),
      );
    }
    addMatch(exactSource(sources, joinDirectory(effectiveCwd, value, context.platform), context.platform));
  }

  if (nearestUnproven) {
    // 对抗验证 F1②：任何选择器目标的覆盖证明缺失 → confirm（宁多不少的反面是
    // 「评了一半、漏了另一半」——漏的那一半可能才是 npm 真实执行的包）。
    return { sources: [], reason: NEAREST_UNSCANNED_REASON };
  }
  if (matched.length === 0) {
    // 静态选择器指向的包不可读/不存在：npm/pnpm 端该命令多半也会失败，但
    // 「选择器可达而 body 不可见」不得静默放行（spec R3 fail-closed 条目）。
    return { sources: [], reason: SELECTOR_UNREAD_REASON };
  }
  return { sources: matched };
}

/**
 * 对抗验证 F1②：目标目录的「最近包已扫描」覆盖证明。
 * - `scannedDirectories` 缺省（legacy 调用方/单测直注入 map）→ 维持 enclosing 信任
 *   （现行为）；生产链路（executor 预取）总是提供；
 * - 提供时：目标目录本身在覆盖内，或命中 source 就在目标目录（读出该 source 必然
 *   读过它）→ 覆盖成立；否则 enclosing 是充数嫌疑 → confirm。
 */
function scanCoverageProven(
  context: TargetRiskContext,
  targetDir: string,
  enclosing: PackageScriptSource,
): boolean {
  const scanned = context.scannedDirectories;
  if (scanned === undefined) return true;
  const fold = comparisonFold(context.platform);
  const normalizedTarget = fold(normalizeRuntimePath(targetDir, context.platform));
  if (
    enclosing !== undefined &&
    fold(normalizeRuntimePath(enclosing.directory, context.platform)) === normalizedTarget
  ) {
    return true;
  }
  return scanned.some(
    (dir) => fold(normalizeRuntimePath(dir, context.platform)) === normalizedTarget,
  );
}

/** win32/darwin 宿主路径大小写不敏感（与 paths.ts 的比较口径一致）。 */
function comparisonFold(platform: string | undefined): (value: string) => string {
  return platform === "win32" || platform === "darwin"
    ? (value) => value.toLowerCase()
    : (value) => value;
}

/** 当前生效 cwd（段级跟踪优先）：已归一化的比较形态。 */
function effectiveTrackedCwd(context: TargetRiskContext): string | undefined {
  const tracked = context.trackedCwd?.unresolved === false ? context.trackedCwd.resolved : undefined;
  if (tracked?.trim()) return tracked;
  const base = context.workingDirectory?.trim() || context.workspaceRoot?.trim();
  return base ? normalizeRuntimePath(base, context.platform) : undefined;
}

/**
 * 包住 dir 的最深已注入 source（npm 向上走语义：目录本身命中也算）。
 * win32/darwin 宿主路径大小写不敏感（与 paths.ts 的 comparisonFold 同一口径）。
 */
function deepestEnclosingSource(
  sources: readonly PackageScriptSource[],
  dir: string,
  platform: string | undefined,
): PackageScriptSource | undefined {
  const fold = (value: string): string =>
    platform === "win32" || platform === "darwin" ? value.toLowerCase() : value;
  const foldedDir = fold(dir);
  let best: PackageScriptSource | undefined;
  let bestLength = -1;
  for (const source of sources) {
    const normalized = fold(normalizeRuntimePath(source.directory, platform));
    if (normalized === foldedDir || foldedDir.startsWith(`${normalized}/`)) {
      if (normalized.length > bestLength) {
        best = source;
        bestLength = normalized.length;
      }
    }
  }
  return best;
}

/** 目录选择器的精确命中（--filter：包目录 = 该路径，pnpm 不做向上走）。 */
function exactSource(
  sources: readonly PackageScriptSource[],
  dir: string,
  platform: string | undefined,
): PackageScriptSource | undefined {
  const fold = (value: string): string =>
    platform === "win32" || platform === "darwin" ? value.toLowerCase() : value;
  const foldedDir = fold(dir);
  return sources.find((source) => fold(normalizeRuntimePath(source.directory, platform)) === foldedDir);
}

/** 相对选择器值拼接（`.`/`..` 交给词法 fold 消除；绝对值直接归一化）。 */
function joinDirectory(base: string, value: string, platform: string | undefined): string {
  const trimmed = stripSelectorQuotes(value.trim());
  if (trimmed.length === 0) return base;
  if (trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return normalizeRuntimePath(trimmed, platform);
  }
  return normalizeRuntimePath(`${base}/${trimmed}`, platform);
}

/** 选择器值剥包裹引号（`--filter "./packages/x"` 的引号是 shell 语法不是值）。 */
function stripSelectorQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// ── body 评估 ────────────────────────────────────────────────────────

function assessScriptBodies(
  invocation: ParsedInvocation,
  sources: readonly PackageScriptSource[],
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
  depth: number,
  assessText: ScriptAssessor,
): void {
  const name = invocation.scriptName!;
  const forwarded = invocation.scriptArgs.join(" ");
  for (const source of sources) {
    const main = source.scripts[name];
    const pre = source.scripts[`pre${name}`];
    const post = source.scripts[`post${name}`];
    // 对抗验证 F6：main 不在 map 且未带 --if-present → npm 报 Missing script 直接
    // 退出，pre/post 钩子不会执行——评估它们是过严误报（F4 同族），跳过。
    // --if-present 语境保留评估（npm 静默跳过缺失的 main，但钩子仍按注册顺序跑）。
    if (main === undefined && !invocation.ifPresent) continue;
    if (main === undefined && pre === undefined && post === undefined) continue;
    // npm scripts 以包根为 cwd（HIGH-1 trackedCwd 同一通道）：body 内相对目标按包根
    // 定基；map 留在 context 里，body 内嵌套 `npm run other` 经同一 map 继续递归。
    const bodyContext: TargetRiskContext = {
      ...context,
      trackedCwd: {
        resolved: normalizeRuntimePath(source.directory, context.platform),
        unresolved: false,
      },
    };
    // 执行顺序 pre → main → post（npm 生命周期）；转发参数只拼进 main。
    if (pre !== undefined) assessText(pre, bodyContext, findings, depth + 1);
    if (main !== undefined) {
      assessText(
        forwarded.length > 0 ? `${main} ${forwarded}` : main,
        bodyContext,
        findings,
        depth + 1,
      );
    }
    if (post !== undefined) assessText(post, bodyContext, findings, depth + 1);
  }
}

// ── fallback 挂点辅助 ────────────────────────────────────────────────

/**
 * fallback 主循环用：该 token 是否应触发 run 族解析——命令位（段首/文本首/控制词后）
 * 或前一个非旗标词是 wrapper（`sudo npm run x` 在 fallback 里没有解包循环）。
 */
export function isPackageManagerAtRunnablePosition(
  managerToken: string,
  previousToken: string | undefined,
  atCommandPosition: boolean,
): boolean {
  if (!PACKAGE_MANAGER_PROGRAMS.has(programBasename(managerToken))) return false;
  if (atCommandPosition) return true;
  return previousToken !== undefined && WRAPPER_PROGRAMS.has(programBasename(previousToken));
}
