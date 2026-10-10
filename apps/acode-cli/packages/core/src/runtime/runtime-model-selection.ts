import type { ModelSelection } from "@acode/contracts";
import { cloneModelSelection } from "./model-selection.js";

/**
 * 会话级模型选择的只读投影。
 *
 * execution-scope 的本轮模型不写入这里；resume/config/首轮持久化共用同一个 owner，
 * 避免 methods 通过共享 `AgentRuntimeInternal` 直接替换会话事实。
 */
export interface RuntimeModelSelectionView {
  readonly sessionModelSelection: ModelSelection | undefined;
}

export interface RuntimeModelSelectionPort {
  /** 提交或清除会话选择；owner 会复制输入，调用方可以安全复用原对象。 */
  set(selection: ModelSelection | undefined): void;
  /** 返回防御性副本，避免调用方通过 getter 结果反向修改 owner。 */
  get(): ModelSelection | undefined;
}

class RuntimeModelSelectionOwner {
  #selection: ModelSelection | undefined;

  constructor(initialSelection: ModelSelection | undefined) {
    this.#selection = initialSelection && cloneModelSelection(initialSelection);
  }

  get selection(): ModelSelection | undefined {
    return this.#selection && cloneModelSelection(this.#selection);
  }

  readonly port: RuntimeModelSelectionPort = Object.freeze({
    set: (selection: ModelSelection | undefined): void => {
      this.#selection = selection && cloneModelSelection(selection);
    },
    get: (): ModelSelection | undefined => this.selection,
  });
}

const owners = new WeakMap<object, RuntimeModelSelectionOwner>();

/** 构造期绑定一次；重复初始化不能替换已有 owner 或 getter。 */
export function initializeRuntimeModelSelection(
  runtime: object,
  initialSelection?: ModelSelection,
): void {
  if (owners.has(runtime)) return;
  const owner = new RuntimeModelSelectionOwner(initialSelection);
  Object.defineProperty(runtime, "sessionModelSelection", {
    configurable: false,
    enumerable: true,
    get: () => owner.selection,
  });
  owners.set(runtime, owner);
}

export function getRuntimeModelSelectionPort(runtime: object): RuntimeModelSelectionPort {
  const owner = owners.get(runtime);
  if (!owner) throw new Error("Runtime model selection has not been initialized");
  return owner.port;
}
