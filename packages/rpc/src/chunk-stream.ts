/**
 * ChunkStream —— 处理 TCP 的分片和粘包
 *
 * 从 protocol.ts 拆出（与 persistent-protocol.ts 拆分同理：单文件行数上限），
 * 保持纯字节缓冲职责，不感知帧语义——帧合法性（声明长度上限、半帧空闲超时）
 * 由 SocketProtocol / PersistentProtocol 的读帧点统一裁决
 * （specs/rpc-frame-hardening.md 规则 5/6）。
 */

import { VSBuffer } from "./buffer.js";

/**
 * TCP 是流式协议，一次 write 不代表对面一次 read 就能完整收到。
 * ChunkStream 把收到的碎片攒起来，按需读取指定字节数。
 */
export class ChunkStream {
  private chunks: VSBuffer[] = [];
  private totalLength = 0;

  get byteLength(): number {
    return this.totalLength;
  }

  acceptChunk(chunk: VSBuffer): void {
    this.chunks.push(chunk);
    this.totalLength += chunk.byteLength;
  }

  /**
   * 预览前 byteCount 字节，但不消费底层缓冲。
   *
   * Socket/stdio 传输天然可能分片。
   * 之前协议层在 body 还没收全时就先把 header read 掉，后续再来的 body
   * 会失去对应的帧头，导致消息永远卡住。这里提供 peek，让调用方先判断
   * “整帧是否已经到齐”，确认足够后再真正消费。
   */
  peek(byteCount: number): VSBuffer | null {
    if (this.totalLength < byteCount) {
      return null;
    }

    if (this.chunks[0].byteLength >= byteCount) {
      return this.chunks[0].slice(0, byteCount);
    }

    const result = VSBuffer.alloc(byteCount);
    let offset = 0;
    for (const chunk of this.chunks) {
      if (offset >= byteCount) {
        break;
      }

      const remaining = byteCount - offset;
      const copyLength = Math.min(chunk.byteLength, remaining);
      result.set(copyLength === chunk.byteLength ? chunk : chunk.slice(0, copyLength), offset);
      offset += copyLength;
    }

    return result;
  }

  /** 丢弃前 byteCount 字节 */
  skip(byteCount: number): void {
    const discarded = this.read(byteCount);
    if (!discarded) {
      throw new Error(`ChunkStream.skip(${byteCount}) 超出可读范围`);
    }
  }

  /** 读取 byteCount 字节，不够就返回 null */
  read(byteCount: number): VSBuffer | null {
    if (this.totalLength < byteCount) {
      return null;
    }

    if (this.chunks[0].byteLength === byteCount) {
      const result = this.chunks.shift()!;
      this.totalLength -= byteCount;
      return result;
    }

    if (this.chunks[0].byteLength > byteCount) {
      const result = this.chunks[0].slice(0, byteCount);
      this.chunks[0] = this.chunks[0].slice(byteCount);
      this.totalLength -= byteCount;
      return result;
    }

    // 需要跨多个 chunk 拼接
    const result = VSBuffer.alloc(byteCount);
    let offset = 0;
    while (offset < byteCount) {
      const chunk = this.chunks[0];
      const needed = byteCount - offset;
      if (chunk.byteLength <= needed) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
        this.chunks.shift();
      } else {
        result.set(chunk.slice(0, needed), offset);
        this.chunks[0] = chunk.slice(needed);
        offset += needed;
      }
    }
    this.totalLength -= byteCount;
    return result;
  }
}
