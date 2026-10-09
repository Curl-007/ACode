// Bash Confirm 级反射门（J1-2）。
// 规格见 apps/acode-cli/specs/bash-confirm-reflexive-gate.md。
//
// 机制参照 jcode (MIT) crates/jcode-command-risk/src/gate.rs，自撰 TypeScript 实现。
//
// 为什么不是第二个模型：LLM judge 贵、加延迟、能被产生该命令的同一套推理绕过去。
// 反射门拒绝一次并回喂结构化四问，强迫生成命令的模型自己补上跳过的思考；
// 拒绝不可被盲目重试满足——重提必须携带有效 justification，且必须发生在
// 反射 prompt 之后（挑战登记表防预填）。
//
// 设计约束：
// - 只收紧不放宽：门仅在 PermissionService 收口处、无熔断器命中且 decision 为
//   allow/ask 时运行；deny 决策永不进门，catastrophic（J1-1 deny 级熔断）永远先行。
// - 不成为绕过路径：ask lane 的终点仍是 ask（用户裁决）；allow lane 无效论证收敛
//   到 ask；allow lane 有效论证放行必留审计。
// - 除审计 sink 外纯函数、无文件 IO；homedir/platform 与 J1-1 同款在模块内读取
//   （与 bypass-immune-breakers.ts 的既有 homedir 用法一致）。
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { assessBashCommandTargetRisk } from "../tool/handlers/bash-target-risk/index.js";
import type { PackageScriptSource } from "../tool/handlers/bash-target-risk/types.js";

type BashReflexGateAction = "pass-through" | "deny" | "ask" | "allow";

export interface BashReflexGateOutcome {
  readonly action: BashReflexGateAction;
  readonly ruleId?: string;
  readonly reason?: string;
}

export interface BashReflexGateRequest {
  readonly toolName: string;
  readonly input: unknown;
  /** 门前 decision（deny 不进门的约定由调用方保证）。 */
  readonly decision: "allow" | "ask";
  readonly workingDirectory?: string;
  readonly workspaceRoot?: string;
  /**
   * 调用方身份（对抗复审 N3）：挑战键把它与命令文本一起哈希，防止共享
   * PermissionService 实例的两个会话互用对方的反射挑战（子代理继承父实例的预填绕过）。
   * 缺省（legacy 调用方）退回仅按命令文本哈希的现行为。
   */
  readonly sessionId?: string;
  /**
   * npm/pnpm/yarn/bun run 的 package.json scripts 预解析 map（R6 边界⑥收口，
   * spec npm-script-body-scan.md R4）：confirm 级 script body（`npm run $X`、不可解析
   * 选择器等）在 yolo 下经门收口。缺省 = legacy 调用方，门看不到 body，维持现行为。
   */
  readonly packageScripts?: readonly PackageScriptSource[];
  /**
   * 预取实际读过/走过的目录（扫描覆盖证据，对抗验证 F1②）。与 packageScripts
   * 同源：目标目录的 enclosing 充数拦截依赖它。缺省 = legacy 调用方。
   */
  readonly scannedDirectories?: readonly string[];
}

/** allow lane 有效论证放行 / 无效论证收敛 ask 的审计条目（R6 / 对抗复审 N6）。 */
export interface BashReflexAuditEntry {
  /**
   * gate 落审计的事件类别（对抗复审 N6：breakerAsk 决策同样留痕，靠 event 名区分）。
   * 联合类型内联在此：barrel 只再导出本接口，不新增独立导出。
   */
  readonly event: "bash_reflex_gate_audited_allow" | "bash_reflex_gate_breaker_ask";
  readonly ruleId: string;
  /** 已做值级脱敏（对抗复审 N2）并截断到 AUDIT_COMMAND_MAX_LENGTH。 */
  readonly command: string;
  /** 已做值级脱敏（对抗复审 N2）。 */
  readonly justification: string;
  readonly assessmentReasons: readonly string[];
  readonly timestamp: string;
  /** 多 App 进程内路由；legacy 调用方可缺席。 */
  readonly sessionId?: string;
}

const REFLEX_GATE_RULE_ID_PREFIX = "gate.bashConfirmReflex.";

const REFLEX_RULE_IDS = {
  reflect: `${REFLEX_GATE_RULE_ID_PREFIX}reflect`,
  insufficient: `${REFLEX_GATE_RULE_ID_PREFIX}insufficientJustification`,
  ask: `${REFLEX_GATE_RULE_ID_PREFIX}ask`,
  breakerAsk: `${REFLEX_GATE_RULE_ID_PREFIX}breakerAsk`,
  auditedAllow: `${REFLEX_GATE_RULE_ID_PREFIX}auditedAllow`,
} as const;

/**
 * ruleId 是否属于反射门（评审 J1-2 修复，spec R5/R7）。
 *
 * 投递层（tool/executor/permission-flow.ts）用它决定 deny 文案是否原样保留：反射门的
 * reason 是**结构化指引**（四问 + 「re-issue with a justification」解锁协议，首轮文案
 * 约 1000 字符），而缺省错误通道会经 sanitizeText 把空白压平并截到 500 字符
 * （errors/error-payload.ts），Q2/Q3/Q4 与解锁指令全部丢失——模型在最该反思的那一轮
 * 拿不到协议，只能盲目重试再撞一次 deny。
 */
export function isBashReflexGateRuleId(ruleId: string | undefined): boolean {
  return ruleId !== undefined && ruleId.startsWith(REFLEX_GATE_RULE_ID_PREFIX);
}

/** jcode 同款低门槛：目标是强迫一个反思轮次，不是给文采打分。 */
const MIN_JUSTIFICATION_LENGTH = 25;
/**
 * 对抗复审 N7（纵深防御）：justification 长度上限，与 contracts BashInputSchema 的
 * `max 4000` 契约对齐。executor 的 .strict()+max 只拦得住主路径；PermissionService
 * 可被不经 executor 的调用方直达（agent-runtime / project-memory-agent 自建实例），
 * gate 内重复把关。超限按无效论证处理。
 */
const MAX_JUSTIFICATION_LENGTH = 4000;
/**
 * 对抗复审 N4 + 对抗复核 F1：零宽、不可见格式字符与视觉空白。String.prototype.trim
 * 不处理它们（U+200B 类不在 ECMAScript WhiteSpace 集合），此前「ok」+25 个零宽空格
 * （27 字符）能通过长度校验——用户在弹窗看到的是视觉空白论证，「所见非所验」。
 * 第一轮修复用枚举清单（软连字符、零宽空格/连接符、双向控制、BOM、变体选择符、
 * 行/段分隔符），对抗复核 F1 证明枚举可被清单外字符族绕过（U+061C/U+0600/U+E0020/
 * U+110BD/U+3164/U+2800/U+FFA0 七族当时全部通过）。机制改为 Unicode 属性类 \p{Cf}
 * 一次覆盖通用类别 Cf 的全部格式字符（含全部清单内成员），再显式追加字形是空白、
 * 类别不是 Cf 的成员：U+2028/U+2029（Zl/Zp 行/段分隔符）、U+2800 盲文空白、
 * U+3164 谚文填充符、U+FFA0 半角谚文填充符。NBSP/空格保持既有 trim 语义。
 */
const INVISIBLE_CHARACTERS_PATTERN = /[\p{Cf}\u2028\u2029\u2800\u3164\uFFA0]/gu;
/** 措辞不披露阈值（R3）：这些常量名与数值绝不出现在任何回喂文案里。 */
const ACKNOWLEDGEMENT_WORDS: ReadonlySet<string> = new Set([
  "yes",
  "y",
  "yep",
  "yeah",
  "ok",
  "okay",
  "k",
  "sure",
  "confirmed",
  "confirm",
  "proceed",
  "continue",
  "approved",
  "approve",
  "do",
  "it",
  "go",
  "ahead",
  "run",
  "execute",
  // 无语义填充词：只用于识破「ok, go ahead and do it now」这类组合形态的纯确认句；
  // 任何提及用户请求/目标/命令实体的真实论证都必然含有集合外的词。
  "and",
  "then",
  "now",
  "please",
  "just",
  "really",
  "certainly",
  "definitely",
  "of",
  "course",
  "again",
  "是",
  "好",
  "好的",
  "确认",
  "继续",
  "执行",
  "可以",
  "行",
  "请",
  "直接",
  "现在",
]);
const ACK_PUNCTUATION_PATTERN =
  /^[\s.!?,;:'"“”‘’。！？，；：、]+|[\s.!?,;:'"“”‘’。！？，；：、]+$/g;
const ACK_TOKEN_SPLIT_PATTERN = /[\s,，、;；.。!！?？]+/;
/**
 * 对抗复核 F1 变体 1：拼接确认词判定前的归一化——把标点/符号/数字/空白全部剥去，
 * 只留可组成确认词的字符。数字同剥：`"ok"+"1".repeat(23)` 与词拼接是同族无语义填充。
 */
const ACK_COMPACT_PATTERN = /[\s\p{P}\p{S}\p{N}]+/gu;
const MAX_CHALLENGE_ENTRIES = 256;
const AUDIT_COMMAND_MAX_LENGTH = 2000;

interface ReflexChallenge {
  readonly nonce: string;
  readonly issuedAt: number;
  attempts: number;
}

/**
 * Confirm 级反射门。状态（挑战登记表）随 PermissionService 实例生灭：
 * 一个实例 = 一个 app = 一个会话，重启 / 冷恢复 / `/new` 都自然清零。
 */
export class BashConfirmReflexGate {
  private readonly challenges = new Map<string, ReflexChallenge>();

  evaluate(request: BashReflexGateRequest): BashReflexGateOutcome {
    if (request.toolName !== "Bash") return PASS_THROUGH;
    const command = stringField(request.input, "command");
    if (!command) return PASS_THROUGH;

    const assessment = assessBashCommandTargetRisk(command, {
      workingDirectory: request.workingDirectory,
      workspaceRoot: request.workspaceRoot,
      homeDirectory: homedir(),
      platform: process.platform,
      // R6 边界⑥收口：confirm 级 script body（`npm run $X`、未知旗标、不可解析选择器）
      // 与目标侧 confirm 同一反射语义（spec npm-script-body-scan.md R4）。
      ...(request.packageScripts ? { packageScripts: request.packageScripts } : {}),
      // 对抗验证 F1②：覆盖证据同源进门（cd/选择器目标的 enclosing 充数拦截依赖它，
      // 缺了门内会退回误判放行）。空数组是有意义状态，不能省。
      ...(request.scannedDirectories ? { scannedDirectories: request.scannedDirectories } : {}),
    });
    if (assessment.level !== "confirm") return PASS_THROUGH;

    const justification = stringField(request.input, "justification");
    // 对抗复审 N3：挑战键并入调用方身份——挑战不跨身份生效（见 challengeKey 注释）。
    const key = challengeKey(command, request.sessionId);
    const challenge = this.challenges.get(key);

    if (!challenge) {
      // 首次调用：记录挑战并拒绝。携带的 justification 是预填——它没有经过反射
      // prompt，不计为应答（R4）。
      this.issueChallenge(key);
      return outcome(
        "deny",
        REFLEX_RULE_IDS.reflect,
        buildReflectPrompt(assessment.findings, justification !== undefined),
      );
    }

    challenge.attempts += 1;

    if (justification === undefined) {
      // 相同调用重发再次失败：盲目重试永远拿不到放行或 ask。
      return outcome("deny", REFLEX_RULE_IDS.reflect, buildRetryPrompt(assessment.findings));
    }

    if (!isSubstantiveJustification(justification)) {
      if (request.decision === "allow") {
        // allow lane（yolo 直通/项目 allow/会话规则）：模型尝试过论证但不到位，
        // 收敛到 ask 交用户裁决，而不是继续循环 deny（R7）。
        // 对抗复审 N6：breakerAsk 决策此前无任何专门留痕（ruleId 只在 debug 级日志，
        // 生产不落盘），落一条与 auditedAllow 同构的审计，靠 event 名区分。
        emitAudit(
          {
            event: "bash_reflex_gate_breaker_ask",
            ruleId: REFLEX_RULE_IDS.breakerAsk,
            command: redactForAudit(command).slice(0, AUDIT_COMMAND_MAX_LENGTH),
            justification: redactForAudit(justification),
            assessmentReasons: assessment.findings.map((finding) => finding.reason),
            timestamp: new Date().toISOString(),
          },
          request.sessionId,
        );
        return outcome(
          "ask",
          REFLEX_RULE_IDS.breakerAsk,
          buildBreakerAskReason(justification, assessment.findings),
        );
      }
      return outcome(
        "deny",
        REFLEX_RULE_IDS.insufficient,
        buildInsufficientPrompt(assessment.findings),
      );
    }

    if (request.decision === "allow") {
      // 对抗复审 N2：command 与 justification 先做值级脱敏再落盘（先脱敏后截断——
      // 先截断会把凭据切碎成模式匹配不到的残片）。
      emitAudit(
        {
          event: "bash_reflex_gate_audited_allow",
          ruleId: REFLEX_RULE_IDS.auditedAllow,
          command: redactForAudit(command).slice(0, AUDIT_COMMAND_MAX_LENGTH),
          justification: redactForAudit(justification),
          assessmentReasons: assessment.findings.map((finding) => finding.reason),
          timestamp: new Date().toISOString(),
        },
        request.sessionId,
      );
      return outcome(
        "allow",
        REFLEX_RULE_IDS.auditedAllow,
        "Bash command allowed under bypass mode with an audited justification",
      );
    }
    return outcome("ask", REFLEX_RULE_IDS.ask, buildAskReason(justification, assessment.findings));
  }

  /** 仅供测试观察挑战登记状态。 */
  hasChallengeForTest(command: string): boolean {
    return this.challenges.has(challengeKey(command));
  }

  private issueChallenge(key: string): void {
    if (this.challenges.size >= MAX_CHALLENGE_ENTRIES) {
      const oldest = this.challenges.keys().next();
      if (!oldest.done) this.challenges.delete(oldest.value);
    }
    this.challenges.set(key, {
      nonce: randomUUID(),
      issuedAt: Date.now(),
      attempts: 0,
    });
  }
}

// ── justification 校验（R3） ─────────────────────────────────────────

function isSubstantiveJustification(text: string): boolean {
  // 对抗复审 N7：超长按无效处理（与 schema max 4000 对齐，纵深防御）。按原始长度判，
  // 与 schema 契约的字段口径一致。
  if (text.length > MAX_JUSTIFICATION_LENGTH) return false;
  // 对抗复审 N4 + 对抗复核 F1：先剥零宽/不可见格式字符/视觉空白再判定——trim 不处理
  // 这些字符，视觉空白不能冒充论证长度。
  const trimmed = text.replace(INVISIBLE_CHARACTERS_PATTERN, "").trim();
  if (trimmed.length < MIN_JUSTIFICATION_LENGTH) return false;
  const stripped = trimmed.replace(ACK_PUNCTUATION_PATTERN, "").toLowerCase();
  if (stripped.length === 0) return false;
  if (ACKNOWLEDGEMENT_WORDS.has(stripped)) return false;
  // 组合形态（"ok, proceed with it"）：切分后每个词都是确认词 → 仍是纯确认。
  const tokens = stripped.split(ACK_TOKEN_SPLIT_PATTERN).filter((token) => token.length > 0);
  if (tokens.length === 0) return false;
  if (tokens.every((token) => ACKNOWLEDGEMENT_WORDS.has(token))) return false;
  // 对抗复核 F1 变体 1：拼接形态（"y".repeat(25)、"确认".repeat(13)、"ok".repeat(13)、
  // "yes".repeat(9)）无分隔符、单一 token 不在集合，切分判定拦不住。归一化后整串可由
  // 黑名单确认词重复拼接而成 → 仍是纯确认。
  const compact = stripped.replace(ACK_COMPACT_PATTERN, "");
  if (compact.length === 0) return false;
  return !isConcatenationOfAckWords(compact);
}

/**
 * 对抗复核 F1：整串是否可由确认词黑名单重复拼接而成。
 *
 * 用子串可达 DP 而不是 `^(?:词1|词2|…)+$` 正则：这类正则在近失配串
 * （如 `"yes".repeat(n)+"x"`）上有指数回溯，justification 上限 4000 字符会构成
 * ReDoS 面；DP 是 O(n·词数·词长) 的确定性行为。
 */
function isConcatenationOfAckWords(compact: string): boolean {
  const reachable = new Array<boolean>(compact.length + 1).fill(false);
  reachable[0] = true;
  for (let position = 0; position < compact.length; position += 1) {
    if (!reachable[position]) continue;
    for (const word of ACKNOWLEDGEMENT_WORDS) {
      if (compact.startsWith(word, position)) {
        reachable[position + word.length] = true;
      }
    }
  }
  return reachable[compact.length];
}

// ── 审计值级脱敏（R6 / 对抗复审 N2、对抗复核 F2/F3） ─────────────────
// 审计 JSONL 里落的是命令与 justification 全文，可能夹带凭据（AGENTS.md 日志红线：
// 不在日志写入凭据）。core 不能 import adapters（依赖方向禁止），这里自撰轻量实现；
// 形态设计与 adapters/src/doctor/redaction.ts 的 SECRET_PATTERNS 是**同一份清单的两处
// 落地**（对抗复核 F2：两处曾各自漂移——JSON 引号键独缺 token、api-key 无大小写/
// 下划线变体），任一侧新增/修正形态必须同步另一侧（两处注释互相指向，spec R6/R5）。
// 取舍：凭据命中处只替换真值、保留句法结构与其余上下文——审计要能回答「为什么放行」，
// 裁剪只到「凭据不落盘」为限，非凭据内容逐字保留（对抗复核 F3：值匹配不吞命令语法
// 需要的闭合引号，脱敏后引号配对）。

const AUDIT_REDACTION_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly category: string;
}[] = Object.freeze([
  // JWT 先于 sk- 族（两段/三段式都认，eyJ 开头 + 两段 base64url）。
  {
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{6,})?\b/g,
    category: "jwt",
  },
  // OpenAI / Anthropic / Stripe 风格 Key 字面量。对抗复核 F2：大小写不敏感 + [_-]
  // 两种分隔（sk_UNDERSCOREKEY123456 / SK-UPPERCASE12345678 此前泄漏）。
  { pattern: /\b(?:sk|pk|rk)[_-][A-Za-z0-9_-]{8,}\b/gi, category: "api-key" },
  // Authorization 方案头整体。对抗复核 F2/F3：值取「整段引号字符串（含两侧引号一起
  // 吃掉，多词值不留残段）| 裸 token（到空白/引号断，不吞闭合引号）」；已被 REDACTED
  // 占位的值（[ 开头）不再二次吃——保住前一层类别标记与引号配对。
  { pattern: /\b(?:Bearer|Basic)\s+(?:"[^"]*"|[^\s"\[]+)/gi, category: "auth-scheme" },
  // GitHub PAT（classic ghp_/gho_/ghs_/ghr_ 与细粒度 github_pat_）。对抗复核 F2：
  // ghp_GITHUBPAT1234567890 此前泄漏。
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, category: "gh-token" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, category: "gh-token" },
  // AWS Access Key。对抗复核 F2：AKIAIOSFODNN7EXAMPLE 此前泄漏。
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, category: "aws-key" },
  // PEM 私钥块：整块（含 base64 体）替换；无 END 时吃到文本结尾——单独的 BEGIN 头
  // 同样要灭（对抗复核 F2：PEM 块此前整段泄漏）。
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
    category: "private-key",
  },
  // JSON 引号形态的凭据字段："api_key": "…"（捕获组把键与冒号补回去，不破 JSON 结构）。
  // 对抗复核 F2：补 token——裸键列表有、引号键列表独缺，"token": "…" 曾整值泄漏。
  {
    pattern:
      /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|x-api-key|anthropic-auth-token|secret|password|credential)"\s*:\s*)"[^"]*"/gi,
    category: "credential-field",
  },
  // 裸 key=value / key: value 形态的凭据字段（含 --token=…、export SECRET=… 等命令
  // 形态）。对抗复核 F2/F3：值分支认「整段引号字符串 | 裸 token」，TOKEN="sk-…" 这类
  // shell 引号值不再在引号处断开留残段。
  {
    pattern:
      /\b(?:api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|secret|password|token|authorization)\s*[:=]\s*(?:"[^"]*"|[^\s,;}"']+)/gi,
    category: "credential-field",
  },
  // x-api-key / anthropic 头形态。
  {
    pattern: /\b(?:x-api-key|anthropic-auth-token)\s*[:=]\s*[^\s,;}"']+/gi,
    category: "auth-header",
  },
]);

/**
 * 对审计文本做凭据形态脱敏（对抗复审 N2）：命中替换为 `[REDACTED:<类别>]`，
 * 其余内容原样返回。全局正则有 lastIndex 状态，每次调用前复位。
 */
function redactForAudit(text: string): string {
  let result = text;
  for (const { pattern, category } of AUDIT_REDACTION_PATTERNS) {
    pattern.lastIndex = 0;
    const tag = `[REDACTED:${category}]`;
    result = result.replace(pattern, (match, prefix: unknown) =>
      // JSON 形态要补回值的双引号，否则留下 `"api_key": [REDACTED:x]"` 这种破括号。
      typeof prefix === "string" && prefix.length > 0 ? `${prefix}"${tag}"` : tag,
    );
  }
  return result;
}

// ── 审计 sink（R6） ──────────────────────────────────────────────────

/** 审计 sink 形态：一条 auditedAllow 记录。宿主可替换（见 setBashReflexAuditSink）。 */
export type BashReflexAuditSink = (entry: BashReflexAuditEntry) => void;

// 缺省写 stderr（console.warn，core 既有先例 tool/registry.ts）——stdio 协议走
// stdout，stderr 是安全的日志通道。缺省 sink 只是**兜底**：单测与未接线的独立调用
// 也不至于完全丢掉审计，但一行易失的 stderr 不满足 plan「yolo 下审计日志落盘」，
// 所以 bootstrap/create-app.ts 在应用装配期用 setBashReflexAuditSink 把它换成
// info 级 Logger（NodeFileLogger 以 appendFileSync 落 JSONL，adapters/logging）。
const defaultAuditSink: BashReflexAuditSink = (entry) => {
  console.warn(`[bash-reflex-audit] ${JSON.stringify(entry)}`);
};

let auditSink: BashReflexAuditSink = defaultAuditSink;
const sessionAuditSinks = new Map<string, BashReflexAuditSink>();

/**
 * 替换审计 sink（进程级注册点，与 setProcessManagedPolicyFloor 同一接线形态）。
 * 传 undefined 复位为缺省 stderr sink（测试隔离用）。审计 sink 故障不影响权限决策。
 */
export function setBashReflexAuditSink(sink: BashReflexAuditSink | undefined): void {
  auditSink = sink ?? defaultAuditSink;
}

/** 注册一个 app/session 的审计 sink，返回幂等释放函数。 */
export function registerBashReflexAuditSink(
  sessionId: string,
  sink: BashReflexAuditSink,
): () => void {
  sessionAuditSinks.set(sessionId, sink);
  return () => {
    if (sessionAuditSinks.get(sessionId) === sink) sessionAuditSinks.delete(sessionId);
  };
}

function emitAudit(entry: BashReflexAuditEntry, sessionId?: string): void {
  try {
    const routedEntry = sessionId === undefined ? entry : { ...entry, sessionId };
    (sessionId === undefined ? auditSink : (sessionAuditSinks.get(sessionId) ?? auditSink))(
      routedEntry,
    );
  } catch {
    // 审计 sink 故障不得反向放宽/收紧权限决策：放行仍然放行，失败静默。
  }
}

// ── 文案（R5：四问、不披露阈值与内部级别名） ─────────────────────────

function buildReflectPrompt(
  findings: readonly { reason: string; target?: string }[],
  prefilled: boolean,
): string {
  const prefillNote = prefilled
    ? "\nThe `justification` field on this first attempt was not counted: it has to be written after reading this prompt, not before.\n"
    : "";
  return [
    "This command was not run. Its full effect could not be verified before execution, so it requires an explicit account of why it is needed.",
    "",
    "What could not be verified:",
    formatFindings(findings),
    "",
    "Before it can proceed, stop and check it against the user's actual request:",
    "1. Which specific thing the user asked for requires this exact action?",
    "2. Is the target of this command something the user explicitly named, or something you inferred?",
    "3. If you inferred it, would a narrower target accomplish the same goal?",
    "4. If this command turns out to be wrong, can its effects be recovered?",
    "",
    "If it is genuinely what the user asked for, re-issue the same command with a `justification` field explaining which request it serves. If you are not sure, ask the user instead: that costs one message, and being wrong costs their data.",
    prefillNote,
  ]
    .join("\n")
    .trimEnd();
}

function buildRetryPrompt(findings: readonly { reason: string; target?: string }[]): string {
  return [
    // 对抗复审 N9：措辞不误导。决策语义不变（spec R7 有意收紧——已获批的同命令重发
    // 仍要重走门），但必须说明「先前获批也救不了重提」，避免把合法重跑场景误读成文案失实。
    "This command is still not run. Repeating the identical call cannot unlock it — even if the same command was approved earlier, every re-issue needs a justification written after reading this prompt.",
    "",
    "What could not be verified:",
    formatFindings(findings),
    "",
    "Re-issue the same command with a `justification` field naming the specific user request this action serves — a confirmation word does not count — or ask the user directly.",
  ].join("\n");
}

function buildInsufficientPrompt(findings: readonly { reason: string; target?: string }[]): string {
  return [
    "This command is still not run. The justification provided does not explain what the user asked for: confirmation words or a reflexive short phrase do not count.",
    "",
    "What could not be verified:",
    formatFindings(findings),
    "",
    "Re-issue the same command with a `justification` field naming the specific user request this action serves and why this target follows from it, or ask the user directly.",
  ].join("\n");
}

function buildAskReason(
  justification: string,
  findings: readonly { reason: string; target?: string }[],
): string {
  return [
    "Command re-issued with a model justification after reflection. Its destructive scope could not be verified statically, so your approval is required.",
    `What could not be verified: ${summarizeFindings(findings)}`,
    `Model justification: "${justification}"`,
    "Check whether the justification matches what you actually asked for.",
  ].join("\n");
}

function buildBreakerAskReason(
  justification: string,
  findings: readonly { reason: string; target?: string }[],
): string {
  return [
    "Command's destructive scope could not be verified statically and the provided justification was insufficient, so bypass mode was downgraded to require your approval.",
    `What could not be verified: ${summarizeFindings(findings)}`,
    `Model justification: "${justification}"`,
  ].join("\n");
}

function formatFindings(findings: readonly { reason: string; target?: string }[]): string {
  const lines = findings.map(
    (finding) => `- ${finding.reason}${finding.target ? ` (target: ${finding.target})` : ""}`,
  );
  return lines.length > 0
    ? lines.join("\n")
    : "- the destructive target could not be determined statically";
}

function summarizeFindings(findings: readonly { reason: string; target?: string }[]): string {
  if (findings.length === 0) return "the destructive target could not be determined statically";
  return findings
    .map((finding) =>
      finding.target ? `${finding.reason} (target: ${finding.target})` : finding.reason,
    )
    .join("; ");
}

// ── 共用 ─────────────────────────────────────────────────────────────

const PASS_THROUGH: BashReflexGateOutcome = Object.freeze({ action: "pass-through" });

function outcome(
  action: Exclude<BashReflexGateAction, "pass-through">,
  ruleId: string,
  reason: string,
): BashReflexGateOutcome {
  return Object.freeze({ action, ruleId, reason });
}

function challengeKey(command: string, sessionId?: string): string {
  const hash = createHash("sha256");
  if (sessionId) {
    // 对抗复审 N3：挑战键并入调用方身份。PermissionService 实例不保证一个实例一个会话
    // （general-purpose/自定义子代理继承父实例），仅按命令文本哈希时，会话 A 触发的
    // 反射挑战会被会话 B 的首调「继承」，B 携带预填 justification 即可绕过反射轮。
    // NUL 分隔避免 "a"/"b\0c" 与 "a\0b"/"c" 这类拼接歧义（sessionId 由宿主生成，
    // 实际不含 NUL）。身份缺失的 legacy 调用方按仅命令文本哈希的现行为（spec R4 登记）。
    hash.update(sessionId, "utf8").update("\u0000", "utf8");
  }
  hash.update(command, "utf8");
  return hash.digest("hex");
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
