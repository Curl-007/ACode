import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ModelConfigRules,
  ProviderConfigMap,
  type PersonalProviderConfigRepository,
  type ProviderApiKeyVault,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "@acode/provider";
import { atomicWritePrivateTextFile, withFileLock } from "@acode/shared/node";
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "./provider-config-file-codec.js";
import {
  deleteOrphanedProviderApiKeys,
  hasPlaintextApiKeys,
  vaultPersonalProviderApiKeys,
} from "./personal-provider-apikey-vaulting.js";

export interface NodePersonalProviderConfigRepositoryOptions {
  readonly filePath: string;
  readonly importLegacy?: () => Promise<ProviderConfigLayerUpdate | null>;
  readonly onRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPollingError?: (error: unknown) => void;
  readonly pollingIntervalMs?: number | false;
  /**
   * BYO Provider API Key 的加密凭据库（安全加固 P1-5）。可选：未注入时明文照写照读
   * （安全空操作，兼容纯 builtin / 测试 / 凭据库不可用）。注入后写入漏斗会把明文 Key
   * 搬进凭据库、文件里只留 credentialRef。由 services（桌面 host）或 CLI 注入。
   */
  readonly providerApiKeyVault?: ProviderApiKeyVault;
}

export interface PersonalProviderConfigRecoveryEvent {
  readonly error: unknown;
}

export class NodePersonalProviderConfigRepository implements PersonalProviderConfigRepository {
  readonly #filePath: string;
  readonly #importLegacy?: () => Promise<ProviderConfigLayerUpdate | null>;
  readonly #onRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly #onPollingError?: (error: unknown) => void;
  readonly #pollingIntervalMs: number | false;
  readonly #providerApiKeyVault: ProviderApiKeyVault | undefined;
  readonly #listeners = new Set<(reason: string) => void>();
  #pollingTimer: ReturnType<typeof setTimeout> | null = null;
  #pollingInFlight = false;
  #writeGeneration = 0;
  #pollingErrorActive = false;
  #observedRevision: string | null = null;
  #disposed = false;

  constructor(options: NodePersonalProviderConfigRepositoryOptions) {
    if (!options.filePath.trim()) throw new Error("Personal Provider Config filePath 不能为空");
    this.#filePath = options.filePath;
    this.#importLegacy = options.importLegacy;
    this.#onRecovery = options.onRecovery;
    this.#onPollingError = options.onPollingError;
    this.#providerApiKeyVault = options.providerApiKeyVault;
    this.#pollingIntervalMs = options.pollingIntervalMs ?? 1_000;
    if (this.#pollingIntervalMs !== false && this.#pollingIntervalMs <= 0) {
      throw new Error("Personal Provider Config pollingIntervalMs 必须大于 0");
    }
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    try {
      const snapshot = await this.#readCurrent();
      this.#observedRevision ??= snapshot.revision;
      return snapshot;
    } catch (error) {
      const snapshot = this.#recoverInvalidFile(error);
      this.#observedRevision ??= snapshot.revision;
      return snapshot;
    } finally {
      this.#ensurePolling();
    }
  }

  async update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    try {
      const snapshot = await withFileLock(this.#filePath, async () => {
        const current = await this.#readLocked();
        const next = transform(current);
        const update = Object.freeze({
          providers: next.providers,
          models: next.models,
          providerOrder: next.providerOrder,
          defaultModelSelection: next.defaultModelSelection,
        });
        const committed = await this.#writeLocked(update);
        // 安全加固 P1-5 回归修复（孤儿清理）：必须在 #writeLocked 成功**之后**删除凭据——
        // 反序会在写文件失败时留下「引用悬空且真值已删」的真丢 Key 状态；正序最坏只留下
        // 孤儿条目（与修复前一致，非破坏）。清理在文件锁内：锁外延迟删除可能与
        // 「并发 writer 重建同名 provider 并写入同一确定性 ref」竞争，误删新真值。
        // 清理失败不改写已提交的事实：update 已成功，此时抛错会让调用方误以为删除失败，
        // 重试则命中「Provider 不存在」；故仅经 onRecovery 上报。
        try {
          await deleteOrphanedProviderApiKeys(current, committed, this.#providerApiKeyVault);
        } catch (error) {
          this.#reportRecovery({ error });
        }
        const snapshot = snapshotFromUpdate(committed);
        // 原子写可能产生多次文件系统事件。写入完成后先记录内容版本，
        // polling 随后读取到同一版本时不会再次发布失效通知。
        this.#observedRevision = snapshot.revision;
        return snapshot;
      });
      this.#emit("updated");
      return snapshot;
    } finally {
      this.#ensurePolling();
    }
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#pollingTimer) clearTimeout(this.#pollingTimer);
    this.#pollingTimer = null;
    this.#listeners.clear();
  }

  async #readCurrent(): Promise<ProviderConfigLayerSnapshot> {
    // 多个进程纯读取也争排他锁，慢 IO 会把轮询放大成锁超时。
    // 正式文件通过同目录临时文件原子替换，纯读可以直接观察已提交的完整文档。
    const file = await readJsonFileIfExists(this.#filePath);
    if (file === null && !this.#importLegacy) return snapshotFromUpdate(emptyUpdate());
    if (file !== null) {
      const update = decodeProviderConfigFile(file.value);
      // P1-5：只有「注入了 vault 且文件里还留着明文 apiKey」才需要迁移，此时落到加锁路径
      // 由那里唯一地调用 vault（快通道不碰凭据库，避免同一把 Key 被 save 两遍）。
      // 未注入 vault 时该判定恒为 false，快通道行为与改动前完全一致——不会平白开始加锁。
      const needsVaultMigration =
        this.#providerApiKeyVault !== undefined && hasPlaintextApiKeys(update);
      if (!needsVaultMigration) {
        if (JSON.stringify(file.value) === JSON.stringify(encodeProviderConfigFile(update))) {
          return snapshotFromUpdate(update);
        }
      }
    }
    // 导入、规范化和 P1-5 迁移仍会写盘。拿锁后必须重读，不能用加锁前的旧内容覆盖其他 writer。
    return withFileLock(this.#filePath, () => this.#readLocked());
  }

  async #readLocked(): Promise<ProviderConfigLayerSnapshot> {
    const file = await readJsonFileIfExists(this.#filePath);
    if (file === null) {
      const imported = await this.#importLegacy?.();
      const update = imported ?? emptyUpdate();
      if (imported) return snapshotFromUpdate(await this.#writeLocked(update));
      return snapshotFromUpdate(update);
    }

    const update = decodeProviderConfigFile(file.value);
    const vaulted = await this.#vaultUpdate(update);
    const encoded = encodeProviderConfigFile(vaulted);
    if (JSON.stringify(file.value) !== JSON.stringify(encoded)) {
      await this.#writeLocked(vaulted);
    }
    // 返回 vaulted（ref 形态）：snapshot 必须与磁盘一致，revision 才等于 sha256(encode(磁盘))，
    // 远程 provisioning 的重算断言才不会失败；明文 hydrate 由 registry 的异步刷新循环负责。
    return snapshotFromUpdate(vaulted);
  }

  /**
   * 把明文 BYO apiKey 搬进加密凭据库、换成 credentialRef（P1-5）。
   *
   * vault.save 抛错时**原样返回未改动的 update**：本次不动文件（明文继续可用），
   * 下次读写再重试迁移。这样凭据库暂时不可用不会让写入失败，更不会弄丢 Key。
   */
  async #vaultUpdate(update: ProviderConfigLayerUpdate): Promise<ProviderConfigLayerUpdate> {
    if (!this.#providerApiKeyVault) return update;
    try {
      return (await vaultPersonalProviderApiKeys(update, this.#providerApiKeyVault)).update;
    } catch (error) {
      this.#reportRecovery({ error });
      return update;
    }
  }

  async #writeLocked(update: ProviderConfigLayerUpdate): Promise<ProviderConfigLayerUpdate> {
    // 同一入口写入规则与默认选择；先严格验证整份结果，不能落盘后才发现来源越权/坏值。
    // 使用与读取相同的规范形态再计算版本，避免外层规则键顺序使“写成功”的版本读回就变化。
    // vault 化必须在 canonical 之前：落盘的、算 revision 的、返回给 snapshot 的都得是 ref 形态，
    // 三者一致才不会出现「revision 基于明文、磁盘是 ref」的错配。
    const vaulted = await this.#vaultUpdate(update);
    const canonical = decodeProviderConfigFile(encodeProviderConfigFile(vaulted));
    const encoded = encodeProviderConfigFile(canonical);
    await atomicWritePrivateTextFile(this.#filePath, JSON.stringify(encoded, null, 2));
    this.#writeGeneration += 1;
    return canonical;
  }

  async #readPollingSnapshot(): Promise<ProviderConfigLayerSnapshot> {
    const file = await readJsonFileIfExists(this.#filePath);
    if (file === null) return snapshotFromUpdate(emptyUpdate());
    return snapshotFromUpdate(decodeProviderConfigFile(file.value));
  }

  #recoverInvalidFile(error: unknown): ProviderConfigLayerSnapshot {
    // 正式文件无效时必须原样保留，不能备份后覆盖成空配置；本进程仅以内存空
    // Overlay 降级，等待用户修复原文件。
    this.#reportRecovery({ error });
    return snapshotFromUpdate(emptyUpdate());
  }

  #reportRecovery(event: PersonalProviderConfigRecoveryEvent): void {
    try {
      this.#onRecovery?.(Object.freeze(event));
    } catch {
      // 观测回调不是配置事实，不能反向阻断恢复。
    }
  }

  #ensurePolling(): void {
    // 轮询在飞时 timer 已清空；显式 read/update 的 finally 不能再排入第二轮。
    if (
      this.#pollingIntervalMs === false ||
      this.#pollingTimer ||
      this.#pollingInFlight ||
      this.#disposed
    )
      return;
    this.#pollingTimer = setTimeout(() => {
      this.#pollingTimer = null;
      void this.#pollOnce();
    }, this.#pollingIntervalMs);
    this.#pollingTimer.unref?.();
  }

  async #pollOnce(): Promise<void> {
    this.#pollingInFlight = true;
    const writeGeneration = this.#writeGeneration;
    try {
      const snapshot = await this.#readPollingSnapshot();
      // 去掉读锁后，旧轮询可能晚于本进程保存返回；丢弃它，避免版本倒退及重复通知。
      if (writeGeneration !== this.#writeGeneration) return;
      this.#pollingErrorActive = false;
      if (this.#disposed || snapshot.revision === this.#observedRevision) return;
      this.#observedRevision = snapshot.revision;
      this.#emit("poll-changed");
    } catch (error) {
      // 成功保存也使旧轮询的失败失效，不能在新版本之后再发布旧读操作的故障。
      if (this.#disposed || writeGeneration !== this.#writeGeneration) return;
      if (!this.#pollingErrorActive) {
        this.#pollingErrorActive = true;
        try {
          this.#onPollingError?.(error);
        } catch {
          // 观测回调不能反向阻断下一轮自愈。
        }
        this.#emit("poll-error");
      }
    } finally {
      this.#pollingInFlight = false;
      this.#ensurePolling();
    }
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodePersonalProviderConfigRepository 已 dispose");
  }
}

export function createNodePersonalProviderConfigRepository(
  options: NodePersonalProviderConfigRepositoryOptions,
): NodePersonalProviderConfigRepository {
  return new NodePersonalProviderConfigRepository(options);
}

async function readJsonFileIfExists(filePath: string): Promise<{ readonly value: unknown } | null> {
  try {
    const text = await readFile(filePath, "utf8");
    return { value: JSON.parse(text) as unknown };
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function emptyUpdate(): ProviderConfigLayerUpdate {
  return Object.freeze({
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
    providerOrder: [],
  });
}

function snapshotFromUpdate(update: ProviderConfigLayerUpdate): ProviderConfigLayerSnapshot {
  const content = JSON.stringify(encodeProviderConfigFile(update));
  return Object.freeze({
    revision: createHash("sha256").update(content).digest("hex"),
    providers: update.providers,
    models: update.models,
    // 快照必须与 revision 对应的磁盘内容一致；补空数组会让未声明排序的文件在 CAS 时误报变化。
    providerOrder: update.providerOrder,
    defaultModelSelection: update.defaultModelSelection,
  });
}
