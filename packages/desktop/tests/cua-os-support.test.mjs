/**
 * C14 三平台判定矩阵（矩阵 1）：resolveCuaOsSupport 纯函数矩阵。
 * 依据 = cua-producer/specs/windows-helper-producer.md §12.6 文件 1 与 §12.3 单一地板裁决：
 * - Windows 地板 = Win10 1809（build 17763，WGC API 契约）；边界 17763/17762 分别断言。
 * - Win11 报告为 10.0.22000+，build 号逻辑对 Win10/Win11 统一（实测形态 10.0.26300）。
 * - NaN/垃圾版本按宽松方向 = supported（对齐 darwin 分支现行语义；真门槛是运行时
 *   preflight fail-closed，§10.9）。
 * - linux → not-applicable（C14 Linux 红线：不产生半成品路径）。
 * - darwin 全形态 = macOS 既有语义回归锚（红线 1：阶段 4 零改动 darwin 行为）。
 * 每行独立 test case，断言消息含输入（表驱动生成，非折叠单断言）。
 */
import assert from "node:assert/strict";
import { release } from "node:os";
import { test } from "node:test";

const { resolveCuaOsSupport } = await import("../src/main/cuaOsSupport.ts");

// 期望值 = spec §12.6 矩阵逐行照抄（deepStrictEqual 全对象比对，含地板字段值）。
const MATRIX = [
  {
    platform: "darwin",
    osRelease: "21.6.0",
    expected: { kind: "supported" },
    note: "macOS 12（Darwin 21）= 地板行，supported",
  },
  {
    platform: "darwin",
    osRelease: "20.6.0",
    expected: { kind: "macos-below-minimum", minimumMacOs: "12.0", currentMacOs: "11" },
    note: "macOS 11（Darwin 20）低于地板，darwin 回归锚",
  },
  {
    platform: "darwin",
    osRelease: "garbage",
    expected: { kind: "supported" },
    note: "NaN 宽松方向，darwin 现状语义回归锚",
  },
  {
    platform: "win32",
    osRelease: "10.0.26300",
    expected: { kind: "supported" },
    note: "Win11 实测形态（本机 os.release()）",
  },
  {
    platform: "win32",
    osRelease: "10.0.22000",
    expected: { kind: "supported" },
    note: "Win11 下界（第三段 ≥22000 即 Win11，逻辑与 Win10 统一）",
  },
  {
    platform: "win32",
    osRelease: "10.0.17763",
    expected: { kind: "supported" },
    note: "Windows 地板边界：Win10 1809 = build 17763，supported",
  },
  {
    platform: "win32",
    osRelease: "10.0.17762",
    expected: {
      kind: "windows-below-minimum",
      minimumWindowsBuild: 17763,
      currentWindowsBuild: 17762,
    },
    note: "Windows 地板边界 -1：17762 拒绝",
  },
  {
    platform: "win32",
    osRelease: "10.0.10240",
    expected: {
      kind: "windows-below-minimum",
      minimumWindowsBuild: 17763,
      currentWindowsBuild: 10240,
    },
    note: "Win10 1507 初版，远低于地板",
  },
  {
    platform: "win32",
    osRelease: "6.3.9600",
    expected: {
      kind: "windows-below-minimum",
      minimumWindowsBuild: 17763,
      currentWindowsBuild: 9600,
    },
    note: "Win8.1；纯函数不掺 Electron 地板事实（宿主跑不起来≠判定层特判）",
  },
  {
    platform: "win32",
    osRelease: "unparseable",
    expected: { kind: "supported" },
    note: "NaN 宽松方向；运行时 preflight 才是真门槛（§12.3）",
  },
  {
    platform: "linux",
    osRelease: "6.8.0",
    expected: { kind: "not-applicable" },
    note: "C14 Linux 红线：明确 not-applicable，不产生半成品路径",
  },
];

for (const row of MATRIX) {
  test(`resolveCuaOsSupport(${JSON.stringify(row.platform)}, ${JSON.stringify(row.osRelease)}) → ${row.expected.kind}（${row.note}）`, () => {
    const actual = resolveCuaOsSupport(row.platform, row.osRelease);
    assert.deepStrictEqual(
      actual,
      row.expected,
      `输入 platform=${row.platform} osRelease=${row.osRelease}：期望 ${JSON.stringify(row.expected)}，实际 ${JSON.stringify(actual)}`,
    );
  });
}

// 缺省参数路径：无参调用必须与显式 (process.platform, release()) 等价。
// 不硬编码 CI 平台（spec §12.6 矩阵最后一行：按宿主平台，不 stub 不注记跳过）。
test("resolveCuaOsSupport() 缺省路径 = 显式宿主平台调用（不硬编码 CI 平台）", () => {
  const hostRelease = release();
  const viaDefault = resolveCuaOsSupport();
  const viaExplicit = resolveCuaOsSupport(process.platform, hostRelease);
  assert.deepStrictEqual(
    viaDefault,
    viaExplicit,
    `宿主 platform=${process.platform} release=${hostRelease}：缺省路径 ${JSON.stringify(viaDefault)} ≠ 显式路径 ${JSON.stringify(viaExplicit)}`,
  );
});
