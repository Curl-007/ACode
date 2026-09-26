import { isOfficialServiceEnabled, ACODE_VERSION, type ACodeEnv } from "@acode/shared";

declare const __ACODE_CDN_BASE_URL__: string | undefined;
const DEFAULT_CDN_BASE_URL = "";

export interface ResolveRemoteCdnOptions {
  env?: ACodeEnv;
  locale?: string;
  timeZone?: string;
  overrideBaseUrl?: string;
  version?: string;
  now?: Date;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("CDN URL must use http or https");
  return value.replace(/\/+$/, "");
}

export function resolveRemoteCdnBaseUrls(options: ResolveRemoteCdnOptions = {}): string[] {
  // 审计版不连接官方服务，不从 CDN 自动下载资源。
  if (!isOfficialServiceEnabled("marketplace")) return [];
  const override = options.overrideBaseUrl?.trim();
  if (override) return [normalizeBaseUrl(override)];
  const baseUrl =
    process.env.ACODE_CDN_BASE_URL?.trim() ||
    (typeof __ACODE_CDN_BASE_URL__ === "undefined" ? "" : __ACODE_CDN_BASE_URL__) ||
    DEFAULT_CDN_BASE_URL;
  return [
    `${normalizeBaseUrl(baseUrl)}/zcode/electron/releases/${options.version ?? ACODE_VERSION}`,
  ];
}
