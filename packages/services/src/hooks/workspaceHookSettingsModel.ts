import { dirname } from "node:path";
import type {
  Hook,
  HookConfiguredState,
  HookEvent,
  SettingsDirectoryLocation,
  WorkspaceHookDiscoveryState,
} from "@acode/shared";
import {
  resolveWorkspaceHookEntries,
  WORKSPACE_HOOK_EVENT_NAMES,
  type CanonicalWorkspaceHookEntryData,
  type WorkspaceHookBundleSnapshotData,
  type WorkspaceHookDefinition,
  type WorkspaceHookEventName,
  type WorkspaceHookRuntimeRoot,
  type WorkspaceHookSourceInput,
  type WorkspaceHooksConfig,
} from "@acode/shared/workspace-hook-discovery";
import { resolveWorkspaceHookDisplayTrustState } from "./workspaceHookValueHash.js";

interface LegacyHookDefinition {
  type?: "command" | "process" | string;
  command?: string;
  args?: string[];
  async?: boolean;
  enabled?: boolean;
  shell?: true | string;
  statusMessage?: string;
  timeout?: number;
  timeoutMs?: number;
  [key: string]: unknown;
}

interface LegacyHookMatcher {
  matcher?: string;
  hooks?: LegacyHookDefinition[];
}

export interface LegacyHooksConfig {
  hooks?: Partial<Record<string, LegacyHookMatcher[]>>;
  [key: string]: unknown;
}

function isHookType(value: unknown): value is Hook["type"] {
  return value === "command" || value === "process";
}

function getCustomHookFields(hook: LegacyHookDefinition | WorkspaceHookDefinition) {
  const {
    type: _type,
    command: _command,
    args: _args,
    async: _async,
    enabled: _enabled,
    shell: _shell,
    statusMessage: _statusMessage,
    timeout: _timeout,
    timeoutMs: _timeoutMs,
    ...custom
  } = hook;
  return Object.keys(custom).length > 0 ? custom : undefined;
}

function resolveWritableDeclarationEnabled(hook: Hook): boolean {
  const configured = hook.configuredState;
  if (!configured) return hook.enabled;
  return hook.enabled === configured.configuredEnabled
    ? configured.declarationEnabled
    : hook.enabled;
}

function getWritableHook(hook: Hook): LegacyHookDefinition {
  const common: LegacyHookDefinition = {
    ...hook.custom,
    type: hook.type,
    command: hook.command,
    enabled: resolveWritableDeclarationEnabled(hook),
    ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
  };
  if (hook.type === "command") {
    return {
      ...common,
      ...(hook.async ? { async: true } : {}),
      ...(hook.shell ? { shell: hook.shell } : {}),
      ...(hook.timeout ? { timeout: hook.timeout } : {}),
    };
  }
  return {
    ...common,
    ...(hook.args && hook.args.length > 0 ? { args: hook.args } : {}),
    ...(hook.timeout ? { timeoutMs: hook.timeout * 1000 } : {}),
  };
}

function getRawHook(
  source: WorkspaceHookSourceInput,
  entry: CanonicalWorkspaceHookEntryData,
): WorkspaceHookDefinition {
  const hook = source.hooks.events?.[entry.event]?.[entry.matcherIndex]?.hooks[entry.hookIndex];
  if (!hook) throw new Error(`Workspace Hook provenance is incomplete for ${entry.reviewItemId}`);
  return hook;
}

function toConfiguredState(
  entry: CanonicalWorkspaceHookEntryData,
  sourcePath: string,
): HookConfiguredState {
  return {
    sourceRootEnabled: entry.sourceRootEnabled,
    declarationEnabled: entry.declarationEnabled,
    runtimeHooksEnabled: entry.runtimeHooksEnabled,
    configuredEnabled: entry.configuredEnabled,
    sourcePath,
  };
}

function toHook(input: {
  entry: CanonicalWorkspaceHookEntryData;
  source: WorkspaceHookSourceInput;
  id: string;
  location: SettingsDirectoryLocation;
  workspaceHook?: Omit<
    WorkspaceHookDiscoveryState,
    keyof HookConfiguredState | "reviewItemId" | "sourceFileIndex"
  >;
}): Hook {
  const raw = getRawHook(input.source, input.entry);
  const configuredState = toConfiguredState(input.entry, input.source.canonicalPath);
  const workspaceHook = input.workspaceHook
    ? {
        ...configuredState,
        reviewItemId: input.entry.reviewItemId,
        sourceFileIndex: input.entry.sourceFileIndex,
        ...input.workspaceHook,
      }
    : undefined;
  return {
    id: input.id,
    event: input.entry.event,
    matcher: input.entry.matcher ?? undefined,
    type: input.entry.type,
    command: input.entry.command,
    ...(input.entry.type === "process" ? { args: [...(input.entry.args ?? [])] } : {}),
    ...(input.entry.type === "command" && input.entry.async !== undefined
      ? { async: input.entry.async }
      : {}),
    ...(input.entry.type === "command" && input.entry.shell !== undefined
      ? { shell: input.entry.shell }
      : {}),
    ...(input.entry.statusMessage ? { statusMessage: input.entry.statusMessage } : {}),
    timeout:
      (raw.type === "command" ? raw.timeout : undefined) ??
      (raw.timeoutMs !== undefined ? Math.round(raw.timeoutMs) / 1000 : undefined),
    enabled: input.entry.configuredEnabled,
    editable: input.entry.editable,
    configuredState,
    ...(workspaceHook ? { workspaceHook } : {}),
    custom: getCustomHookFields(raw),
    location: input.location,
  };
}

export function fromProjectSnapshot(input: {
  sources: WorkspaceHookSourceInput[];
  snapshot: WorkspaceHookBundleSnapshotData | undefined;
  workspaceIdentity: string;
  workspacePath: string;
  persistentTrustedDigests?: ReadonlySet<string>;
  /**
   * 记录派生的等价索引（值哈希扩展，spec: hooks-trust-value-hash.md）：
   * slot 等价（同位置值变）与改名等价（值同路径变）命中时分类为 stale_digest，
   * 而非全新 pending_trust；两者都绝不升级 trusted_persistent（runtime 精确 digest 强制）。
   */
  persistentTrustEquivalence?: {
    recordSlotKeys: ReadonlySet<string>;
    recordDisplayValueHashes: ReadonlySet<string>;
  };
}): Hook[] {
  const snapshot = input.snapshot;
  if (!snapshot) return [];
  const emptyEquivalence = {
    recordSlotKeys: new Set<string>(),
    recordDisplayValueHashes: new Set<string>(),
  };
  const equivalence = input.persistentTrustEquivalence ?? emptyEquivalence;
  return snapshot.hooks.map((entry) => {
    const source = input.sources[entry.sourceFileIndex];
    if (!source) throw new Error(`Workspace Hook source is missing for ${entry.reviewItemId}`);
    return toHook({
      entry,
      source,
      id: entry.reviewItemId,
      location: {
        source: "acode",
        scope: "project",
        directoryPath: dirname(source.canonicalPath),
        projectPath: input.workspacePath,
      },
      workspaceHook: {
        workspaceIdentity: input.workspaceIdentity,
        bundleDigest: snapshot.bundleDigest,
        hookDeclarationDigest: entry.hookDeclarationDigest,
        trustState: resolveWorkspaceHookDisplayTrustState({
          entry,
          sourceDiscoveryOrder: source.discoveryOrder,
          trustedDigests: input.persistentTrustedDigests ?? new Set<string>(),
          recordSlotKeys: equivalence.recordSlotKeys,
          recordDisplayValueHashes: equivalence.recordDisplayValueHashes,
        }),
      },
    });
  });
}

export function fromUserACodeSource(input: {
  source: WorkspaceHookSourceInput | undefined;
  runtimeRoot: WorkspaceHookRuntimeRoot;
  workspacePath: string;
  location: SettingsDirectoryLocation;
}): Hook[] {
  if (!input.source) return [];
  return resolveWorkspaceHookEntries({
    workspacePath: input.workspacePath,
    sources: [input.source],
    runtimeRoot: input.runtimeRoot,
  }).map((entry, index) =>
    toHook({
      entry,
      source: input.source!,
      id: `hook-acode-user-${index}`,
      location: input.location,
    }),
  );
}

export function fromLegacyHooksConfig(input: {
  legacyConfig: LegacyHooksConfig | null;
  location: SettingsDirectoryLocation;
  isHookEvent: (value: string) => value is HookEvent;
}): Hook[] {
  const hooks: Hook[] = [];
  let idCounter = 0;
  for (const [eventName, matchers] of Object.entries(input.legacyConfig?.hooks ?? {})) {
    if (!input.isHookEvent(eventName) || !Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      for (const hook of matcher.hooks ?? []) {
        if (!isHookType(hook.type) || !hook.command) continue;
        hooks.push({
          id: `hook-${input.location.source}-${input.location.scope}-${idCounter++}`,
          event: eventName,
          matcher: matcher.matcher,
          type: hook.type,
          command: hook.command,
          ...(hook.type === "process" ? { args: hook.args ?? [] } : {}),
          ...(hook.async !== undefined ? { async: hook.async } : {}),
          ...(hook.shell !== undefined ? { shell: hook.shell } : {}),
          ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
          timeout:
            hook.timeout ??
            (hook.timeoutMs !== undefined ? Math.round(hook.timeoutMs / 1000) : undefined),
          enabled: false,
          editable: false,
          location: input.location,
        });
      }
    }
  }
  return hooks;
}

/**
 * 可写事件面守护（apps/acode-cli/specs/hook-event-surface.md D2/F2/F9）：展示面的
 * HookEvent 已扩到 17 全集，但用户配置文件（acode.json hooks）的可写面仍由
 * workspace-hook-config 的 strict schema 钉在存量 7 事件（信任 digest 演进策略未定，
 * F2 后续批次）。携带新事件的 hook 只可能来自 legacy settings.json 的只读展示源
 * （editable=false，saveHooksImpl 已过滤），这里的守护保证即使未来读边界变化，
 * 也绝不把 CLI 侧 schema 会拒绝的事件键写进配置文件（strict 校验失败 = 整份 hooks
 * 配置被丢弃，方向不可接受）。
 */
function isWritableWorkspaceHookEvent(event: HookEvent): event is WorkspaceHookEventName {
  return (WORKSPACE_HOOK_EVENT_NAMES as readonly string[]).includes(event);
}

export function toACodeHooksEvents(hooks: Hook[]): WorkspaceHooksConfig["events"] {
  const events: WorkspaceHooksConfig["events"] = {};
  for (const hook of hooks) {
    if (!isWritableWorkspaceHookEvent(hook.event)) continue;
    const eventMatchers = events[hook.event] ?? [];
    let matcher = eventMatchers.find((item) => item.matcher === hook.matcher);
    if (!matcher) {
      matcher = {
        ...(hook.matcher ? { matcher: hook.matcher } : {}),
        hooks: [],
      };
      eventMatchers.push(matcher);
      events[hook.event] = eventMatchers;
    }
    matcher.hooks.push(getWritableHook(hook) as WorkspaceHookDefinition);
  }
  return events;
}

export function resolveNextRootEnabled(
  existingEnabled: boolean | undefined,
  hooks: Hook[],
): boolean | undefined {
  if (
    hooks.some(
      (hook) =>
        hook.enabled &&
        (!hook.configuredState || hook.enabled !== hook.configuredState.configuredEnabled),
    )
  ) {
    return true;
  }
  return existingEnabled;
}
