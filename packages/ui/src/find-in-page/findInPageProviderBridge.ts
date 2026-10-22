/**
 * 页内查找二期：renderer provider 路桥接（specs: packages/desktop/specs/find-in-page.md R8/R10）。
 *
 * window.acode 二期四成员的结构类型探测（EmbeddedBrowserPermissionPromptHost /
 * 一期 findInPageModel 同一先例——ui 包单独 typecheck 拿不到 desktop 的完整桥声明）。
 * 接线三件事：
 * 1. 注册表 → main：provider 注册表非空即申报 setFindInPageProviderActive(true)；
 *    归零时先清协调器高亮再申报 false（能力撤回不留残影）；查询激活期间的注册表
 *    变动触发协调器 grow 重归并（蓝本 bo()/Go() 通知链的收口形态）。
 * 2. main → 协调器：FindInPageDispatch 载荷运行时校验后 dispatchFind，结果经
 *    FindInPageReport 原样带回 epoch；协调器异常/拒绝一律申报 {0,0}（fail-soft）。
 * 3. main → 协调器：FindInPageClear 即协调器 clear()（epoch 作废在途搜索）。
 *
 * 幂等：RootShell 常驻，多次 init 只接线一次；桥缺席（Web 端/旧 preload）静默不启用，
 * 原生路不受影响。
 */
import type {
  FindInPageDispatchPayload,
  FindInPageReportPayload,
  FindInPageResult,
} from "@acode/shared";
import { logger } from "@/logger.js";
import { getSharedFindInPageCoordinator } from "./findInPageCoordinator.js";
import {
  getFindInPageProviders,
  subscribeFindInPageProviderRegistry,
} from "./findInPageProvider.js";

/** 平台桥二期成员的局部结构类型（缺任一即视为平台不支持 provider 路）。 */
interface FindInPageProviderBridge {
  setFindInPageProviderActive?: (active: boolean) => Promise<void>;
  onFindInPageDispatch?: (callback: (payload: FindInPageDispatchPayload) => void) => () => void;
  reportFindInPageResult?: (payload: FindInPageReportPayload) => Promise<void>;
  onFindInPageClear?: (callback: () => void) => () => void;
}

type ProviderBridgeWindow = Window & { acode?: FindInPageProviderBridge };

const EMPTY_FIND_RESULT: FindInPageResult = { activeIndex: 0, total: 0 };

/** dispatch 载荷运行时校验（防御性：main 可信但载荷经 IPC 序列化，坏帧直接丢）。 */
export function parseFindInPageDispatchPayload(payload: unknown): FindInPageDispatchPayload | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const candidate = payload as Partial<FindInPageDispatchPayload>;
  if (typeof candidate.epoch !== "number" || !Number.isFinite(candidate.epoch)) {
    return null;
  }
  if (typeof candidate.text !== "string") {
    return null;
  }
  if (typeof candidate.findNext !== "boolean") {
    return null;
  }
  if (typeof candidate.forward !== "boolean") {
    return null;
  }
  return {
    epoch: candidate.epoch,
    text: candidate.text,
    findNext: candidate.findNext,
    forward: candidate.forward,
  };
}

function resolveProviderBridge(): FindInPageProviderBridge | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const bridge = (window as ProviderBridgeWindow).acode;
  return typeof bridge?.setFindInPageProviderActive === "function" &&
    typeof bridge.onFindInPageDispatch === "function" &&
    typeof bridge.reportFindInPageResult === "function" &&
    typeof bridge.onFindInPageClear === "function"
    ? bridge
    : undefined;
}

let initialized = false;
let lastDeclaredActive: boolean | null = null;

/**
 * 初始化 provider 路桥（幂等）。由 useFindInPageOverlay 在一期桥在场时调用；
 * 返回是否完成接线（false = 桥缺席或已初始化过，调用方无需处置）。
 */
export function initFindInPageProviderBridge(): boolean {
  if (initialized) {
    return true;
  }
  const bridge = resolveProviderBridge();
  if (!bridge) {
    return false;
  }
  initialized = true;
  const coordinator = getSharedFindInPageCoordinator();

  const declareActive = (active: boolean): void => {
    if (lastDeclaredActive === active) {
      return;
    }
    lastDeclaredActive = active;
    bridge.setFindInPageProviderActive?.(active).catch((error: unknown) => {
      logger.warn("[find-in-page] provider 能力申报失败", error);
    });
  };

  subscribeFindInPageProviderRegistry(() => {
    const active = getFindInPageProviders().length > 0;
    if (!active) {
      // 能力撤回：先清高亮（防残留），再申报 false（main 侧同迁移也会下发 clear，双保险）。
      coordinator.clear();
    } else {
      // 查询激活期间的新 provider 注册：grow 重归并，高亮与新腿一致。
      coordinator.refresh();
    }
    declareActive(active);
  });
  // 启动同步：桥接线前已注册的 provider（理论上无——init 早于列表挂载，防御性对齐）。
  declareActive(getFindInPageProviders().length > 0);

  bridge.onFindInPageDispatch?.((payload: unknown) => {
    const parsed = parseFindInPageDispatchPayload(payload);
    if (parsed === null) {
      return;
    }
    coordinator
      .dispatchFind(parsed)
      .then((result) =>
        bridge.reportFindInPageResult?.({ epoch: parsed.epoch, result }).catch((error: unknown) => {
          logger.warn("[find-in-page] 结果申报失败", error);
        }),
      )
      .catch((error: unknown) => {
        logger.warn("[find-in-page] provider 路搜索失败", error);
        bridge
          .reportFindInPageResult?.({ epoch: parsed.epoch, result: EMPTY_FIND_RESULT })
          .catch(() => {});
      });
  });

  bridge.onFindInPageClear?.(() => {
    coordinator.clear();
  });
  return true;
}
