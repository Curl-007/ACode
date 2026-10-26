import type {
  LocalDiagnosticConnection,
  LocalDiagnosticFacts,
} from "@acode/shared";
import { ACODE_COMMIT, ACODE_VERSION } from "@acode/shared";
import type { WebReconnectController, WebReconnectState } from "../reconnect/index.js";

/**
 * Web 端本地诊断事实采集与下载（U12）。
 * 契约真源：packages/shared/specs/local-diagnostic-report.md；Web 本地不变量见
 * packages/web/specs/local-diagnostic-report-web.md。
 *
 * 两条承重不变量：
 * 1. **零副作用**（spec 产品规则 4 / 验收 U12-A1）：只读当前内存状态，不 fetch、不开 socket、
 *    不触发 provider probe、不为采集而重连。手机离线也必须能产出报告。
 * 2. **只报自己拥有的事实**（spec 产品规则 2）：`os`/`arch`/`appVersion`/`commit` 的所有者是
 *    Desktop main；Web 读 `navigator.userAgentData` 会新开设备指纹面，故**省略**而非猜测。
 *    `locale` 用既有权威源 `document.documentElement.lang`（与 webPlatform.ts 同源）。
 */

/** 连接事实的读取面——由入口注入，避免本模块持有连接状态副本（AGENTS.md：不重复状态）。 */
export interface WebConnectionFactsSource {
  /** 当前重连状态；null = 尚未进入重连循环（首连成功且未断过）。 */
  readonly lastState: WebReconnectState | null;
  /** 当前重连控制器的尝试计数；null = 控制器尚未创建。 */
  readonly attempt: number | null;
}

/**
 * Web 的交付档位。真源：`packages/server/src/http.ts:539`（`/ws` 的
 * `setupChannelServer(..., "web-remote-replayable")`）——Web 入口只可能是这一档，
 * 故为常量而非探测值（探测需要问 server，违反零副作用不变量）。
 */
const WEB_DELIVERY_MODE = "web-remote-replayable";

/**
 * 构建常量的非事实回退值（version.ts:8-12 在未注入 define 的环境下返回它们）。
 * 这些值**不是事实**，采集时必须识别并省略，否则报告会声称一个假版本（契约产品规则 2）。
 */
const NON_FACT_VERSION_VALUES = new Set(["0.0.0-dev", "unknown", ""]);

/** 只在值是真实构建事实时返回，否则 undefined（省略字段而非上报回退值）。 */
function realBuildValue(value: string | undefined): string | undefined {
  if (!value || NON_FACT_VERSION_VALUES.has(value)) {
    return undefined;
  }
  return value;
}

/** 连接阶段 → 公开稳定词。不透传原始 err.message / URL（spec 产品规则 5）。 */
function phaseToStableWord(state: WebReconnectState | null): string {
  if (state === null) {
    // 尚未进入重连循环 = 首连成功后一直健康。
    return "connected";
  }
  switch (state.phase) {
    case "reconnected":
      return "connected";
    case "waiting":
    case "connecting":
      return "reconnecting";
    case "exhausted":
      return "disconnected";
    case "idle":
    default:
      return "idle";
  }
}

/** 采集 Web 端事实 DTO。纯读，无任何 IO。 */
export function collectWebDiagnosticFacts(
  connectionSource: WebConnectionFactsSource | null,
): LocalDiagnosticFacts {
  // locale：与 webPlatform.ts:69 同一权威源（html lang 由 i18n provider 写入）。
  const locale =
    typeof document !== "undefined" && document.documentElement.lang
      ? document.documentElement.lang
      : "unknown";

  const connection: LocalDiagnosticConnection | undefined = connectionSource
    ? {
        deliveryMode: WEB_DELIVERY_MODE,
        phase: phaseToStableWord(connectionSource.lastState),
        // 重连层只有原始错误、无公开稳定码；按 spec 宁缺毋滥，出空数组而非泄漏 err.message。
        errorCodes: [],
        reconnectCount: Math.max(0, connectionSource.attempt ?? 0),
      }
    : undefined;

  return {
    platformType: "web",
    // build 组：报 Web 真正拥有的字段。appVersion/commit 来自 shared 的 bundler 注入常量
    // （web/vite.config.ts:101 也注入），是本 bundle 的构建事实、非设备指纹；未构建环境的
    // 回退值（"0.0.0-dev"/"unknown"）不是事实，realBuildValue 会省略它们。
    // os/arch 省略：所有者是 Desktop main 的 process.platform/arch，Web 不猜（不开指纹面）。
    build: {
      ...(realBuildValue(ACODE_VERSION) ? { appVersion: realBuildValue(ACODE_VERSION) } : {}),
      ...(realBuildValue(ACODE_COMMIT) ? { commit: realBuildValue(ACODE_COMMIT) } : {}),
      locale,
      capabilities: ["saveDiagnosticReport"],
    },
    buildAvailability: "collected",
    ...(connection ? { connection } : {}),
    connectionAvailability: connection ? "collected" : "unavailable",
  };
}

/** 浏览器下载用的最小 DOM 面——测试可注入假实现（本仓 web 测试无 jsdom）。 */
export interface WebDownloadDeps {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  /** 触发下载（生产实现建 `<a download>` 并 click）。 */
  triggerDownload(url: string, suggestedName: string): void;
  createBlob(parts: string[], type: string): Blob;
}

/** Web 下载不可用时返回的稳定错误码（UI 据此降级为「复制 JSON 到剪贴板」，不得声称成功）。 */
export const WEB_DOWNLOAD_UNSUPPORTED = "download-unsupported" as const;

export function createBrowserDownloadDeps(): WebDownloadDeps {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    createBlob: (parts, type) => new Blob(parts, { type }),
    triggerDownload: (url, suggestedName) => {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = suggestedName;
      // 不挂进文档也可 click（现代浏览器支持）；挂上再移除是兼容性更稳的写法。
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    },
  };
}

/**
 * 保存诊断报告 JSON：Blob → object URL → `<a download>` → **revoke（释放率 100%，验收 U12-A5）**。
 * 失败路径也 revoke（try/finally），并返回稳定错误码——不谎报成功：真实移动浏览器可能拦截
 * 程序化下载，此时 UI 应提供剪贴板降级。
 */
export async function saveWebDiagnosticReport(
  json: string,
  suggestedName: string,
  deps: WebDownloadDeps,
): Promise<{ saved: boolean; path?: string; cancelled?: boolean; error?: string }> {
  if (typeof deps.createBlob !== "function" || typeof deps.createObjectURL !== "function") {
    return { saved: false, error: WEB_DOWNLOAD_UNSUPPORTED };
  }
  let url: string | null = null;
  try {
    const blob = deps.createBlob([json], "application/json");
    url = deps.createObjectURL(blob);
    deps.triggerDownload(url, suggestedName);
    return { saved: true };
  } catch {
    return { saved: false, error: WEB_DOWNLOAD_UNSUPPORTED };
  } finally {
    // 释放临时资源：成功与失败都必须 revoke（spec U12-A5 资源门槛）。
    if (url !== null) {
      try {
        deps.revokeObjectURL(url);
      } catch {
        // revoke 自身失败不掩盖上面的结果（已尽力释放）。
      }
    }
  }
}

/** 从入口的重连状态构造连接事实源（controller 可能尚未创建 → attempt 为 null）。 */
export function createWebConnectionFactsSource(getters: {
  getController: () => WebReconnectController | null;
  getLastState: () => WebReconnectState | null;
}): WebConnectionFactsSource {
  return {
    get lastState() {
      return getters.getLastState();
    },
    get attempt() {
      const controller = getters.getController();
      return controller ? controller.attempt : null;
    },
  };
}
