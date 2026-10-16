// Workspace Hook 信任值哈希扩展测试（spec: packages/services/specs/hooks-trust-value-hash.md 验收节）。
// 覆盖：展示值哈希改名不变量、slot/改名等价分类、精确 digest 优先、
// AtGrant 字段缺失 fail-closed、corrupt store 全量重问（loadHooks 集成，tmp HOME）。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildWorkspaceHookBundleSnapshot,
  createWorkspaceHookSourceInput,
  resolveWorkspaceHookRuntimeRoot,
  type WorkspaceHookSourceInput,
} from "@acode/shared/workspace-hook-discovery";
import type { WorkspaceHookTrustRecord } from "@acode/shared/workspace-hook-trust-store-file";
import { createHooksService } from "../src/hooks/hooksService.js";
import { fromProjectSnapshot } from "../src/hooks/workspaceHookSettingsModel.js";
import {
  computeWorkspaceHookEntryDisplayValueHash,
  computeWorkspaceHookEntrySlotKey,
  computeWorkspaceHookRecordDisplayValueHash,
  computeWorkspaceHookRecordSlotKey,
  deriveWorkspaceHookDisplayCommand,
  resolveWorkspaceHookDisplayTrustState,
} from "../src/hooks/workspaceHookValueHash.js";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeSource(input: {
  path: string;
  workingDirectory: string;
  discoveryOrder: number;
  command?: string;
  event?: string;
}): WorkspaceHookSourceInput {
  return createWorkspaceHookSourceInput({
    path: input.path,
    workingDirectory: input.workingDirectory,
    discoveryOrder: input.discoveryOrder,
    hooks: {
      events: {
        [input.event ?? "PreToolUse"]: [
          {
            hooks: [{ type: "command", command: input.command ?? "echo hi" }],
          },
        ],
      },
    } as never,
  });
}

function makeSnapshot(sources: WorkspaceHookSourceInput[], workspacePath: string) {
  return buildWorkspaceHookBundleSnapshot({
    workspaceIdentity: workspacePath,
    workspacePath,
    sources,
    runtimeRoot: resolveWorkspaceHookRuntimeRoot(sources.map((source) => source.hooks)),
  })!;
}

function buildRecord(
  entry: {
    hookDeclarationDigest: string;
    event: string;
    type: "command" | "process";
    command: string;
    args?: readonly string[];
    matcher: string | null;
    sourceRelativePath: string;
    matcherIndex: number;
    hookIndex: number;
  },
  source: WorkspaceHookSourceInput,
  workspaceIdentity: string,
  overrides: Partial<WorkspaceHookTrustRecord> = {},
): WorkspaceHookTrustRecord {
  return {
    workspaceIdentity,
    hookDeclarationDigest: entry.hookDeclarationDigest,
    digestAlgorithm: "sha256",
    decision: "trusted",
    grantedAt: new Date().toISOString(),
    eventAtGrant: entry.event as WorkspaceHookTrustRecord["eventAtGrant"],
    displayCommandAtGrant: deriveWorkspaceHookDisplayCommand(entry),
    sourcePathAtGrant: entry.sourceRelativePath,
    sourceDiscoveryOrderAtGrant: source.discoveryOrder,
    matcherAtGrant: entry.matcher,
    matcherIndexAtGrant: entry.matcherIndex,
    hookIndexAtGrant: entry.hookIndex,
    ...overrides,
  };
}

test("display value hash is rename-invariant and value-sensitive", () => {
  const ws = join(tmpdir(), "hook-value-hash-ws");
  const sourceA = makeSource({
    path: join(ws, ".acode", "config.json"),
    workingDirectory: ws,
    discoveryOrder: 0,
  });
  const snapshotA = makeSnapshot([sourceA], ws);
  const entryA = snapshotA.hooks[0]!;

  // 改名（路径变、发现序变、位置不变值不变）：declaration digest 变，展示值哈希不变。
  const sourceB = makeSource({
    path: join(ws, "nested", ".acode", "hooks.json"),
    workingDirectory: ws,
    discoveryOrder: 3,
  });
  const snapshotB = makeSnapshot([sourceB], ws);
  const entryB = snapshotB.hooks[0]!;
  assert.notEqual(entryA.hookDeclarationDigest, entryB.hookDeclarationDigest);
  assert.equal(
    computeWorkspaceHookEntryDisplayValueHash(entryA),
    computeWorkspaceHookEntryDisplayValueHash(entryB),
  );

  // 值变（命令变）：展示值哈希必须变。
  const sourceC = makeSource({
    path: join(ws, ".acode", "config.json"),
    workingDirectory: ws,
    discoveryOrder: 0,
    command: "echo bye",
  });
  const entryC = makeSnapshot([sourceC], ws).hooks[0]!;
  assert.notEqual(
    computeWorkspaceHookEntryDisplayValueHash(entryA),
    computeWorkspaceHookEntryDisplayValueHash(entryC),
  );

  // process 钩子的 args 参与 displayCommand 推导（与 CLI 写记录侧一致）。
  assert.equal(
    deriveWorkspaceHookDisplayCommand({ type: "process", command: "node", args: ["a.js", "--x"] }),
    "node a.js --x",
  );
  assert.equal(
    deriveWorkspaceHookDisplayCommand({ type: "command", command: "echo hi" }),
    "echo hi",
  );
});

test("record-side equivalence keys fail closed on missing AtGrant fields", () => {
  const ws = join(tmpdir(), "hook-value-hash-ws2");
  const source = makeSource({
    path: join(ws, ".acode", "config.json"),
    workingDirectory: ws,
    discoveryOrder: 0,
  });
  const entry = makeSnapshot([source], ws).hooks[0]!;
  const record = buildRecord(entry, source, ws);

  assert.equal(
    computeWorkspaceHookRecordDisplayValueHash(record),
    computeWorkspaceHookEntryDisplayValueHash(entry),
  );
  assert.equal(
    computeWorkspaceHookRecordSlotKey(record),
    computeWorkspaceHookEntrySlotKey(entry, source.discoveryOrder),
  );

  // matcherAtGrant 缺失（旧记录）：undefined 与 null 不判等，两个等价键都不可比。
  const legacy = { ...record };
  delete legacy.matcherAtGrant;
  assert.equal(computeWorkspaceHookRecordDisplayValueHash(legacy), null);
  assert.equal(computeWorkspaceHookRecordSlotKey(legacy), null);
  // slot 索引字段缺失同样不可比（镜像 runtime hasStaleSlotRecord 的跳过语义）。
  const noIndex = { ...record, hookIndexAtGrant: undefined };
  assert.equal(computeWorkspaceHookRecordSlotKey(noIndex), null);
});

test("display trust state classification order", () => {
  const ws = join(tmpdir(), "hook-value-hash-ws3");
  const source = makeSource({
    path: join(ws, ".acode", "config.json"),
    workingDirectory: ws,
    discoveryOrder: 0,
  });
  const entry = makeSnapshot([source], ws).hooks[0]!;
  const record = buildRecord(entry, source, ws);
  const slotKeys = new Set([computeWorkspaceHookRecordSlotKey(record)!]);
  const valueHashes = new Set([computeWorkspaceHookRecordDisplayValueHash(record)!]);
  const digests = new Set([record.hookDeclarationDigest]);
  const empty = new Set<string>();

  // 1. 精确 digest 命中优先。
  assert.equal(
    resolveWorkspaceHookDisplayTrustState({
      entry,
      sourceDiscoveryOrder: source.discoveryOrder,
      trustedDigests: digests,
      recordSlotKeys: slotKeys,
      recordDisplayValueHashes: valueHashes,
    }),
    "trusted_persistent",
  );
  // 2. slot 等价（同位置值变→digest 失配）→ stale_digest。
  assert.equal(
    resolveWorkspaceHookDisplayTrustState({
      entry,
      sourceDiscoveryOrder: source.discoveryOrder,
      trustedDigests: empty,
      recordSlotKeys: slotKeys,
      recordDisplayValueHashes: empty,
    }),
    "stale_digest",
  );
  // 3. 改名等价（值同、路径/位置变）→ stale_digest，绝不升级 trusted_persistent。
  const renamedEntry = {
    ...entry,
    hookDeclarationDigest: "f".repeat(64),
    sourceRelativePath: "other/config.json",
  };
  assert.equal(
    resolveWorkspaceHookDisplayTrustState({
      entry: renamedEntry,
      sourceDiscoveryOrder: 9,
      trustedDigests: empty,
      recordSlotKeys: empty,
      recordDisplayValueHashes: valueHashes,
    }),
    "stale_digest",
  );
  // 4. 无任何等价 → pending_trust；corrupt（全空集合）时同样全量 pending。
  assert.equal(
    resolveWorkspaceHookDisplayTrustState({
      entry: { ...entry, hookDeclarationDigest: "0".repeat(64) },
      sourceDiscoveryOrder: source.discoveryOrder,
      trustedDigests: empty,
      recordSlotKeys: empty,
      recordDisplayValueHashes: empty,
    }),
    "pending_trust",
  );
});

test("fromProjectSnapshot wires equivalence index into trustState", () => {
  const ws = join(tmpdir(), "hook-value-hash-ws4");
  const source = makeSource({
    path: join(ws, ".acode", "config.json"),
    workingDirectory: ws,
    discoveryOrder: 0,
  });
  const snapshot = makeSnapshot([source], ws);
  const entry = snapshot.hooks[0]!;
  const record = buildRecord(entry, source, ws);

  const trusted = fromProjectSnapshot({
    sources: [source],
    snapshot,
    workspaceIdentity: ws,
    workspacePath: ws,
    persistentTrustedDigests: new Set([record.hookDeclarationDigest]),
    persistentTrustEquivalence: {
      recordSlotKeys: new Set([computeWorkspaceHookRecordSlotKey(record)!]),
      recordDisplayValueHashes: new Set([computeWorkspaceHookRecordDisplayValueHash(record)!]),
    },
  });
  assert.equal(trusted[0]!.workspaceHook!.trustState, "trusted_persistent");

  // 值变（命令改写）后 digest 与展示值哈希都失配，但 slot 等价命中 → stale_digest。
  const changedSource = makeSource({
    path: join(ws, ".acode", "config.json"),
    workingDirectory: ws,
    discoveryOrder: 0,
    command: "echo changed",
  });
  const changedSnapshot = makeSnapshot([changedSource], ws);
  const changed = fromProjectSnapshot({
    sources: [changedSource],
    snapshot: changedSnapshot,
    workspaceIdentity: ws,
    workspacePath: ws,
    persistentTrustedDigests: new Set([record.hookDeclarationDigest]),
    persistentTrustEquivalence: {
      recordSlotKeys: new Set([computeWorkspaceHookRecordSlotKey(record)!]),
      recordDisplayValueHashes: new Set([computeWorkspaceHookRecordDisplayValueHash(record)!]),
    },
  });
  assert.equal(changed[0]!.workspaceHook!.trustState, "stale_digest");

  // 无等价索引（未接线/空集合）→ 回退既有 pending_trust 行为。
  const pending = fromProjectSnapshot({
    sources: [changedSource],
    snapshot: changedSnapshot,
    workspaceIdentity: ws,
    workspacePath: ws,
    persistentTrustedDigests: new Set<string>(),
  });
  assert.equal(pending[0]!.workspaceHook!.trustState, "pending_trust");
});

test("loadHooks: persistent store grants trust; corrupt store re-asks everything (fail-closed)", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hook-home-"));
  const ws = await mkdtemp(join(tmpdir(), "hook-ws-"));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    await rm(home, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  });

  await mkdir(join(ws, ".acode"), { recursive: true });
  // worktree 标记让项目配置发现停在 ws 本层，避免向上遍历吸入宿主机真实目录的配置。
  await mkdir(join(ws, ".git"), { recursive: true });
  await writeFile(
    join(ws, ".acode", "config.json"),
    JSON.stringify({
      hooks: { events: { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] } },
    }),
    "utf8",
  );
  const service = createHooksService({ logger: silentLogger as never });

  // 无 store：pending_trust。
  const first = await service.loadHooks({ workspacePath: ws });
  const projectHook = first.hooks.find((hook) => hook.workspaceHook)!;
  assert.equal(projectHook.workspaceHook!.trustState, "pending_trust");
  assert.equal(first.trustStoreCorrupt, undefined);

  // 写入与 CLI 记录侧同形的信任记录 → trusted_persistent。
  const snapshot = first.workspaceHookSnapshot!;
  const entry = snapshot.hooks[0]!;
  const source = snapshot.sourceFiles[0]!;
  const record = buildRecord(
    { ...entry, args: undefined },
    { discoveryOrder: source.discoveryOrder } as WorkspaceHookSourceInput,
    snapshot.workspaceIdentity,
  );
  const securityDir = join(home, ".acode", "security");
  await mkdir(securityDir, { recursive: true });
  const storePath = join(securityDir, "workspace-hook-trust-v1.json");
  await writeFile(storePath, JSON.stringify({ schemaVersion: 1, records: [record] }), "utf8");
  const second = await service.loadHooks({ workspacePath: ws });
  assert.equal(
    second.hooks.find((hook) => hook.workspaceHook)!.workspaceHook!.trustState,
    "trusted_persistent",
  );

  // 值变更（命令改写）→ digest 失配但 slot 等价 → stale_digest（值哈希失配即重问）。
  await writeFile(
    join(ws, ".acode", "config.json"),
    JSON.stringify({
      hooks: { events: { PreToolUse: [{ hooks: [{ type: "command", command: "rm -rf /" }] }] } },
    }),
    "utf8",
  );
  const third = await service.loadHooks({ workspacePath: ws });
  assert.equal(
    third.hooks.find((hook) => hook.workspaceHook)!.workspaceHook!.trustState,
    "stale_digest",
  );

  // store 损坏 → 全量重问 + trustStoreCorrupt（fail-closed，等价索引不得半份生效）。
  await writeFile(storePath, "{ not json", "utf8");
  const fourth = await service.loadHooks({ workspacePath: ws });
  assert.equal(fourth.trustStoreCorrupt, true);
  assert.equal(
    fourth.hooks.find((hook) => hook.workspaceHook)!.workspaceHook!.trustState,
    "pending_trust",
  );
});
