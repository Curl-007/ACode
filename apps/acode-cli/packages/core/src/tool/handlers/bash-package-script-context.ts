// Bash 权限链路的 package.json scripts 异步预取（R6 边界⑥收口）。
// 规格见 apps/acode-cli/specs/npm-script-body-scan.md R1（谁预取/谁注入/纯模块边界）。
//
// 定位：本文件是**接线层**，是 bash-target-risk 零 IO 宪法之外唯一做文件读取的地方。
// 预取结果经 ToolEntry.resolvePermissionCapabilityContextAsync 注入
// ToolRuntimePermissionCapabilityContext.packageScripts，executor 在
// resolveToolPermission / hook 改写复核中 await 它——生产链路保证「cwd 可达
// package.json 时 map 一定注入」。
//
// 预取纪律（spec R1）：
// - 宽匹配：从命令原文正则提取目录选择器与 cd/pushd 目标候选，宁多读不少读；少读了
//   会 fail-closed（纯模块对「静态选择器但无 source」「目标目录未被扫描覆盖」升
//   confirm），不会 fail-open；
// - cd/pushd 目标提取（对抗验证 F1①）：npm 的就近语义跟的是执行时 cwd，
//   `cd sub && npm run clean` 的最近包在 sub 里——只从初始 cwd 向上走会漏读子包，
//   模块端拿根包 map 充数判 safe（yolo 静默放行 body 灾难命令）；
// - body 第二遍扫描（对抗验证 F1①）：嵌套 body（`release:cli`=`pnpm --dir sub run
//   release`）里的选择器目标是 npm 真实会执行的包，只在命令原文提取会漏；
// - 坏 JSON/超限向上走止于该层（对抗验证 F4）：npm 读到的是这份坏文件、命令天然
//   失败——越过它改用更上层包的 map 是过严误报；
// - 异步读（node:fs/promises，handler 层既有先例 bash-cwd-policy.ts）、容错不抛：
//   任何失败只损失条目，绝不阻断权限链路；
// - 大小上限 1 MiB、向上走深度上限 64 级、source 总量上限 12（超限登记为边界）；
// - 返回 scannedDirectories（实际读过/走过的目录）：模块端 F1② 覆盖证明的证据；
//   source 超限被丢弃时该次向上走的目录区间不记入（覆盖与注册必须同源）；
// - 绝不读取/返回 scripts 以外的 package.json 内容（凭据最小化：scripts 本就是
//   要在 shell 里执行的命令文本，注入面与既有命令文本同权）。

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { PackageScriptSource } from "./bash-target-risk/index.js";
import { PACKAGE_MANAGER_PROGRAMS } from "./bash-target-risk/index.js";

/** package.json 大小上限：超限视为不可解析（spec R2），不产生 source。 */
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
/** npm 自己向上走到文件系统根；64 级深度上限是登记边界（spec R7）。 */
const MAX_WALK_DEPTH = 64;
/** source 总量上限：最近 1 个 + 选择器候选若干，防病态命令拖垮预取。 */
const MAX_SOURCES = 12;
/** 选择器候选上限：超出部分直接丢弃（模块端对缺失候选 fail-closed）。 */
const MAX_SELECTOR_VALUES = 8;

/** 命令里出现任一包管理器词才值得做 IO（廉价预过滤，词边界防止误伤普通文本）。 */
const PACKAGE_MANAGER_WORD_PATTERN = new RegExp(
  `\\b(?:${[...PACKAGE_MANAGER_PROGRAMS].join("|")})\\b`,
);

/** `--flag=value` 形态的选择器候选提取。 */
const SELECTOR_EQ_PATTERN =
  /(?:^|[\s;&|(])(--filter|--dir|--prefix|--cwd)=(?:"([^"]*)"|'([^']*)'|([^\s;&|"'`]+))/g;
/** `--flag value` 与粘连 `-Cpath`/`-Fpath` 形态的选择器候选提取。 */
const SELECTOR_SPACE_PATTERN =
  /(?:^|[\s;&|(])(--filter|--dir|--prefix|--cwd|-C|-F)\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|"'`]+))|(?:^|[\s;&|(])-([CF])(?![-\s=&])([^\s;&|"'`]+)/g;
/** `cd <dir>`/`pushd <dir>` 目标提取（对抗验证 F1①；宽匹配，含子壳/`sh -c` 内层）。
 * 边界类含引号字符：`sh -c "cd sub && …"` 的 cd 紧跟开引号，漏了会把 sh -c 变体
 * 拱手让给模块端 confirm（过严方向的摩擦，这里按 ① 就地闭合）。 */
const CD_TARGET_PATTERN = /(?:^|[\s;&|("'])(?:cd|pushd)\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|"'`]+))/g;

/** 预取入参（内部形态；knip：只在同文件消费，不导出）。 */
interface BashPackageScriptContextOptions {
  readonly workingDirectory?: string;
  readonly workspaceRoot?: string;
}

/** 预取结果：sources 注入模块端查表；scannedDirectories 是 F1② 覆盖证明的证据。 */
interface BashPackageScriptPrefetch {
  readonly sources: readonly PackageScriptSource[];
  readonly scannedDirectories: readonly string[];
}

/**
 * 预取入口：返回要注入的 scripts sources 与扫描覆盖证据。sources 为空数组 =
 * 调用方确认向上不存在可解析的 package.json。绝不抛错。
 */
export async function collectBashPackageScriptSources(
  command: string,
  options: BashPackageScriptContextOptions,
): Promise<BashPackageScriptPrefetch> {
  try {
    if (!command || !PACKAGE_MANAGER_WORD_PATTERN.test(command)) {
      return { sources: [], scannedDirectories: [] };
    }
    const base = options.workingDirectory?.trim() || options.workspaceRoot?.trim();
    if (!base) return { sources: [], scannedDirectories: [] };

    const sources: PackageScriptSource[] = [];
    // 覆盖证据：只有「读到可解析包并注册」或「走到根/深度上限确无包」的向上走，
    // 其走过的目录才算覆盖（对抗验证 F1②）。
    const scanned = new Set<string>();
    const seen = new Set<string>();
    // 注册失败（超限丢弃）→ 返回 false：本次向上走的目录区间整体失权。
    const add = (source: PackageScriptSource): boolean => {
      if (sources.length >= MAX_SOURCES) return false;
      const key = source.directory.replaceAll("\\", "/").toLowerCase();
      if (seen.has(key)) return true;
      seen.add(key);
      sources.push(source);
      return true;
    };

    // 最近 package.json：npm 的 scripts 以「从 cwd 向上走找到的最近 package.json」
    // 为准（会越过 workspaceRoot 直到文件系统根，spec R2）。
    await walkForNearest(base, add, scanned);

    // 目录选择器候选：`pnpm --filter ./packages/x run …`、`npm --prefix ./server run …`
    // 等。宽匹配提取（其它工具的同名旗标只会多读一个 package.json，无害）。
    // cd/pushd 目标候选（对抗验证 F1①）：npm 就近语义跟执行时 cwd。
    const commandCandidates = [
      ...extractSelectorValues(command),
      ...extractCdTargets(command),
    ];
    for (const value of commandCandidates) {
      const dirs = candidateDirectories(value, base, options.workspaceRoot?.trim());
      for (const dir of dirs) await walkForNearest(dir, add, scanned);
    }

    // body 第二遍扫描（对抗验证 F1①）：嵌套 body 里的选择器/cd 目标是 npm 真实
    // 会执行的包。迭代到无新 source；MAX_SOURCES 与去重约束总量。
    const bodyScanned = new Set<string>();
    for (let guard = 0; guard <= MAX_SOURCES; guard += 1) {
      const pending = sources.filter((source) => !bodyScanned.has(keyOf(source)));
      if (pending.length === 0) break;
      for (const source of pending) {
        bodyScanned.add(keyOf(source));
        const bodyText = Object.values(source.scripts).join("\n");
        if (bodyText.trim().length === 0) continue;
        const bodyCandidates = [
          ...extractSelectorValues(bodyText),
          ...extractCdTargets(bodyText),
        ];
        for (const value of bodyCandidates) {
          // body 以包根为 cwd（npm 语义）：body 内相对目标按该包根解析。
          const dirs = candidateDirectories(value, source.directory, options.workspaceRoot?.trim());
          for (const dir of dirs) await walkForNearest(dir, add, scanned);
        }
      }
    }
    return { sources, scannedDirectories: [...scanned] };
  } catch {
    // 预取失败 = 上下文缺席 = 各消费点按 legacy 语义判定；绝不阻断权限链路。
    return { sources: [], scannedDirectories: [] };
  }
}

function keyOf(source: PackageScriptSource): string {
  return source.directory.replaceAll("\\", "/").toLowerCase();
}

/** package.json 单层读取结果（missing 才继续向上走；invalid 止走，对抗验证 F4）。 */
type PackageReadResult =
  | { readonly status: "missing" }
  | { readonly status: "invalid" }
  | { readonly status: "ok"; readonly source: PackageScriptSource };

/**
 * 从 dir 向上找最近的 package.json（每层至多一次读取）。
 * - ok：注册后把本段走过的目录记入覆盖证据；注册被拒（超限丢弃）→ 整段失权
 *   （覆盖与注册同源，模块端对该区间 fail-closed）；
 * - invalid（坏 JSON/超限/scripts 非对象）：止走（npm 读到的是这份坏文件、天然
 *   失败，对抗验证 F4），本段不产生覆盖证据；
 * - 走到根/深度上限确无包：走过的目录全部记入覆盖证据（证明「无包」本身）。
 */
async function walkForNearest(
  start: string,
  add: (source: PackageScriptSource) => boolean,
  scanned: Set<string>,
): Promise<void> {
  const walked: string[] = [];
  let current = start;
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    walked.push(current);
    const found = await readPackageScripts(current);
    if (found.status === "ok") {
      if (add(found.source)) for (const dir of walked) scanned.add(dir);
      return;
    }
    if (found.status === "invalid") return; // 对抗验证 F4：止走，不越过坏文件
    const parent = dirname(current);
    if (parent === current) break; // 文件系统根
    current = parent;
  }
  for (const dir of walked) scanned.add(dir);
}

/** 读取 dir/package.json 的 scripts；missing=无文件，invalid=坏 JSON/超限/非字符串 map。 */
async function readPackageScripts(directory: string): Promise<PackageReadResult> {
  const file = join(directory, "package.json");
  let raw: string;
  try {
    const buffer = await readFile(file);
    if (buffer.byteLength > MAX_PACKAGE_JSON_BYTES) return { status: "invalid" };
    raw = buffer.toString("utf8");
  } catch {
    return { status: "missing" }; // ENOENT 等按「此处无包」继续向上走
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { status: "invalid" };
    const scripts = (parsed as Record<string, unknown>).scripts;
    if (scripts === undefined) return { status: "ok", source: { directory, scripts: {} } };
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
      return { status: "invalid" };
    }
    const map: Record<string, string> = {};
    for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof value === "string") map[name] = value;
    }
    return { status: "ok", source: { directory, scripts: map } };
  } catch {
    // 坏 JSON：npm 读到的就是这份文件、命令天然失败（spec R3）——止走不放行到上层。
    return { status: "invalid" };
  }
}

/** 从命令原文宽匹配提取选择器值（剥引号；动态值留给模块端 fail-closed）。 */
function extractSelectorValues(command: string): string[] {
  const values: string[] = [];
  const push = (raw: string | undefined): void => {
    if (!raw) return;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    if (!values.includes(trimmed) && values.length < MAX_SELECTOR_VALUES) values.push(trimmed);
  };
  for (const match of command.matchAll(SELECTOR_EQ_PATTERN)) {
    push(match[2] ?? match[3] ?? match[4]);
  }
  for (const match of command.matchAll(SELECTOR_SPACE_PATTERN)) {
    // 空格形态：旗标后三选一的值（dq/sq/裸）；粘连形态：`-C`/`-F` + 紧跟路径——
    // 值只取路径段（对抗验证 F5 同口径：把旗标字母并进值会解析出 `Cpackages/x`
    // 这类错误目录，恰好漏掉真实选择器目标的覆盖）。
    push(
      match[2] ??
        match[3] ??
        match[4] ??
        (match[5] !== undefined ? match[6] : undefined),
    );
  }
  return values;
}

/**
 * cd/pushd 目标提取（对抗验证 F1①）。宽匹配纪律与选择器一致：`cd sub`、
 * `cd ./sub`、`cd "sub"`、子壳/`sh -c` 内层都提取；动态值（`cd $D`）、`cd -`
 *（OLDPWD）、`-` 开头的旗标形提取失败静默跳过——这些落点静态不可知，由模块端
 * F1② 覆盖证明（trackedCwd unresolved / 目标未覆盖 → confirm）兜底。
 */
function extractCdTargets(command: string): string[] {
  const values: string[] = [];
  for (const match of command.matchAll(CD_TARGET_PATTERN)) {
    const raw = match[1] ?? match[2] ?? match[3];
    if (!raw) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("-")) continue;
    if (/[$`%*?]/.test(trimmed)) continue; // 动态落点：模块端 unresolved → confirm
    if (!values.includes(trimmed) && values.length < MAX_SELECTOR_VALUES) values.push(trimmed);
  }
  return values;
}

/** 选择器值 → 候选目录（相对值按 cwd 与 workspaceRoot 双基准，与模块端同一口径）。 */
function candidateDirectories(value: string, base: string, workspaceRoot?: string): string[] {
  const stripped = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  if (isAbsolute(stripped) || /^[a-zA-Z]:[\\/]/.test(stripped)) return [stripped];
  const dirs = [resolve(base, stripped)];
  if (workspaceRoot) {
    const rootResolved = resolve(workspaceRoot, stripped);
    if (!dirs.includes(rootResolved)) dirs.push(rootResolved);
  }
  return dirs;
}
