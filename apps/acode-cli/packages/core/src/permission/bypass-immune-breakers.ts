// 旁路免疫熔断器（安全加固 P2）。
//
// 一组内置的危险动作检查：**即使 yolo/bypass 也强制降级为 ask**。把「yolo = 无条件放行」
// 改成「yolo = 放行除熔断器外的一切」。规格见
// apps/acode-cli/specs/managed-policy-floor-and-bypass-immune-breakers.md R2。
//
// 设计约束：
// - 纯函数、无 IO、不依赖配置——熔断器是代码内不变量，策略地板只能额外收紧、不能放松它。
// - 只降级 allow：调用方（PermissionService）仅在决策为 allow 时应用本模块的命中结果，
//   deny/ask 分支永远不经过这里，因此熔断器不可能把更严的决策放宽。
// - 命中返回 ask 而非 deny：保留用户「我知道我在做什么」的最终决定权，与既有 ask 语义一致。
// - 本模块**从不执行**任何外部程序：只对工具入参字符串做静态判定。Bash 文本的结构分析
//   委托给既有的 bash-command-parser（unbash AST），本模块只消费其纯数据结果。
import { homedir } from "node:os";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import {
  analyzeBashCommand,
  extractForcedDeleteCandidates,
} from "../tool/handlers/bash-command-parser.js";
import type { PermissionContext } from "./service.js";

export interface BypassImmuneBreakerHit {
  readonly ruleId: string;
  readonly reason: string;
}

export interface BypassImmuneBreakerContext {
  readonly toolName: string;
  readonly input: unknown;
  readonly workingDirectory?: string;
  readonly workspaceRoot?: string;
}

/** 按 R3 顺序评估三类熔断器，返回第一个命中；无命中返回 undefined。 */
export function evaluateBypassImmuneBreakers(
  context: BypassImmuneBreakerContext,
): BypassImmuneBreakerHit | undefined {
  return (
    checkForcedRootDelete(context) ?? checkPathEscapeWrite(context) ?? checkSensitiveRead(context)
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

function hit(ruleId: string, reason: string): BypassImmuneBreakerHit {
  return Object.freeze({ ruleId, reason });
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
  };
}
