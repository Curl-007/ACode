// ============================================================
// Open Tool (K9 工具微增补) - 打开/揭示文件、目录或 URL 给用户
// ============================================================
// 注册待整合方接线：本文件不进 handlers/index.ts 的 BUILT_IN 聚合，
// 注册（含平台端口注入与门控选项）由整合方统一处理。
//
// 语义（specs/tooling-micro-additions.md R2）：agent 完成构建后让用户看产物、打开日志
// 目录、打开预览 URL。平台面走注入的 platform port（IPlatformService 的结构子集），
// 红线是零直接 OS 调用——不 spawn start/open、不碰 window.acode（AGENTS.md 平台边界）。
//
// 门控：CLI/TUI 无平台面 → createOpenToolEntry 返回 undefined（与 runtime-tools.ts
// 的 includeWorkflow 端口门同款思路：端口在场才注册）。本工具不注册即不可见。
//
// 日志纪律（J3-2 / R2）：info 级 event "tool.open" 只记 kind 与 opened，
// 不记 URL/路径本体——两者都可能携带敏感段。

import {
  CoreErrorType,
  OPEN_PROVIDER_DESCRIPTION,
  OPEN_TOOL_NAME,
  OpenInputJsonSchema,
  OpenInputSchema,
  OpenResultJsonSchema,
  OpenResultSchema,
  createCoreError,
  type Logger,
  type OpenInput,
  type OpenResult,
} from "@acode/contracts";
import { isAbsolute as isAbsolutePath, relative } from "node:path";
// `statSync` 只用于权限档的目录探测（见 resolveOpenPermissionCapability）；
// 这是同步 fs 探针，与 bash-git-runtime-safety.ts 在权限链路上的既有用法同族，
// 任何失败都按「非目录」处理——能力判定 fail-closed 回落 entry 默认 confirm 档。
import { statSync } from "node:fs";
import { resolveWorkspacePath } from "../path-policy.js";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolRuntimePermissionCapability,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";

/** spec「常量」表：URL 协议白名单——http/https 之外的协议一律拒绝（file:// 等是逃逸面）。 */
export const OPEN_URL_PROTOCOLS: readonly string[] = ["http:", "https:"];

const OPEN_TIMEOUT_MS = 30_000;
const MAX_OPEN_MODEL_BYTES = 4_000;

/**
 * 平台端口：`IPlatformService`（packages/shared/src/platform.ts）的结构子集。
 * Desktop/Web 宿主持有完整 IPlatformService 时可直接传入（超集结构兼容）；
 * reveal 依赖可选成员 `openExternalFile`——缺席即按能力探测降级（opened:false + detail，
 * 不 fail）。openExternalFile 在 Desktop 用系统默认应用开箱（目录即文件管理器）；
 * 平台侧的 openInFileManager 未纳入本端口面，保持任务声明的最小注入面。
 */
export interface OpenPlatformPort {
  openExternal(url: string): void;
  /** reveal:true = 在文件管理器中**定位**（不打开）；缺省 false = 用默认应用打开。
   * 可选第二参向后兼容（既有实现只收 path 的签名仍满足结构子集）。 */
  openExternalFile?(
    path: string,
    options?: { reveal?: boolean },
  ): Promise<{ success: boolean; error?: string }>;
}

export interface CreateOpenToolEntryDeps {
  /** 平台能力端口；缺席 → 返回 undefined（调用方不注册，CLI/TUI 形态）。 */
  platform?: OpenPlatformPort;
  logger?: Logger;
}

/**
 * 构造 Open 工具 entry。platform 缺席时返回 undefined——注册门在返回值上，
 * 整合方按 `const entry = createOpenToolEntry({ platform }); if (entry) register(entry)`
 * 接线（与 runtime-tools.ts 的 includeWorkflow 端口门同款：端口在场才注册）。
 */
export function createOpenToolEntry(
  deps: CreateOpenToolEntryDeps = {},
): ToolEntry | undefined {
  if (!deps.platform) return undefined;
  const platform = deps.platform;
  return {
    ...openToolEntryBase,
    handler: createOpenHandler(platform, deps.logger),
  };
}

// -----------------------------------------------
// 目标分类（URL 白名单 vs workspace 治理路径）
// -----------------------------------------------

type OpenTargetClassification =
  | { kind: "url"; url: string; normalizedUrl: string }
  | { kind: "rejected-protocol"; protocol: string }
  | { kind: "path"; path: string };

/**
 * 分类判定（spec R2）：
 * - http(s) URL → url（协议白名单钉住，http/https 之外一律拒绝）；
 * - 其余能被 URL 解析的目标（file://、ftp://、javascript:、自定义协议）→ 拒绝——
 *   这些是逃逸面，不是「路径」；
 * - Windows 盘符路径（C:\… 或 C:/…）先按路径处理，避免被 URL 解析器误判成 "c:" 协议；
 * - 路径经既有 workspace 路径治理工具（tool/path-policy.ts resolveWorkspacePath）解析，
 *   不手写格式（AGENTS.md Workspace Identity 章口径）。
 */
function classifyOpenTarget(
  target: string,
  workingDirectory: string,
  workspaceRoot: string,
): OpenTargetClassification {
  // Windows 盘符（含正斜杠形态）优先判定为路径：WHATWG URL 会把 "C:/x" 解析成协议 "c:"。
  const isWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(target);
  if (!isWindowsDrivePath) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(target);
    } catch {
      parsed = undefined;
    }
    if (parsed) {
      if (OPEN_URL_PROTOCOLS.includes(parsed.protocol)) {
        // 回执保留模型原始字符串；执行面（openExternal）用 href 规范形——
        // WHATWG 序列化会把 `"`/空格等 percent-encode，href 里不可能出现引号，
        // 宿主 opener 拿到的目标无元字符（对抗复核 H1：原始串内嵌 `"` 曾击穿 cmd 转义）。
        return { kind: "url", url: target, normalizedUrl: parsed.href };
      }
      return { kind: "rejected-protocol", protocol: parsed.protocol };
    }
  }
  return {
    kind: "path",
    path: resolveWorkspacePath({
      inputPath: target,
      workingDirectory,
      workspaceRoot,
      operation: "read",
    }),
  };
}

/** 分类失败（如路径治理抛错）→ undefined，能力判定回落 confirm 档（fail-closed）。 */
function tryClassifyOpenTarget(
  target: string,
  workingDirectory: string | undefined,
  workspaceRoot: string | undefined,
): OpenTargetClassification | undefined {
  if (!workingDirectory || !workspaceRoot) return undefined;
  try {
    return classifyOpenTarget(target, workingDirectory, workspaceRoot);
  } catch {
    return undefined;
  }
}

function isPathInsideWorkspace(path: string, workspaceRoot: string): boolean {
  const relativePath = relative(workspaceRoot, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolutePath(relativePath));
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 结果 kind 探测：优先 fileSystemPort.stat；端口缺席/探测失败回落 "file"（fire-and-forget 语义）。 */
async function detectPathKind(
  path: string,
  fileSystemPort: ToolExecutionContext["fileSystemPort"],
): Promise<"file" | "directory"> {
  if (!fileSystemPort) return "file";
  try {
    const stat = await fileSystemPort.stat({ path });
    return stat.kind === "directory" ? "directory" : "file";
  } catch {
    return "file";
  }
}

// -----------------------------------------------
// handler
// -----------------------------------------------

function createOpenHandler(platform: OpenPlatformPort, logger?: Logger): ToolHandler {
  return async (input, context): Promise<OpenResult> => {
    const { target, action = "open" } = OpenInputSchema.parse(input) as OpenInput;
    const classification = classifyOpenTarget(
      target,
      context.workingDirectory,
      context.workspaceRoot,
    );

    if (classification.kind === "rejected-protocol") {
      // 协议白名单是逃逸面防线，必须钉住：拒绝是业务失败（recoverable），模型可改用 http(s) 或路径重试。
      throw createCoreError(
        CoreErrorType.InvalidInput,
        `Open tool rejected target protocol ${classification.protocol}: only http and https URLs are allowed`,
        {
          context: {
            toolCallId: context.toolCallId,
            toolName: OPEN_TOOL_NAME,
            protocol: classification.protocol,
          },
          recoverable: true,
        },
      );
    }

    if (classification.kind === "url") {
      if (action === "reveal") {
        // reveal 的语义是「在文件管理器中定位」，对 URL 无意义；明确拒绝而非静默换成开浏览器。
        throw createCoreError(
          CoreErrorType.InvalidInput,
          "Open tool action reveal is only supported for local files and directories, not URLs",
          {
            context: { toolCallId: context.toolCallId, toolName: OPEN_TOOL_NAME },
            recoverable: true,
          },
        );
      }
      // fire-and-forget：与 openExternal 的 void 签名同构（spec「未做与取舍」§2）。
      // 执行面传 href 规范形（对抗复核 H1 第二防线：percent-encoded 后无引号/元字符）。
      platform.openExternal(classification.normalizedUrl);
      logOpenCall(logger, "url", true);
      return { opened: true, kind: "url" };
    }

    const pathKind = await detectPathKind(classification.path, context.fileSystemPort);
    const openExternalFile = platform.openExternalFile;
    if (!openExternalFile) {
      // 能力探测降级（不 fail）：平台面没有本地文件开箱能力（openExternalFile 是可选成员）。
      logOpenCall(logger, pathKind, false);
      return {
        opened: false,
        kind: pathKind,
        detail:
          "Platform cannot open local paths in this environment (openExternalFile unavailable); ask the user to open the path manually.",
      };
    }

    const openResult = await openExternalFile(classification.path, {
      reveal: action === "reveal",
    });
    logOpenCall(logger, pathKind, openResult.success);
    return openResult.success
      ? { opened: true, kind: pathKind }
      : {
          opened: false,
          kind: pathKind,
          detail: openResult.error ?? "Platform failed to open the path",
        };
  };
}

function logOpenCall(logger: Logger | undefined, kind: OpenResult["kind"], opened: boolean): void {
  // 日志纪律（spec R2 / J3-2）：URL 与路径可能含敏感段，只记 kind 与 opened，不记本体。
  logger?.info("Open tool called", {
    event: "tool.open",
    module: "core.tool.handlers.open",
    kind,
    opened,
  });
}

// -----------------------------------------------
// 权限档（spec R2）
// -----------------------------------------------

/**
 * - URL / workspace 外路径 / 非目录 → 返回 undefined（entry 默认 confirm 档：
 *   needsApproval + medium——「agent 能替用户打开任意网页/外部文件」的风险面）；
 * - workspace 内**目录** → 低档（打开目录管理器无破坏性，needsApproval=false）。
 * capability 形态参考 bash.ts：只收窄默认档，永不把 confirm 放宽成放行。
 */
function resolveOpenPermissionCapability(
  input: unknown,
  context?: ToolRuntimePermissionCapabilityContext,
): ToolRuntimePermissionCapability | undefined {
  const parsed = OpenInputSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const classification = tryClassifyOpenTarget(
    parsed.data.target,
    context?.workingDirectory,
    context?.workspaceRoot,
  );
  if (classification?.kind !== "path") return undefined;
  if (!context?.workspaceRoot || !isPathInsideWorkspace(classification.path, context.workspaceRoot)) {
    return undefined;
  }
  if (!isExistingDirectory(classification.path)) return undefined;
  return {
    readOnly: false,
    needsApproval: false,
    riskLevel: "low",
    sideEffectScope: "userInteraction",
    permission: {
      needsApproval: false,
      riskLevel: "low",
      sideEffectScope: "userInteraction",
    },
  };
}

// -----------------------------------------------
// entry 静态面
// -----------------------------------------------

const openToolEntryBase: Omit<ToolEntry, "handler"> = {
  capability:
    "Open a file, directory, or URL in the user's environment through the platform service so the user can see it",
  metadata: {
    name: OPEN_TOOL_NAME,
    description: OPEN_PROVIDER_DESCRIPTION,
    // 用户可见的副作用面（默认应用/浏览器/文件管理器），但不改写任何数据。
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: OPEN_TIMEOUT_MS,
    maxOutputBytes: MAX_OPEN_MODEL_BYTES,
    sideEffectScope: "userInteraction",
    // capability 中档 + needsApproval（spec R2：URL 开箱与文件开箱默认 confirm 分级）。
    riskLevel: "medium",
    needsApproval: true,
  },
  resolvePermissionCapability: resolveOpenPermissionCapability,
  inputSchema: OpenInputJsonSchema,
  outputSchema: OpenResultJsonSchema,
  runtimeInputSchema: OpenInputSchema,
  runtimeOutputSchema: OpenResultSchema,
  permission: {
    permission: "open",
    reason: "Open surfaces URLs or local files to the user via the platform shell (default browser/app/file manager)",
    riskLevel: "medium",
    sideEffectScope: "userInteraction",
    needsApproval: true,
    patternSources: ["input"],
    alwaysAllowPatternSources: ["input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_OPEN_MODEL_BYTES,
    maxModelBytes: MAX_OPEN_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_OPEN_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: OPEN_TIMEOUT_MS,
    maxMs: OPEN_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Open was cancelled before the platform opened the target",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    // trace 纪律与日志一致：输入含 URL/路径本体，不进原始入参。
    recordInput: "none",
    recordOutput: "summary",
  },
};
