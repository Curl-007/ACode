// SSH config 别名的不支持指令检测（结构化拒绝）。
// 规格见 packages/services/specs/ssh-config-alias-proxy-rejection.md。
//
// 修复原因：`ssh -G` 解析此前只取 hostname/port/username/identityfile 类平铺键，
// 别名生效配置里的 ProxyJump/ProxyCommand/LocalCommand/Match 被静默丢弃——内置
// SSH 引擎会绕过跳板直连目标地址，用户看到的是超时挂起而不是解释性拒绝。
// 这里把「生效痕迹」检测提炼为纯函数：输入 -G 输出文本或已解析配置块，输出
// 闭集 reason 的结构化拒绝；接线（spawn/缓存/合并）仍留在 sshConfigAlias.ts。
import type { SSHConfigAliasOption } from "@acode/shared";

// 类型载体在 shared/platform.ts（barrel 暂未导出这两个符号，消费方经
// SSHConfigAliasOption 索引访问派生；barrel 导出需求已登记）。
export type SSHConfigAliasUnsupportedInfo = NonNullable<SSHConfigAliasOption["unsupported"]>;
export type SSHConfigAliasUnsupportedReason = SSHConfigAliasUnsupportedInfo["reason"];

export interface ParsedDirective {
  key: string;
  value: string;
}

export interface ParsedBlock {
  /** Host 块为 host patterns；Match 块为条件 token（不是 host pattern）。 */
  patterns: string[];
  directives: ParsedDirective[];
  source: string;
  fromHostDirective: boolean;
  fromMatchDirective: boolean;
}

const DIRECTIVE_REJECTIONS: Record<
  Exclude<SSHConfigAliasUnsupportedReason, "match_unsupported">,
  { directive: string; label: string }
> = {
  proxy_jump_unsupported: { directive: "ProxyJump", label: "ProxyJump（跳板机）" },
  proxy_command_unsupported: { directive: "ProxyCommand", label: "ProxyCommand（代理命令）" },
  local_command_unsupported: { directive: "LocalCommand", label: "LocalCommand（本地命令）" },
};

const MATCH_LABEL = "Match（条件配置块）";

/** 指令类拒绝的文案语义固定：说明依赖的不支持指令 + 直连/说明拓扑的出路。 */
export function buildSSHConfigAliasRejection(
  reason: SSHConfigAliasUnsupportedReason,
  detectedBy: SSHConfigAliasUnsupportedInfo["detectedBy"],
): SSHConfigAliasUnsupportedInfo {
  if (reason === "match_unsupported") {
    return {
      reason,
      directive: "Match",
      message: `该别名依赖 ACode 尚不支持的 ${MATCH_LABEL}，且其条件无法被静态判定是否对本别名生效；为避免按错误的生效配置直连，请直连目标主机或说明你的跳板拓扑。`,
      detectedBy,
    };
  }
  const { directive, label } = DIRECTIVE_REJECTIONS[reason];
  return {
    reason,
    directive,
    message: `该别名依赖 ACode 尚不支持的 ${label}，内置 SSH 引擎无法经该指令建连（直连会表现为超时挂起）；请直连目标主机或说明你的跳板拓扑。`,
    detectedBy,
  };
}

const SSH_G_UNSUPPORTED_KEY_REASONS: Readonly<Record<string, SSHConfigAliasUnsupportedReason>> = {
  proxyjump: "proxy_jump_unsupported",
  proxycommand: "proxy_command_unsupported",
  localcommand: "local_command_unsupported",
};

/**
 * 检测 `ssh -G` 输出里的不支持指令生效痕迹。
 *
 * -G 输出为「小写键 + 空白 + 值」的平铺行；proxyjump/proxycommand/localcommand
 * 只在生效配置里存在时出现（实测 OpenSSH 9.8）。两个易错点：
 * 1. `permitlocalcommand` 是恒出现的独立键，必须整键精确匹配，前缀匹配会误报；
 * 2. `proxycommand none` 是「显式禁用代理」的合法值，不构成代理依赖。
 * Match 块在 -G 求值时已被真实 ssh 展开进平铺键（Match 设置的 proxy 类指令会
 * 以上述键现形），因此 -G 成功路径不需要、也不应该再做静态 Match 判断。
 */
export function detectUnsupportedInSshGOutput(
  output: string,
): SSHConfigAliasUnsupportedInfo | undefined {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^(\S+)\s+(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const key = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    const reason = SSH_G_UNSUPPORTED_KEY_REASONS[key];
    if (!reason || value.length === 0) {
      continue;
    }
    if (key === "proxycommand" && value.toLowerCase() === "none") {
      continue;
    }
    return buildSSHConfigAliasRejection(reason, "ssh-g");
  }
  return undefined;
}

const STATIC_UNSUPPORTED_DIRECTIVE_REASONS = SSH_G_UNSUPPORTED_KEY_REASONS;

/** 检测已匹配块（Host 块或确定适用的 Match 块）指令列表里的不支持指令。 */
export function detectUnsupportedDirectiveReason(
  directives: readonly ParsedDirective[],
): SSHConfigAliasUnsupportedReason | undefined {
  for (const directive of directives) {
    const reason = STATIC_UNSUPPORTED_DIRECTIVE_REASONS[directive.key];
    if (!reason) {
      continue;
    }
    const value = directive.value.trim();
    if (value.length === 0) {
      continue;
    }
    if (directive.key === "proxycommand" && value.toLowerCase() === "none") {
      continue;
    }
    return reason;
  }
  return undefined;
}

export type SSHConfigMatchApplicability = "applies" | "not_applicable" | "indeterminate";

/** Match 条件的取值关键字（关键字后跟随一个值 token）。 */
const MATCH_VALUE_KEYWORDS = new Set([
  "host",
  "exec",
  "address",
  "localaddress",
  "localnetwork",
  "user",
  "group",
  "tagged",
]);

/** 无值关键字中可静态判定的只有 all；canonical/final 依赖运行期状态，判不可判定。 */
const MATCH_STATIC_VALUELESS_KEYWORDS = new Set(["all"]);

/**
 * 静态判定 Match 块条件对别名是否适用。
 *
 * Match 语义：关键字之间 AND、关键字内列表 OR、`!` 否定。只有 `host <patterns>`
 * 与 `all` 可静态判定；exec/address/localaddress/localnetwork/user/group/tagged/
 * canonical/final 及未知关键字一律不可判定。任一条件确定不成立 → 块确定不适用
 * （AND 短路，即使其余条件含 exec）；否则存在不可判定条件 → indeterminate，
 * 由调用方按保守原则拒绝。
 */
export function evaluateMatchApplicability(
  conditions: readonly string[],
  alias: string,
  matchesPattern: (pattern: string, alias: string) => boolean,
): SSHConfigMatchApplicability {
  if (conditions.length === 0) {
    // 裸 Match 行不是合法配置；无法推断意图，按不可判定处理。
    return "indeterminate";
  }

  let definitelyFails = false;
  let indeterminate = false;

  for (let i = 0; i < conditions.length; i += 1) {
    const keyword = (conditions[i] ?? "").toLowerCase();
    if (MATCH_STATIC_VALUELESS_KEYWORDS.has(keyword)) {
      continue; // all：恒成立
    }
    if (keyword === "host") {
      const listToken = conditions[i + 1] ?? "";
      i += 1;
      const patterns = listToken
        .split(",")
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0);
      if (patterns.length === 0) {
        indeterminate = true;
        continue;
      }
      const positives = patterns.filter((pattern) => !pattern.startsWith("!"));
      const negatives = patterns.filter((pattern) => pattern.startsWith("!"));
      if (negatives.some((pattern) => matchesPattern(pattern.slice(1), alias))) {
        // 否定模式命中：host 条件确定不成立 → 整块 AND 确定不适用。
        definitelyFails = true;
        continue;
      }
      const positiveHit = positives.some((pattern) => matchesPattern(pattern, alias));
      if (positiveHit) {
        continue; // host 条件成立
      }
      if (positives.length > 0) {
        // 只有正模式且都不命中：host 条件确定不成立。
        definitelyFails = true;
        continue;
      }
      // 只有否定模式且都未命中别名：host 条件成立。
      continue;
    }
    if (MATCH_VALUE_KEYWORDS.has(keyword)) {
      i += 1; // 跳过条件值 token（exec 命令等；不参与静态判定）
    }
    indeterminate = true;
  }

  if (definitelyFails) {
    return "not_applicable";
  }
  return indeterminate ? "indeterminate" : "applies";
}
