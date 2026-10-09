// 编译校验的消费示例（架构 context 阅读包展示；不执行任何 IO——不建连接、
// 不触网、不落盘）：channel/protocol 由宿主注入（declare），只演示 contract.ts
// 公开面的典型用法。
import {
  BufferReader,
  BufferWriter,
  Emitter,
  ProxyChannel,
  deserialize,
  serialize,
  type IChannel,
  type IDisposable,
  type IServerChannel,
} from "./contract.js";

declare const channel: IChannel;

/** call/listen 是 Channel RPC 的全部动词：命令走 call，广播事实走 listen。 */
export async function exampleCallAndListen(): Promise<{ echo: string; events: number }> {
  const echo = await channel.call<string>("echo", "ping");
  let events = 0;
  const subscription: IDisposable = channel.listen<number>("onProgress")(() => {
    events += 1;
  });
  subscription.dispose();
  return { echo, events };
}

/** 服务端：任意 service 对象经 ProxyChannel.fromService 自动包装为 IServerChannel。 */
export function exampleExposeService(): IServerChannel<string> {
  const service = {
    async echo(text: string): Promise<string> {
      return text;
    },
  };
  return ProxyChannel.fromService<string>(service);
}

/** 序列化是纯函数：writer 收集字节，reader 游标读取，roundtrip 无副作用。 */
export function exampleSerializeRoundtrip(): string {
  const writer = new BufferWriter();
  serialize(writer, { hello: "rpc" });
  const reader = new BufferReader(writer.buffer);
  const round = deserialize(reader) as { hello: string };
  return round.hello;
}

/** Event/Emitter 是模块内通用的观察者基座：fire 同步派发，dispose 幂等。 */
export function exampleEmitter(): number {
  const emitter = new Emitter<number>();
  let total = 0;
  const subscription = emitter.event((value) => {
    total += value;
  });
  emitter.fire(2);
  subscription.dispose();
  emitter.dispose();
  return total;
}
