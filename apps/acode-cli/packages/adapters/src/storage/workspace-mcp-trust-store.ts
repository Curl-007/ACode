// Workspace MCP Trust store（specs/project-mcp-trust-gate.md，安全修复 H2）
//
// 项目作用域 stdio MCP server 的持久信任存储：与 Workspace Hook Trust store 对称
// （同一 security 目录、同一锁/原子写/损坏恢复语义、同一 fail-closed 哲学），但记录
// 是「每 server 一条内容 digest」而不是 hook 的逐条声明 + bundle。
//
// 为什么对称新建而不是复用 FileWorkspaceHookTrustStore：hook 记录 schema 是 hook 域
// 专属（eventAtGrant/matcherAtGrant 等必填），且下沉在 root packages/shared 供 root
// services 消费；把 MCP 记录塞进去会污染两个域的信任语义（决策依据见 spec）。
// 锁/原子写/损坏恢复机制住在 locked-json-store-file.ts（从 hook store 实现对称提炼的
// 通用件）；storage root 解析复用 hook store 导出的 resolveSecurityDirectory（单一所有者）。
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { LockedJsonStoreFile } from "./locked-json-store-file.js";
import {
  resolveSecurityDirectory,
  type WorkspaceHookTrustStorePathOptions,
} from "./workspace-hook-trust-store.js";

const MCP_TRUST_STORE_FILE = "workspace-mcp-trust-v1.json";

export const WORKSPACE_MCP_TRUST_STORE_SCHEMA_VERSION = 1 as const;

const nonEmptyStringSchema = z.string().trim().min(1);
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const workspaceMcpTrustRecordSchema = z
  .object({
    workspaceIdentity: nonEmptyStringSchema,
    serverName: nonEmptyStringSchema,
    mcpServerDigest: sha256DigestSchema,
    digestAlgorithm: z.literal("sha256"),
    decision: z.literal("trusted"),
    grantedAt: z.string().datetime(),
    lastUsedAt: z.string().datetime().optional(),
    /** 授权时的展示命令（command + args），审查/回溯用，不参与 digest。 */
    displayCommandAtGrant: nonEmptyStringSchema,
    appVersionAtGrant: nonEmptyStringSchema.optional(),
  })
  .strict();
export type WorkspaceMcpTrustRecord = z.infer<typeof workspaceMcpTrustRecordSchema>;

export const workspaceMcpTrustStoreFileSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_MCP_TRUST_STORE_SCHEMA_VERSION),
    records: z.array(workspaceMcpTrustRecordSchema),
  })
  .strict()
  .superRefine((store, context) => {
    const keys = store.records.map((record) => mcpTrustKey(record));
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["records"],
        message: "workspace identity and server name keys must be unique",
      });
    }
  });
export type WorkspaceMcpTrustStoreFile = z.infer<typeof workspaceMcpTrustStoreFileSchema>;

export type WorkspaceMcpTrustStoreLoadResult =
  | { status: "missing"; records: [] }
  | { status: "ok"; records: WorkspaceMcpTrustRecord[] }
  | { status: "corrupt"; records: []; recoveredCorruptPath: string };

export interface FileWorkspaceMcpTrustStoreOptions {
  filePath: string;
  now?: () => number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  renameFile?: typeof rename;
  renameRetryDelaysMs?: readonly number[];
  /** 测试注入：查询 pid 当前实例启动时间；默认按平台实现（/proc / ps / powershell）。 */
  probeProcessStartTime?: (pid: number) => Promise<number | null>;
}

export interface WorkspaceMcpTrustStoreRevokeOptions {
  workspaceIdentity: string;
  /** undefined = 撤销该 workspace 全部；非空数组 = 精确撤销；空数组拒绝（三态与 hooks 同款）。 */
  serverNames?: readonly string[];
}

export async function resolveWorkspaceMcpTrustStorePath(
  options: WorkspaceHookTrustStorePathOptions = {},
): Promise<string> {
  return join(await resolveSecurityDirectory(options), MCP_TRUST_STORE_FILE);
}

export async function createDefaultFileWorkspaceMcpTrustStore(
  options: WorkspaceHookTrustStorePathOptions &
    Omit<FileWorkspaceMcpTrustStoreOptions, "filePath"> = {},
): Promise<FileWorkspaceMcpTrustStore> {
  return createFileWorkspaceMcpTrustStore({
    ...options,
    filePath: await resolveWorkspaceMcpTrustStorePath(options),
  });
}

export function createFileWorkspaceMcpTrustStore(
  options: FileWorkspaceMcpTrustStoreOptions,
): FileWorkspaceMcpTrustStore {
  return new FileWorkspaceMcpTrustStore(options);
}

export class FileWorkspaceMcpTrustStore {
  private readonly lockedFile: LockedJsonStoreFile<WorkspaceMcpTrustStoreFile>;

  constructor(options: FileWorkspaceMcpTrustStoreOptions) {
    this.lockedFile = new LockedJsonStoreFile<WorkspaceMcpTrustStoreFile>(
      {
        filePath: options.filePath,
        ...(options.now ? { now: options.now } : {}),
        ...(options.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
        ...(options.staleLockMs !== undefined ? { staleLockMs: options.staleLockMs } : {}),
        ...(options.renameFile ? { renameFile: options.renameFile } : {}),
        ...(options.renameRetryDelaysMs
          ? { renameRetryDelaysMs: options.renameRetryDelaysMs }
          : {}),
        ...(options.probeProcessStartTime
          ? { probeProcessStartTime: options.probeProcessStartTime }
          : {}),
      },
      {
        parse: (value) => workspaceMcpTrustStoreFileSchema.parse(value),
        empty: () => ({
          schemaVersion: WORKSPACE_MCP_TRUST_STORE_SCHEMA_VERSION,
          records: [],
        }),
      },
    );
  }

  async load(): Promise<WorkspaceMcpTrustStoreLoadResult> {
    const loaded = await this.lockedFile.load();
    if (loaded.status === "missing") return { status: "missing", records: [] };
    if (loaded.status === "corrupt") {
      return {
        status: "corrupt",
        records: [],
        recoveredCorruptPath: loaded.recoveredCorruptPath,
      };
    }
    return { status: "ok", records: loaded.file.records };
  }

  grant(records: readonly WorkspaceMcpTrustRecord[]): Promise<WorkspaceMcpTrustStoreFile> {
    const validated = records.map((record) => workspaceMcpTrustRecordSchema.parse(record));
    return this.lockedFile.mutate((current) => {
      // 同键（identity+serverName）覆盖：grant 的是当前内容 digest，旧 digest 记录
      // 直接被替换——配置变更后旧信任自然失效，无需显式 revoke。
      const next = new Map(current.records.map((record) => [mcpTrustKey(record), record] as const));
      for (const record of validated) next.set(mcpTrustKey(record), record);
      return {
        schemaVersion: WORKSPACE_MCP_TRUST_STORE_SCHEMA_VERSION,
        records: [...next.values()],
      };
    });
  }

  revoke(options: WorkspaceMcpTrustStoreRevokeOptions): Promise<WorkspaceMcpTrustStoreFile> {
    if (options.serverNames?.length === 0) {
      // 与 hooks 同款三态：空数组会生成空 Set，filter 保留全部记录并静默成功，
      // 调用方无法区分「撤销全部」的 undefined 与「没有目标」的无效请求。
      // 在任何 IO 前拒绝。
      return Promise.reject(new Error("serverNames must be undefined or non-empty"));
    }
    const selected = options.serverNames ? new Set(options.serverNames) : undefined;
    return this.lockedFile.mutate((current) => ({
      schemaVersion: WORKSPACE_MCP_TRUST_STORE_SCHEMA_VERSION,
      records: current.records.filter(
        (record) =>
          record.workspaceIdentity !== options.workspaceIdentity ||
          (selected !== undefined && !selected.has(record.serverName)),
      ),
    }));
  }
}

function mcpTrustKey(record: { workspaceIdentity: string; serverName: string }): string {
  return `${record.workspaceIdentity}\u0000${record.serverName}`;
}
