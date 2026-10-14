/**
 * Native addon 加载器（specs/windows-helper-producer.md §2.1/§2.7/§3.4/§4.1）。
 *
 * 路径只取自 ACODE_CUA_HELPER_ADDON（唯一来源，不回退契约相对路径——回退会让宿主接线
 * 错误被静默掩盖）；经 createRequire 以绝对路径加载（§1.1 解析隔离的来源③：禁止裸包名）。
 * 任何加载/形状校验失败都返回显式失败类别，由 entry 按 §2.7 报 error 并以 exit 2 退出——
 * 绝不降级为「无 addon 模式」继续跑（§3.4 C12 语义 / 能力真实性红线）。
 */
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

import { HELPER_ADDON_ENV } from "./control-protocol.js";

/** probe() 返回形态（§4.1 精确签名）：napiVersion = 编译期 NAPI_VERSION 宏值（§4.4 防漂移锚）。 */
export interface AxNativeProbeResult {
  ok: true;
  napiVersion: number;
}

/**
 * addon 导出面（§4.1 A1 核心两项 + A2 导出经索引签名取用）。
 * 加载校验只钉 A1 核心（addonVersion + probe 回读）——A2 导出的在场性由
 * native-driver.ts 以 typeof 检查推导 capabilities（§10.9「导出在场性」判据），
 * 缺失导出 = 能力诚实降级（capabilities=false → 对应方法不注册 → unimplemented），
 * 绝不是加载失败（A1 形态 addon 仍可诚实服务 health/A1 面）。
 */
export interface AxNativeAddon {
  readonly addonVersion: string;
  probe(): AxNativeProbeResult;
  readonly [exportName: string]: unknown;
}

/** 失败类别对应 §2.7 封闭表的两行（均 exit 2）。 */
export type NativeLoadFailure = "native-addon-env-missing" | "native-addon-load-failed";

export type NativeLoadOutcome =
  | { ok: true; addon: AxNativeAddon }
  | { ok: false; failure: NativeLoadFailure };

/**
 * 加载并校验 addon。同步函数：加载校验路径上只调用一次（§4.1 probe 同步例外同理），
 * 失败不抛——返回显式类别，错误细节（可能含路径/系统文本）绝不外泄进 IPC/日志（§3.2）。
 */
export function loadNativeAddon(env: NodeJS.ProcessEnv): NativeLoadOutcome {
  const configured = env[HELPER_ADDON_ENV];
  if (typeof configured !== "string" || configured.trim().length === 0) {
    return { ok: false, failure: "native-addon-env-missing" };
  }
  // 非绝对路径 = 宿主接线错误（§1.1 只允许绝对路径加载），诚实失败、不猜解析基准。
  if (!isAbsolute(configured)) {
    return { ok: false, failure: "native-addon-load-failed" };
  }
  let loaded: unknown;
  try {
    loaded = createRequire(import.meta.url)(configured);
  } catch {
    // SAC 拦截 / ABI 不符 / 文件损坏 / 路径不存在——共用同一稳定类别（§2.7/§3.4）；
    // 不重试绕过、不提示关系统安全策略、不静默降级。
    return { ok: false, failure: "native-addon-load-failed" };
  }
  if (!isHonestAddon(loaded)) {
    // 可 require ≠ 诚实 addon：形状不符（缺导出/probe 失败）同样按加载失败处理。
    return { ok: false, failure: "native-addon-load-failed" };
  }
  return { ok: true, addon: loaded };
}

/** §4.1 导出面形状校验 + probe 同步回读（存在意义 =「可构建、可加载、可调用、诚实」）。 */
function isHonestAddon(value: unknown): value is AxNativeAddon {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AxNativeAddon>;
  if (typeof candidate.addonVersion !== "string" || candidate.addonVersion.length === 0) {
    return false;
  }
  if (typeof candidate.probe !== "function") return false;
  let probeResult: unknown;
  try {
    probeResult = candidate.probe();
  } catch {
    return false;
  }
  if (!probeResult || typeof probeResult !== "object") return false;
  const result = probeResult as Partial<AxNativeProbeResult>;
  return (
    result.ok === true && Number.isInteger(result.napiVersion) && (result.napiVersion as number) > 0
  );
}
