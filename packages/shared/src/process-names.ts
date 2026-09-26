const ACODE_PROCESS_PREFIX = "acode";
const MAX_PROCESS_NAME_SEGMENT_LENGTH = 24;

function sanitizeProcessNameSegment(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, MAX_PROCESS_NAME_SEGMENT_LENGTH);
}

function joinACodeProcessName(...segments: Array<string | null | undefined>): string {
  const sanitizedSegments = segments
    .map((segment) => sanitizeProcessNameSegment(segment))
    .filter((segment): segment is string => Boolean(segment));
  return [ACODE_PROCESS_PREFIX, ...sanitizedSegments].join("-");
}

function pickWorkspaceTag(workspacePath: string | null | undefined): string | undefined {
  const trimmedPath = workspacePath?.trim();
  if (!trimmedPath) {
    return undefined;
  }

  const parts = trimmedPath.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmedPath;
}

export function formatACodeMainProcessName(): string {
  return joinACodeProcessName("main");
}

export function formatACodeGpuProcessName(): string {
  return joinACodeProcessName("gpu");
}

export function formatACodeHostProcessName(label?: string): string {
  return joinACodeProcessName("host", label);
}

export function formatACodeRendererProcessName(windowTitle?: string): string {
  const normalizedTitle = windowTitle?.trim();
  if (!normalizedTitle || normalizedTitle === "ACode") {
    return joinACodeProcessName("renderer", "main");
  }

  if (normalizedTitle === "Resource Manager") {
    return joinACodeProcessName("renderer", "resource-manager");
  }

  const remoteWindowPrefix = "ACode - ";
  if (normalizedTitle.startsWith(remoteWindowPrefix)) {
    return joinACodeProcessName(
      "renderer",
      "remote",
      normalizedTitle.slice(remoteWindowPrefix.length),
    );
  }

  return joinACodeProcessName("renderer", normalizedTitle);
}

export function formatACodeAgentProcessName(provider: string, workspacePath?: string): string {
  return joinACodeProcessName("agent", provider, pickWorkspaceTag(workspacePath));
}

export function formatACodeUtilityProcessName(name?: string, type = "utility"): string {
  return joinACodeProcessName(type, name);
}
