/**
 * SecretRedactor：混淆/还原双面引擎（WI-17 转录密钥混淆·核心件）。
 *
 * 语义移植自 oh-my-pi（MIT License, Copyright (c) oh-my-pi contributors）
 * `packages/coding-agent/src/secrets/obfuscator.ts` 的可逆混淆子集；omp 的
 * replace 模式、SecretValueSet 碰撞索引、流式增量脱敏、friendly 前缀剥离等面
 * 不在 ACode 落点内（spec R2/R4 论证），不移植。裁剪后保留的核心不变量：
 *   1. 确定性：同一秘密在同一 per-install 私钥下铸造同一占位符（跨请求/跨重启稳定）；
 *   2. 可逆性：铸造即登记还原表，obfuscate→restore 逐字节相等；
 *   3. 幂等性：占位符字符集与内置正则的前缀/边界锚定互斥，二次混淆恒等；
 *   4. 惰性密钥：keyProvider 只在第一次真正铸造时被调用（无活跃秘密不落 key 文件）；
 *   5. 性能：plain 秘密合并 literal 探测 + 每正则 literalPrefixes 门（omp 同款），
 *      无命中文本原引用返回（不复制、不破坏调用方的 === 恒等判断）。
 */
import type { ModelInputMessage, ModelMessageContentBlock } from "@acode/contracts";
import type { SecretEntry } from "./collect.js";
import {
  buildHashBase,
  buildPlaceholder,
  createPlaceholderRegex,
  inferCaseHint,
  isStrictMintedPlaceholderShape,
  MIN_OBFUSCATE_SECRET_LEN,
  placeholderWithoutFriendlyName,
  sanitizeSecretFriendlyName,
} from "./placeholder.js";

interface PlainSecretRecord {
  secret: string;
  /** 惰性铸造的占位符（首次替换时计算并 memoize，HMAC 每秘密一次/进程）。 */
  placeholder?: string;
}

interface CompiledRegexEntry {
  regex: RegExp;
  friendlyName?: string;
  /** 快速跳过门：命中任一字面量才跑 regex。i-flag 时以小写形态比较。 */
  gateLiterals?: readonly string[];
  gateCaseInsensitive: boolean;
}

interface SecretRedactorOptions {
  entries: readonly SecretEntry[];
  /** 惰性 per-install HMAC 私钥。调用方保证值不进日志（spec R5）。 */
  keyProvider: () => string;
}

export interface RestoreOutcome<T> {
  value: T;
  /** 严格铸造形态但还原表查不到的候选数（fail-loud 提示的触发面，spec R3）。 */
  unresolvedPlaceholders: number;
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class SecretRedactor {
  /** plain 秘密按长度降序（长秘密先替换，防短秘密截断长秘密的中段）。 */
  readonly #plain: PlainSecretRecord[] = [];
  readonly #plainBySecret = new Map<string, PlainSecretRecord>();
  #plainDetector: RegExp | undefined;
  readonly #regexEntries: CompiledRegexEntry[] = [];
  /** 占位符 → 秘密原文（铸造即登记；含去友好前缀别名键）。 */
  readonly #deobfuscateMap = new Map<string, string>();
  readonly #placeholderMemo = new Map<string, string>();
  readonly #keyProvider: () => string;

  constructor(options: SecretRedactorOptions) {
    this.#keyProvider = options.keyProvider;
    for (const entry of options.entries) {
      if (entry.type === "plain") {
        this.addPlainSecret(entry.content);
        continue;
      }
      try {
        const flags = entry.flags ?? "";
        const regex = new RegExp(entry.content, flags.includes("g") ? flags : `${flags}g`);
        const gateCaseInsensitive = flags.includes("i");
        this.#regexEntries.push({
          regex,
          friendlyName: entry.friendlyName,
          gateCaseInsensitive,
          ...(entry.literalPrefixes === undefined
            ? {}
            : {
                gateLiterals: entry.literalPrefixes.map((literal) =>
                  gateCaseInsensitive ? literal.toLowerCase() : literal,
                ),
              }),
        });
      } catch {
        // 非法正则条目跳过（内置族是仓库常量，理论不可达；防御性静默跳过而非启动失败）。
      }
    }
  }

  /** 注册 plain 秘密（收集面 + key 文件内容自保护共用入口，spec R1-4）。 */
  addPlainSecret(secret: string): void {
    if (secret.length < MIN_OBFUSCATE_SECRET_LEN) return;
    if (this.#plainBySecret.has(secret)) return;
    const record: PlainSecretRecord = { secret };
    this.#plainBySecret.set(secret, record);
    // 插入保持长度降序。
    let index = this.#plain.length;
    while (index > 0 && this.#plain[index - 1].secret.length < secret.length) index--;
    this.#plain.splice(index, 0, record);
    this.#plainDetector = undefined; // 失效合并探测器，下次扫描惰性重建。
  }

  get plainSecretCount(): number {
    return this.#plain.length;
  }

  get regexEntryCount(): number {
    return this.#regexEntries.length;
  }

  get registeredPlaceholderCount(): number {
    return this.#deobfuscateMap.size;
  }

  /** 预铸造全部 plain 秘密的占位符（禁用开关下的存量占位符还原用，spec R6）。 */
  premintPlainPlaceholders(): void {
    // 快照迭代：铸造可能触发 keyProvider 的 addPlainSecret（惰性 key 创建路径），
    // 不得在 for...of 中途变更被迭代数组。
    for (const record of this.#plain.slice()) this.#placeholderFor(record);
  }

  // ─────────────────────────── 混淆面 ───────────────────────────

  /** 混淆一段文本；无命中时返回原引用（identity）。 */
  obfuscateText(text: string): string {
    if (!text) return text;
    if (this.#plain.length === 0 && this.#regexEntries.length === 0) return text;
    let result = text;
    let changed = false;

    if (this.#plain.length > 0) {
      const detector = (this.#plainDetector ??= new RegExp(
        this.#plain.map((record) => escapeRegExpLiteral(record.secret)).join("|"),
      ));
      if (detector.test(result)) {
        // 快照迭代：首次铸造会调 keyProvider，其惰性 key 创建分支可能 addPlainSecret
        // （key 文件内容自保护）并在本循环进行中变更 #plain——快照隔离该变更，
        // 新条目从下一次扫描开始生效。
        for (const record of this.#plain.slice()) {
          if (!result.includes(record.secret)) continue;
          result = result.split(record.secret).join(this.#placeholderFor(record));
          changed = true;
        }
      }
    }

    if (this.#regexEntries.length > 0) {
      // i-flag 门的 lowercase 探针全文只算一次（omp #foldedOnce 同款惰性折叠）。
      let folded: string | undefined;
      for (const entry of this.#regexEntries) {
        if (entry.gateLiterals !== undefined) {
          const probe = entry.gateCaseInsensitive ? (folded ??= result.toLowerCase()) : result;
          let gateHit = false;
          for (const literal of entry.gateLiterals) {
            if (probe.includes(literal)) {
              gateHit = true;
              break;
            }
          }
          if (!gateHit) continue;
        }
        const before = result;
        result = result.replace(entry.regex, (match) => {
          if (match.length < MIN_OBFUSCATE_SECRET_LEN) return match;
          return this.#mint(match, entry.friendlyName);
        });
        if (result !== before) changed = true;
      }
    }

    return changed ? result : text;
  }

  /** 深遍历模型请求消息做混淆投影；全部无命中时返回原数组引用。 */
  projectModelMessages(messages: readonly ModelInputMessage[]): ModelInputMessage[] {
    if (this.#plain.length === 0 && this.#regexEntries.length === 0) {
      return messages as ModelInputMessage[];
    }
    let changed = false;
    const projected = messages.map((message) => {
      const next = this.#projectMessage(message);
      if (next !== message) changed = true;
      return next;
    });
    return changed ? projected : (messages as ModelInputMessage[]);
  }

  #projectMessage(message: ModelInputMessage): ModelInputMessage {
    let changed = false;
    const content = this.#projectContent(message.content);
    if (content !== message.content) changed = true;
    let toolCalls = message.toolCalls;
    if (toolCalls !== undefined) {
      let callsChanged = false;
      const projectedCalls = toolCalls.map((call) => {
        const input = this.obfuscateValue(call.input);
        if (input === call.input) return call;
        callsChanged = true;
        return { ...call, input };
      });
      if (callsChanged) {
        toolCalls = projectedCalls;
        changed = true;
      }
    }
    return changed
      ? { ...message, content, ...(toolCalls === undefined ? {} : { toolCalls }) }
      : message;
  }

  #projectContent(content: ModelInputMessage["content"]): ModelInputMessage["content"] {
    if (typeof content === "string") return this.obfuscateText(content);
    let changed = false;
    const projected = content.map((block) => {
      const next = this.#projectBlock(block);
      if (next !== block) changed = true;
      return next;
    });
    return changed ? projected : content;
  }

  #projectBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
    // 二进制载荷（image/video/file dataUrl）与路由标识符（resource_link）不动——
    // omp docs/secrets.md 同款边界；file block 的 text 字段是文本面，参与混淆。
    switch (block.type) {
      case "text":
      case "reasoning": {
        const text = this.obfuscateText(block.text);
        return text === block.text ? block : { ...block, text };
      }
      case "file": {
        if (block.text === undefined) return block;
        const text = this.obfuscateText(block.text);
        return text === block.text ? block : { ...block, text };
      }
      default:
        return block;
    }
  }

  /** 深遍历任意 JSON 值混淆其中字符串（assistant toolCalls input 回放用）。 */
  obfuscateValue(value: unknown): unknown {
    return this.#walk(value, (text) => this.obfuscateText(text), undefined);
  }

  // ─────────────────────────── 还原面 ───────────────────────────

  /** 深遍历工具执行入参还原占位符；未知 $$…$$ 形态原样放行（spec R3）。 */
  restoreValue(value: unknown): RestoreOutcome<unknown> {
    const state = { unresolved: 0 };
    const restored = this.#walk(value, (text) => this.#restoreText(text, state), new WeakSet());
    return { value: restored, unresolvedPlaceholders: state.unresolved };
  }

  #restoreText(text: string, state: { unresolved: number }): string {
    if (!text.includes("$$")) return text;
    const regex = createPlaceholderRegex();
    let changed = false;
    const result = text.replace(regex, (match) => {
      const secret = this.#lookup(match);
      if (secret !== undefined) {
        changed = true;
        return secret;
      }
      // 只有严格铸造形态计入 unresolved（宽松形态可能是用户字面量，spec R3 误杀边界）。
      if (isStrictMintedPlaceholderShape(match)) state.unresolved++;
      return match;
    });
    return changed ? result : text;
  }

  #lookup(placeholder: string): string | undefined {
    const direct = this.#deobfuscateMap.get(placeholder);
    if (direct !== undefined) return direct;
    const unprefixed = placeholderWithoutFriendlyName(placeholder);
    return unprefixed === undefined ? undefined : this.#deobfuscateMap.get(unprefixed);
  }

  #walk(
    value: unknown,
    transform: (text: string) => string,
    seen: WeakSet<object> | undefined,
  ): unknown {
    if (typeof value === "string") return transform(value);
    if (Array.isArray(value)) {
      if (seen) {
        if (seen.has(value)) return value;
        seen.add(value);
      }
      let changed = false;
      const mapped = value.map((item) => {
        const next = this.#walk(item, transform, seen);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? mapped : value;
    }
    if (value !== null && typeof value === "object") {
      if (seen) {
        if (seen.has(value)) return value;
        seen.add(value);
      }
      let changed = false;
      const mapped: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const next = this.#walk(item, transform, seen);
        if (next !== item) changed = true;
        mapped[key] = next;
      }
      return changed ? mapped : value;
    }
    return value;
  }

  // ─────────────────────────── 铸造 ───────────────────────────

  #placeholderFor(record: PlainSecretRecord): string {
    record.placeholder ??= this.#mint(record.secret, undefined);
    return record.placeholder;
  }

  #mint(secret: string, friendlyName: string | undefined): string {
    const memoKey = friendlyName === undefined ? secret : `${friendlyName}\u0000${secret}`;
    const memoized = this.#placeholderMemo.get(memoKey);
    if (memoized !== undefined) return memoized;
    const key = this.#keyProvider();
    const sanitized =
      friendlyName === undefined ? undefined : sanitizeSecretFriendlyName(friendlyName);
    // 碰撞防御：12 位 base36（~62bit）下碰撞概率可忽略，但确定性正确性要求不同秘密
    // 绝不共享占位符——冲突时以 attempt 加盐重铸（omp #reserveFallbackPlaceholderBase 同款）。
    let placeholder = "";
    for (let attempt = 0; attempt < 16; attempt++) {
      const base =
        attempt === 0
          ? buildHashBase(key, secret)
          : buildHashBase(key, `${secret}\u0000${attempt}`);
      const candidate = buildPlaceholder(inferCaseHint(secret), base, sanitized);
      const existing = this.#deobfuscateMap.get(candidate);
      if (existing === undefined || existing === secret) {
        placeholder = candidate;
        break;
      }
    }
    if (placeholder === "") {
      // 16 次加盐全部碰撞在密码学上不可达；仍不静默：以最后一次候选兜底会破坏可逆性，
      // 这里选择保留原文（fail-open 到不混淆单条，绝不 fail 到错误还原）。
      return secret;
    }
    this.#placeholderMemo.set(memoKey, placeholder);
    this.#deobfuscateMap.set(placeholder, secret);
    if (sanitized !== undefined) {
      // 去友好前缀别名：模型可能省略前缀回写，还原查表需要兜住（omp 同款别名）。
      const alias = placeholderWithoutFriendlyName(placeholder);
      if (alias !== undefined && !this.#deobfuscateMap.has(alias)) {
        this.#deobfuscateMap.set(alias, secret);
      }
    }
    return placeholder;
  }
}
