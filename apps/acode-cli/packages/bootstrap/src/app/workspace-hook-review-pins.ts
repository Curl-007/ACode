// ============================================================
// workspace hook-pins 三态钉扎 · review/授予面接线
// （specs/plugin-hook-middleware.md 三 / 接线 W3）
// ============================================================
// 授予事实记录层的两个消费面：
// 1. 授予时（respond → 持久 Trust 落盘成功后）：对本次授予的 hook 声明做三态分类
//    （script/inline/unpinnable），合并写入本项目的 pins 记录；
// 2. dispatch 前复核（admission.activate 的异步边界，见 workspace-hook-trust.ts 的
//    包装）：对已有 pin 的声明重分类并按 workspaceHookPinEquals 等价复核——不符
//    （含 unpinnable 永不等价）即漂移，由 controller 走「撤销信任 → 回待信任」收口。
//
// 单源纪律（spec 三.6）：pins 记录层/分类层的唯一事实源在 core/src/hooks
// （workspace-hook-pins.ts / workspace-hook-pins-classify.ts），本模块只消费其 API，
// 不复制分类逻辑；services 侧不得读写 pins 文件。
//
// 层次定位与失败姿态：pins 是 trust 记录层之上的**增强**——「声明在授予时至今内容
// 是否漂移」的内容级复核。trust 主层（bundleDigest/hookDeclarationDigest 谱系）的
// 校验不受本模块成败影响。因此：
// - 授予时写 pins 失败 → 不回滚授予（trust 已落盘），warn 留诊断；该钩暂无 pin
//   可比对，复核跳过（缺 pin = 无从比对，与波前存量授予同形态）；
// - 复核期读 pins 失败（invalid/missing）→ 空集跳过（core 记录层读时 fail-closed）；
// - 复核本身抛错 → 不阻断 activate（controller 侧 catch + warn）。
import type { Logger, WorkspaceHookBundleSnapshot } from "@acode/contracts";
import {
  classifyWorkspaceHookPin,
  readWorkspaceHookPins,
  workspaceHookPinEquals,
  workspaceHookPinsDirPath,
  writeWorkspaceHookPins,
  type WorkspaceHookPin,
  type WorkspaceHookPinsFs,
} from "@acode/core";
import { resolveSecurityStorageRoot } from "@acode/adapters/storage";

export interface WorkspaceHookReviewPinsPort {
  /** 对本次授予的 hook 声明分类并合并写入 pins；失败抛错（授予面记诊断，不回滚授予）。 */
  pinGranted(input: {
    reviewItemIds: readonly string[];
    snapshot: WorkspaceHookBundleSnapshot;
  }): Promise<void>;
  /** dispatch 前复核：返回已有 pin 且等价判定不符（漂移）的 hookDeclarationDigest 集。 */
  detectDrift(snapshot: WorkspaceHookBundleSnapshot): Promise<readonly string[]>;
  /** 撤销漂移钩的信任后清掉其陈旧 pin：不符的 pin 已非事实，留着会让每次激活重复检出。 */
  forgetPins(
    digests: readonly string[],
    snapshot: WorkspaceHookBundleSnapshot,
  ): Promise<void>;
}

/** 项目级 hook 声明可用的变量展开（与 configured-runner 的 dispatch 期语义对齐的最小子集）。 */
const PINS_PROJECT_DIR_VARIABLE_PATTERN = /\$\{(ACODE_PROJECT_DIR|CLAUDE_PROJECT_DIR)\}/gu;

export function createWorkspaceHookReviewPinsPort(input: {
  homeDir?: string;
  logger?: Logger;
  userConfigPath: string;
  fs?: WorkspaceHookPinsFs;
}): WorkspaceHookReviewPinsPort {
  // pins 目录与 trust store 同一安全存储根（<storageRoot>/cli/hook-pins）：
  // resolveSecurityStorageRoot 单一所有者，storage.dir 重定向对两者一致生效。
  let pinsDirPromise: Promise<string> | undefined;
  const resolvePinsDir = (): Promise<string> => {
    pinsDirPromise ??= resolveSecurityStorageRoot({
      userConfigPath: input.userConfigPath,
      ...(input.homeDir ? { homeDir: input.homeDir } : {}),
    }).then((storageRoot) => workspaceHookPinsDirPath(storageRoot));
    return pinsDirPromise;
  };
  const projectKeyOf = (snapshot: WorkspaceHookBundleSnapshot): string =>
    // 身份 key 全局规则：workspaceIdentity（schema 保证非空串；trim 归一）。
    snapshot.workspaceIdentity.trim();

  /** 每条声明的分类入参：projectDir = 该声明所属配置文件的 baseDir（项目根，逐源文件精确）。 */
  const classifyEntry = async (
    snapshot: WorkspaceHookBundleSnapshot,
    entry: WorkspaceHookBundleSnapshot["hooks"][number],
  ): Promise<WorkspaceHookPin | undefined> => {
    const projectDir = snapshot.sourceFiles[entry.sourceFileIndex]?.baseDir;
    // 源文件索引失配的快照本身不合法（schema 层保证）；防御性跳过 = 不落 pin，
    // 主 trust 层不受影响（模块头注的层次定位）。
    if (!projectDir) return undefined;
    return classifyWorkspaceHookPin({
      declaration: {
        type: entry.type,
        command: entry.command,
        ...(entry.type === "process" && entry.args ? { args: entry.args } : {}),
      },
      // 会话/插件级变量（SESSION_ID、PLUGIN_ROOT 等）不在授予面展开：残留在候选
      // 路径里的 ${…} 由分类层判 unpinnable（fail-closed，内容不可静态钉住）。
      expandVariable: (text) => text.replace(PINS_PROJECT_DIR_VARIABLE_PATTERN, projectDir),
      ...(input.fs ? { fs: input.fs } : {}),
      projectDir,
    });
  };

  return {
    async pinGranted({ reviewItemIds, snapshot }) {
      const granted = new Set(reviewItemIds);
      const entries = snapshot.hooks.filter((entry) => granted.has(entry.reviewItemId));
      if (entries.length === 0) return;
      const pinsDir = await resolvePinsDir();
      const projectKey = projectKeyOf(snapshot);
      // 合并写：读旧记录（missing/invalid 一律空集起步，core 读时 fail-closed）后
      // 覆盖本次授予的 digest 键，其余项目的既有 pin 原样保留。
      const existing = await readWorkspaceHookPins({
        pinsDir,
        projectKey,
        ...(input.fs ? { fs: input.fs } : {}),
      });
      const pins = new Map(existing.pins);
      for (const entry of entries) {
        const pin = await classifyEntry(snapshot, entry);
        if (pin) pins.set(entry.hookDeclarationDigest, pin);
      }
      await writeWorkspaceHookPins({
        pins,
        pinsDir,
        projectKey,
        ...(input.fs ? { fs: input.fs } : {}),
      });
    },

    async detectDrift(snapshot) {
      const pinsDir = await resolvePinsDir();
      const stored = await readWorkspaceHookPins({
        pinsDir,
        projectKey: projectKeyOf(snapshot),
        ...(input.fs ? { fs: input.fs } : {}),
      });
      if (stored.pins.size === 0) return [];
      const drifted: string[] = [];
      for (const entry of snapshot.hooks) {
        const pinned = stored.pins.get(entry.hookDeclarationDigest);
        // 无 pin（波前存量授予/写失败）→ 无从比对，跳过：trust 主层仍是权威。
        if (!pinned) continue;
        const current = await classifyEntry(snapshot, entry);
        // 分类不可达（源文件索引失配）按漂移处理：授予时至今声明已无法核验 =
        // fail-closed（与 unpinnable 永不等价同一姿态）。
        if (current === undefined || !workspaceHookPinEquals(pinned, current)) {
          drifted.push(entry.hookDeclarationDigest);
        }
      }
      return drifted;
    },

    async forgetPins(digests, snapshot) {
      const pinsDir = await resolvePinsDir();
      const projectKey = projectKeyOf(snapshot);
      const existing = await readWorkspaceHookPins({
        pinsDir,
        projectKey,
        ...(input.fs ? { fs: input.fs } : {}),
      });
      let removed = 0;
      const pins = new Map(existing.pins);
      for (const digest of digests) {
        if (pins.delete(digest)) removed += 1;
      }
      if (removed === 0) return;
      await writeWorkspaceHookPins({
        pins,
        pinsDir,
        projectKey,
        ...(input.fs ? { fs: input.fs } : {}),
      });
    },
  };
}
