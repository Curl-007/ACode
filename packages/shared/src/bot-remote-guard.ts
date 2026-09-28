/**
 * 远程 bot 入口的权限模式天花板原语（安全加固 P0-3）。
 *
 * 背景：被绑定的聊天用户可经 `/mode` 选 yolo 并 createTask 驱动 host agent，yolo 下无逐动作确认，
 * 等于「一条聊天消息 → 远程任意命令执行」。入站通道已扩到 4 个（飞书/Telegram/企业微信/Discord），
 * 该面随之放大。本模块把「远程入口不可达全权限档」这条不变量收敛为单一事实源，供 services 与 UI 共用。
 *
 * 仅含纯函数与常量、无任何 import：可被 node --test 直接加载做不变量守护测试，也不进 Node-only 子路径，
 * 浏览器/渲染进程可安全引用（UI 的权限模式选择卡片同样据此过滤）。
 *
 * 引擎作用域的实际允许集仍由注册表（acode-agent-registry）拥有；本模块只判定「哪些档位属于全权限」
 * 并提供过滤/夹取原语，二者组合见 `@acode/shared` 的 `getBotSelectablePermissionModes`。
 */

/**
 * 远程 bot 入口禁止的权限模式：这些档位跳过逐动作确认（yolo 直通、bypass 直通），
 * 一旦命中即等于把「远程聊天一条消息」直接放大成 host 上的任意副作用执行。
 * 需要这些模式必须在桌面本地显式操作，远程入口永不可达。
 */
export const BOT_REMOTE_FORBIDDEN_PERMISSION_MODES = ["yolo", "bypassPermissions"] as const;

/** 某权限模式是否属于远程入口禁止的全权限档。 */
export function isBotRemoteForbiddenPermissionMode(mode: string | null | undefined): boolean {
  if (!mode) {
    return false;
  }
  return (BOT_REMOTE_FORBIDDEN_PERMISSION_MODES as readonly string[]).includes(mode);
}

/**
 * 从引擎支持的权限模式集合中剔除全权限档，得到远程 bot 入口可选集（天花板）。
 * native(glm) 输入 build/edit/plan/yolo → 输出 build/edit/plan；不内联枚举，按输入过滤。
 */
export function filterBotSelectablePermissionModes<T extends string>(
  supportedModes: readonly T[],
): T[] {
  return supportedModes.filter((mode) => !isBotRemoteForbiddenPermissionMode(mode));
}

/**
 * 把请求的权限模式夹取到远程入口天花板内：
 * - 命中可选集（如 build/plan）→ 原样保留；
 * - 命中全权限档或不被引擎支持 → 回退 fallback（缺省权限模式）；
 * - fallback 自身也不在可选集 → 退到可选集首项；可选集为空 → undefined（调用方按既有逻辑跳过下发）。
 *
 * 这是「bot 驱动的会话永不进入 yolo」不变量的纯函数核心，派发咽喉与持久化归一都据此夹取。
 */
export function clampBotPermissionMode<T extends string>(
  mode: string | null | undefined,
  supportedModes: readonly T[],
  fallback: T,
): T | undefined {
  const selectable = filterBotSelectablePermissionModes(supportedModes);
  if (selectable.length === 0) {
    return undefined;
  }
  if (mode && (selectable as readonly string[]).includes(mode)) {
    return mode as T;
  }
  if ((selectable as readonly string[]).includes(fallback)) {
    return fallback;
  }
  return selectable[0];
}

// ── 绑定码防爆破（安全加固 P0-3）──────────────────────────────────────────────
//
// 背景：绑定码空间有限且 TTL 仅 30s，但旧 handleBind 无尝试频率限制，攻击者可在 TTL 内高速枚举。
// 这里提供「每 bot 连续错误计数 + 指数退避锁定」的纯逻辑单一事实源，与 hostCapability 同样是
// 仅存活于进程内存的守护存储；handleBind 据此在解锁前直接拒绝，杜绝暴力枚举。
//
// 状态所有者：botsService 进程内存（Map<botId, entry>），不落盘、不跨进程。

/** 触发首次锁定所需的连续错误尝试数；达到该数即锁定。 */
export const BOT_BIND_MAX_ATTEMPTS = 5;
/** 首次锁定基础时长；之后每次错误翻倍，封顶 BOT_BIND_MAX_LOCK_MS。 */
export const BOT_BIND_BASE_LOCK_MS = 30_000;
/** 单次锁定时长上限（15 分钟），防止退避无限增长锁死合法用户过久。 */
export const BOT_BIND_MAX_LOCK_MS = 15 * 60_000;

export interface BotBindAttemptGuardOptions {
  /** 触发首次锁定的连续错误数（默认 BOT_BIND_MAX_ATTEMPTS）。 */
  maxAttempts?: number;
  /** 首次锁定时长（默认 BOT_BIND_BASE_LOCK_MS）。 */
  baseLockMs?: number;
  /** 锁定时长上限（默认 BOT_BIND_MAX_LOCK_MS）。 */
  maxLockMs?: number;
  /** 时钟注入，便于测试推进时间（默认 Date.now）。 */
  now?: () => number;
}

export interface BotBindLockStatus {
  locked: boolean;
  /** 仍需等待多少毫秒解锁；未锁定为 0。 */
  retryAfterMs: number;
}

export interface BotBindAttemptGuard {
  /** 当前是否处于锁定（已过期锁定视为解锁，并顺手清理）。 */
  isLocked(botId: string): BotBindLockStatus;
  /**
   * 记录一次错误尝试：累计连续错误数，达到阈值后按 2^(失败次数-阈值) 指数退避锁定。
   * 返回记录后的锁定状态，供调用点直接回显剩余等待时间。
   */
  recordFailure(botId: string): BotBindLockStatus;
  /** 绑定成功后清除该 bot 的尝试计数与锁定。 */
  recordSuccess(botId: string): void;
}

interface BotBindAttemptEntry {
  /** 连续错误次数（成功或自然重置前不清零）。 */
  failures: number;
  /** 锁定到期时间戳（毫秒）；<= now 表示未锁定。 */
  lockedUntil: number;
}

/** 每 bot 绑定码尝试守护；纯内存、可注入时钟，便于回归测试推进时间验证退避。 */
export function createBotBindAttemptGuard(
  options: BotBindAttemptGuardOptions = {},
): BotBindAttemptGuard {
  const maxAttempts = Math.max(1, options.maxAttempts ?? BOT_BIND_MAX_ATTEMPTS);
  const baseLockMs = Math.max(0, options.baseLockMs ?? BOT_BIND_BASE_LOCK_MS);
  const maxLockMs = Math.max(baseLockMs, options.maxLockMs ?? BOT_BIND_MAX_LOCK_MS);
  const now = options.now ?? Date.now;
  const entries = new Map<string, BotBindAttemptEntry>();

  const statusAt = (entry: BotBindAttemptEntry | undefined, at: number): BotBindLockStatus => {
    if (!entry || entry.lockedUntil <= at) {
      return { locked: false, retryAfterMs: 0 };
    }
    return { locked: true, retryAfterMs: entry.lockedUntil - at };
  };

  return {
    isLocked(botId) {
      const at = now();
      const entry = entries.get(botId);
      // 锁定已自然过期：清掉 lockedUntil 但保留失败计数，使后续再犯的退避继续增长。
      if (entry && entry.lockedUntil <= at) {
        entry.lockedUntil = 0;
      }
      return statusAt(entry, at);
    },
    recordFailure(botId) {
      const at = now();
      const entry = entries.get(botId) ?? { failures: 0, lockedUntil: 0 };
      // 锁定窗口内的重试不再累计/延长，避免「锁定期狂发」把退避瞬间顶到上限；
      // 直接回显当前剩余等待时间，调用点据此提示。
      if (entry.lockedUntil > at) {
        entries.set(botId, entry);
        return statusAt(entry, at);
      }
      entry.failures += 1;
      if (entry.failures >= maxAttempts) {
        // 指数退避：第 maxAttempts 次锁 baseLockMs，其后每多一次翻倍，封顶 maxLockMs。
        const exponent = entry.failures - maxAttempts;
        const backoff = Math.min(baseLockMs * 2 ** exponent, maxLockMs);
        entry.lockedUntil = at + backoff;
      }
      entries.set(botId, entry);
      return statusAt(entry, at);
    },
    recordSuccess(botId) {
      entries.delete(botId);
    },
  };
}
