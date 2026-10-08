/**
 * 传输帧限制 —— 声明长度硬上限 + 半帧组装空闲超时
 *
 * 独立成模块的原因：SocketProtocol（protocol.ts）与 PersistentProtocol
 * （persistent-protocol.ts）两个读帧点共用同一套阈值与错误类型，
 * 不允许另起第二套（specs/rpc-frame-hardening.md 状态所有者）。
 */

/**
 * 单个传输帧声明 payload 长度的硬上限（256 MiB）。
 *
 * 修复依据（specs/rpc-frame-hardening.md 规则 5）：此前 readMessages 直接信任
 * header.readUInt32BE(9) 声明的长度（uint32 可声明至 ~4 GiB），整帧未到齐仅 break
 * 等待——远端可声明超大帧并慢速滴字节，让 ChunkStream 无界累积；VSBuffer.alloc 大
 * 分配走堆外内存，单连接即可吃掉 GiB 级 RSS（内存耗尽 DoS）。暴露面为 server /
 * acode-server-cli 的 WebSocket RPC 与 stdio RPC（ws 层 maxPayload 只限单条 ws 消息，
 * 逻辑帧可横跨多条，不构成传输帧上限）。
 *
 * 阈值调研依据（2026-10，repo 内经本帧协议的合法大载荷，详见 spec 规则 5）：
 * - IPluginSyncService 归档 50 MiB，嵌套 Uint8Array 走 base64+JSON ≈ 67 MiB（最大合法单帧）；
 * - IFileService.readBinaryPreview 25 MiB → base64 ≈ 34 MiB；readMediaPreview 8 MiB → ≈ 11 MiB；
 *   readFile 分段 256 KiB（顶层 Uint8Array 原始字节通道）；
 * - getModelTrajectory 32 MiB 轨迹尾部；ISkillSyncService 归档 20 MiB → ≈ 27 MiB；
 * - v4 事件：物理帧 1 MiB / 逻辑帧组装上限 16 MiB；附件 512 KiB 分块或路径 staging。
 * 最大合法单帧 ≈ 67 MiB，256 MiB 保留约 3.8 倍 headroom——宁大勿小，错杀合法大帧是
 * 功能回归，比防护不足更糟。TCP 顺序性保证半帧滞留字节 ≤ HEADER_SIZE + 声明长度，
 * 因此本上限同时把单连接组装内存钉死在 256 MiB + 13 B 以内。
 */
export const TRANSPORT_FRAME_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

/**
 * 半帧组装空闲超时（30 s，对齐 v4 PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs）。
 *
 * 修复依据（specs/rpc-frame-hardening.md 规则 6）：此前半帧组装无任何超时，半开连接
 * 可无限期占住半帧内存与连接槽位（PersistentProtocol 的 ACK_TIMEOUT 只覆盖发送侧
 * outgoingUnackMsg，被动慢速连接永不超时）。
 *
 * 语义：**空闲**计时而非绝对截止——仅当接收缓冲存在未完成帧的字节时武装，每有新字节
 * 到达即重新计时。慢但持续推进的合法大帧（如 67 MiB 归档走慢速 WAN）不受影响；纯空闲
 * 连接（缓冲无字节）不武装定时器；停滞的半帧在到期后断开释放。stdio 本地传输发送端
 * 单次 write 写整帧，帧中间停滞 ≥ 30 s 只可能是对端进程挂死，统一适用是安全的；
 * Node 定时器基于单调时钟，系统休眠恢复不会误触发。MessagePort 传输天然消息边界、
 * 不经 ChunkStream 组装，不适用本超时。
 */
export const TRANSPORT_FRAME_ASSEMBLY_IDLE_TIMEOUT_MS = 30_000;

/** 传输帧违规原因（用于日志与消费方诊断，不携带 payload 内容）。 */
export type TransportFrameViolationReason = "declared-payload-too-large" | "assembly-idle-timeout";

/**
 * 传输层帧违规错误。
 *
 * 与 serialization 层的 FrameDecodeError 语义不同：FrameDecodeError 表示"帧内容畸形"，
 * 由 ChannelServer 丢弃单帧且连接保持存活；TransportFrameError 表示"字节流本身不可信"
 * （流式传输上无法安全跳过永远不会到齐的半帧再同步），必须终结底层连接。
 */
export class TransportFrameError extends Error {
  constructor(
    readonly reason: TransportFrameViolationReason,
    message: string,
  ) {
    super(message);
    this.name = "TransportFrameError";
  }
}

/**
 * Node 环境下不让 watchdog 定时器阻止进程自然退出；浏览器 setTimeout 无 unref，跳过。
 * 包内工具（protocol / persistent-protocol 共用），不从包入口导出。
 */
export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}
