// Harness API 的 in-process 构造小入口（K8 ACP 宿主适配专用，spec 附录 A.1）。
//
// 为什么需要这个文件：ACP 适配进程要把 createHarnessApiServer 挂在同进程的
// ServiceCollection 上（不绕道子进程），但 services 的懒构造与退出回收
// （createStdioServices / disposeServiceResourcesAndWait）目前只在 entry-harness
// 这个独立入口里接线。若由适配层（apps/acode-cli）直接 import @acode/services，
// 会破坏「适配层只 import harness SDK/server 公开面」的源码断言——所以把
// in-process 生命周期封装成本包的公开导出，services 依赖留在 server 包内。
//
// 边界：本文件不承载任何业务状态——services 实例的所有者仍是 ServiceCollection
// 自身，这里只持「懒工厂 + dispose 句柄」两个连接作用域值（K7 R5 同款纪律）。

import type { ServiceCollection } from "@acode/services";
import { disposeServiceResourcesAndWait } from "@acode/services/node";
import { createStdioServices } from "./stdioServices.js";

/**
 * services 集合类型的公开再导出：ACP 适配层需要以 ServiceCollection 为参数
 * 装配 in-process 链路，但源码断言禁止适配层直接 import @acode/services——
 * 经本公开面转出类型，依赖方向保持在 server 包内（spec 附录 A.1）。
 */
export type HarnessServiceCollection = ServiceCollection;

export interface CreateInProcessHarnessServicesOptions {
  /**
   * 环境（缺省 process.env）。与 entry-harness 同源：authority mode 等推导链
   * 从 env 进入 services。内置 provider 配置文件路径为必填——调用方（CLI 进程）
   * 用自己的 provider runtime env 物化结果传入，本入口不做构建期常量假设
   * （readBundledACodeBuiltinProviderConfig 的嵌入常量只在远端 Server 构建存在）。
   */
  env?: Record<string, string | undefined>;
  acodeBuiltinProviderConfigFilePath: string;
  /** 非法 authority mode 的观测回调（生产打 stderr 日志；测试可静默）。 */
  onInvalidAuthorityMode?: (invalidRawValue: string) => void;
}

export interface InProcessHarnessServices {
  /** 懒构造（首个调用才装配 services——握手/降级路径不初始化完整服务面）。 */
  services: () => Promise<ServiceCollection>;
  /** 退出回收：走 services 层统一异步回收契约（Agent 进程树清理），幂等。 */
  dispose: () => Promise<void>;
}

export function createInProcessHarnessServices(
  options: CreateInProcessHarnessServicesOptions,
): InProcessHarnessServices {
  let instance: ServiceCollection | undefined;
  let promise: Promise<ServiceCollection> | undefined;
  let disposed = false;
  const services = (): Promise<ServiceCollection> => {
    if (instance) return Promise.resolve(instance);
    // dispose 之后不允许再拉起服务面（fail-closed，防止退出路径上复活 services）。
    if (disposed) return Promise.reject(new Error("in-process harness services already disposed"));
    promise ??= (async () => {
      const { authorityModeParseResult, services: created } = createStdioServices({
        ...(options.env ? { env: options.env } : {}),
        acodeBuiltinProviderConfigFilePath: options.acodeBuiltinProviderConfigFilePath,
      });
      if (authorityModeParseResult.invalidRawValue) {
        options.onInvalidAuthorityMode?.(authorityModeParseResult.invalidRawValue);
      }
      instance = created;
      return created;
    })();
    return promise;
  };
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    if (instance) {
      const target = instance;
      instance = undefined;
      promise = undefined;
      await disposeServiceResourcesAndWait(target);
    }
  };
  return { services, dispose };
}
