// 更新交接账本（specs/updater-journal-recovery.md R1/R3/R6，WI-9 / 价值提取 T1#14）。
//
// Mechanism ported from oh-my-pi (MIT) packages/coding-agent/src/cli/update-cli.ts,
// Copyright (c) 2025 Mario Zechner & Stencil Labs —— 借鉴其 replaceBinaryForUpdate
// 的「备份→换入→验证→失败回滚」阶段化闭环思想与 omp.dist 的未知值保守兜底契约，
// 按 electron-updater 现实能力转译：NSIS 安装器接管后主进程已退出，主进程侧闭环
// = 交接前落账（handed-off）→ 下次启动核对（verified / failed /
// install-not-effective）→ 恢复指引与残留清扫。安装器层真实回滚不在主进程能力
// 内，不伪造（spec R0）。
//
// 崩溃一致性（spec R1）：handed-off 落账严格先于安装器 spawn；所有写均为
// temp+rename 原子写且在 quitAndInstall 前 await 完成，不存在「异步写被退出
// 竞态打断」的窗口，因此走异步 IO 纪律、不登记同步例外。
//
// schema/解析面在 updaterJournalFormat.ts（400 行 ratchet 拆分）；本文件对其
// 全量再导出，调用方（autoUpdater.ts 与测试）导入面不变。
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import {
  UPDATE_JOURNAL_MAX_ENTRIES,
  UPDATE_JOURNAL_SCHEMA_VERSION,
  parseUpdateJournal,
  type UpdateJournalEntry,
  type UpdateJournalExitSweepHandoff,
  type UpdateJournalLogger,
  type UpdateJournalOutcome,
} from "./updaterJournalFormat.js";

export * from "./updaterJournalFormat.js";

export interface AppendHandoffInput {
  fromVersion: string;
  toVersion: string;
  installerPath: string | null;
  installerFileName: string | null;
  sha512: string | null;
  size: number | null;
  pendingReleaseName: string | null;
  channel: string | null;
  platform: string | null;
}

/** 异步 fs 面，测试可整体注入内存实现（含 temp+rename 观测）。 */
export interface UpdateJournalFs {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
}

/**
 * 启动恢复计划推导（spec R3，纯函数）：只对最后一条 outcome=handed-off 的
 * 未收口条目行动；unknown outcome 保守不行动（返回 none 但保留 warn 由调用方
 * 承担——未来版本的新枚举值不能触发本版本的清理行为）。版本比较用精确词面
 * 相等（electron-updater 版本即发布词面，semver 归一会隐藏 prerelease 身份）。
 */
export type UpdateHandoffRecoveryPlan =
  | { kind: "none" }
  | { kind: "first-launch-after-update"; entry: UpdateJournalEntry }
  | {
      kind: "install-not-effective";
      entry: UpdateJournalEntry;
      fingerprint: "version-unchanged" | "version-diverged";
    };

export function deriveStartupRecoveryPlan(
  lastEntry: UpdateJournalEntry | null,
  currentVersion: string,
): UpdateHandoffRecoveryPlan {
  if (lastEntry === null || lastEntry.outcome !== "handed-off") {
    return { kind: "none" };
  }
  const current = currentVersion.trim();
  if (current === lastEntry.toVersion) {
    return { kind: "first-launch-after-update", entry: lastEntry };
  }
  if (current === lastEntry.fromVersion) {
    return {
      kind: "install-not-effective",
      entry: lastEntry,
      fingerprint: "version-unchanged",
    };
  }
  return {
    kind: "install-not-effective",
    entry: lastEntry,
    fingerprint: "version-diverged",
  };
}

export interface UpdateJournalStore {
  /** 启动期读盘（每次读最新文件，不信任内存跨代缓存）；null = 无账本路径。 */
  load(): Promise<UpdateJournalEntry[] | null>;
  /** 交接落账：返回新代数；遇悬案 handed-off 先改判 install-not-effective。 */
  appendHandoff(input: AppendHandoffInput): Promise<number>;
  /** R19 豁免链标记改写（仅 handed-off 条目生效，二次调用 no-op）。 */
  setExitSweepHandoff(
    generation: number,
    value: UpdateJournalExitSweepHandoff,
  ): Promise<void>;
  /** 收口改判（仅 handed-off 条目生效，二次调用 no-op）。 */
  markOutcome(generation: number, outcome: UpdateJournalOutcome): Promise<void>;
}

export function createUpdateJournalStore(deps: {
  filePath: string;
  logger: UpdateJournalLogger;
  fs?: Partial<UpdateJournalFs>;
  wallNow?: () => number;
}): UpdateJournalStore {
  const fs: UpdateJournalFs = {
    readFile: deps.fs?.readFile ?? ((path) => readFile(path, "utf8")),
    writeFile: deps.fs?.writeFile ?? ((path, data) => writeFile(path, data, "utf8")),
    rename: deps.fs?.rename ?? rename,
    rm: deps.fs?.rm ?? ((path) => rm(path, { force: true })),
    // node 的 recursive mkdir 返回 Promise<string|undefined>，接口约定 Promise<void>，
    // 这里显式收敛返回值。
    mkdir: deps.fs?.mkdir ?? ((path) => mkdir(path, { recursive: true }).then(() => undefined)),
  };
  const wallNow = deps.wallNow ?? Date.now;
  let entries: UpdateJournalEntry[] | null = null;
  let lastLoadDroppedToNoJournal = false;

  function dirName(): string {
    const index = Math.max(deps.filePath.lastIndexOf("/"), deps.filePath.lastIndexOf("\\"));
    return index > 0 ? deps.filePath.slice(0, index) : ".";
  }

  async function ensureLoaded(): Promise<UpdateJournalEntry[]> {
    if (entries !== null) {
      return entries;
    }
    let raw: string | null = null;
    try {
      raw = await fs.readFile(deps.filePath);
    } catch {
      // ENOENT 等读失败 = 无账本起步（debug 留痕即可，属常态首启）。
      deps.logger.debug?.("[update-journal] no readable journal, starting fresh", {
        event: "update_journal_load_absent",
        outcome: "absent",
      });
      entries = [];
      lastLoadDroppedToNoJournal = false;
      return entries;
    }
    const parsed = parseUpdateJournal(raw, deps.logger);
    // 解析失败降级为「无 journal」路径（spec R6）：工作集置空继续可写，
    // load() 对外如实返回 null，调用方按无账本决策。
    lastLoadDroppedToNoJournal = parsed === null;
    entries = parsed ?? [];
    return entries;
  }

  async function persist(): Promise<void> {
    if (entries === null) {
      return;
    }
    // 落盘成功后工作集即权威状态，解除「上次读盘畸形」标记（spec R6）。
    lastLoadDroppedToNoJournal = false;
    const payload = JSON.stringify({
      version: UPDATE_JOURNAL_SCHEMA_VERSION,
      entries,
    });
    const tempPath = `${deps.filePath}.${process.pid}.tmp`;
    await fs.mkdir(dirName());
    await fs.writeFile(tempPath, payload);
    try {
      await fs.rename(tempPath, deps.filePath);
    } catch {
      // rename 被占用/杀软拦截时退化为直写：账本尽力落盘优先于原子性
      // （参照 shutdownEvidence 的降级路径；残留 temp 下次写会覆盖）。
      await fs.writeFile(deps.filePath, payload);
      try {
        await fs.rm(tempPath);
      } catch {
        // 残留 temp 无害。
      }
    }
  }

  function truncate(): void {
    if (entries !== null && entries.length > UPDATE_JOURNAL_MAX_ENTRIES) {
      entries = entries.slice(entries.length - UPDATE_JOURNAL_MAX_ENTRIES);
    }
  }

  function findHandedOff(generation: number): UpdateJournalEntry | null {
    const found = entries?.find((entry) => entry.generation === generation) ?? null;
    return found !== null && found.outcome === "handed-off" ? found : null;
  }

  return {
    async load() {
      const loaded = await ensureLoaded();
      return lastLoadDroppedToNoJournal ? null : loaded;
    },
    async appendHandoff(input) {
      const current = await ensureLoaded();
      const last = current.length > 0 ? (current[current.length - 1] ?? null) : null;
      // 幂等边界（spec R1）：上一代交接未收口（进程在 quitAndInstall 前死亡等）
      // 时先改判，避免同时存在两条 handed-off 悬案。
      if (last !== null && last.outcome === "handed-off") {
        last.outcome = "install-not-effective";
        last.outcomeAt = wallNow();
      }
      const generation =
        current.reduce((max, entry) => Math.max(max, entry.generation), 0) + 1;
      current.push({
        generation,
        fromVersion: input.fromVersion,
        toVersion: input.toVersion,
        outcome: "handed-off",
        handedOffAt: wallNow(),
        exitSweepHandoff: "pending",
        installerPath: input.installerPath,
        installerFileName: input.installerFileName,
        sha512: input.sha512,
        size: input.size,
        pendingReleaseName: input.pendingReleaseName,
        channel: input.channel,
        platform: input.platform,
        outcomeAt: null,
      });
      truncate();
      await persist();
      return generation;
    },
    async setExitSweepHandoff(generation, value) {
      const entry = findHandedOff(generation);
      if (entry === null) {
        // 只有 handed-off 条目可改（幂等：已收口/不存在一律 no-op）。
        return;
      }
      entry.exitSweepHandoff = value;
      await persist();
    },
    async markOutcome(generation, outcome) {
      const entry = findHandedOff(generation);
      if (entry === null) {
        return;
      }
      entry.outcome = outcome;
      entry.outcomeAt = wallNow();
      await persist();
    },
  };
}
