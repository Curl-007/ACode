// 旁路免疫熔断器（安全加固 P2）。
//
// 一组内置的危险动作检查：**即使 yolo/bypass 也强制降级为 ask**。把「yolo = 无条件放行」
// 改成「yolo = 放行除熔断器外的一切」。规格见
// apps/acode-cli/specs/managed-policy-floor-and-bypass-immune-breakers.md R2
// 与 apps/acode-cli/specs/bash-target-blast-radius.md R5（J1-1 新增 deny 级命中类）。
//
// 设计约束：
// - 纯函数、无 IO、不依赖配置——熔断器是代码内不变量，策略地板只能额外收紧、不能放松它。
// - 只降级、永不放宽：调用方（PermissionService）保证本模块的命中只会把决策改严。
// - 命中分两级（J1-1 起）：
//   · ask 级（缺省，既有三类）：保留用户「我知道我在做什么」的最终决定权，与既有
//     ask 语义一致；decision 已是 ask 时不覆写原 ruleId。
//   · deny 级（behavior: "deny"，仅 catastrophic 目标档）：「永不执行、任何论证不
//     解锁」，把 allow 与 ask 一并降级为 deny——deny 比两者都严，不违反上一条不变量。
//     用户最终决定权的体现是工具拒绝充当执行载体，用户仍可在工具外自行执行。
// - 本模块**从不执行**任何外部程序：只对工具入参字符串做静态判定。Bash 文本的结构分析
//   委托给既有的 bash-command-parser（unbash AST），本模块只消费其纯数据结果；
//   目标 blast-radius 分级委托给 bash-target-risk（同为纯函数）。
import { homedir } from "node:os";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import {
  analyzeBashCommand,
  extractForcedDeleteCandidates,
} from "../tool/handlers/bash-command-parser.js";
import { assessBashCommandTargetRisk } from "../tool/handlers/bash-target-risk/index.js";
import type { PackageScriptSource } from "../tool/handlers/bash-target-risk/types.js";
import type { PermissionContext } from "./service.js";

export interface BypassImmuneBreakerHit {
  readonly ruleId: string;
  readonly reason: string;
  /** 缺省 "ask"（只降级 allow）；"deny" 为 J1-1 catastrophic 目标档的绝对拒绝。 */
  readonly behavior?: "ask" | "deny";
}

export interface BypassImmuneBreakerContext {
  readonly toolName: string;
  readonly input: unknown;
  readonly workingDirectory?: string;
  readonly workspaceRoot?: string;
  /**
   * npm/pnpm/yarn/bun run 的 package.json scripts 预解析 map（R6 边界⑥收口）。
   * breaker 是纯函数：script body 只能由调用方（PermissionService，map 来自 executor
   * 的异步预取）喂进来——没有它，「npm run clean（body=rimraf ~）」在 yolo 下没有任何
   * deny 通道（capability critical 不影响 yolo 直通，实测确认）。缺省 = legacy 调用方，
   * body 不可见，维持收口前行为（spec npm-script-body-scan.md R4/R6）。
   */
  readonly packageScripts?: readonly PackageScriptSource[];
  /**
   * 预取实际读过/走过的目录（扫描覆盖证据，对抗验证 F1②）。与 packageScripts
   * 同源：目标目录的 enclosing 命中只有被它覆盖才可信任（`cd sub` 落进未扫描子包
   * 时根包 map 充数会漏掉 deny）。缺省 = legacy 调用方，维持 enclosing 信任。
   */
  readonly scannedDirectories?: readonly string[];
}

/**
 * 按 R3 顺序评估熔断器，返回第一个命中；无命中返回 undefined。
 * J1-1 的 catastrophic 目标档排在最前（deny 严于 ask，首命中即最严命中）；
 * 既有三类的相对顺序与 ruleId 保持不变。
 */
export function evaluateBypassImmuneBreakers(
  context: BypassImmuneBreakerContext,
): BypassImmuneBreakerHit | undefined {
  return (
    checkCatastrophicBashTarget(context) ??
    checkForcedRootDelete(context) ??
    checkPathEscapeWrite(context) ??
    checkSensitiveRead(context)
  );
}

// ── 类 4（J1-1）：catastrophic 目标 blast-radius ─────────────────────

function checkCatastrophicBashTarget(
  context: BypassImmuneBreakerContext,
): BypassImmuneBreakerHit | undefined {
  if (context.toolName !== "Bash") return undefined;
  const bashText = stringField(context.input, "command");
  if (!bashText) return undefined;

  const assessment = assessBashCommandTargetRisk(bashText, {
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
    homeDirectory: homedir(),
    platform: process.platform,
    // R6 边界⑥收口（spec npm-script-body-scan.md R4）：script body 的 catastrophic
    //（`npm run clean` 且 body=`rimraf ~`）走同一个 deny 级命中类，ruleId 仍是
    // `breaker.bashTargetCatastrophic`——命中路径经 script body 发现不改变类别。
    ...(context.packageScripts ? { packageScripts: context.packageScripts } : {}),
    // 对抗验证 F1②：覆盖证据同源进 breaker（空数组是有意义状态，不能省）。
    ...(context.scannedDirectories ? { scannedDirectories: context.scannedDirectories } : {}),
  });
  if (assessment.level !== "catastrophic") return undefined;

  const first = assessment.findings.find((item) => item.level === "catastrophic");
  const detail = first
    ? `${first.reason}${first.target ? ` (target: ${first.target})` : ""}`
    : "command targets a path that must never be destroyed";
  return hit(
    "breaker.bashTargetCatastrophic",
    `Bash command blocked: ${detail}. This target class is never permitted through the Bash tool. ` +
      "No justification, permission rule, or mode unlocks it — narrow the target to a specific " +
      "workspace path, or ask the user to run the command themselves.",
    "deny",
  );
}

// ── 类 1：空变量根删除 ────────────────────────────────────────────────

const DELETE_PROGRAM_NAMES: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "remove-item",
]);
/** 解析失败时的 fail-closed 兜底：被检文本含删除类程序名即按危险对待（纯字符串匹配）。 */
const DELETE_KEYWORD_PATTERN = /\b(rm|rmdir|del|erase|Remove-Item)\b/i;
const RECURSIVE_FORCE_FLAGS = new Set([
  "-r",
  "-f",
  "-rf",
  "-fr",
  "--recursive",
  "--force",
  "/s",
  "/q",
  "-recurse",
  "-force",
]);
/** 组合短旗标形态（-rf、-Rf、-fr…）：只用 test 判定，不捕获执行。 */
const SHORT_FLAG_CLUSTER_PATTERN = /^-[a-z]+$/i;

function checkForcedRootDelete(
  context: BypassImmuneBreakerContext,
): BypassImmuneBreakerHit | undefined {
  if (context.toolName !== "Bash") return undefined;
  const bashText = stringField(context.input, "command");
  if (!bashText) return undefined;

  const analysis = analyzeBashCommand(bashText);
  if (analysis.hasParseErrors) {
    // fail-closed：AST 不可用时退回文本匹配——拦不住解析器覆盖不到的危险形态就等于没有熔断。
    if (DELETE_KEYWORD_PATTERN.test(bashText)) {
      return hit(
        "breaker.bashRootDelete",
        "Recursive/force delete text could not be parsed; confirmation required",
      );
    }
    return undefined;
  }

  const candidates = extractForcedDeleteCandidates(
    analysis,
    DELETE_PROGRAM_NAMES,
    isRecursiveForceFlag,
  );
  for (const candidate of candidates) {
    // 含未解析展开（$VAR/$(…) 等）：变量为空时 `rm -rf "$DIR"/` 等价于删根，
    // 静态分析无法证明安全 → 熔断。这正是「空变量根删除」的主形态。
    if (candidate.hasDynamicWords) {
      return hit(
        "breaker.bashRootDelete",
        "Recursive/force delete with unresolved shell expansion; confirmation required",
      );
    }
    if (candidate.pathArguments.some(isRootOrHomeTarget)) {
      return hit(
        "breaker.bashRootDelete",
        "Recursive/force delete targets a filesystem root or home directory; confirmation required",
      );
    }
  }
  return undefined;
}

function isRecursiveForceFlag(arg: string): boolean {
  const normalized = arg.toLowerCase();
  if (RECURSIVE_FORCE_FLAGS.has(normalized)) return true;
  // 组合短旗标（-rf、-Rf、-fr 等）：单字符簇里含 r 或 f 即视为递归/强制。
  if (!SHORT_FLAG_CLUSTER_PATTERN.test(normalized)) return false;
  const letters = normalized.slice(1);
  return letters.includes("r") || letters.includes("f");
}

function isRootOrHomeTarget(arg: string): boolean {
  const trimmed = arg.trim();
  if (trimmed.length === 0) return true; // 空参数：展开后为空即根语义
  if (trimmed === "~" || trimmed === "~/" || trimmed === "$HOME" || trimmed === "${HOME}") {
    return true;
  }
  const normalized = normalize(trimmed);
  if (normalized === sep || normalized === "/" || DRIVE_ROOT_PATTERN.test(normalized)) {
    return true;
  }
  const home = normalize(homedir());
  return normalized === home || normalized === `${home}${sep}`;
}

/** Windows 盘符根（C:\、C:/、C:）。 */
const DRIVE_ROOT_PATTERN = /^[a-zA-Z]:[\\/]?$/;

// ── 类 2：路径逃逸写 ──────────────────────────────────────────────────

const WRITE_TOOLS = new Set(["Write", "Edit", "ApplyPatch", "MultiEdit"]);

function checkPathEscapeWrite(
  context: BypassImmuneBreakerContext,
): BypassImmuneBreakerHit | undefined {
  if (!WRITE_TOOLS.has(context.toolName)) return undefined;
  const workspaceRoot = context.workspaceRoot?.trim();
  // 拿不到 workspaceRoot 时不触发：与既有「拿不到工作目录照常按其余规则判定」同一容错哲学，
  // 宁可少一层熔断，不能把无根上下文的所有写入都拦下。
  if (!workspaceRoot) return undefined;
  const rawPath = stringField(context.input, "file_path") ?? stringField(context.input, "path");
  if (!rawPath) return undefined;

  const resolved = isAbsolute(rawPath)
    ? normalize(rawPath)
    : resolve(context.workingDirectory?.trim() || workspaceRoot, rawPath);
  if (isPathInside(resolved, workspaceRoot)) return undefined;
  return hit("breaker.pathEscapeWrite", "Write target escapes the workspace root");
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ── 类 3：敏感位置读 ──────────────────────────────────────────────────

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
/**
 * 封闭清单：只覆盖「凭据/密钥材料」位置，不做泛化的「workspace 外即敏感」。
 * 扩展走策略地板的 deny/ask 规则，不在这里加配置开关（R2）。
 * 匹配前统一：反斜杠→斜杠、小写；相对路径先按 workingDirectory 解析，
 * 防止 `../../.ssh/id_rsa` 这类字面绕过。
 */
const SENSITIVE_LOCATION_PATTERNS: readonly string[] = [
  ".ssh/",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  ".aws/credentials",
  ".azure/",
  ".config/gcloud/",
  ".kube/config",
  ".acode/v2/credentials.json",
  "credential-key.json",
  ".git-credentials",
  ".netrc",
  "_netrc",
  "appdata/local/google/chrome/user data",
  "appdata/roaming/google/chrome",
  "library/application support/google/chrome",
  "appdata/local/microsoft/edge/user data",
  ".mozilla/firefox",
  "appdata/roaming/microsoft/windows/credentials",
];

function checkSensitiveRead(
  context: BypassImmuneBreakerContext,
): BypassImmuneBreakerHit | undefined {
  if (READ_TOOLS.has(context.toolName)) {
    const candidates = [
      stringField(context.input, "file_path"),
      stringField(context.input, "path"),
      stringField(context.input, "pattern"),
      stringField(context.input, "glob"),
    ].filter((value): value is string => value !== undefined);
    for (const candidate of candidates) {
      const resolved = isAbsolute(candidate)
        ? normalize(candidate)
        : resolve(context.workingDirectory?.trim() || ".", candidate);
      if (matchesSensitiveLocation(resolved)) {
        return hit("breaker.sensitiveRead", "Read targets a known credential location");
      }
    }
    return undefined;
  }
  if (context.toolName === "Bash") {
    const bashText = stringField(context.input, "command");
    if (bashText && matchesSensitiveLocation(bashText)) {
      return hit("breaker.sensitiveRead", "Command text references a known credential location");
    }
  }
  return undefined;
}

function matchesSensitiveLocation(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  return SENSITIVE_LOCATION_PATTERNS.some((pattern) => normalized.includes(pattern));
}

// ── 共用 ──────────────────────────────────────────────────────────────

function hit(
  ruleId: string,
  reason: string,
  behavior: "ask" | "deny" = "ask",
): BypassImmuneBreakerHit {
  return Object.freeze(behavior === "deny" ? { ruleId, reason, behavior } : { ruleId, reason });
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** 从 PermissionContext 提取熔断器所需的子集（service 层调用入口）。 */
export function breakerContextFromPermissionContext(
  context: PermissionContext,
): BypassImmuneBreakerContext {
  return {
    toolName: context.toolName,
    input: context.input,
    ...(context.workingDirectory ? { workingDirectory: context.workingDirectory } : {}),
    ...(context.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
    // R6 边界⑥收口：script body map 透传给 deny 级命中类（yolo 下 body catastrophic
    // 的唯一 deny 通道，spec npm-script-body-scan.md R4）。
    ...(context.packageScripts ? { packageScripts: context.packageScripts } : {}),
    // 对抗验证 F1②：扫描覆盖证据同源透传（cd/选择器目标的 enclosing 充数拦截依赖它）。
    ...(context.scannedDirectories ? { scannedDirectories: context.scannedDirectories } : {}),
  };
}
