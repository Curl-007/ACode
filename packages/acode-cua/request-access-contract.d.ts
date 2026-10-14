export declare const CUA_REQUEST_ACCESS_STATUS_META_KEY: string;

export interface CuaRequestAccessStatus {
  schemaVersion: 1;
  // 阶段 4（specs/windows-helper-producer.md §12.1）：类型字面量扩为联合（accept-widening）。
  // darwin 既有值域不变；win32 为未来 Windows producer 状态（§10.9 request_access）提供合法形态。
  platform: "darwin" | "win32";
  grantOwner: string;
  accessibility: "granted" | "stale" | "denied";
  screenRecording: "unknown" | "granted" | "denied";
}

export interface CuaRequestAccessStatusSchema {
  safeParse(
    input: unknown,
  ): { success: true; data: CuaRequestAccessStatus } | { success: false; error: Error };
}

export declare const cuaRequestAccessStatusSchema: CuaRequestAccessStatusSchema;
