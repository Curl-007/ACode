/**
 * C14 三平台判定矩阵（矩阵 2）：v4 cuaRequestAccessStatusSchema 受理矩阵。
 * 依据 = cua-producer/specs/windows-helper-producer.md §12.6 文件 2 与 §12.2：
 * - darwin 现值全形态通过（macOS 回归红线锚：accessibility 三值、screenRecording 三值、
 *   strict 未知键拒绝、grantOwner 非空）。
 * - win32 全形态通过（阶段 4 accept-widening 的受理面证据）。
 * - platform:"linux" / "darwin "（带空格）拒绝——联合只收 darwin|win32 两个精确成员。
 * - requiredCuaPermissionsForRequestAccessStatus 对 darwin/win32 同值输入行为一致
 *   （函数零改动的回归锚，§12.2）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cuaRequestAccessStatusSchema,
  requiredCuaPermissionsForRequestAccessStatus,
} from "../src/acode-protocol-v4/cuaPermission.js";

type Platform = "darwin" | "win32";

const ACCESSIBILITY_VALUES = ["granted", "stale", "denied"] as const;
const SCREEN_RECORDING_VALUES = ["granted", "denied", "unknown"] as const;

function baseStatus(platform: Platform) {
  return {
    schemaVersion: 1 as const,
    platform,
    grantOwner: platform === "darwin" ? "com.acode.cua-helper" : "C:\\ACode\\ACode.exe",
    accessibility: "granted" as const,
    screenRecording: "granted" as const,
  };
}

for (const platform of ["darwin", "win32"] as const) {
  // 每行独立断言且断言消息含输入（darwin 行同时是 macOS 回归红线锚）。
  for (const accessibility of ACCESSIBILITY_VALUES) {
    test(`platform=${platform} accessibility=${accessibility} 受理通过`, () => {
      const input = { ...baseStatus(platform), accessibility };
      const parsed = cuaRequestAccessStatusSchema.safeParse(input);
      assert.equal(parsed.success, true, `输入 ${JSON.stringify(input)} 应通过受理`);
    });
  }
  for (const screenRecording of SCREEN_RECORDING_VALUES) {
    test(`platform=${platform} screenRecording=${screenRecording} 受理通过`, () => {
      const input = { ...baseStatus(platform), screenRecording };
      const parsed = cuaRequestAccessStatusSchema.safeParse(input);
      assert.equal(parsed.success, true, `输入 ${JSON.stringify(input)} 应通过受理`);
    });
  }

  test(`platform=${platform} strict 未知键拒绝（.strict() 不随扩面放松）`, () => {
    const input = { ...baseStatus(platform), unexpectedKey: "x" };
    const parsed = cuaRequestAccessStatusSchema.safeParse(input);
    assert.equal(parsed.success, false, `输入 ${JSON.stringify(input)} 含未知键应被拒绝`);
  });

  test(`platform=${platform} grantOwner 空串拒绝（非空约束不随扩面放松）`, () => {
    const input = { ...baseStatus(platform), grantOwner: "" };
    const parsed = cuaRequestAccessStatusSchema.safeParse(input);
    assert.equal(parsed.success, false, `输入 ${JSON.stringify(input)} grantOwner 空串应被拒绝`);
  });
}

test('platform="linux" 拒绝（联合只收 darwin|win32，C14 linux not-applicable）', () => {
  const input = { ...baseStatus("darwin"), platform: "linux" };
  const parsed = cuaRequestAccessStatusSchema.safeParse(input);
  assert.equal(parsed.success, false, `输入 ${JSON.stringify(input)} 应被拒绝`);
});

test('platform="darwin "（带空格）拒绝（精确成员，不做 trim）', () => {
  const input = { ...baseStatus("darwin"), platform: "darwin " };
  const parsed = cuaRequestAccessStatusSchema.safeParse(input);
  assert.equal(parsed.success, false, `输入 ${JSON.stringify(input)} 应被拒绝`);
});

// 推导函数零改动回归锚：同值输入在 darwin/win32 上结果必须一致（§12.2「行为一致」）。
const REQUIRED_CASES = [
  {
    accessibility: "denied",
    screenRecording: "denied",
    expected: ["accessibility", "screen_recording"],
  },
  { accessibility: "stale", screenRecording: "granted", expected: ["accessibility"] },
  { accessibility: "denied", screenRecording: "unknown", expected: ["accessibility"] },
  { accessibility: "granted", screenRecording: "denied", expected: ["screen_recording"] },
  { accessibility: "granted", screenRecording: "unknown", expected: [] },
  { accessibility: "granted", screenRecording: "granted", expected: [] },
] as const;

for (const row of REQUIRED_CASES) {
  test(`requiredCuaPermissions 一致性：accessibility=${row.accessibility} screenRecording=${row.screenRecording} → [${row.expected.join(", ")}]（darwin/win32 同值）`, () => {
    const darwinResult = requiredCuaPermissionsForRequestAccessStatus({
      ...baseStatus("darwin"),
      accessibility: row.accessibility,
      screenRecording: row.screenRecording,
    });
    const win32Result = requiredCuaPermissionsForRequestAccessStatus({
      ...baseStatus("win32"),
      accessibility: row.accessibility,
      screenRecording: row.screenRecording,
    });
    assert.deepStrictEqual(
      darwinResult,
      [...row.expected],
      `darwin 输入 accessibility=${row.accessibility} screenRecording=${row.screenRecording}`,
    );
    assert.deepStrictEqual(
      win32Result,
      darwinResult,
      `win32 与 darwin 同值输入（accessibility=${row.accessibility} screenRecording=${row.screenRecording}）行为必须一致`,
    );
  });
}
