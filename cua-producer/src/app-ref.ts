/**
 * app_ref 全形态解析（specs/windows-helper-producer.md §11.3——A3 收口 §10.9 的 A2
 * pid-only 限制）。纯 TS + 注入 driver（§10.11 模块规则①）：解析素材只来自
 * listApplications（native 枚举的 canonical 事实）与 processExecutablePath（pid 存活 +
 * canonical exe 可读），本模块绝不自行猜测。
 *
 * 裁决纪律（§11.3 钉死）：
 * - 组合形态须一致：pid 与 bundle_id/name 的解析结果冲突 → invalid_request（appRefMultiple
 *   字面量），绝不择一；
 * - 唯一候选：0 候选 → 「target app is not running」字面量（含 SDK isAppNotFound 兼容
 *   子串——该子串是 SDK alternateAppRef 换字段重试的触发器，字面量改动须两侧同审）；
 *   ≥2 候选 → invalid_request（"…pass a pid."），绝不猜 active、绝不取枚举第一个；
 * - identity 展示与解析分离：解析只用 pid/exe_path/AUMID（canonical 身份）；本地化
 *   display name 只服务展示（_meta/树文本头部）。
 */
import type { CuaNativeDriver, CuaUiaDriver } from "./driver-contract.js";
import type { ParsedAppRef } from "./param-validation.js";
import { exeBasename } from "./tree-text.js";
import { WIRE_ERROR_MESSAGES, WireRequestFailure } from "./wire-server.js";

/** 解析成功的 canonical 身份（展示字段只服务 _meta/树头部，绝不参与派发判定）。 */
export interface AppIdentity {
  pid: number;
  exePath: string;
  aumid: string | null;
  displayName: string | null;
}

export interface AppRefResolverDeps {
  driver: CuaNativeDriver;
  uia: CuaUiaDriver;
}

export type AppRefResolver = (ref: ParsedAppRef) => Promise<AppIdentity>;

/** NTFS 语义的路径规范化比较（大小写不敏感 + 分隔符归一，§11.3 bundle_id 第二判据）。 */
function sameCanonicalPath(a: string, b: string): boolean {
  return a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
}

/**
 * 构造 app_ref 解析器（entry 组装期创建、注入两个 backend——A2 handler 的 name/bundle_id
 * 形态自 A3 起同样走全解析，§11.3「A3 收口 §10.9 的 A2 限制」）。
 */
export function createAppRefResolver(deps: AppRefResolverDeps): AppRefResolver {
  const { driver, uia } = deps;

  /** bundle_id：先 AUMID 精确匹配，再 canonical exe 全路径匹配（§11.3 解析顺序 2）。 */
  const candidatesByBundleId = async (
    bundleId: string,
  ): Promise<Array<{ pid: number; exePath: string; aumid: string | null; displayName: string | null }>> => {
    const apps = await uia.listApplications();
    const byAumid = apps.filter((app) => app.aumid !== null && app.aumid === bundleId);
    if (byAumid.length > 0) return byAumid;
    return apps.filter((app) => sameCanonicalPath(app.exePath, bundleId));
  };

  /** name：在 list_apps 集合内做 display name / exe basename 大小写不敏感匹配（顺序 3）。 */
  const candidatesByName = async (
    name: string,
  ): Promise<Array<{ pid: number; exePath: string; aumid: string | null; displayName: string | null }>> => {
    const apps = await uia.listApplications();
    const needle = name.toLowerCase();
    return apps.filter((app) => {
      if (app.displayName !== null && app.displayName.toLowerCase() === needle) return true;
      return exeBasename(app.exePath).toLowerCase() === needle;
    });
  };

  /** 候选集收敛为唯一身份（0 → not running；≥2 → pass a pid；绝不猜 active/第一个）。 */
  const uniqueOr = (
    candidates: Array<{ pid: number; exePath: string; aumid: string | null; displayName: string | null }>,
  ): AppIdentity => {
    const distinctPids = new Set(candidates.map((candidate) => candidate.pid));
    if (distinctPids.size === 0) {
      throw new WireRequestFailure(WIRE_ERROR_MESSAGES.appNotRunning, "invalid_request");
    }
    if (distinctPids.size >= 2) {
      throw new WireRequestFailure(WIRE_ERROR_MESSAGES.appRefMultiple, "invalid_request");
    }
    const chosen = candidates.find((candidate) => candidate.pid === [...distinctPids][0]);
    if (!chosen) {
      // 结构性不可达（distinctPids 来自 candidates）；防御 = 确定未派发域。
      throw new WireRequestFailure(WIRE_ERROR_MESSAGES.appNotRunning, "invalid_request");
    }
    return {
      pid: chosen.pid,
      exePath: chosen.exePath,
      aumid: chosen.aumid,
      displayName: chosen.displayName,
    };
  };

  return async (ref: ParsedAppRef): Promise<AppIdentity> => {
    // pid 形态：存活 + canonical exe 可读（§11.3 顺序 1；A2 语义不变）。
    let pidIdentity: AppIdentity | undefined;
    if (ref.pid !== undefined) {
      const exe = await driver.processExecutablePath(ref.pid);
      if (exe.path === null) {
        throw new WireRequestFailure(WIRE_ERROR_MESSAGES.appNotRunning, "invalid_request");
      }
      pidIdentity = { pid: ref.pid, exePath: exe.path, aumid: null, displayName: null };
    }

    // bundle_id / name 形态：经 list_apps 集合解析（canonical 身份字段）。
    let resolved: AppIdentity | undefined;
    if (ref.bundleId !== undefined) {
      resolved = uniqueOr(await candidatesByBundleId(ref.bundleId));
    } else if (ref.name !== undefined) {
      resolved = uniqueOr(await candidatesByName(ref.name));
    }

    if (pidIdentity && resolved) {
      // 组合形态一致性（§11.3：冲突 → invalid_request，绝不择一）。
      if (pidIdentity.pid !== resolved.pid) {
        throw new WireRequestFailure(WIRE_ERROR_MESSAGES.appRefMultiple, "invalid_request");
      }
      // 一致：合并展示字段（枚举面比 processExecutablePath 富——aumid/displayName）。
      return { ...pidIdentity, aumid: resolved.aumid, displayName: resolved.displayName };
    }
    if (pidIdentity) {
      // pid-only：展示字段 best-effort 补齐（不引入第二次枚举——aumid/displayName 缺席
      // 对 _meta 是合法可选面，§11.6）。
      return pidIdentity;
    }
    if (resolved) return resolved;
    // 结构性不可达（parseAppRefShape 保证至少一个身份字段）；防御 = 参数域。
    throw new WireRequestFailure(WIRE_ERROR_MESSAGES.invalidParams, "invalid_request");
  };
}
