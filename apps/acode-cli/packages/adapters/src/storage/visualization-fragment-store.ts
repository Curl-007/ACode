// ============================================================
// NodeVisualizationFragmentStore - 对话内可视化片段的磁盘 + 注册表实现
// ============================================================
// spec：apps/acode-cli/specs/gen-ui-visualize.md。目录族复用 NodeToolArtifactStore：
// <rootDir>/<sessionId>/visualize/<name>.html（rootDir 即 <storageRoot>/cli/artifacts，
// 由 create-app 用同一个值构造两边），随 session 清理策略走，独立于 toolCall 生命周期。
//
// 注册表是**写入工具是唯一注册者**的内存事实（Map<sessionId, Map<name, meta>>）：
// 投影 reducer 同步查询它核对 ::visualize 引用；冷恢复（进程重启后的 hydration）
// 经 rebuildVisualizationFragments 从磁盘目录重建（displayName 不可恢复，回退 name）。

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  VisualizationFragmentMeta,
  VisualizationFragmentStorePort,
} from "@acode/contracts";

export interface NodeVisualizationFragmentStoreOptions {
  /** 与 NodeToolArtifactStore 的 rootDir 同值（<storageRoot>/cli/artifacts）。 */
  rootDir: string;
}

/** name 校验已在上游 schema 完成；这里再做一次同规则防御（绝不把调用方字符串直接拼路径）。 */
const FRAGMENT_NAME_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/u;
const MAX_SESSION_ID_SEGMENT_LENGTH = 120;

export class NodeVisualizationFragmentStore implements VisualizationFragmentStorePort {
  private readonly rootDir: string;
  private readonly registry = new Map<string, Map<string, VisualizationFragmentMeta>>();

  constructor(options: NodeVisualizationFragmentStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async writeVisualizationFragment(input: {
    sessionId: string;
    name: string;
    content: string;
    title?: string;
  }): Promise<{ bytes: number }> {
    const path = this.fragmentPath(input.sessionId, input.name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.content, "utf8");
    const bytes = Buffer.byteLength(input.content, "utf8");
    const sha256 = createHash("sha256").update(input.content, "utf8").digest("hex");
    // 同名覆盖 = 更新：注册表整体替换该条目（title 也随之更新）。
    this.registryFor(input.sessionId).set(input.name, {
      bytes,
      sha256,
      ...(input.title ? { displayName: input.title } : {}),
    });
    return { bytes };
  }

  async readVisualizationFragment(input: {
    sessionId: string;
    name: string;
  }): Promise<Uint8Array | undefined> {
    try {
      // 读路径只消费已消毒的段；任何越界 name 在 fragmentPath 里已被拒。
      return new Uint8Array(await readFile(this.fragmentPath(input.sessionId, input.name)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  lookupVisualizationFragment(
    sessionId: string,
    name: string,
  ): VisualizationFragmentMeta | undefined {
    return this.registry.get(sessionId)?.get(name);
  }

  async rebuildVisualizationFragments(sessionId: string): Promise<void> {
    const entries = await readdir(this.sessionDir(sessionId)).catch(() => []);
    const rebuilt = new Map<string, VisualizationFragmentMeta>();
    for (const entry of entries) {
      if (!FRAGMENT_NAME_PATTERN.test(entry) || !entry.endsWith(".html")) continue;
      const bytes = await readFile(join(this.sessionDir(sessionId), entry))
        .then((buffer) => buffer)
        .catch(() => undefined);
      if (bytes === undefined) continue;
      rebuilt.set(entry, {
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    // 整体替换：进程重启后的重建不能残留上半个进程的陈旧条目。
    this.registry.set(sessionId, rebuilt);
  }

  private sessionDir(sessionId: string): string {
    return join(this.rootDir, sanitizeSessionIdSegment(sessionId), "visualize");
  }

  /** 取（缺则建）该会话的注册表条目。写入是唯一建表点，lookup 只读不建。 */
  private registryFor(sessionId: string): Map<string, VisualizationFragmentMeta> {
    let entries = this.registry.get(sessionId);
    if (!entries) {
      entries = new Map();
      this.registry.set(sessionId, entries);
    }
    return entries;
  }

  private fragmentPath(sessionId: string, name: string): string {
    if (!FRAGMENT_NAME_PATTERN.test(name)) {
      // 防御：schema 之外（测试桩/未来调用方）进来的名字绝不进路径。
      throw new Error(`Invalid visualization fragment name: ${name}`);
    }
    return join(this.sessionDir(sessionId), name);
  }
}

function sanitizeSessionIdSegment(sessionId: string): string {
  return (
    sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, MAX_SESSION_ID_SEGMENT_LENGTH) || "unknown"
  );
}

export function createNodeVisualizationFragmentStore(
  options: NodeVisualizationFragmentStoreOptions,
): VisualizationFragmentStorePort {
  return new NodeVisualizationFragmentStore(options);
}
