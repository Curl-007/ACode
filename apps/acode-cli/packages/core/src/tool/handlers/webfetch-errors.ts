import { CoreErrorType, createCoreError } from "@acode/contracts";
import { WEBFETCH_TOOL_NAME } from "./webfetch-constants.js";

/**
 * 撞闸文案：明确告知模型下一步（写进结论 / 请用户贴内容），并钉死「重试必失败」。
 * WebFetch 与 Read URL 直读（specs/read-url-direct.md R2）共用——同一闸门同一语义，
 * 两个入口的指引不得漂移。
 */
export const UNPROVENANCED_URL_BLOCKED_MESSAGE =
  "Blocked by the URL provenance gate: this URL has not appeared in any user message, WebSearch result, or previous WebFetch result in this session. Retrying it will keep failing. Record the URL in your conclusion as not fetched (or ask the user to paste the content) and continue with the rest of your task.";

type WebFetchErrorCode = keyof typeof WEBFETCH_ERROR_CODE_MAP;

export function webFetchError(
  code: WebFetchErrorCode,
  message: string,
  context: Record<string, unknown> = {},
  cause?: unknown,
): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, {
    cause: cause instanceof Error ? cause : undefined,
    context: {
      ...context,
      webFetchCode: WEBFETCH_ERROR_CODE_MAP[code],
      toolName: WEBFETCH_TOOL_NAME,
    },
    recoverable: true,
    retryable: code === "FetchFailed" || code === "ProcessingFailed",
  });
}

const WEBFETCH_ERROR_CODE_MAP = {
  InvalidUrl: "webfetch_invalid_url",
  UnsupportedProtocol: "webfetch_unsupported_protocol",
  CredentialsInUrl: "webfetch_credentials_in_url",
  MissingRedirectLocation: "webfetch_missing_redirect_location",
  UnsafeRedirect: "webfetch_unsafe_redirect",
  EgressBlocked: "webfetch_egress_blocked",
  TooManyRedirects: "webfetch_too_many_redirects",
  ResponseTooLarge: "webfetch_response_too_large",
  FetchFailed: "webfetch_fetch_failed",
  ProcessingFailed: "webfetch_processing_failed",
  // 溯源闸门拒绝（specs/error-taxonomy-injection-defense.md R5）：不可重试
  // （retryable 仅 FetchFailed/ProcessingFailed），与「重试必失败」的闸门语义一致。
  UnprovenancedUrl: "webfetch_unprovenanced_url",
} as const;
