// 连接层公开类型的中立落点：connection.ts 与 handshake.ts 共同引用。
// 拆分约束（纳管后 forbidCycles 生效）：handshake.ts 若直接 import connection.ts，
// 会与 connection.ts → handshake.ts 形成模块内循环；类型下沉到本文件消除该环。
// connection.ts 以 `export type ... from` 原样转发，包根导出面不变。

export interface HarnessConnectionOptions {
  handshakeTimeoutMs?: number;
  /** seq 缺口回调（丢帧检测）：expectedSeq 为按单调性应到达的 seq。 */
  onGap?: (info: { expectedSeq: number; receivedSeq: number; sessionId: string }) => void;
  stderr?: (chunk: string) => void;
}

export interface HarnessServerInfo {
  server: string;
  protocolMinor: number;
  capabilities: string[];
}
