/**
 * C14 三平台判定矩阵（矩阵 3）：第四处 display schema 受理矩阵。
 * 依据 = cua-producer/specs/windows-helper-producer.md §12.6 文件 3 与 §12.2（oQ13 裁决）：
 * - cuaRequestAccessStatusDisplaySchema（tool-result-metadata.ts:46-54）与 v4
 *   cuaPermission.ts 同批扩为 darwin|win32；win32 通过、darwin 回归、linux 拒绝。
 * - 不扩则 Windows 状态在 display 投影层 safeParse 失败 → permissionStatus 字段静默缺席
 *   （「静默降级」形态）；本矩阵含 payload 级受理，防「v4 受理、display 拒绝」半闭状态。
 * - iconLocators 形态不变（platform 扩面不触碰应用图标定位器词汇）。
 * 导入纪律：contracts TS 源深导入，先例 = cua-producer-a3-logic.test.mjs 对
 * tool-result-metadata.ts 的 pathToFileURL 深导入（tsx loader，node --import tsx --test）。
 */
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const { cuaRequestAccessStatusDisplaySchema, cuaTargetAppDisplaySchema, cuaToolResultDisplayPayloadSchema } =
  await import(
    pathToFileURL(
      join(repoRoot, "apps", "acode-cli", "packages", "contracts", "src", "tools", "tool-result-metadata.ts"),
    ).href
  );

function baseStatus(platform) {
  return {
    schemaVersion: 1,
    platform,
    grantOwner: platform === "darwin" ? "com.acode.cua-helper" : "C:\\ACode\\ACode.exe",
    accessibility: "granted",
    screenRecording: "granted",
  };
}

const ACCESSIBILITY_VALUES = ["granted", "stale", "denied"];
const SCREEN_RECORDING_VALUES = ["granted", "denied", "unknown"];

// darwin 全形态 = macOS 回归锚；win32 全形态 = 本批扩面受理证据（§12.6 同矩阵）。
for (const platform of ["darwin", "win32"]) {
  for (const accessibility of ACCESSIBILITY_VALUES) {
    test(`display schema：platform=${platform} accessibility=${accessibility} 通过`, () => {
      const input = { ...baseStatus(platform), accessibility };
      const parsed = cuaRequestAccessStatusDisplaySchema.safeParse(input);
      assert.equal(parsed.success, true, `输入 ${JSON.stringify(input)} 应通过受理`);
    });
  }
  for (const screenRecording of SCREEN_RECORDING_VALUES) {
    test(`display schema：platform=${platform} screenRecording=${screenRecording} 通过`, () => {
      const input = { ...baseStatus(platform), screenRecording };
      const parsed = cuaRequestAccessStatusDisplaySchema.safeParse(input);
      assert.equal(parsed.success, true, `输入 ${JSON.stringify(input)} 应通过受理`);
    });
  }

  test(`display schema：platform=${platform} strict 未知键拒绝`, () => {
    const input = { ...baseStatus(platform), unexpectedKey: "x" };
    const parsed = cuaRequestAccessStatusDisplaySchema.safeParse(input);
    assert.equal(parsed.success, false, `输入 ${JSON.stringify(input)} 含未知键应被拒绝`);
  });

  // payload 级：CUA display payload 的 permissionStatus（tool-result-metadata.ts:130 消费口）
  // 对 win32 状态整体受理，防「v4 受理、display 拒绝」的半闭状态（§12.2 oQ13）。
  test(`display payload：permissionStatus platform=${platform} 整体受理`, () => {
    const input = {
      kind: "cua",
      schemaVersion: 1,
      toolName: "request_access",
      status: "success",
      permissionStatus: baseStatus(platform),
    };
    const parsed = cuaToolResultDisplayPayloadSchema.safeParse(input);
    assert.equal(
      parsed.success,
      true,
      `输入 ${JSON.stringify(input)} 应在 payload 级通过受理（permissionStatus 不得静默缺席）`,
    );
  });
}

test('display schema：platform="linux" 拒绝（联合只收 darwin|win32）', () => {
  const input = { ...baseStatus("darwin"), platform: "linux" };
  const parsed = cuaRequestAccessStatusDisplaySchema.safeParse(input);
  assert.equal(parsed.success, false, `输入 ${JSON.stringify(input)} 应被拒绝`);
});

test('display schema：platform="win32 "（带空格）拒绝（精确成员，不做 trim）', () => {
  const input = { ...baseStatus("win32"), platform: "win32 " };
  const parsed = cuaRequestAccessStatusDisplaySchema.safeParse(input);
  assert.equal(parsed.success, false, `输入 ${JSON.stringify(input)} 应被拒绝`);
});

// iconLocators 形态不变：platform 扩面不触碰应用图标定位器三词汇（darwin-bundle-id /
// windows-executable-path / windows-aumid），未知 kind 仍拒绝。
const ICON_LOCATOR_SAMPLES = [
  { kind: "darwin-bundle-id", value: "com.apple.finder" },
  { kind: "windows-executable-path", value: "C:\\Windows\\explorer.exe" },
  { kind: "windows-aumid", value: "Microsoft.Windows.Explorer" },
];

for (const locator of ICON_LOCATOR_SAMPLES) {
  test(`iconLocators 形态不变：kind=${locator.kind} 通过`, () => {
    const input = { schemaVersion: 1, iconLocators: [locator] };
    const parsed = cuaTargetAppDisplaySchema.safeParse(input);
    assert.equal(parsed.success, true, `输入 ${JSON.stringify(input)} 应通过受理`);
  });
}

test("iconLocators 形态不变：未知 kind 拒绝", () => {
  const input = { schemaVersion: 1, iconLocators: [{ kind: "linux-desktop-file", value: "x.desktop" }] };
  const parsed = cuaTargetAppDisplaySchema.safeParse(input);
  assert.equal(parsed.success, false, `输入 ${JSON.stringify(input)} 未知定位器 kind 应被拒绝`);
});
