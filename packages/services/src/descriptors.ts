/**
 * ServiceDescriptor — 以频道名称标识服务并通过泛型关联类型。
 *
 * 利用 TypeScript 允许同名 interface + const（类型和值在不同命名空间）的特性，
 * 让调用方使用同一个名称引用服务类型和运行时描述符。
 */

export interface ServiceDescriptor<T> {
  readonly channelName: string;
  /**
   * RPC 公开方法/事件表。所有服务必须显式声明，避免把实现类上的内部原型方法或事件
   * 暴露到远程边界；新增成员时同步公开 interface 与此表。
   */
  readonly allowedMethods: readonly string[];
  /** Runtime argument guards for sensitive methods; copied and frozen at assembly. */
  readonly argumentValidators: ReadonlyMap<string, RpcArgumentValidator>;
  /** Phantom type — 仅用于类型推断，运行时不存在 */
  readonly _brand?: T;
}

export function createServiceDescriptor<T>(
  channelName: string,
  options: {
    readonly allowedMethods: readonly Extract<keyof T, string>[];
    readonly argumentValidators?: Partial<Record<Extract<keyof T, string>, RpcArgumentValidator>>;
  },
): ServiceDescriptor<T> {
  const validators = new Map<string, RpcArgumentValidator>();
  for (const [method, validator] of Object.entries(options.argumentValidators ?? {})) {
    if (typeof validator === "function") {
      validators.set(method, validator as RpcArgumentValidator);
    }
  }
  return {
    channelName,
    // 修复依据（rpc-service-boundary spec）：descriptor 拥有唯一公开表，不能让调用者
    // 持有的可变数组在装配前后扩张权限。复制并冻结，隔离外部数组的后续修改。
    allowedMethods: Object.freeze([...options.allowedMethods]),
    argumentValidators: createReadonlyMap(validators),
  };
}

function createReadonlyMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const map = new Map(source);
  return Object.freeze({
    get size() {
      return map.size;
    },
    get: map.get.bind(map),
    has: map.has.bind(map),
    keys: map.keys.bind(map),
    values: map.values.bind(map),
    entries: map.entries.bind(map),
    forEach: map.forEach.bind(map),
    [Symbol.iterator]: map[Symbol.iterator].bind(map),
  }) as ReadonlyMap<K, V>;
}
import type { RpcArgumentValidator } from "@acode/rpc";
