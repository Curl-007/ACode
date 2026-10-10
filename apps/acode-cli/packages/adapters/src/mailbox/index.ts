import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  SessionId,
  SessionMailboxDeliverInput,
  SessionMailboxEnvelope,
  SessionMailboxPort,
} from "@acode/contracts";

export interface NodeSessionMailboxOptions {
  rootDir: string;
}

const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9._-]+$/;
// 编排方案 Phase 5 P1（specs/agent-peer-messaging-cross-process.md R1）：messageId 会进
// drain 排序文件名，文件名安全校验是信封字段防路径注入的唯一防线（sessionId 由
// SESSION_ID_PATTERN + root 包含检查覆盖）。
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class NodeSessionMailboxAdapter implements SessionMailboxPort {
  constructor(private readonly options: NodeSessionMailboxOptions) {}

  async deliver(input: SessionMailboxDeliverInput): Promise<void> {
    if (!MESSAGE_ID_PATTERN.test(input.messageId)) {
      throw new Error(`Invalid session mailbox message id: ${input.messageId}`);
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const sortKey = Date.parse(createdAt);
    if (Number.isNaN(sortKey)) {
      throw new Error(`Invalid session mailbox createdAt: ${createdAt}`);
    }
    const envelope: SessionMailboxEnvelope = {
      version: 1,
      messageId: input.messageId,
      fromSessionId: input.fromSessionId,
      toSessionId: input.toSessionId,
      content: input.content,
      createdAt,
    };
    const unreadDir = this.sessionDir(input.toSessionId, "unread");
    await mkdir(unreadDir, { recursive: true });
    // 原子写（R1）：读方跨进程 readdir+readFile，半截文件会炸 parseEnvelope。tmp 后缀
    // 不匹配 drain 的 .json 过滤，rename 是唯一发布点；文件名前缀 = createdAt 毫秒零
    // 填充，drain 的字典序 sort 即发送序。
    const fileName = `${String(sortKey).padStart(15, "0")}-${input.messageId}.json`;
    const tmpPath = join(
      unreadDir,
      `${fileName}.${process.pid.toString(36)}${Math.random().toString(36).slice(2)}.tmp`,
    );
    await writeFile(tmpPath, JSON.stringify(envelope), "utf8");
    await rename(tmpPath, join(unreadDir, fileName));
  }

  async drainUnread(
    input: { sessionId: SessionId; limit?: number },
    options?: { signal?: AbortSignal },
  ): Promise<SessionMailboxEnvelope[]> {
    const unreadDir = this.sessionDir(input.sessionId, "unread");
    // 副作用消除（cross-process spec R7 配套）：空扫不建目录——drain 挂在每个
    // PostToolUse hook 点上，child runtime 转发端口后，先 mkdir 再 readdir 等于每个
    // 工具调用都为空信箱铲两个目录。ENOENT = 从未有消息，直接返回空；read 目录只在
    // 确有消息要归档时惰性建。返回值语义与原实现一致。
    let entryNames: string[];
    try {
      entryNames = await readdir(unreadDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries = entryNames
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .slice(0, input.limit ?? 20);
    if (entries.length === 0) return [];

    const readDir = this.sessionDir(input.sessionId, "read");
    await mkdir(readDir, { recursive: true });
    const messages: SessionMailboxEnvelope[] = [];

    for (const entry of entries) {
      options?.signal?.throwIfAborted();
      const unreadPath = join(unreadDir, entry);
      const readPath = join(readDir, entry);
      const envelope = parseEnvelope(await readFile(unreadPath, "utf8"));
      messages.push(envelope);
      await rename(unreadPath, readPath);
    }

    return messages;
  }

  private sessionDir(sessionId: SessionId, kind: "read" | "unread"): string {
    const normalizedSessionId = String(sessionId);
    if (!SESSION_ID_PATTERN.test(normalizedSessionId)) {
      throw new Error(`Invalid session id: ${normalizedSessionId}`);
    }

    const rootDir = resolve(this.options.rootDir);
    const sessionDir = resolve(rootDir, normalizedSessionId, kind);
    const relativePath = relative(rootDir, sessionDir);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Session mailbox path escapes root: ${normalizedSessionId}`);
    }
    return sessionDir;
  }
}

export function createNodeSessionMailboxAdapter(
  options: NodeSessionMailboxOptions,
): SessionMailboxPort {
  return new NodeSessionMailboxAdapter(options);
}

function parseEnvelope(content: string): SessionMailboxEnvelope {
  const parsed = JSON.parse(content) as SessionMailboxEnvelope;
  if (
    parsed.version !== 1 ||
    typeof parsed.messageId !== "string" ||
    typeof parsed.fromSessionId !== "string" ||
    typeof parsed.toSessionId !== "string" ||
    typeof parsed.content !== "string" ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error("Invalid session mailbox envelope");
  }
  return parsed;
}
