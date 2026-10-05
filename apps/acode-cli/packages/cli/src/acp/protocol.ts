// ============================================================
// ACP（Agent Client Protocol）wire 协议层：NDJSON JSON-RPC 2.0 帧循环
// 与适配层内部使用的最小 ACP 类型（不进 shared/contracts 公开契约——
// spec「接口」节：规范跟随时只动适配层）。
//
// 分帧按 ACP 官方规范现行稳定版（protocol version 1，schema 产物 1.24.1）：
// stdio 上一行一条 JSON-RPC 消息（UTF-8，消息内不得含换行），
// stderr 仅日志，stdout 不得输出非 ACP 消息。规范快照见 spec 附录 A.2。
//
// 组织参照 jcode (MIT) src/cli/acp.rs 的帧循环分解，自撰实现，未拷贝任何文件。
// ============================================================

import { StringDecoder } from "node:string_decoder";
import { HARNESS_MAX_LINE_LENGTH } from "@acode/shared/harness-api";

/** JSON-RPC 2.0 / ACP 错误码（保留段，spec 常量与附录 A.2）。 */
export const JSONRPC_PARSE_ERROR = -32700 as const;
export const JSONRPC_INVALID_REQUEST = -32600 as const;
export const JSONRPC_METHOD_NOT_FOUND = -32601 as const;
export const JSONRPC_INVALID_PARAMS = -32602 as const;
/** spec 常量 ACP_UNKNOWN_ERROR_CODE：未知引擎错误统一归 internal，不透内部栈。 */
export const ACP_UNKNOWN_ERROR_CODE = -32603 as const;
/** ACP 保留段：资源（会话）不存在。 */
export const ACP_RESOURCE_NOT_FOUND = -32002 as const;
/**
 * F9（K8 对抗复核）：本实现自用的协议层冲突（同会话并发 prompt / 并发会话竞态
 * 超限）改占 -32052——原 -32001 属 ACP 保留段 -32000..-32099 中上游已密集分配的
 * 低段（-32000 鉴权、-32002 资源不存在等），占用未分配位有被上游未来分配撞位的
 * 风险；-32050 起为自用区段（占用理由见 spec 附录 A.4）。
 */
export const ACP_SESSION_BUSY = -32052 as const;
/**
 * F4（K8 对抗复核）：stdin 单行超过 HARNESS_MAX_LINE_LENGTH 时回的 line_too_long
 * 语义错误码（自用区段 -32053；截断行无法解析出请求 id，回 id:null）。
 */
export const ACP_LINE_TOO_LONG = -32053 as const;
/** ACP 单进程并发会话上限（spec 常量表）。 */
export const ACP_MAX_CONCURRENT_SESSIONS = 8 as const;
/** 适配器声明的 ACP 稳定协议大版本（附录 A.2：现行稳定版为 1）。 */
export const ACP_PROTOCOL_VERSION = 1 as const;
/** 模型选择 config option 的稳定 id（附录 A.3：值形态 providerId/modelId）。 */
export const ACP_MODEL_CONFIG_ID = "acode.model" as const;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number | string | null;
  error: JsonRpcErrorBody;
}

export type JsonRpcClientMessage = JsonRpcRequest | JsonRpcNotification;
export type JsonRpcAgentMessage = JsonRpcSuccess | JsonRpcFailure;

/** 适配层内聚的协议错误：携带 JSON-RPC 错误码与人话 message（不透内部栈）。 */
export class AcpProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpProtocolError";
    this.code = code;
    this.data = data;
  }
}

/** 解析一行客户端消息；非法形态返回 undefined（由调用方回协议错误，不崩进程）。 */
export function parseClientLine(line: string): JsonRpcClientMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.jsonrpc !== "2.0" || typeof record.method !== "string" || record.method === "") {
    return undefined;
  }
  const base = { jsonrpc: "2.0" as const, method: record.method };
  if ("id" in record) {
    const id = record.id;
    if (typeof id !== "number" && typeof id !== "string") return undefined;
    return { ...base, id, ...(record.params !== undefined ? { params: record.params } : {}) };
  }
  return { ...base, ...(record.params !== undefined ? { params: record.params } : {}) };
}

/** 读侧抽象：产出已去换行的消息行；流结束（stdin 关闭）后迭代器完结。 */
export interface AcpLineSource {
  lines(): AsyncIterable<string>;
}

/** 写侧抽象：整行写出（自动补换行）。 */
export interface AcpLineSink {
  writeLine(line: string): void;
}

/** stdio 读写对（测试可注入内存管道）。 */
export interface AcpIo {
  input: AcpLineSource;
  output: AcpLineSink;
}

/** createStreamLineSource 的行长治理选项（F4）。 */
export interface StreamLineSourceOptions {
  /**
   * F4（K8 对抗复核）：单行超过 HARNESS_MAX_LINE_LENGTH（与 K7 harness 传输同一
   * 出处 @acode/shared/harness-api，单一事实源）时的回调——调用方在此回
   * line_too_long 语义的 JSON-RPC error 帧。回调后行源断链（迭代完结），
   * 无界缓冲同理（防 OOM，与 server 侧 transport 的 M4 纪律一致）。
   */
  onOversize?: (info: { lineLength: number }) => void;
}

/**
 * 把 node 可读流适配成行源（推拉混合模型：data 事件填队列，迭代器消费）。
 * 跨 chunk 的多字节 UTF-8 序列经 StringDecoder 解码，防止中文帧切开损坏。
 */
export function createStreamLineSource(
  stream: NodeJS.ReadableStream,
  options?: StreamLineSourceOptions,
): AcpLineSource {
  const pending: string[] = [];
  const wakeups: (() => void)[] = [];
  let ended = false;
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  const signal = (): void => {
    while (wakeups.length > 0) wakeups.shift()?.();
  };
  let oversizeFired = false;
  // F4：超限即断链——丢弃缓冲、完结迭代、best-effort 销毁输入流，并经
  // onOversize 通知调用方回错误帧（回调异常不阻断断链本身）。
  const failOversize = (lineLength: number): void => {
    if (oversizeFired) return;
    oversizeFired = true;
    ended = true;
    buffer = "";
    // 已解析的完整行照常投递后完结（与 server 侧 transport 的 failOversizeLine
    // 同款语义：丢弃未完成缓冲，不断链前已收的行）。
    try {
      options?.onOversize?.({ lineLength });
    } catch {
      // 回调异常吞掉：断链是安全侧动作，不能被回执写出失败反噬。
    }
    (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    signal();
  };
  const handleChunk = (chunk: Buffer | string): void => {
    if (oversizeFired) return;
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.length > HARNESS_MAX_LINE_LENGTH) {
        failOversize(line.length);
        return;
      }
      if (line.trim().length > 0) pending.push(line);
      index = buffer.indexOf("\n");
    }
    // 无换行的无界缓冲同样受限（对端要么失控要么恶意，停止解析防 OOM）。
    if (buffer.length > HARNESS_MAX_LINE_LENGTH) {
      failOversize(buffer.length);
      return;
    }
    signal();
  };
  const handleEnd = (): void => {
    if (oversizeFired) return;
    if (buffer.trim().length > 0) {
      pending.push(buffer.replace(/\r$/, ""));
      buffer = "";
    }
    ended = true;
    signal();
  };
  stream.on("data", handleChunk);
  stream.on("end", handleEnd);
  stream.on("error", handleEnd);
  stream.on("close", handleEnd);
  return {
    lines() {
      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            while (pending.length > 0) yield (pending.shift() as string);
            if (ended) return;
            await new Promise<void>((resolve) => {
              wakeups.push(resolve);
            });
          }
        },
      };
    },
  };
}

/** node 可写流的行汇。 */
export function createStreamLineSink(stream: NodeJS.WritableStream): AcpLineSink {
  return {
    writeLine(line: string) {
      // 写失败（流已关）由流自身承载，这里不抛——stdout 关闭即进程收尾路径。
      stream.write(`${line}\n`);
    },
  };
}
