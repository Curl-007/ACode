import { release } from "node:os";
import type { CuaOsSupport } from "@acode/shared";

// 承诺地板 = max(Helper Info.plist LSMinimumSystemVersion 12.0, SEA 二进制 minos 11.0)。
// 2026-08 事故：地板检查缺位时，低版本 macOS 用户只看到授权反复无响应
// （真因是 LaunchServices -10825 拒启 Helper）。
const CUA_MINIMUM_MACOS_VERSION = "12.0";
// 地板与上游 acode-cua helperAppBundle.ts 的 Info.plist LSMinimumSystemVersion(12.0) 联动，
// bump 任一侧必须同步其余常量。
const CUA_MINIMUM_DARWIN_MAJOR = 21; // Darwin major - 9 = macOS major（21↔12, 22↔13）

// Windows 单一地板 = Win10 1809（build 17763），依据 = WGC（Windows.Graphics.Capture）
// API 契约（GraphicsCaptureItem 属 UniversalApiContract 7.0，1809 引入）；截图是 WGC
// 唯一合法路径（无 fallback），低版本上不存在合法截图实现 → 诚实整体拒绝，不产出
// 「UIA 可用、截图不可用」的半成品路径（specs/windows-helper-producer.md §12.3 裁决）。
// Win11 报告为 10.0.22000+，build 号逻辑对 Win10/Win11 统一，无需特判。
const CUA_MINIMUM_WINDOWS_BUILD = 17_763;

function darwinMajorToMacosMajor(major: number): number {
  return major - 9;
}

export function resolveCuaOsSupport(
  platform = process.platform,
  // 第二参从 darwinRelease 泛化为 osRelease（darwin/win32 共用注入点，测试可注入口径不变）。
  osRelease = release(),
): CuaOsSupport {
  if (platform === "win32") {
    // os.release() 在 Windows 返回 "10.0.26300" 形态，第三段是 build 号。
    const build = Number.parseInt(osRelease.split(".")[2] ?? "", 10);
    // NaN 宽松方向对齐 darwin 分支现行语义：真门槛是运行时 preflight fail-closed（§10.9），
    // 静态判定不承担安全。
    if (Number.isNaN(build)) return { kind: "supported" };
    if (build < CUA_MINIMUM_WINDOWS_BUILD) {
      return {
        kind: "windows-below-minimum",
        minimumWindowsBuild: CUA_MINIMUM_WINDOWS_BUILD,
        currentWindowsBuild: build,
      };
    }
    return { kind: "supported" };
  }
  // linux/其它：现状零改动（C14 Linux not-applicable 红线）。
  if (platform !== "darwin") return { kind: "not-applicable" };
  // darwin 分支现状逐字保留（红线 1：macOS 既有语义零改动）。
  const major = Number.parseInt(osRelease.split(".")[0] ?? "0", 10);
  if (Number.isNaN(major)) return { kind: "supported" };
  if (major < CUA_MINIMUM_DARWIN_MAJOR) {
    return {
      kind: "macos-below-minimum",
      minimumMacOs: CUA_MINIMUM_MACOS_VERSION,
      currentMacOs: String(darwinMajorToMacosMajor(major)),
    };
  }
  return { kind: "supported" };
}
