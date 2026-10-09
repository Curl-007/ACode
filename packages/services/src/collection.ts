import { ProxyChannel, type IChannelServer } from "@acode/rpc";
import type { ServiceDescriptor } from "./descriptors.js";

/**
 * ServiceCollection — 服务注册中心
 *
 * 服务端用来注册服务实例，并自动暴露到 ChannelServer。
 */
export class ServiceCollection {
  private readonly _services = new Map<string, unknown>();
  private readonly _descriptors = new Map<string, ServiceDescriptor<unknown>>();

  register<T>(descriptor: ServiceDescriptor<T>, instance: T): this {
    this._services.set(descriptor.channelName, instance);
    this._descriptors.set(descriptor.channelName, descriptor as ServiceDescriptor<unknown>);
    return this;
  }

  get<T>(descriptor: ServiceDescriptor<T>): T {
    const instance = this._services.get(descriptor.channelName);
    if (!instance) {
      throw new Error(`Service not registered: ${descriptor.channelName}`);
    }
    return instance as T;
  }

  getOptional<T>(descriptor: ServiceDescriptor<T>): T | undefined {
    return this._services.get(descriptor.channelName) as T | undefined;
  }

  /** 将所有已注册的服务自动暴露为 channel */
  exposeOnChannelServer(
    server: IChannelServer,
    overrides: ReadonlyMap<string, unknown> = new Map(),
  ): void {
    for (const [channelName, instance] of this._services) {
      const exposed = overrides.get(channelName) ?? instance;
      server.registerChannel(
        channelName,
        ProxyChannel.fromService(exposed as Record<string, unknown>, undefined, {
          // JS 调用方或旧测试替身可能缺少表；必须按空表拒绝，不能退回原型发现。
          allowedMethods: this._descriptors.get(channelName)?.allowedMethods ?? [],
          argumentValidators: this._descriptors.get(channelName)?.argumentValidators,
        }),
      );
    }
  }
}
