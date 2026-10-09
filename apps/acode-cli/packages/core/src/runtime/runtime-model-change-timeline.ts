import type { PendingModelChangeTimeline } from "./types.js";

/**
 * 待持久化模型切换 timeline 的所有者（CLI-05 I8，specs/runtime-state-ownership.md）。
 *
 * 不并入 RuntimeLifecycleOwner：这不是单调旗标，而是可替换、可清除的 pending 记录，
 * 消费语义（set / consume）与一次性 flag 不同。记录只能整体替换或原子取出：
 * `recordPendingModelChange` 在同步片内计算 replace-or-clear 后经 set 提交；
 * `persistPendingModelChangeTimeline` 经 consume「读取即清空」，避免持久化 await
 * 期间第二条记录被同一次 consume 重复发布。
 *
 * owner 对入库记录做浅冻结：现有路径从不原地修改存储对象（替换时构造新对象），
 * 冻结不改变行为，只阻止读面通过 getter 结果反向改写 owner 事实。
 */
export interface RuntimeModelChangeTimelineView {
  readonly pendingModelChangeTimeline: PendingModelChangeTimeline | undefined;
}

export interface RuntimeModelChangeTimelinePort {
  /** 替换或清除 pending 记录；undefined 表示清除（等价 from/to 的回退场景）。 */
  setPendingModelChangeTimeline(timeline: PendingModelChangeTimeline | undefined): void;
  /** 原子取出并清空；空时返回 undefined，二次 consume 不会拿到同一条记录。 */
  consumePendingModelChangeTimeline(): PendingModelChangeTimeline | undefined;
}

class RuntimeModelChangeTimelineOwner {
  #timeline: PendingModelChangeTimeline | undefined;

  get timeline(): PendingModelChangeTimeline | undefined {
    return this.#timeline;
  }

  readonly port: RuntimeModelChangeTimelinePort = Object.freeze({
    setPendingModelChangeTimeline: (timeline: PendingModelChangeTimeline | undefined): void => {
      this.#timeline = timeline && Object.freeze(timeline);
    },
    consumePendingModelChangeTimeline: (): PendingModelChangeTimeline | undefined => {
      const current = this.#timeline;
      this.#timeline = undefined;
      return current;
    },
  });
}

const owners = new WeakMap<object, RuntimeModelChangeTimelineOwner>();

/** 构造期绑定一次；重复初始化不能替换已有 owner 或 getter。 */
export function initializeRuntimeModelChangeTimeline(runtime: object): void {
  if (owners.has(runtime)) return;
  const owner = new RuntimeModelChangeTimelineOwner();
  Object.defineProperty(runtime, "pendingModelChangeTimeline", {
    configurable: false,
    enumerable: true,
    get: () => owner.timeline,
  });
  owners.set(runtime, owner);
}

export function getRuntimeModelChangeTimelinePort(
  runtime: object,
): RuntimeModelChangeTimelinePort {
  const owner = owners.get(runtime);
  if (!owner) throw new Error("Runtime model change timeline has not been initialized");
  return owner.port;
}
