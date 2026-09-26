import { DEFAULT_ACODE_ENDPOINT_ORIGIN } from "./acodeEndpoint.js";

export const ACODE_SOURCE_HEADERS = {
  "User-Agent": "ACode/unknown",
  "HTTP-Referer": DEFAULT_ACODE_ENDPOINT_ORIGIN,
  "X-Title": "Z Code@electron",
} as const;

export interface BuildACodeSourceHeadersFromContextOptions {
  appVersion?: string;
  arch?: string;
  clientLanguage?: string;
  clientTimezone?: string;
  deviceMid?: string;
  endpointOrigin?: string;
  osVersion?: string;
  platform?: string;
  releaseChannel?: string;
  sourceTitle?: string;
}

export function normalizeACodeSourceHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[\x20-\x7e]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function buildACodeSourceHeadersFromContext(
  options: BuildACodeSourceHeadersFromContextOptions = {},
): Record<string, string> {
  const appVersion = normalizeACodeSourceHeaderValue(options.appVersion);
  const arch = normalizeACodeSourceHeaderValue(options.arch);
  const clientLanguage = normalizeACodeSourceHeaderValue(options.clientLanguage) ?? "unknown";
  const clientTimezone = normalizeACodeSourceHeaderValue(options.clientTimezone) ?? "unknown";
  const deviceMid = normalizeACodeSourceHeaderValue(options.deviceMid);
  const endpointOrigin =
    normalizeACodeSourceHeaderValue(options.endpointOrigin) ?? DEFAULT_ACODE_ENDPOINT_ORIGIN;
  const osVersion = normalizeACodeSourceHeaderValue(options.osVersion);
  const platform = normalizeACodeSourceHeaderValue(options.platform);
  const releaseChannel = normalizeACodeSourceHeaderValue(options.releaseChannel);
  const sourceTitle = normalizeACodeSourceHeaderValue(options.sourceTitle) ?? "electron";

  return {
    ...ACODE_SOURCE_HEADERS,
    "HTTP-Referer": endpointOrigin,
    "User-Agent": `ACode/${appVersion ?? "unknown"}`,
    ...(appVersion ? { "X-ACode-App-Version": appVersion } : {}),
    "X-Title": `Z Code@${sourceTitle}`,
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    ...(releaseChannel ? { "X-Release-Channel": releaseChannel } : {}),
    "X-Client-Language": clientLanguage,
    "X-Client-Timezone": clientTimezone,
    ...(platform ? { "X-Os-Category": normalizeOsCategory(platform) } : {}),
    ...(osVersion ? { "X-Os-Version": osVersion } : {}),
    ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
  };
}

function normalizeOsCategory(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
