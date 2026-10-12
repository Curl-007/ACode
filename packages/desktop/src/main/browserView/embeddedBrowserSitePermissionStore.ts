import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PlatformChannels } from "@acode/shared";
import type { PlatformChannelMap } from "@acode/shared";

/**
 * 决策类型定义在 shared/platform.ts 但未从 @acode/shared 入口再导出；
 * 经由已导出的 PlatformChannelMap 对管理面通道做索引访问派生（仓库既有先例：
 * desktopMainIpcPlatform.ts 的 WindowControlsOverlayReadyPayload）。
 */
export type EmbeddedBrowserSitePermissionDecision =
  PlatformChannelMap[(typeof PlatformChannels)["GetEmbeddedBrowserSitePermissions"]]["response"]["permissions"][string][string];

/**
 * 嵌入式浏览器站点权限的持久表（specs/embedded-browser-site-permissions.md）。
 *
 * 形状：`{ [origin]: { [permission]: "allow" | "deny" } }`，整体读写。
 * 模板来自 browserView/browserTabRecoveryStore.ts：内存快照 + mutationQueue 串行 +
 * tmp-uuid rename 原子写 + 损坏文件隔离 `.corrupt-<ts>`。
 * 属平台层持久化：不进任何 session/task 业务状态；不迁移、不版本化
 * （损坏时 warn 后按空表继续，app 不崩）。
 */
export type EmbeddedBrowserSitePermissionTable = Record<
  string,
  Record<string, EmbeddedBrowserSitePermissionDecision>
>;

/** 为单测注入 fs 桩；生产缺省走 node:fs/promises。 */
export interface EmbeddedBrowserSitePermissionStoreFs {
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  rename: typeof rename;
  unlink: typeof unlink;
}

interface EmbeddedBrowserSitePermissionStoreOptions {
  onWarning?: (message: string) => void;
  fs?: EmbeddedBrowserSitePermissionStoreFs;
  /** 为单测注入时钟；生产缺省 Date.now。 */
  now?: () => number;
}

const EMPTY_TABLE: EmbeddedBrowserSitePermissionTable = {};

export class EmbeddedBrowserSitePermissionStore {
  private table: EmbeddedBrowserSitePermissionTable | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly onWarning?: (message: string) => void;
  private readonly fs: EmbeddedBrowserSitePermissionStoreFs;
  private readonly now: () => number;

  constructor(
    private readonly filePath: string,
    options: EmbeddedBrowserSitePermissionStoreOptions = {},
  ) {
    this.onWarning = options.onWarning;
    this.fs = options.fs ?? { mkdir, readFile, writeFile, rename, unlink };
    this.now = options.now ?? Date.now;
  }

  async readTable(): Promise<EmbeddedBrowserSitePermissionTable> {
    await this.mutationQueue;
    const table = await this.ensureLoaded();
    return cloneTable(table);
  }

  /**
   * 同步读取已加载的内存快照（未加载时返回 null）。
   * setPermissionCheckHandler 是同步回调，不能等首次 IO；加载完成前按空表
   * （即不放行）处理，fail-closed。
   */
  getCachedTable(): EmbeddedBrowserSitePermissionTable | null {
    return this.table ? cloneTable(this.table) : null;
  }

  async setDecision(
    origin: string,
    permission: string,
    decision: EmbeddedBrowserSitePermissionDecision,
  ): Promise<void> {
    await this.mutate((table) => {
      const byPermission = table[origin] ?? {};
      byPermission[permission] = decision;
      table[origin] = byPermission;
    });
  }

  async resetDecision(origin: string, permission: string): Promise<void> {
    await this.mutate((table) => {
      const byPermission = table[origin];
      if (!byPermission) return;
      delete byPermission[permission];
      if (Object.keys(byPermission).length === 0) delete table[origin];
    });
  }

  async clearAll(): Promise<void> {
    await this.mutate((table) => {
      for (const key of Object.keys(table)) delete table[key];
    });
  }

  /** 等待所有已提交 mutation 完成，供应用退出建立持久化屏障。 */
  async whenIdle(): Promise<void> {
    await this.mutationQueue;
  }

  private async mutate(
    mutation: (table: EmbeddedBrowserSitePermissionTable) => void,
  ): Promise<void> {
    const task = this.mutationQueue.then(async () => {
      const table = await this.ensureLoaded();
      mutation(table);
      await this.writeTable(table);
    });
    this.mutationQueue = task.catch(() => undefined);
    await task;
  }

  private async ensureLoaded(): Promise<EmbeddedBrowserSitePermissionTable> {
    if (this.table) return this.table;
    try {
      const parsed = JSON.parse(await this.fs.readFile(this.filePath, "utf8")) as unknown;
      this.table = parseTable(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // 损坏文件隔离：warn 后按空表继续（spec 验收 4：store 文件损坏 app 不崩）。
        const corruptPath = `${this.filePath}.corrupt-${this.now()}`;
        try {
          await this.fs.rename(this.filePath, corruptPath);
          this.onWarning?.(`embedded browser site permissions 文件损坏，已隔离到 ${corruptPath}`);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") {
            this.onWarning?.(
              `embedded browser site permissions 损坏文件隔离失败: ${
                renameError instanceof Error ? renameError.message : String(renameError)
              }`,
            );
          }
        }
      }
      this.table = cloneTable(EMPTY_TABLE);
    }
    return this.table;
  }

  private async writeTable(table: EmbeddedBrowserSitePermissionTable): Promise<void> {
    await this.fs.mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${randomUUID()}`;
    try {
      await this.fs.writeFile(temporaryPath, JSON.stringify(table), "utf8");
      await this.fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      await this.fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

/** 严格校验落盘形状；非法值整表拒绝（按损坏处理），避免半合法状态进入策略判定。 */
function parseTable(value: unknown): EmbeddedBrowserSitePermissionTable {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid embedded browser site permission table");
  }
  const table: EmbeddedBrowserSitePermissionTable = {};
  for (const [origin, byPermission] of Object.entries(value as Record<string, unknown>)) {
    if (!origin || typeof origin !== "string") {
      throw new TypeError("invalid embedded browser site permission origin");
    }
    if (!byPermission || typeof byPermission !== "object" || Array.isArray(byPermission)) {
      throw new TypeError("invalid embedded browser site permission record");
    }
    const normalized: Record<string, EmbeddedBrowserSitePermissionDecision> = {};
    for (const [permission, decision] of Object.entries(byPermission as Record<string, unknown>)) {
      if (!permission || (decision !== "allow" && decision !== "deny")) {
        throw new TypeError("invalid embedded browser site permission decision");
      }
      normalized[permission] = decision;
    }
    table[origin] = normalized;
  }
  return table;
}

function cloneTable(table: EmbeddedBrowserSitePermissionTable): EmbeddedBrowserSitePermissionTable {
  const cloned: EmbeddedBrowserSitePermissionTable = {};
  for (const [origin, byPermission] of Object.entries(table)) {
    cloned[origin] = { ...byPermission };
  }
  return cloned;
}
