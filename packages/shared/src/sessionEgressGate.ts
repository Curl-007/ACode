/**
 * session/task id 出网形态门（specs/log-privacy-redaction.md R12）。
 *
 * ACode 自己的 id 拼写（调查自 apps/acode-cli/packages/contracts/src/interfaces/
 * shared.ts、cli-workflow 的 runId 铸造点与 acp session-registry）：
 * - 下划线前缀族：sess_/turn_/evt_/query_/tool_/msg_/part_/input_/proj_/ws_/wf_
 *   + `[A-Za-z0-9._-]{1,128}` 主体（uuid、`<base36ts>_<uuid>` 可排序段、
 *   `subagent_<id>`/`dwf-…` 派生段均落在该字符类内）。
 * - 连字符前缀族：dwfrun-/dwfeval-/launch-/settings-/acp-prompt- + 同类主体。
 * - 裸 UUID：TraceId（createTraceId = crypto.randomUUID()）。
 *
 * 出网（反馈、遥测、任何离开本机的文本）值只允许三种形态：
 * 空串、`local_*`（本地占位，不含真 id）、`sha256_[0-9a-f]{64}`（哈希后关联键）。
 * 文本中检出「带 id 前缀但不符合合法形态」的疑似会话 token → 判定泄漏，
 * 消费方（脱敏管线）对该行 fail-closed 抑制为 <withheld>——不合格式的
 * token 可能是被截断/拼接的内部 id，也可能是伪装成 id 的第三方秘密，
 * 两者都不允许出网。
 *
 * 纯函数，无 IO、无 node 依赖（哈希由消费方用自己的 crypto 实施）。
 */

/** id 主体：uuid、可排序段、派生段共用的宽松字符类（长度封顶防正则放大）。 */
const ID_BODY = String.raw`[A-Za-z0-9._-]{1,128}`;

/** 下划线前缀族（contracts createSessionId/createTurnId/… 的全部前缀）。 */
const UNDERSCORE_PREFIXES = String.raw`sess|turn|evt|query|tool|msg|part|input|proj|ws|wf`;

/** 连字符前缀族（cli-workflow/acp 的铸造点前缀）。 */
const HYPHEN_PREFIXES = String.raw`dwfrun|dwfeval|launch|settings|acp-prompt`;

/**
 * id 前缀形态（非锚定）：供机密形态脱敏的 blob 规则做负向前瞻——
 * ACode 自己的 id token（如 `sess_<uuid>`，41 字符）不是高熵秘密，
 * 本地日志必须保留用于排障关联，不能被 base64 blob 规则吞掉。
 */
export const ACODE_ID_TOKEN_PREFIX_SOURCE = String.raw`(?:(?:${UNDERSCORE_PREFIXES})_|(?:${HYPHEN_PREFIXES})-)`;

/** UUID 形态（TraceId 与 ACP sessionId 的裸 uuid 拼写）。 */
const UUID_PATTERN = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;

/** ACode 会话/任务类 id 的合法形态（整值锚定，大小写不敏感）。 */
export const ACODE_SESSION_ID_PATTERN = new RegExp(
  `^(?:(?:${UNDERSCORE_PREFIXES})_${ID_BODY}|(?:${HYPHEN_PREFIXES})-${ID_BODY}|${UUID_PATTERN})$`,
  "i",
);

/**
 * 文本内「疑似 id token」检出形态：前缀命中即候选，再按合法形态判定。
 * 捕获字符类比合法形态更宽（含 ~+/=:% 等损坏/拼接/编码残留字符），
 * 这样「带前缀但形态不合格」的 token 才会被检出并触发 fail-closed 抑制。
 */
const SUSPECTED_TOKEN_PATTERN = new RegExp(
  String.raw`(?:^|[^A-Za-z0-9])((?:(?:${UNDERSCORE_PREFIXES})_|(?:${HYPHEN_PREFIXES})-)[A-Za-z0-9._~+/=:%-]*)`,
  "gi",
);

/** 出网允许的哈希形态。 */
const EGRESS_HASH_PATTERN = /^sha256_[0-9a-f]{64}$/;

/** 出网允许的本地占位形态。 */
const EGRESS_LOCAL_PATTERN = /^local_[A-Za-z0-9._-]{1,128}$/;

/** 值是否为 ACode 合法形态的会话/任务 id（内部使用判定，不代表可出网）。 */
export function isCanonicalACodeSessionId(value: string): boolean {
  return typeof value === "string" && ACODE_SESSION_ID_PATTERN.test(value);
}

/**
 * 出网形态门：允许 ""、`local_*`、`sha256_[0-9a-f]{64}` 三种值出网。
 * 裸内部 id（含合法形态的 sess_<uuid>）一律 false——出网必须先哈希。
 */
export function isAllowedEgressSessionValue(value: unknown): boolean {
  if (value === "") {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  return EGRESS_LOCAL_PATTERN.test(value) || EGRESS_HASH_PATTERN.test(value);
}

/**
 * 文本泄漏检测：检出带 id 前缀但不符合合法形态的 token 即返回 true。
 * 消费方对命中文本 fail-closed 抑制（整行 <withheld>），不做局部修补。
 */
export function detectSuspectedSessionTokenLeak(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) {
    return false;
  }
  for (const [, token] of text.matchAll(SUSPECTED_TOKEN_PATTERN)) {
    if (!ACODE_SESSION_ID_PATTERN.test(token!)) {
      return true;
    }
  }
  return false;
}
