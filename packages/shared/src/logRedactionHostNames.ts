/**
 * 主机名/用户名注册表：运行期收名 + 不劈名字的截断
 * （specs/log-privacy-redaction.md R2/R6）。
 *
 * 日志里会出现 SSH 主机名、远程 workspace 主机名、Windows 账户真名等
 * 「内部服务地址与真实用户数据」。这些名字无法静态枚举，只能在运行期
 * 由知道名字的调用点（身份收集、远程连接建立点）登记进本注册表，
 * 脱敏管线再按登记名单做整词替换。
 *
 * 收名规则（与替换正则的边界守卫配套）：
 * - NFC 归一 + casefold（逐字符 toLowerCase，长度变化的字符保留原形；ς→σ），
 *   剥尾部点号；同时登记 NFD 打印形态，保证组合字符两种拼法都能命中。
 * - 长度 <3 不收（误伤面太大）；>255 不收（DNS 上限，防正则膨胀）。
 * - localhost / 127.x.x.x / ::1 不收：回环地址不是隐私，保留可排障。
 * - 上限 2000 条：超限置 full 标志并停止收录（注册表绝不无界增长）。
 * - 剥不可见码点（Cc/Cf/U+034F/U+2028/U+2029）后若与原形不同，递归补登记，
 *   防止零宽字符把名字切成两半绕过整词替换。
 *
 * 纯数据结构，无 IO、无 node 依赖。
 */

export type RedactionNameKind = "user" | "host";

export interface HostNameRegistry {
  /** 登记一个名字；kind 决定替换占位符（<user>/<host>）。 */
  register(kind: RedactionNameKind, name: string): void;
  /** 批量登记 [name, kind] 条目。 */
  registerAll(entries: Iterable<readonly [name: string, kind: RedactionNameKind]>): void;
  /** 当前登记的名字 → 类别（只读视图，供组合正则按引用+size 缓存）。 */
  readonly names: ReadonlyMap<string, RedactionNameKind>;
  /** 已登记名字的全部打印形态（NFC/NFD/casefold 变体），截断回退用。 */
  readonly printedForms: ReadonlySet<string>;
  /** 最长打印形态长度，截断回退窗口用。 */
  readonly longestPrintedLength: number;
  /** 是否已因超限/超长拒收（诊断用；已收名字继续生效）。 */
  readonly full: boolean;
  /** 截断文本到 limit，截断点不落在任何已登记名字内部（R6：整段进或整段出）。 */
  truncatePreservingNames(text: string, limit: number): string;
}

/** 注册表容量上限：超过后停止收名并置 full 标志。 */
export const HOST_NAME_REGISTRY_LIMIT = 2000;

/** 回环主机名/地址不收名：不是隐私，保留可排障。 */
const LOOPBACK_NAME_PATTERN = /^(?:localhost|127(?:\.\d{1,3}){1,3}|::1)$/;

/** 不可见/格式码点：剥掉后与原形不同则递归补登记（防零宽字符绕过）。 */
const INVISIBLE_CODEPOINT_PATTERN = /[\p{Cc}\p{Cf}\u034f\u2028\u2029]/gu;

/**
 * casefold：逐字符小写，但仅当小写不改变长度时采用
 * （如 `İ`.toLowerCase() 会变两字符，保留原形防止错位）；末尾 ς→σ
 * 统一希腊字母终形，保证同一名字的词中/词尾拼法收敛到同一键。
 */
export function casefoldName(name: string): string {
  return name
    .replace(/./gsu, (character) => {
      const lower = character.toLowerCase();
      return lower.length === character.length ? lower : character;
    })
    .replaceAll("\u03c2", "\u03c3");
}

interface RegistryState {
  names: Map<string, RedactionNameKind>;
  printedForms: Set<string>;
  longestPrintedLength: number;
  full: boolean;
}

export function createHostNameRegistry(): HostNameRegistry {
  const state: RegistryState = {
    names: new Map(),
    printedForms: new Set(),
    longestPrintedLength: 0,
    full: false,
  };

  function register(kind: RedactionNameKind, rawName: string): void {
    if (typeof rawName !== "string") {
      return;
    }
    const name = casefoldName(rawName.normalize("NFC").replace(/\.$/, ""));
    // 过短的名字（如 "ab"）整词替换误伤面太大；已收过的名字只允许类别升级 user 优先。
    if (name.length < 3 || LOOPBACK_NAME_PATTERN.test(name)) {
      return;
    }
    if (state.names.has(name)) {
      if (kind === "user") {
        state.names.set(name, kind);
      }
      return;
    }
    if (state.names.size >= HOST_NAME_REGISTRY_LIMIT || name.length > 255) {
      // fail-closed 方向：宁可少替换，也不让组合正则无界膨胀拖垮每行日志。
      state.full = true;
      return;
    }
    for (const variant of new Set([name, name.toLowerCase()])) {
      state.names.set(variant, kind);
      // NFC 与 NFD 两种拼法都登记为打印形态：日志里的组合字符可能是任一种。
      for (const form of [variant, casefoldName(variant.normalize("NFD"))]) {
        state.printedForms.add(form);
        state.longestPrintedLength = Math.max(state.longestPrintedLength, form.length);
      }
    }
    const stripped = name.replace(INVISIBLE_CODEPOINT_PATTERN, "");
    if (stripped !== name) {
      register(kind, stripped);
    }
  }

  function truncatePreservingNames(text: string, limit: number): string {
    if (text.length <= limit) {
      return text;
    }
    const { printedForms, longestPrintedLength } = state;
    if (printedForms.size === 0) {
      return text.slice(0, limit);
    }
    // 在 [limit-longest, limit+longest] 窗口内找最靠前的名字命中，把截断点
    // 回退到名字起点之前——名字整段进或整段出，绝不出现半截真名。
    const windowStart = Math.max(0, limit - longestPrintedLength);
    const window = casefoldName(text.slice(windowStart, limit + longestPrintedLength));
    let cut = limit - windowStart;
    for (const form of printedForms) {
      const found = window.indexOf(form, Math.max(0, cut - form.length + 1));
      if (found !== -1 && found < cut) {
        cut = found;
      }
    }
    const absoluteCut = windowStart + cut;
    if (absoluteCut < limit) {
      return truncatePreservingNames(text, absoluteCut);
    }
    return text.slice(0, limit);
  }

  return {
    register,
    registerAll(entries) {
      for (const [name, kind] of entries) {
        register(kind, name);
      }
    },
    get names() {
      return state.names;
    },
    get printedForms() {
      return state.printedForms;
    },
    get longestPrintedLength() {
      return state.longestPrintedLength;
    },
    get full() {
      return state.full;
    },
    truncatePreservingNames,
  };
}
