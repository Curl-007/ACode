// ============================================================
// Provider Doctor 检查点记录器（J3-1 / spec R3 + R5）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// 12 个检查点的顺序、初始状态（skipped）与详情脱敏集中在这里：诊断主流程只调用
// `set/skip`，不再各自拼字符串，也就不会出现「某条详情绕过 redactor」的漏口。

import { PROVIDER_DOCTOR_CHECKPOINT_CATALOG } from "./checkpoints.js";
import type { ProviderDoctorRedactor } from "./redaction.js";
import type {
  ProviderDoctorCheckResult,
  ProviderDoctorCheckStatus,
  ProviderDoctorCheckpointId,
  ProviderDoctorTier,
} from "./types.js";

export interface ProviderDoctorCheckRecorder {
  set(
    id: ProviderDoctorCheckpointId,
    status: ProviderDoctorCheckStatus,
    detail: string,
    durationMs?: number,
  ): void;
  skip(id: ProviderDoctorCheckpointId, reason: string): void;
  statusOf(id: ProviderDoctorCheckpointId): ProviderDoctorCheckStatus | undefined;
  isPassed(id: ProviderDoctorCheckpointId): boolean;
  results(): readonly ProviderDoctorCheckResult[];
}

interface MutableCheckResult {
  readonly id: ProviderDoctorCheckpointId;
  readonly label: string;
  status: ProviderDoctorCheckStatus;
  detail: string;
  durationMs?: number;
}

export function createProviderDoctorCheckRecorder(
  tier: ProviderDoctorTier,
  redactor: ProviderDoctorRedactor,
): ProviderDoctorCheckRecorder {
  const checks: MutableCheckResult[] = PROVIDER_DOCTOR_CHECKPOINT_CATALOG.map((definition) => ({
    id: definition.id,
    label: definition.label,
    status: "skipped",
    detail: `${tier} 档不运行该检查点`,
  }));
  const byId = new Map<ProviderDoctorCheckpointId, MutableCheckResult>(
    checks.map((check) => [check.id, check]),
  );

  const set = (
    id: ProviderDoctorCheckpointId,
    status: ProviderDoctorCheckStatus,
    detail: string,
    durationMs?: number,
  ): void => {
    const check = byId.get(id);
    if (!check) return;
    check.status = status;
    check.detail = redactor.redact(detail);
    if (durationMs !== undefined) check.durationMs = durationMs;
  };

  return {
    set,
    skip: (id, reason) => set(id, "skipped", reason),
    statusOf: (id) => byId.get(id)?.status,
    isPassed: (id) => byId.get(id)?.status === "passed",
    results: () =>
      checks.map((check) =>
        Object.freeze({
          id: check.id,
          label: check.label,
          status: check.status,
          detail: check.detail,
          ...(check.durationMs !== undefined ? { durationMs: check.durationMs } : {}),
        }),
      ),
  };
}
