// Ported from oh-my-pi (MIT) — packages/coding-agent/src/jsonrpc/message-framing.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// Content-Length JSON-RPC 帧编解码（LSP stdio 自研实现，omp 同为自研，勿引新依赖）
// ============================================================

const MESSAGE_DECODER = new TextDecoder("utf-8");
// 头部块携带长度与可选 content-type；正文可含整份源文件/工作区诊断。
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_CONTENT_BYTES = 256 * 1024 * 1024;
// 头部终止符 \r\n\r\n；逐字节模式匹配，fallback 从 \r 重启。
const TERMINATOR = [13, 10, 13, 10] as const;

export class MessageFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageFramingError";
  }
}

/**
 * 把一条 JSON-RPC 消息编码为完整 Content-Length 帧。
 *
 * 正文只做一次 UTF-8 编码、直接写入帧缓冲——整文档 didOpen/didChange 不会被
 * 反复编码或拼接。返回的 Buffer 之后不会被改动。
 */
export function encodeMessageFrame(message: unknown): Buffer {
  const json = JSON.stringify(message);
  const bodyLength = Buffer.byteLength(json, "utf8");
  const header = `Content-Length: ${bodyLength}\r\n\r\n`;
  const frame = Buffer.allocUnsafe(header.length + bodyLength);
  frame.write(header, 0, "latin1");
  frame.write(json, header.length, "utf8");
  return frame;
}

/**
 * 增量 Content-Length 帧解码器。
 *
 * 入站字节按块缓存，只有跨块的字节才拷贝拼接——每次 read 都整体拼接累积器对
 * 跨多块的大消息（冷启动诊断爆发）是 O(n^2)。用 {@link push} 喂原始块，
 * 用 {@link drain} 取出全部完整消息的 JSON 文本。
 */
export class MessageFramer {
  readonly #chunks: Buffer[] = [];
  #chunkIndex = 0; // 读取游标所在块
  #offset = 0; // 读取游标在该块内的偏移
  #available = 0; // 游标之后的总字节数
  #matched = 0; // \r\n\r\n 匹配进度（0..4）
  #scanned = 0; // 当前头部已扫描字节数（超限判定）
  #contentLength = -1;
  #body: Buffer | undefined;
  #bodyWritten = 0;
  #failure: MessageFramingError | undefined;

  constructor(seed?: Uint8Array) {
    if (seed && seed.byteLength > 0) this.push(seed);
  }

  /** 追加一块新读到的字节。调用方之后不得复用/改写该块。 */
  push(chunk: Uint8Array): void {
    if (this.#failure) throw this.#failure;
    if (chunk.byteLength === 0) return;
    this.#chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    this.#available += chunk.byteLength;
  }

  /**
   * 取出当前缓冲的每条完整消息的 JSON 文本。
   * 没有 Content-Length 的头部块属于非协议噪声（服务器往 stdout 打印）；
   * 调 `onResync` 并跳过伪终止符继续，而不是在同一个坏头部上永久卡住。
   */
  drain(onResync?: (headerText: string) => void): string[] {
    if (this.#failure) throw this.#failure;
    const messages: string[] = [];
    for (;;) {
      if (this.#contentLength < 0) {
        if (!this.#scanForHeader(onResync)) break;
        continue;
      }
      const message = this.#tryTakeBody();
      if (message === undefined) break;
      messages.push(message);
    }
    this.#compact();
    return messages;
  }

  /** 从游标扫 \r\n\r\n；找到则解析头部返回 true，字节不足返回 false。 */
  #scanForHeader(onResync?: (headerText: string) => void): boolean {
    const headerStart = this.#snapshot();
    while (this.#available > 0) {
      const byte = this.#peek(0);
      this.#advance(1);
      this.#matched = byte === TERMINATOR[this.#matched] ? this.#matched + 1 : byte === 13 ? 1 : 0;
      this.#scanned += 1;
      if (this.#scanned > MAX_HEADER_BYTES) {
        return this.#fail(`LSP header exceeds ${MAX_HEADER_BYTES} bytes`);
      }
      if (this.#matched === TERMINATOR.length) {
        this.#matched = 0;
        const headerText = this.#readBetween(headerStart).toString("latin1");
        return this.#parseHeader(headerText, onResync);
      }
    }
    return false;
  }

  #parseHeader(headerText: string, onResync?: (headerText: string) => void): boolean {
    const match = /Content-Length: *(\d+)/i.exec(headerText);
    if (!match) {
      onResync?.(headerText.trim());
      this.#scanned = 0;
      return true; // 继续扫下一个头部
    }
    const length = Number.parseInt(match[1]!, 10);
    if (!Number.isFinite(length) || length < 0 || length > MAX_CONTENT_BYTES) {
      return this.#fail(`LSP Content-Length out of range: ${match[1]}`);
    }
    this.#contentLength = length;
    this.#body = Buffer.allocUnsafe(length);
    this.#bodyWritten = 0;
    this.#scanned = 0;
    return true;
  }

  /** 头部就绪后尝试取出一条完整正文；字节不足返回 undefined。 */
  #tryTakeBody(): string | undefined {
    const remaining = this.#contentLength - this.#bodyWritten;
    const take = Math.min(remaining, this.#available);
    if (take > 0) {
      this.#readInto(this.#body!, this.#bodyWritten, take);
      this.#bodyWritten += take;
    }
    if (this.#bodyWritten < this.#contentLength) return undefined;
    const text = MESSAGE_DECODER.decode(this.#body!);
    this.#contentLength = -1;
    this.#body = undefined;
    this.#bodyWritten = 0;
    return text;
  }

  // ---- 块游标原语 ----

  /** 读取游标快照（块索引 + 块内偏移）。 */
  #snapshot(): { index: number; offset: number } {
    return { index: this.#chunkIndex, offset: this.#offset };
  }

  #peek(ahead: number): number {
    let index = this.#chunkIndex;
    let offset = this.#offset + ahead;
    for (;;) {
      const chunk = this.#chunks[index]!;
      if (offset < chunk.length) return chunk[offset]!;
      index += 1;
      offset -= chunk.length;
    }
  }

  #advance(n: number): void {
    let remaining = n;
    while (remaining > 0) {
      const chunk = this.#chunks[this.#chunkIndex]!;
      const inChunk = chunk.length - this.#offset;
      const step = Math.min(inChunk, remaining);
      this.#offset += step;
      this.#available -= step;
      remaining -= step;
      if (this.#offset >= chunk.length) {
        this.#chunkIndex += 1;
        this.#offset = 0;
      }
    }
  }

  /** 读出快照到当前游标之间的字节（用于头部块提取）。 */
  #readBetween(from: { index: number; offset: number }): Buffer {
    const parts: Buffer[] = [];
    let total = 0;
    let index = from.index;
    let offset = from.offset;
    while (index < this.#chunkIndex || (index === this.#chunkIndex && offset < this.#offset)) {
      const chunk = this.#chunks[index]!;
      const end = index === this.#chunkIndex ? this.#offset : chunk.length;
      const slice = chunk.subarray(offset, end);
      parts.push(slice);
      total += slice.length;
      index += 1;
      offset = 0;
    }
    return total === parts[0]!.length ? parts[0]! : Buffer.concat(parts, total);
  }

  #readInto(target: Buffer, targetOffset: number, length: number): void {
    let remaining = length;
    let written = targetOffset;
    while (remaining > 0) {
      const chunk = this.#chunks[this.#chunkIndex]!;
      const take = Math.min(chunk.length - this.#offset, remaining);
      chunk.copy(target, written, this.#offset, this.#offset + take);
      written += take;
      remaining -= take;
      this.#advance(take);
    }
  }

  /** 丢弃已消费的块，防止长会话下块列表无界增长。 */
  #compact(): void {
    if (this.#chunkIndex > 0) {
      this.#chunks.splice(0, this.#chunkIndex);
      this.#chunkIndex = 0;
    }
  }

  #fail(message: string): false {
    this.#failure = new MessageFramingError(message);
    throw this.#failure;
  }
}
