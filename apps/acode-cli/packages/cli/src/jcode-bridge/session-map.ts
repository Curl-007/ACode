// ============================================================
// jcode 桥接：v4 sessionId ↔ jcode sessionId 双向映射（spec R3）
//
// 为什么需要映射而非直接复用同一 id：
// - v4 sessionId 由 ACode 客户端在 createSession 命令里给出（或网关生成），是
//   ACode 侧的会话身份，贯穿 topic 名（conversation/<sessionId>）、CommandInbox
//   的 per-session 串行 gate、attachment registry 的分桶键。
// - jcode sessionId 由 jcode daemon 生成（spike 实测形如
//   session_retriever_1792735243337_a8a51d56e4b2116d），shim 无法指定。
// 两者必须建立稳定关联，且是「唯一会话关联事实源」（spec R3 不变量）：投影、
// 命令路由、事件翻译都以本表为准，不得各自另存一份（避免重复状态与多写入路径）。
//
// 生命周期：进程内（shim 无持久状态，spec R3）。重启即新表；jcode 侧会话可经
// session/load 重新 attach，但 attach 前 shim 无从知道对应关系，故不跨进程恢复。
//
// 本模块是纯内存数据结构，无外部 I/O，可直接单测。
// ============================================================

/** 单条映射的附加事实：建立时刻与该会话的 workspace（供 sessions-index 分桶）。 */
export interface JcodeSessionBinding {
  /** ACode v4 侧会话 id。 */
  readonly v4SessionId: string;
  /** jcode 侧会话 id（由 session/new 返回）。 */
  readonly jcodeSessionId: string;
  /** 会话工作目录（v4 的 workspaceIdentity 在 jcode 侧退化为 cwd，见 spec R4-5 边界）。 */
  readonly cwd: string;
  /** 映射建立时刻（Unix ms），用于诊断与 LRU 兜底。 */
  readonly createdAt: number;
}

/**
 * 双向映射表。
 *
 * 反向索引（jcode→v4）是必需的：jcode 的 session/update 事件只带 jcode sessionId，
 * 翻译层必须据此找回 v4 sessionId 才能把 SessionEvent 喂给正确的投影 topic。
 */
export class JcodeSessionMap {
  private readonly byV4 = new Map<string, JcodeSessionBinding>();
  private readonly byJcode = new Map<string, JcodeSessionBinding>();

  /**
   * 登记一条映射。
   *
   * 冲突语义（fail-closed，对齐 ACode 纪律）：
   * - 同一 v4SessionId 重复登记但指向**不同** jcodeSessionId → 抛错。这是调用方
   *   逻辑错误（一个 v4 会话不应绑定两个 jcode 会话），静默覆盖会让旧 jcode 会话
   *   的事件流向错误投影。
   * - 同一 jcodeSessionId 被两个 v4SessionId 登记 → 抛错（同一 jcode 会话的事件
   *   无法同时归属两个投影）。
   * - 完全相同的重复登记（同 v4 + 同 jcode）→ 幂等 no-op，返回既有 binding。
   */
  bind(v4SessionId: string, jcodeSessionId: string, cwd: string, now: number): JcodeSessionBinding {
    const existingByV4 = this.byV4.get(v4SessionId);
    if (existingByV4) {
      if (existingByV4.jcodeSessionId === jcodeSessionId) {
        return existingByV4;
      }
      throw new Error(
        `jcode session map: v4 session ${v4SessionId} already bound to ` +
          `${existingByV4.jcodeSessionId}, refusing to rebind to ${jcodeSessionId}`,
      );
    }
    const existingByJcode = this.byJcode.get(jcodeSessionId);
    if (existingByJcode) {
      throw new Error(
        `jcode session map: jcode session ${jcodeSessionId} already bound to ` +
          `${existingByJcode.v4SessionId}, refusing duplicate bind`,
      );
    }
    const binding: JcodeSessionBinding = { v4SessionId, jcodeSessionId, cwd, createdAt: now };
    this.byV4.set(v4SessionId, binding);
    this.byJcode.set(jcodeSessionId, binding);
    return binding;
  }

  /** v4 → jcode。未登记返回 undefined（调用方据此判定「非本进程创建的会话」）。 */
  toJcode(v4SessionId: string): string | undefined {
    return this.byV4.get(v4SessionId)?.jcodeSessionId;
  }

  /** jcode → v4。事件翻译的主入口；未登记返回 undefined（事件应被忽略并留痕）。 */
  toV4(jcodeSessionId: string): string | undefined {
    return this.byJcode.get(jcodeSessionId)?.v4SessionId;
  }

  /** 取完整 binding（诊断/测试用）。 */
  get(v4SessionId: string): JcodeSessionBinding | undefined {
    return this.byV4.get(v4SessionId);
  }

  /** 会话是否在册（V4GatewayHost.sessionExists 的实现依据，spec R1/接口节）。 */
  has(v4SessionId: string): boolean {
    return this.byV4.has(v4SessionId);
  }

  /**
   * 解除映射（会话关闭/删除时）。
   *
   * 返回被移除的 binding；不存在返回 undefined（幂等——重复 close 不应报错，
   * 与 spike §4.3 实测的 `session/cancel` 空闲幂等语义一致）。
   */
  unbind(v4SessionId: string): JcodeSessionBinding | undefined {
    const binding = this.byV4.get(v4SessionId);
    if (!binding) return undefined;
    this.byV4.delete(v4SessionId);
    this.byJcode.delete(binding.jcodeSessionId);
    return binding;
  }

  /** 当前在册会话数（诊断/上限校验）。 */
  get size(): number {
    return this.byV4.size;
  }

  /** 全部在册 v4 sessionId（sessions-index 降级实现用，spec「未做与取舍」）。 */
  listV4SessionIds(): string[] {
    return [...this.byV4.keys()];
  }
}
