/**
 * Layer 5: ProxyChannel —— 服务自动代理（杀手锏）
 *
 * 这是让 VS Code 开发者效率极高的关键抽象。
 *
 * 没有 ProxyChannel 时，你需要为每个服务手写 IServerChannel：
 *   class FileServiceChannel implements IServerChannel {
 *     call(ctx, command, arg) {
 *       switch (command) {
 *         case 'readFile': return this.service.readFile(arg[0]);
 *         case 'writeFile': return this.service.writeFile(arg[0], arg[1]);
 *         // ... 每个方法都要手动映射
 *       }
 *     }
 *   }
 *
 * 有了 ProxyChannel，一行代码搞定：
 *   const channel = ProxyChannel.fromService(fileService);
 *   // 自动把所有方法映射为 call，所有 on* 事件映射为 listen
 *
 * 客户端同样一行：
 *   const fileService = ProxyChannel.toService<IFileService>(channel);
 *   await fileService.readFile(uri);  // 就像调用本地方法！
 *
 * 原理：
 * - fromService: 遍历 service 的属性，方法 → call，on* 事件 → listen
 * - toService: 利用 ES6 Proxy 拦截属性访问，自动分派到 call/listen
 */

import { Event, Emitter, IDisposable, DisposableStore } from "./foundation.js";
import { IChannel, IServerChannel } from "./channels.js";

// ============================================================================
// ProxyChannel
// ============================================================================

export namespace ProxyChannel {
  /**
   * 服务公开面的可选收窄。缺省时从服务自己的可调用成员建立冻结表，
   * 显式名单读取真实成员（包括 Proxy get 覆盖），不能暴露不可调用属性。
   */
  export interface FromServiceOptions {
    readonly allowedMethods?: readonly string[];
    /** Runtime argument guards executed before the service method body. */
    readonly argumentValidators?: ReadonlyMap<string, RpcArgumentValidator>;
  }

  /**
   * 服务端：把一个 service 对象自动包装为 IServerChannel
   *
   * 约定：
   * - 以 on + 大写字母开头的属性视为事件 (如 onDidChange)
   * - 以 onDynamic + 大写字母开头的视为动态事件（方法，调用后返回事件）
   * - 其他方法视为 RPC 方法
   */
  export function fromService<TContext>(
    service: unknown,
    disposables?: DisposableStore,
    options?: FromServiceOptions,
  ): IServerChannel<TContext> {
    const handler = service as { [key: string]: unknown };

    // 公开面只在装配时解析一次。不能在 call 时按字符串重新索引 service：
    // 那会把 constructor/__proto__/Object.prototype 方法变成远程入口。
    const { events, methods } = collectServiceMembers(handler, options?.allowedMethods);
    const argumentValidators = freezeArgumentValidators(options?.argumentValidators);
    const eventMap = new Map<string, Event<unknown>>();
    for (const [key, event] of events) {
      // 把事件 buffer 化：即使没人订阅，事件也不会丢失。
      eventMap.set(key, bufferEvent(event));
    }

    return {
      listen<T>(_ctx: TContext, event: string, arg?: any): Event<T> {
        // 先查缓存
        const cached = eventMap.get(event);
        if (cached) {
          return cached as Event<T>;
        }

        const target = methods.get(event);
        if (target) {
          // 动态事件：onDynamicXxx(arg) 返回一个 Event
          if (isDynamicEvent(event)) {
            const validator = argumentValidators.get(event);
            if (validator) {
              try {
                validator(arg === undefined ? [] : [arg]);
              } catch (error) {
                if (error instanceof RpcArgumentError) throw error;
                throw new RpcArgumentError(
                  event,
                  error instanceof Error ? error.message : undefined,
                );
              }
            }
            return target.call(handler, arg) as Event<T>;
          }
        }

        throw new Error(`Event not found: ${event}`);
      },

      call<T>(_ctx: TContext, command: string, args?: any[]): Promise<T> {
        const target = methods.get(command);
        if (target) {
          const validator = argumentValidators.get(command);
          if (validator) {
            try {
              validator(args ?? []);
            } catch (error) {
              if (error instanceof RpcArgumentError) {
                throw error;
              }
              throw new RpcArgumentError(command, error instanceof Error ? error.message : undefined);
            }
          }
          let result = target.apply(handler, args || []);
          if (!(result instanceof Promise)) {
            result = Promise.resolve(result);
          }
          return result as Promise<T>;
        }
        throw new Error(`Method not found: ${command}`);
      },
    };
  }

  /**
   * 客户端：把一个 IChannel 包装成类型安全的 service 对象
   *
   * 利用 ES6 Proxy 拦截所有属性访问：
   * - 访问 on* → channel.listen(propKey)
   * - 访问其他 → 返回一个函数，调用时变成 channel.call(propKey, args)
   */
  export function toService<T extends object>(
    channel: IChannel,
    options?: { context?: unknown },
  ): T {
    return new Proxy({} as T, {
      get(target: T, propKey: PropertyKey, receiver: object) {
        // React 开发态、日志工具和浏览器运行时会探测对象的 Symbol / then 等内置属性。
        // 之前这里把所有未知属性都强行当成 RPC 成员处理，读取 Symbol.toStringTag 会直接抛错，
        // 读取 then 还会把普通 service 误判成 thenable，导致远程 workspace 在选目录后重渲染时炸掉。
        // 这类运行时探测属性应该回退到普通对象语义，而不是走 RPC。
        if (typeof propKey === "symbol") {
          return Reflect.get(target as object, propKey, receiver);
        }

        if (typeof propKey === "string") {
          if (propKey === "then") {
            return undefined;
          }

          // 动态事件
          if (isDynamicEvent(propKey)) {
            return (arg: unknown) => channel.listen(propKey, arg);
          }

          // 普通事件
          if (isEvent(propKey)) {
            return channel.listen(propKey);
          }

          // 方法调用
          return async (...args: unknown[]) => {
            // 可选：注入 context 作为第一个参数
            const methodArgs = options?.context !== undefined ? [options.context, ...args] : args;
            return channel.call(propKey, methodArgs);
          };
        }

        return Reflect.get(target as object, propKey, receiver);
      },
    });
  }
}

/** A small runtime contract shared by RPC descriptors and the generic proxy. */
export type RpcArgumentValidator = (args: readonly unknown[]) => void;

/** Stable, serializable rejection for malformed RPC input. */
export class RpcArgumentError extends Error {
  readonly code = "rpc-invalid-arguments" as const;
  readonly method: string;
  readonly details: string;

  constructor(method: string, details = "arguments do not match the declared RPC contract") {
    super(`Invalid arguments for RPC method: ${method}`);
    this.name = "RpcArgumentError";
    this.method = method;
    // Validators must provide a safe summary, never the rejected values.
    this.details = details.slice(0, 160);
  }
}

function freezeArgumentValidators(
  validators?: ReadonlyMap<string, RpcArgumentValidator>,
): ReadonlyMap<string, RpcArgumentValidator> {
  if (!validators || validators.size === 0) return new Map();
  return new Map(validators);
}

const RPC_RESERVED_MEMBER_NAMES = new Set(["constructor", "__proto__", "prototype"]);

function collectServiceMembers(
  handler: { [key: string]: unknown },
  allowedMethods?: readonly string[],
): {
  events: Map<string, Event<unknown>>;
  methods: Map<string, (...args: any[]) => unknown>;
} {
  const events = new Map<string, Event<unknown>>();
  const methods = new Map<string, (...args: any[]) => unknown>();
  const collectMember = (key: string): void => {
    if (RPC_RESERVED_MEMBER_NAMES.has(key)) return;
    // 修复依据：connection scope 和 Host owner 路由通过 Proxy.get 覆盖方法。
    // descriptor.value 会绕过这些鉴权/路由；显式名单也必须支持无自有属性的远端 Proxy。
    const value = Reflect.get(handler, key);
    if (typeof value !== "function") return;
    // 显式名单不能把普通对象继承的内置方法扩张成远程入口；自定义覆盖仍遵循 JS 语义。
    if (value === Reflect.get(Object.prototype, key)) return;
    if (isEvent(key) && !isDynamicEvent(key)) {
      events.set(key, value as Event<unknown>);
    } else {
      methods.set(key, value as (...args: any[]) => unknown);
    }
  };
  if (allowedMethods !== undefined) {
    for (const key of new Set(allowedMethods)) collectMember(key);
    return { events, methods };
  }

  const seenMembers = new Set<string>();
  let current: object | null = handler;

  // Walk custom prototypes so existing class services remain callable, but stop
  // before Object.prototype and never expose reserved prototype escape hatches.
  while (current && current !== Object.prototype) {
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string" || RPC_RESERVED_MEMBER_NAMES.has(key)) continue;
      if (seenMembers.has(key)) continue;
      // 修复依据：JavaScript 自有成员优先于原型。即使自有成员不是函数，也不能
      // 回退暴露同名原型方法，所以必须在检查 descriptor 前记录第一次出现的名字。
      seenMembers.add(key);
      collectMember(key);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }

  return { events, methods };
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 匹配 onXxx 事件命名约定 */
function isEvent(name: string): boolean {
  return (
    name.length >= 3 &&
    name[0] === "o" &&
    name[1] === "n" &&
    name.charCodeAt(2) >= 65 && // A
    name.charCodeAt(2) <= 90
  ); // Z
}

/** 匹配 onDynamicXxx 动态事件命名约定 */
function isDynamicEvent(name: string): boolean {
  return (
    name.length >= 10 &&
    name.startsWith("onDynamic") &&
    name.charCodeAt(9) >= 65 &&
    name.charCodeAt(9) <= 90
  );
}

/**
 * 缓冲事件：确保在订阅之前触发的事件不会丢失。
 * 未订阅时事件存入队列，一有订阅者就 flush。
 */
function bufferEvent<T>(event: Event<T>): Event<T> {
  let buffer: T[] = [];
  let flushing = false;
  let listener: IDisposable | undefined;

  const emitter = new Emitter<T>({
    onWillAddFirstListener: () => {
      listener = event((e) => {
        if (flushing) {
          emitter.fire(e);
        } else {
          buffer.push(e);
        }
      });
    },
    onDidRemoveLastListener: () => {
      listener?.dispose();
      listener = undefined;
      buffer = [];
    },
  });

  // 一旦有订阅者，先 flush 缓冲区
  const originalEvent = emitter.event;
  return (listener_fn) => {
    const disposable = originalEvent(listener_fn);
    if (!flushing) {
      flushing = true;
      for (const item of buffer) {
        emitter.fire(item);
      }
      buffer = [];
    }
    return disposable;
  };
}
