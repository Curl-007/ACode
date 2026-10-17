// server-cli↔desktop 版本兼容窗（部署补强）。
// 规格见 packages/server/specs/remote-deploy-hardening.md R2。
//
// manifest 可选 compat 字段由发布管线产出（登记项）；desktop 部署路径读取时
// 做防御性解析，形状不符按未声明处理。硬窗（min/max）窗外拒绝部署；
// testedVersions 未命中只 warn（未测试 ≠ 不兼容）；未声明放行。

export interface RemoteAssetManifestCompatWindow {
  /** 兼容窗声明自身的 schema 版本；未来字段演进用。 */
  schemaVersion?: number;
  /** 该 server 资产测过的 desktop 版本列表（advisory）。 */
  testedVersions?: string[];
  /** 兼容的最低 desktop 版本（含）。 */
  minDesktopVersion?: string;
  /** 兼容的最高 desktop 版本（含）。 */
  maxDesktopVersion?: string;
}

export type RemoteServerCompatVerdict =
  | { readonly status: "compatible" }
  | { readonly status: "out_of_window"; readonly message: string }
  | { readonly status: "untested_warning"; readonly message: string }
  | { readonly status: "undeclared" };

export class RemoteServerCompatError extends Error {
  readonly code = "remote-server-compat-out-of-window" as const;

  constructor(message: string) {
    super(message);
    this.name = "RemoteServerCompatError";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 防御性解析 manifest.compat；任何形状不符都按未声明处理（老 manifest 兼容）。 */
export function parseRemoteAssetManifestCompatWindow(
  manifest: unknown,
): RemoteAssetManifestCompatWindow | undefined {
  if (typeof manifest !== "object" || manifest === null) {
    return undefined;
  }
  const raw = (manifest as { compat?: unknown }).compat;
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  const window: RemoteAssetManifestCompatWindow = {};
  if (typeof candidate["schemaVersion"] === "number") {
    window.schemaVersion = candidate["schemaVersion"];
  }
  if (
    Array.isArray(candidate["testedVersions"]) &&
    candidate["testedVersions"].every(isNonEmptyString)
  ) {
    window.testedVersions = candidate["testedVersions"] as string[];
  }
  if (isNonEmptyString(candidate["minDesktopVersion"])) {
    window.minDesktopVersion = candidate["minDesktopVersion"];
  }
  if (isNonEmptyString(candidate["maxDesktopVersion"])) {
    window.maxDesktopVersion = candidate["maxDesktopVersion"];
  }
  const hasAnyField =
    window.schemaVersion !== undefined ||
    window.testedVersions !== undefined ||
    window.minDesktopVersion !== undefined ||
    window.maxDesktopVersion !== undefined;
  return hasAnyField ? window : undefined;
}

function splitPrerelease(version: string): [string, string | undefined] {
  const trimmed = version.trim();
  const dashIndex = trimmed.indexOf("-");
  if (dashIndex < 0) {
    return [trimmed, undefined];
  }
  return [trimmed.slice(0, dashIndex), trimmed.slice(dashIndex + 1)];
}

function compareCoreParts(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i += 1) {
    const leftValue = Number.parseInt(leftParts[i] ?? "0", 10);
    const rightValue = Number.parseInt(rightParts[i] ?? "0", 10);
    const leftNumber = Number.isFinite(leftValue) ? leftValue : 0;
    const rightNumber = Number.isFinite(rightValue) ? rightValue : 0;
    if (leftNumber !== rightNumber) {
      return leftNumber < rightNumber ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 点分版本比较：核心段数值比较；核心相同时 prerelease < 正式版
 * （1.0.0-rc.1 < 1.0.0），两个 prerelease 之间按字典序。
 */
export function compareDottedVersions(left: string, right: string): number {
  const [leftCore, leftPre] = splitPrerelease(left);
  const [rightCore, rightPre] = splitPrerelease(right);
  const coreResult = compareCoreParts(leftCore, rightCore);
  if (coreResult !== 0) {
    return coreResult;
  }
  if (leftPre === undefined && rightPre === undefined) {
    return 0;
  }
  if (leftPre === undefined) {
    return 1;
  }
  if (rightPre === undefined) {
    return -1;
  }
  if (leftPre === rightPre) {
    return 0;
  }
  return leftPre < rightPre ? -1 : 1;
}

export function assessRemoteServerCompat(params: {
  currentVersion: string;
  compatWindow?: RemoteAssetManifestCompatWindow;
}): RemoteServerCompatVerdict {
  const compatWindow = params.compatWindow;
  if (!compatWindow) {
    return { status: "undeclared" };
  }

  const { minDesktopVersion, maxDesktopVersion } = compatWindow;
  if (minDesktopVersion && compareDottedVersions(params.currentVersion, minDesktopVersion) < 0) {
    return {
      status: "out_of_window",
      message: `远端资产 manifest 声明的兼容窗为 [${minDesktopVersion} .. ${maxDesktopVersion ?? "*"}]，当前 ACode 版本 ${params.currentVersion} 低于窗口下限；拒绝部署，请升级 ACode 桌面端。`,
    };
  }
  if (maxDesktopVersion && compareDottedVersions(params.currentVersion, maxDesktopVersion) > 0) {
    return {
      status: "out_of_window",
      message: `远端资产 manifest 声明的兼容窗为 [${minDesktopVersion ?? "*"} .. ${maxDesktopVersion}]，当前 ACode 版本 ${params.currentVersion} 超出窗口上限；拒绝部署，该远端资产与当前桌面端不兼容。`,
    };
  }

  const testedVersions = compatWindow.testedVersions;
  if (
    testedVersions &&
    testedVersions.length > 0 &&
    !testedVersions.includes(params.currentVersion)
  ) {
    return {
      status: "untested_warning",
      message: `当前 ACode 版本 ${params.currentVersion} 不在远端资产 manifest 的 testedVersions（${testedVersions.join(", ")}）内；未测试不等于不兼容，继续部署。`,
    };
  }

  return { status: "compatible" };
}
