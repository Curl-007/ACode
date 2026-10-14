/**
 * 变更类派发编排（specs/windows-helper-producer.md §10.4 规则 4/5、§10.5、§10.12 铁律 1、
 * §18 第 9 条）。A2 实现批次自 backend-a2.ts 拆出（§5.3「文件划分可微调」；oxlint
 * max-lines 400 硬约束 + 编排面独立锁定）。
 *
 * 四件原语：
 * - admit：admission 包装（队满/排队超时/被 stop 清空 → ok:false controller_busy，
 *   确定未派发域，§10.5）；
 * - runMutating：变更类收口（Rejected → ok:false 映射封闭字面量；Ambiguous →
 *   possibly_sent 收据——派发后禁 ok:false 的铁律 1 落点；非类型化 → 防御 internal）；
 * - releaseQuiet：收口释放（§10.4 规则 3/5：幂等、免前台校验、失败不掩盖原始失败类别）；
 * - withModifiers：修饰键包裹（§10.2「修饰 down → 主体 → 修饰 up」；A2 导出面无
 *   composite 原语，实现为 admission 串行域内的连续 driver 调用——并发=1 保证序列
 *   相对其它 CUA 操作原子，前台校验逐段适用比单次校验更严）。
 *
 * 纯 TS + 注入 driver（§10.11 模块规则①：不得 import native-driver）。
 */
import {
  NativeAmbiguousError,
  NativeRejectedError,
  type CuaNativeDriver,
  type PressKeysEntry,
} from "./driver-contract.js";
import { SessionBusyError, type InputSession } from "./input-session.js";
import {
  MODIFIER_VK,
} from "./param-validation.js";
import {
  RECEIPT_MESSAGES,
  WIRE_BY_NATIVE_CODE,
  interruptedReceipt,
  possiblySentReceipt,
  type ToolResultPayload,
} from "./receipts.js";
import { WIRE_ERROR_MESSAGES, WireRequestFailure } from "./wire-server.js";

export interface MutatingDispatchDeps {
  readonly driver: CuaNativeDriver;
  readonly session: InputSession;
}

export interface MutatingDispatch {
  admit<T>(kind: string, fn: () => Promise<T>): Promise<T>;
  runMutating(kind: string, fn: () => Promise<ToolResultPayload>): Promise<ToolResultPayload>;
  releaseQuiet(): Promise<void>;
  withModifiers(
    pid: number,
    modifiers: string[] | undefined,
    body: () => Promise<void>,
  ): Promise<{ modifierCleanupAfterBodySuccess: boolean } | undefined>;
  modifierCleanupReceipt(): ToolResultPayload;
}

export function createMutatingDispatch(deps: MutatingDispatchDeps): MutatingDispatch {
  const { driver, session } = deps;

  /** admission 包装：队满/排队超时/被 stop 清空 → ok:false controller_busy（确定未派发）。 */
  const admit = async <T>(kind: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await session.submit(kind, fn);
    } catch (error) {
      if (error instanceof SessionBusyError) {
        throw new WireRequestFailure(WIRE_ERROR_MESSAGES.controllerBusy, "controller_busy");
      }
      throw error;
    }
  };

  /**
   * 变更类收口（§10.12 铁律 1 + §10.3 二分判据）：fn 在 admission 内执行；
   * Rejected → ok:false（映射封闭字面量）；Ambiguous → possibly_sent 收据；
   * WireRequestFailure → 原样上抛（dispatch 产 ok:false）；非类型化 → 防御 internal。
   */
  const runMutating = async (
    kind: string,
    fn: () => Promise<ToolResultPayload>,
  ): Promise<ToolResultPayload> => {
    try {
      return await admit(kind, fn);
    } catch (error) {
      if (error instanceof WireRequestFailure) throw error;
      if (error instanceof NativeRejectedError) {
        const mapped = WIRE_BY_NATIVE_CODE[error.code] ?? {
          code: "internal",
          message: WIRE_ERROR_MESSAGES.internal,
        };
        throw new WireRequestFailure(mapped.message, mapped.code);
      }
      if (error instanceof NativeAmbiguousError) {
        return possiblySentReceipt(error.code, error.reason);
      }
      throw error;
    }
  };

  /** 收口释放（§10.4 规则 3/5：幂等、免前台校验；失败不掩盖原始失败类别）。 */
  const releaseQuiet = async (): Promise<void> => {
    try {
      await driver.releaseAllHeldInputs();
    } catch {
      // best-effort：native 注册表已幂等清空；释放失败由退出路径兜底。
    }
  };

  /**
   * 修饰键包裹（§10.4 规则 4/5 的失败收口）：主体失败 → 跳过修饰 up 业务段（规则 4
   * 「不续注入」）、cleanup 释放先于收据/上抛（规则 5）；主体成功但修饰 up 失败 →
   * cleanup 释放 + 诚实收据信号（主体副作用已发生 ⇒ 铁律 1 禁 ok:false）。
   */
  const withModifiers = async (
    pid: number,
    modifiers: string[] | undefined,
    body: () => Promise<void>,
  ): Promise<{ modifierCleanupAfterBodySuccess: boolean } | undefined> => {
    if (!modifiers || modifiers.length === 0) {
      await body();
      return undefined;
    }
    const downs: PressKeysEntry[] = modifiers.map((name) => ({
      vk: MODIFIER_VK[name] as number,
      up: false,
    }));
    const ups: PressKeysEntry[] = [...downs].reverse().map((entry) => ({ vk: entry.vk, up: true }));
    const tokens = modifiers.map((name) => `mod:${name}`);
    await driver.pressKeys(downs, { expectedForegroundPid: pid });
    for (const token of tokens) session.noteHeld(token);
    let bodyError: unknown;
    try {
      await body();
    } catch (error) {
      bodyError = error;
    }
    if (bodyError !== undefined) {
      await releaseQuiet();
      for (const token of tokens) session.noteReleased(token);
      throw bodyError;
    }
    try {
      await driver.pressKeys(ups, { expectedForegroundPid: pid });
      for (const token of tokens) session.noteReleased(token);
      return undefined;
    } catch (error) {
      await releaseQuiet();
      for (const token of tokens) session.noteReleased(token);
      if (error instanceof NativeRejectedError) {
        return { modifierCleanupAfterBodySuccess: true };
      }
      throw error;  // Ambiguous → possibly_sent（保守方向，action_sent 语义相同）
    }
  };

  const modifierCleanupReceipt = (): ToolResultPayload =>
    interruptedReceipt("internal", RECEIPT_MESSAGES.modifierReleaseCleanup);

  return { admit, runMutating, releaseQuiet, withModifiers, modifierCleanupReceipt };
}
