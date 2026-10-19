// 更新恢复诊断通知的视图模型映射（desktop/specs/update-recovery-notice.md R4/R5）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveUpdateStatusViewModel } from "../src/updateStatusModel.js";
import type { UpdateStatePayload } from "@acode/shared";

const RECOVERY_RETRY: UpdateStatePayload = {
  kind: "install-recovery",
  enabled: true,
  outcome: "install-not-effective",
  fingerprint: "version-unchanged",
  fromVersion: "1.0.0",
  toVersion: "1.0.1",
  retryAvailable: true,
  exitSweepHandoff: "pending",
};

const RECOVERY_NOTICE_ONLY: UpdateStatePayload = {
  kind: "install-recovery",
  enabled: true,
  outcome: "stale-pending-cleared",
  fingerprint: "version-unchanged",
  fromVersion: "1.0.0",
  toVersion: "1.0.1",
  retryAvailable: false,
};

test("install-recovery + retryAvailable：ready 语义与 update-downloaded 同级", () => {
  const model = deriveUpdateStatusViewModel({
    legacyReadyVersion: null,
    updateState: RECOVERY_RETRY,
  });
  assert.equal(model.displayVersion, "1.0.1");
  assert.equal(model.dialogPhase, "downloaded");
  assert.ok(model.recoveryNotice);
  assert.equal(model.recoveryNotice.outcome, "install-not-effective");
  assert.equal(model.recoveryNotice.fingerprint, "version-unchanged");
  assert.equal(model.recoveryNotice.retryAvailable, true);
  assert.equal(model.recoveryNotice.exitSweepHandoff, "pending");
  // 不可跳过/无渠道字段（恢复通知没有 skip 语义）。
  assert.equal(model.skippableVersion, null);
  assert.equal(model.updateChannel, undefined);
});

test("install-recovery 通知形态（不可重试）：以 toVersion 撑起入口，phase=before-download", () => {
  const model = deriveUpdateStatusViewModel({
    legacyReadyVersion: null,
    updateState: RECOVERY_NOTICE_ONLY,
  });
  assert.equal(model.displayVersion, "1.0.1");
  assert.equal(model.dialogPhase, "before-download");
  assert.ok(model.recoveryNotice);
  assert.equal(model.recoveryNotice.outcome, "stale-pending-cleared");
  assert.equal(model.recoveryNotice.retryAvailable, false);
  assert.equal(model.recoveryNotice.exitSweepHandoff, undefined);
});

test("verification-failed / version-diverged 形态映射", () => {
  const failed = deriveUpdateStatusViewModel({
    legacyReadyVersion: null,
    updateState: {
      kind: "install-recovery",
      enabled: true,
      outcome: "verification-failed",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
      retryAvailable: false,
    },
  });
  assert.equal(failed.recoveryNotice?.outcome, "verification-failed");
  assert.equal(failed.dialogPhase, "before-download");

  const diverged = deriveUpdateStatusViewModel({
    legacyReadyVersion: null,
    updateState: {
      kind: "install-recovery",
      enabled: true,
      outcome: "install-not-effective",
      fingerprint: "version-diverged",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
      retryAvailable: false,
    },
  });
  assert.equal(diverged.recoveryNotice?.fingerprint, "version-diverged");
});

test("既有 kind 零回归：update-downloaded ready、idle 无通知、legacy 缓存语义不变", () => {
  const downloaded = deriveUpdateStatusViewModel({
    legacyReadyVersion: null,
    updateState: { kind: "update-downloaded", enabled: true, version: "2.0.0" },
  });
  assert.equal(downloaded.displayVersion, "2.0.0");
  assert.equal(downloaded.dialogPhase, "downloaded");
  assert.equal(downloaded.recoveryNotice, null);

  const idle = deriveUpdateStatusViewModel({
    legacyReadyVersion: null,
    updateState: { kind: "idle", enabled: true },
  });
  assert.equal(idle.displayVersion, null);
  assert.equal(idle.recoveryNotice, null);

  // legacy UpdateReady 缓存仅在无新状态时撑 ready（既有语义）。
  const legacyOnly = deriveUpdateStatusViewModel({
    legacyReadyVersion: "0.9.0",
    updateState: null,
  });
  assert.equal(legacyOnly.displayVersion, "0.9.0");
  assert.equal(legacyOnly.dialogPhase, "downloaded");
});
