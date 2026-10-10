/**
 * harness-sdk 模块清单：Harness API v1 TypeScript SDK（connect/launch 双模式）。
 *
 * 连接层（握手/pending map/seq）、会话面（订阅/事件队列/权限 fail-closed 计时器）
 * 与 launch 运行时治理都是模块内部实现；消费者只能经 contract.ts（或保持兼容的
 * index.ts 包根入口）使用公开 API。依赖声明与 architecture-policy.yaml 保持一致：
 * 协议投影唯一来自 @acode/shared/harness-api（requires: ["shared"]）。
 */
export const harnessSdkModule = {
  id: "harness-sdk",
  requires: ["shared"],
  provides: ["harness-sdk-client"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
