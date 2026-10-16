import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { createNodeWebFetchHttpClientAdapter } from "../http/index.js";
import {
  appendPluginSourceCleanupError,
  cleanupPluginSourceBestEffort,
  directoryExists,
  fileExists,
} from "./helpers.js";
import { extractZipArchiveTrustTiered } from "./zip-trust-extract.js";

// 解包面上限常量（解压总量/条目数/单文件）随两阶段引擎迁至 zip-trust-extract.ts，
// 语义原样保留；下载面常量仍归本文件所有。
const ZIP_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
const ZIP_MAX_REDIRECTS = 5;
const ZIP_DOWNLOAD_TIMEOUT_MS = 180_000;
const ZIP_TEMP_PREFIX = "acode-plugin-zip-";
const ZIP_DENIED_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
]);
const ZIP_REQUIRED_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

// 预览不解包面（manifest+icon，拒远程 URL icon）：实现与规格见 zip-preview.ts。
export {
  readZipPluginArchivePreview,
  ZIP_PREVIEW_ICON_MAX_BYTES,
  ZIP_PREVIEW_MANIFEST_MAX_BYTES,
  type ZipPluginArchivePreview,
} from "./zip-preview.js";

export interface ResolvedZipPluginSourceRoot {
  cleanup: () => Promise<void>;
  path: string;
}

interface ResolveZipPluginSourceInput {
  headers?: Record<string, string>;
  path?: string;
  sha256: string;
  signal?: AbortSignal;
  stripRoot?: boolean;
  url: string;
}

interface ResolveHttpZipSourceInput {
  headers?: Record<string, string>;
  path?: string;
  requireSingleRoot?: boolean;
  sha256?: string;
  signal?: AbortSignal;
  stripRoot?: boolean;
  url: string;
}

export class PluginZipDownloadError extends Error {
  readonly status?: number;
  readonly url: string;

  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = "PluginZipDownloadError";
    this.url = url;
    if (status !== undefined) this.status = status;
  }
}

export async function resolveZipPluginSource(
  input: ResolveZipPluginSourceInput,
): Promise<ResolvedZipPluginSourceRoot> {
  validateZipSourceInput(input);
  const resolved = await resolveHttpZipSource({
    headers: input.headers,
    path: input.path,
    sha256: input.sha256,
    signal: input.signal,
    stripRoot: input.stripRoot,
    url: input.url,
  });
  return resolved;
}

export async function resolveHttpZipSource(
  input: ResolveHttpZipSourceInput,
): Promise<ResolvedZipPluginSourceRoot> {
  validateZipDownloadUrl(input.url);
  validateZipHeaders(input.headers);
  if (input.path !== undefined) normalizeZipRelativePath(input.path);
  if (input.sha256 !== undefined && !ZIP_REQUIRED_SHA256_PATTERN.test(input.sha256.toLowerCase())) {
    throw new Error("Plugin zip source sha256 must be a 64 character hex string");
  }
  const tempRoot = await mkdtemp(join(tmpdir(), ZIP_TEMP_PREFIX));
  const extractRoot = join(tempRoot, "extract");
  const cleanup = async (): Promise<void> => {
    await rm(tempRoot, { force: true, recursive: true });
  };

  try {
    throwIfAborted(input.signal);
    const zipBytes = await downloadZipArchive({
      headers: input.headers,
      signal: input.signal,
      url: input.url,
    });
    const actualSha256 = createHash("sha256").update(zipBytes).digest("hex");
    if (input.sha256 !== undefined && actualSha256 !== input.sha256.toLowerCase()) {
      throw new Error(
        `Plugin zip sha256 mismatch: expected=${input.sha256.toLowerCase()}, actual=${actualSha256}`,
      );
    }

    // 解包经 store 信任档两阶段引擎（先全量元数据判定、后落盘）：
    // 规格 apps/acode-cli/specs/file-containment-trust-tiers.md R1。
    const extracted = await extractZipArchiveTrustTiered({
      archiveBytes: zipBytes,
      signal: input.signal,
      targetRoot: extractRoot,
    });
    const pluginRoot = resolveZipRoot({
      extractRoot,
      path: input.path,
      requireSingleRoot: input.requireSingleRoot,
      stripRoot: input.stripRoot,
      topLevelSegments: extracted.topLevelSegments,
    });
    return { cleanup, path: pluginRoot };
  } catch (error) {
    const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
    throw appendPluginSourceCleanupError(error, cleanupError);
  }
}

export function readZipPluginSourceSha256(source: unknown): string | undefined {
  if (!isZipPluginUrlSource(source)) return undefined;
  return source.sha256;
}

export function isZipPluginUrlSource(
  source: unknown,
): source is { source: "url"; type: "zip"; sha256: string; url: string } {
  return (
    typeof source === "object" &&
    source !== null &&
    !Array.isArray(source) &&
    "source" in source &&
    (source as { source?: unknown }).source === "url" &&
    (source as { type?: unknown }).type === "zip" &&
    typeof (source as { url?: unknown }).url === "string" &&
    typeof (source as { sha256?: unknown }).sha256 === "string"
  );
}

function validateZipSourceInput(input: ResolveZipPluginSourceInput): void {
  validateZipDownloadUrl(input.url);
  if (!ZIP_REQUIRED_SHA256_PATTERN.test(input.sha256.toLowerCase())) {
    throw new Error("Plugin zip source sha256 must be a 64 character hex string");
  }
  validateZipHeaders(input.headers);
  if (input.path !== undefined) {
    normalizeZipRelativePath(input.path);
  }
}

async function downloadZipArchive(input: {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  url: string;
}): Promise<Uint8Array> {
  // agent 会封存用户 shell 代理，ZIP 下载必须和其他应用层 fetch 一样读取 captured proxy fallback。
  const client = createNodeWebFetchHttpClientAdapter({
    env: process.env,
    maxResponseBytes: ZIP_DOWNLOAD_MAX_BYTES,
    timeoutMs: ZIP_DOWNLOAD_TIMEOUT_MS,
  });
  let currentUrl = input.url;
  let currentHeaders = input.headers;
  for (let redirectCount = 0; redirectCount <= ZIP_MAX_REDIRECTS; redirectCount += 1) {
    throwIfAborted(input.signal);
    validateZipDownloadUrl(currentUrl);
    const response = await client.request(
      {
        headers: currentHeaders,
        maxResponseBytes: ZIP_DOWNLOAD_MAX_BYTES,
        method: "GET",
        redirect: "manual",
        url: currentUrl,
      },
      { signal: input.signal },
    );

    if (isRedirectStatus(response.status)) {
      const location = response.headers.location;
      if (!location) {
        throw new Error(`Plugin zip download redirect is missing Location header: ${currentUrl}`);
      }
      const redirectUrl = new URL(location, currentUrl);
      // 跨 CDN origin 继续发送 marketplace 自定义 header 会把内部元数据泄露给跳转目标。
      if (redirectUrl.origin !== new URL(currentUrl).origin) {
        currentHeaders = undefined;
      }
      currentUrl = redirectUrl.toString();
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new PluginZipDownloadError(
        `Failed to download plugin zip: ${response.status} ${response.statusText}`,
        currentUrl,
        response.status,
      );
    }
    return response.body;
  }
  throw new Error(`Plugin zip download exceeded redirect limit: ${input.url}`);
}

function resolveZipRoot(input: {
  extractRoot: string;
  path?: string;
  requireSingleRoot?: boolean;
  stripRoot?: boolean;
  topLevelSegments: Set<string>;
}): string {
  const extractRoot = resolve(input.extractRoot);
  if (input.requireSingleRoot && input.topLevelSegments.size !== 1) {
    throw new Error(
      `Plugin zip must contain exactly one top-level directory: ${input.topLevelSegments.size}`,
    );
  }
  if (input.path !== undefined) {
    const requested = resolveZipPathWithin(extractRoot, normalizeZipRelativePath(input.path));
    if (!directoryExists(requested)) {
      throw new Error(`Plugin zip source subdirectory does not exist: ${input.path}`);
    }
    return requested;
  }

  if (hasPluginManifest(extractRoot)) {
    return extractRoot;
  }

  if (input.stripRoot !== false && input.topLevelSegments.size === 1) {
    const [segment] = [...input.topLevelSegments];
    if (segment) {
      const candidate = resolveZipPathWithin(extractRoot, segment);
      if (directoryExists(candidate)) return candidate;
    }
  }

  if (!directoryExists(extractRoot)) {
    throw new Error("Plugin zip did not extract a plugin root directory");
  }
  return extractRoot;
}

function hasPluginManifest(rootPath: string): boolean {
  // 候选集与优先级见 specs/plugin-foreign-manifest-compat.md（所有发现点必须一致）。
  return (
    fileExists(join(rootPath, ".acode-plugin", "plugin.json")) ||
    fileExists(join(rootPath, ".claude-plugin", "plugin.json")) ||
    fileExists(join(rootPath, ".codex-plugin", "plugin.json")) ||
    fileExists(join(rootPath, ".cursor-plugin", "plugin.json"))
  );
}

function normalizeZipRelativePath(path: string): string {
  if (path.includes("\0")) {
    throw new Error(`Unsafe plugin zip path: ${path}`);
  }
  const withoutTrailingSlash = path.replace(/\/+$/u, "");
  if (
    !withoutTrailingSlash ||
    path.includes("\\") ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    /^[a-zA-Z]:/u.test(path)
  ) {
    throw new Error(`Unsafe plugin zip path: ${path}`);
  }
  const parts = withoutTrailingSlash.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe plugin zip path: ${path}`);
  }
  return withoutTrailingSlash;
}

function resolveZipPathWithin(rootPath: string, relativePath: string): string {
  const root = resolve(rootPath);
  const target = resolve(root, ...relativePath.split("/"));
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Unsafe plugin zip path: ${relativePath}`);
  }
  return target;
}

function validateZipHeaders(headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const [key, value] of Object.entries(headers)) {
    if (ZIP_DENIED_HEADERS.has(key.toLowerCase())) {
      throw new Error(`Plugin zip source header is not allowed: ${key}`);
    }
    if (typeof value !== "string") {
      throw new Error(`Plugin zip source header must be a string: ${key}`);
    }
  }
}

function validateZipDownloadUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Plugin zip source URL is invalid: ${value}`);
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
  throw new Error(`Plugin zip source URL must be HTTPS: ${value}`);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    isIpv4LoopbackHost(normalized)
  );
}

function isIpv4LoopbackHost(hostname: string): boolean {
  const match = /^127(?:\.(\d{1,3})){3}$/u.exec(hostname);
  if (!match) return false;
  return hostname
    .split(".")
    .every((part) => Number.parseInt(part, 10) >= 0 && Number.parseInt(part, 10) <= 255);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("Plugin operation cancelled");
    error.name = "AbortError";
    throw error;
  }
}
