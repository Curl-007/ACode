// keyboard-interactive 安全应答（修复「同一密码应答全部提示」缺口）。
// 规格见 packages/server/specs/ssh-prompt-mediation.md R2/R3/R4-6。
//
// 修复原因：旧实现 `finish(prompts.map(() => password))` 用同一密码应答全部
// 提示——多提示（2FA）场景必错；`Username:` 这类 echo=true 的可见槽位也会被
// 答上密码，把凭据推进非密文通道；提示文本从不经消毒就参与任何展示。
// 现在只允许「单提示 + echo=false + 密码语义」自动应答；其余记录闭集拒绝、
// 空应答结束本轮认证，并预留中介提示通道入口（顺序闸由通道治理）。
import {
  sanitizeSSHPromptText,
  summarizeSanitizedPromptText,
} from "@acode/server/remote/sshPromptSanitize.js";
import type {
  SSHPromptAbortReason,
  SSHPromptOutcome,
  SSHSecretPromptKind,
} from "@acode/server/remote/sshPromptTypes.js";

export type SSHKeyboardInteractivePromptClassification =
  | "password"
  | "passphrase"
  | "second_factor"
  | "unrecognized";

/** 拒绝原因闭集；错误通道形态对齐 SSHHostKeyVerificationError（code + 结构化载荷）。 */
export type SSHKeyboardInteractiveRefusalReason =
  | "multi_prompt"
  | "second_factor_prompt"
  | "passphrase_prompt"
  | "unrecognized_prompt";

export interface SSHKeyboardInteractiveRefusal {
  readonly reason: SSHKeyboardInteractiveRefusalReason;
  /** 消毒后的提示文本快照（按提示顺序）；仅用于展示、日志与错误文案。 */
  readonly sanitizedPrompts: readonly string[];
  /** 经中介通道但被 abort 时记录 abort 原因；纯拒绝路径缺省。 */
  readonly mediatorAbort?: SSHPromptAbortReason;
}

// 语义词表宁保守：拒答标记优先于密码白名单（「动态密码/验证码」同时含
// 「密码」与拒答词时判 second_factor）；无法确认即 unrecognized。
// 覆盖 en/zh(简繁)/ja/ko/de/fr/es/pt/it/nl/sv/no/da/pl/ru/tr/vi/id/ar 常见措辞。
const SECOND_FACTOR_MARKER_PATTERN =
  /\b(?:otp|totp|hotp|2fa|mfa|passcode|authenticator|yubikey|token|code|pin|challenge|duo|verification|verify)\b|\bone[\s-]?time\b|\btwo[\s-]?factor\b|\bsecurity\s+key\b|验证码|驗證碼|认证码|認證碼|动态密码|動態密碼|动态口令|一次性|双因素|雙因素|两步验证|兩步驗證|認証コード|確認コード|ワンタイム|二要素|일회용|인증\s*코드|확인\s*코드/u;

const PASSPHRASE_MARKER_PATTERN =
  /\bpassphrase\b|\bpass[\s-]?phrase\b|\bprivate[\s-]?key\b|\bsecret[\s-]?key\b|口令|パスフレーズ|개인키/u;

const PASSWORD_MARKER_PATTERN =
  /password|passwort|mot de passe|contraseña|senha|parola|wachtwoord|lösenord|passord|adgangskode|hasło|пароль|كلمة المرور|şifre|密码|密碼|パスワード|비밀번호|mật khẩu|kata sandi/u;

/**
 * 单条提示的语义分类（纯函数，消毒后匹配）。
 * echo=true 是可见输入槽位（如 Username），一律不识别为密码——用密码应答
 * 可见槽位等于把凭据泄露进对端可回显/可记录的通道。
 */
export function classifyKeyboardInteractivePrompt(prompt: {
  prompt: string;
  echo: boolean;
}): SSHKeyboardInteractivePromptClassification {
  if (prompt.echo !== false) {
    return "unrecognized";
  }
  const text = sanitizeSSHPromptText(prompt.prompt).toLowerCase();
  if (!text) {
    return "unrecognized";
  }
  if (SECOND_FACTOR_MARKER_PATTERN.test(text)) {
    return "second_factor";
  }
  if (PASSPHRASE_MARKER_PATTERN.test(text)) {
    return "passphrase";
  }
  if (PASSWORD_MARKER_PATTERN.test(text)) {
    return "password";
  }
  return "unrecognized";
}

/** 拒绝的用户可读解释（自撰文案；提示摘要必须先经消毒与截断）。 */
export function describeSSHKeyboardInteractiveRefusal(
  refusal: SSHKeyboardInteractiveRefusal,
): string {
  const excerpt = summarizeSanitizedPromptText(refusal.sanitizedPrompts[0] ?? "");
  switch (refusal.reason) {
    case "multi_prompt":
      return `SSH 服务器一次发出了 ${refusal.sanitizedPrompts.length} 条交互提示（可能包含双因素验证码）。ACode 只自动应答单条密码提示；为避免把密码答给错误的问题，本次认证已放弃。请在服务器侧启用密码或公钥认证，或改用无需多条提示的登录方式。`;
    case "second_factor_prompt":
      return `SSH 服务器要求一次性验证码/双因素应答（提示：“${excerpt}”）。ACode 尚未接入可代为输入验证码的交互界面，本次认证已放弃；请改用密码或公钥认证，或在系统 SSH 客户端完成本次登录。`;
    case "passphrase_prompt":
      return `SSH 服务器通过交互提示索取私钥口令（提示：“${excerpt}”）。连接密码与私钥口令是两种凭据，为避免答非所问泄露密码，本次认证已放弃；请为该连接配置正确的私钥口令。`;
    case "unrecognized_prompt":
      return `SSH 服务器发起了 ACode 无法识别语义的交互提示（提示：“${excerpt}”），已放弃自动应答；请改用密码或公钥认证。`;
  }
}

export class SSHKeyboardInteractiveRefusalError extends Error {
  readonly code = "ssh-keyboard-interactive-refused" as const;
  readonly reason: SSHKeyboardInteractiveRefusalReason;
  readonly refusal: SSHKeyboardInteractiveRefusal;

  constructor(refusal: SSHKeyboardInteractiveRefusal) {
    super(describeSSHKeyboardInteractiveRefusal(refusal));
    this.name = "SSHKeyboardInteractiveRefusalError";
    this.reason = refusal.reason;
    this.refusal = refusal;
  }
}

/**
 * 中介提示通道入口（预留）：结构化 requestSecretPrompt 与
 * sshPromptChannel.ts 的通道形状兼容（结构类型对接，无 import 环）。
 */
export interface SSHKeyboardInteractiveMediatorPort {
  requestSecretPrompt(request: {
    kind: SSHSecretPromptKind;
    text: string;
    secret: boolean;
  }): Promise<SSHPromptOutcome>;
}

export interface SSHKeyboardInteractiveResponderOptions {
  /** 存在中介时，非密码语义的单提示交给通道由真人应答；abort 落回拒绝路径。 */
  mediator?: SSHKeyboardInteractiveMediatorPort;
  /** 拒绝回调：连接层记录/暴露解释文案（SSHBackend 注入属后续集成批次）。 */
  onRefusal?: (refusal: SSHKeyboardInteractiveRefusal) => void;
}

export type SSHKeyboardInteractiveResponder = ((
  name: string,
  instructions: string,
  lang: string,
  prompts: Array<{ prompt: string; echo: boolean }>,
  finish: (responses: string[]) => void,
) => void) & {
  /**
   * 读取并清空最近一次拒绝记录（take 语义：防止陈旧拒绝污染后续无关错误的
   * 归一化）。连接层在认证失败时读取，注入 normalizeSSHConnectError context。
   */
  takeLastRefusal(): SSHKeyboardInteractiveRefusal | undefined;
};

const CLASSIFICATION_TO_REFUSAL_REASON: Record<
  Exclude<SSHKeyboardInteractivePromptClassification, "password">,
  SSHKeyboardInteractiveRefusalReason
> = {
  passphrase: "passphrase_prompt",
  second_factor: "second_factor_prompt",
  unrecognized: "unrecognized_prompt",
};

const CLASSIFICATION_TO_PROMPT_KIND: Record<
  Exclude<SSHKeyboardInteractivePromptClassification, "password">,
  SSHSecretPromptKind
> = {
  passphrase: "passphrase",
  second_factor: "otp",
  unrecognized: "generic",
};

export function createKeyboardInteractiveResponder(
  password?: string,
  options?: SSHKeyboardInteractiveResponderOptions,
): SSHKeyboardInteractiveResponder {
  let lastRefusal: SSHKeyboardInteractiveRefusal | undefined;

  const responder = (
    _name: string,
    _instructions: string,
    _lang: string,
    prompts: Array<{ prompt: string; echo: boolean }>,
    finish: (responses: string[]) => void,
  ): void => {
    void _name;
    void _instructions;
    void _lang;
    if (!Array.isArray(prompts) || prompts.length === 0) {
      finish([]);
      return;
    }

    let settled = false;
    const finishOnce = (responses: string[]): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        finish(responses);
      } catch {
        // 连接可能已在中介等待期间关闭；迟到应答不能再抛进 ssh2 内部状态机。
      }
    };
    const refuse = (
      refusal: SSHKeyboardInteractiveRefusal,
    ): void => {
      lastRefusal = refusal;
      try {
        options?.onRefusal?.(refusal);
      } catch {
        // 拒绝回调是观测面：回调异常不得改变 fail-closed 结果。
      }
      finishOnce([]);
    };

    const sanitizedPrompts = prompts.map((prompt) =>
      sanitizeSSHPromptText(String(prompt?.prompt ?? "")),
    );

    if (prompts.length > 1) {
      // 多提示批次不经中介：ssh2 finish 是批量语义，逐条中介留待通道 UI 批次。
      refuse({ reason: "multi_prompt", sanitizedPrompts });
      return;
    }

    const classification = classifyKeyboardInteractivePrompt(prompts[0]!);
    if (classification === "password") {
      if (typeof password === "string" && password.length > 0) {
        finishOnce([password]);
        return;
      }
      finishOnce([]);
      return;
    }

    const refusalReason = CLASSIFICATION_TO_REFUSAL_REASON[classification];
    const mediator = options?.mediator;
    if (!mediator) {
      refuse({ reason: refusalReason, sanitizedPrompts });
      return;
    }

    // 预留的中介提示通道入口：顺序闸（对端 host key 未确认 → secret 提示
    // 不展示，abort peer_unconfirmed）由通道内部治理；abort/异常落回拒绝路径。
    void (async () => {
      let outcome: SSHPromptOutcome;
      try {
        outcome = await mediator.requestSecretPrompt({
          kind: CLASSIFICATION_TO_PROMPT_KIND[classification],
          text: sanitizedPrompts[0] ?? "",
          secret: true,
        });
      } catch {
        outcome = { answered: false, abort: "dismissed" };
      }
      if (outcome.answered && outcome.value.length > 0) {
        finishOnce([outcome.value]);
        return;
      }
      refuse({
        reason: refusalReason,
        sanitizedPrompts,
        ...(outcome.answered ? {} : { mediatorAbort: outcome.abort }),
      });
    })();
  };

  return Object.assign(responder, {
    takeLastRefusal(): SSHKeyboardInteractiveRefusal | undefined {
      const refusal = lastRefusal;
      lastRefusal = undefined;
      return refusal;
    },
  });
}
