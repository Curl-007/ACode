/**
 * state 注册表（specs/windows-helper-producer.md §11.5）：state_id → 会话层元数据 +
 * native 冻结域 token 的映射。进程内存态、代际即失效（新 Helper 代的一切 token 全新，
 * 旧代 token 一律 unknown → element_unavailable，SDK STALE_STATE/reobserve 语义自然承接）。
 *
 * 索引解析纪律（§11.4）：动作按「该 app scope 最新一次观察」解析索引——wire 不携观察
 * 凭证（SDK 契约：索引身份只有 app + index）；新观察覆盖注册表 → 旧 state 的 element
 * target → element_unavailable（stale → reobserve）。**跨观察索引兼容被结构性排除**：
 * 覆盖时即通知 native 释放旧冻结域，旧域索引即使数值上存在于新域也不可解析。
 *
 * 内存有界（§11.5 钉死）：每 app scope ≤16 条元数据 LRU、≤8 个 app scope；逐出 =
 * 通知 native 释放冻结 COM 引用（AddRef/Release 配对是 native 职责，JS 绝不触 COM）。
 *
 * 纯 TS、零依赖（§10.11 模块规则①同律：不得 import native-driver/uia-driver）。
 */

export interface StateRecord {
  /** 不透明串 st-<generation>-<counter>（代内唯一、不复用，§11.5）。 */
  readonly stateId: string;
  readonly pid: number;
  /** native 冻结域 token（COM 引用不出 native；JS 只持不透明整数）。 */
  readonly nativeStateToken: number;
  readonly windowId: number;
  readonly createdAt: number;
  readonly elementCount: number;
  /** §11.2：记录进元数据（诊断/未来位移台账用），不作 load-bearing 判定。 */
  readonly treeShownToModel: boolean;
  /** 该记录的冻结域是否仍可动作（被新观察覆盖后 false；元数据保留仅供诊断）。 */
  readonly actionable: boolean;
}

export interface StateRegistryDeps {
  /** 冻结域释放通知（native COM 引用释放；best-effort，实现侧吞错）。 */
  release(nativeStateToken: number): void;
  /** state_id 的 generation 分量（entry 注入 process.pid——Helper 代内唯一）。 */
  generation: number;
  maxStatesPerScope?: number;
  maxScopes?: number;
}

export interface StateRegistration {
  pid: number;
  nativeStateToken: number;
  windowId: number;
  elementCount: number;
  treeShownToModel: boolean;
}

export interface StateRegistry {
  /** 登记一次新观察：同 scope 旧观察的冻结域立即释放（覆盖语义，§11.4）。 */
  register(registration: StateRegistration): StateRecord;
  /** 该 app scope 最新一次观察（element target 的索引解析入口）；无 → undefined。 */
  latestForPid(pid: number): StateRecord | undefined;
  readonly size: number;
  readonly scopeCount: number;
}

export const STATE_MAX_PER_SCOPE = 16;
export const STATE_MAX_SCOPES = 8;

export function createStateRegistry(deps: StateRegistryDeps): StateRegistry {
  const maxPerScope = deps.maxStatesPerScope ?? STATE_MAX_PER_SCOPE;
  const maxScopes = deps.maxScopes ?? STATE_MAX_SCOPES;
  let counter = 0;
  // Map 迭代序 = 插入序：scope 级 LRU（最旧 scope 先逐出）与 scope 内 LRU 都靠它。
  const scopes = new Map<number, StateRecord[]>();
  // 每 scope 的最新观察（唯一可动作域）。
  const latest = new Map<number, StateRecord>();

  const releaseQuiet = (token: number): void => {
    try {
      deps.release(token);
    } catch {
      // 释放通知失败不阻断观察登记（native 侧 best-effort，代际清零兜底）。
    }
  };

  return {
    register(registration: StateRegistration): StateRecord {
      counter += 1;
      const record: StateRecord = {
        stateId: `st-${deps.generation}-${counter}`,
        pid: registration.pid,
        nativeStateToken: registration.nativeStateToken,
        windowId: registration.windowId,
        createdAt: Date.now(),
        elementCount: registration.elementCount,
        treeShownToModel: registration.treeShownToModel,
        actionable: true,
      };
      // 覆盖语义（§11.4）：同 scope 旧最新观察的冻结域立即释放——旧 state_id 的
      // element target 自此 element_unavailable（跨观察索引兼容被结构性排除）。
      const previous = latest.get(registration.pid);
      if (previous && previous.nativeStateToken !== registration.nativeStateToken) {
        releaseQuiet(previous.nativeStateToken);
      }
      latest.set(registration.pid, record);

      const history = scopes.get(registration.pid) ?? [];
      // 历史记录里的旧条目全部降为非可动作（元数据保留，冻结域已释放）。
      for (let i = 0; i < history.length; i += 1) {
        if (history[i].actionable) {
          history[i] = { ...history[i], actionable: false };
        }
      }
      history.push(record);
      // scope 内 LRU：超出 ≤16 逐出最旧（最旧必非 actionable——其冻结域已在覆盖时释放）。
      while (history.length > maxPerScope) history.shift();
      scopes.set(registration.pid, history);

      // scope 级 LRU：超出 ≤8 逐出最旧 scope（释放其最新冻结域）。
      while (scopes.size > maxScopes) {
        const oldest = scopes.keys().next();
        if (oldest.done === true) break;
        const oldestPid = oldest.value as number;
        const oldestLatest = latest.get(oldestPid);
        if (oldestLatest) releaseQuiet(oldestLatest.nativeStateToken);
        scopes.delete(oldestPid);
        latest.delete(oldestPid);
      }
      return record;
    },

    latestForPid(pid: number): StateRecord | undefined {
      return latest.get(pid);
    },

    get size(): number {
      let total = 0;
      for (const history of scopes.values()) total += history.length;
      return total;
    },

    get scopeCount(): number {
      return scopes.size;
    },
  };
}
