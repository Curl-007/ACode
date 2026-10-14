/**
 * frame 注册表（specs/windows-helper-producer.md §10.7/§10.9/§11.5）。
 *
 * `frame_id` → 栅格几何/bounds/owner/显示拓扑世代；坐标投影与 stale 判定的事实源。
 * 进程内存态、随进程消亡（§1.3）；代际即失效（新 Helper 代的一切 token 全新）。
 *
 * A2 切片登记（§10.0）：frame 注册表由 get_app_state(include_screenshot) 供给（A3 才有
 * wire 观察面），A2 运行期恒空——坐标 target 的隐式绑定命中「无任何 frame」→
 * element_unavailable 固定字面量（诚实 fail-closed）；指针三工具 handler 以本注册表的
 * 注入形态单测（§10.11），wire 级指针闭环自 A3 点亮。
 *
 * 纯 TS、零依赖（§10.11 模块规则①）。
 */
import type { CaptureRect } from "./driver-contract.js";

/** frame 归属域（§11.5）：pid（app scope）或 "display:<n>"（显示器捕获）。 */
export type FrameOwnerScope = string;

export interface FrameRecord {
  readonly frameId: string;
  readonly rasterWidth: number;
  readonly rasterHeight: number;
  readonly bounds: CaptureRect;
  readonly ownerScope: FrameOwnerScope;
  readonly topologyEpoch: number;
  readonly createdAt: number;
}

export interface FrameRegistration {
  rasterWidth: number;
  rasterHeight: number;
  bounds: CaptureRect;
  ownerScope: FrameOwnerScope;
  /** 捕获时显示器拓扑指纹（captureDisplay 的 topologyFingerprint，§10.7 世代对照）。 */
  topologyFingerprint?: string;
}

export type FrameLookupFailure = "unknown" | "stale-epoch" | "owner-mismatch";

export interface FrameLookupResult {
  ok: boolean;
  frame?: FrameRecord;
  reason?: FrameLookupFailure;
}

export interface FrameRegistry {
  /** 捕获/使用时的拓扑世代对照（§10.7）：指纹变化 → 世代 +1，旧世代 frame 一律 stale。 */
  observeTopology(fingerprint: string): void;
  register(registration: FrameRegistration): FrameRecord;
  /** frame_id 精确解析：未知 / 拓扑换代 → 失败（element_unavailable 的 stale 语义）。 */
  resolve(frameId: unknown): FrameLookupResult;
  /** 该 app scope 最近一次可动作 frame（§10.9 坐标 target 的隐式绑定）。 */
  latestForScope(ownerScope: FrameOwnerScope): FrameRecord | undefined;
  /**
   * 坐标投影（§10.9 producer 自持）：x_phys = bounds.x + x_model × (bounds.width /
   * rasterWidth)（y 同型）；四舍五入到物理像素，越界 clamp 到 bounds 内并如实保留。
   * 预算阶梯（§10.7）保证 model 栅格 = 登记栅格，投影为纯线性算术。
   */
  projectCoordinates(frame: FrameRecord, xModel: number, yModel: number): { x: number; y: number };
  readonly size: number;
  readonly topologyEpoch: number;
}

/** app scope 的 ownerScope 键形态（§11.5 ownerScope = pid ∣ "display:<n>"）。 */
export function appOwnerScope(pid: number): FrameOwnerScope {
  return `app:${pid}`;
}

export function createFrameRegistry(): FrameRegistry {
  let topologyEpoch = 0;
  let topologyFingerprint: string | undefined;
  let counter = 0;
  const frames = new Map<string, FrameRecord>();
  // 每 scope 的最新 frame（隐式绑定用；LRU/上限治理属 A3 的 state 注册表，frame 面
  // A2 运行期恒空、A3 每次观察至多 +1，内存有界性由观察频率天然约束）。
  const latestByScope = new Map<FrameOwnerScope, FrameRecord>();

  // 拓扑世代对照（§10.7）：指纹变化 → 世代 +1，旧世代 frame 一律 stale。
  const applyTopology = (fingerprint: string): void => {
    if (typeof fingerprint !== "string" || fingerprint.length === 0) return;
    if (topologyFingerprint !== undefined && topologyFingerprint !== fingerprint) {
      topologyEpoch += 1;  // 显示拓扑换代（reobserve 语义正确）
    }
    topologyFingerprint = fingerprint;
  };

  return {
    observeTopology(fingerprint: string): void {
      applyTopology(fingerprint);
    },

    register(registration: FrameRegistration): FrameRecord {
      // 捕获即拓扑对照：登记指纹先行换代，新 frame 属于新世代（frameId 以当前世代铸造）。
      if (typeof registration.topologyFingerprint === "string") {
        applyTopology(registration.topologyFingerprint);
      }
      counter += 1;
      // frame_id 不透明串 fr-<epoch>-<counter>（§11.5 同型；代内唯一、不复用）。
      const frame: FrameRecord = {
        frameId: `fr-${topologyEpoch}-${counter}`,
        rasterWidth: registration.rasterWidth,
        rasterHeight: registration.rasterHeight,
        bounds: registration.bounds,
        ownerScope: registration.ownerScope,
        topologyEpoch,
        createdAt: Date.now(),
      };
      frames.set(frame.frameId, frame);
      latestByScope.set(frame.ownerScope, frame);
      return frame;
    },

    resolve(frameId: unknown): FrameLookupResult {
      if (typeof frameId !== "string" || frameId.length === 0) {
        return { ok: false, reason: "unknown" };
      }
      const frame = frames.get(frameId);
      if (!frame) return { ok: false, reason: "unknown" };
      if (frame.topologyEpoch !== topologyEpoch) return { ok: false, reason: "stale-epoch" };
      return { ok: true, frame };
    },

    latestForScope(ownerScope: FrameOwnerScope): FrameRecord | undefined {
      const frame = latestByScope.get(ownerScope);
      if (!frame) return undefined;
      if (frame.topologyEpoch !== topologyEpoch) return undefined;  // 换代后隐式绑定同样 stale
      return frame;
    },

    projectCoordinates(frame: FrameRecord, xModel: number, yModel: number): { x: number; y: number } {
      const { bounds, rasterWidth, rasterHeight } = frame;
      const scaleX = rasterWidth > 0 ? bounds.width / rasterWidth : 1;
      const scaleY = rasterHeight > 0 ? bounds.height / rasterHeight : 1;
      // 四舍五入到物理像素 + clamp 到 bounds 内（副屏负 bounds 天然成立：bounds.x 为负时
      // 投影结果同样为负——全链一致虚拟桌面空间，§10.7）。
      const project = (model: number, origin: number, scale: number, extent: number): number => {
        const physical = Math.round(origin + model * scale);
        const low = Math.round(origin);
        const high = Math.round(origin + extent) - 1;
        return Math.min(Math.max(physical, low), high);
      };
      return {
        x: project(xModel, bounds.x, scaleX, bounds.width),
        y: project(yModel, bounds.y, scaleY, bounds.height),
      };
    },

    get size(): number {
      return frames.size;
    },

    get topologyEpoch(): number {
      return topologyEpoch;
    },
  };
}
