// ============================================================
// InMemoryHookRunner —— hooks 执行入口（拆分后的装配面）
// ============================================================
// 中间件链语义落地后本文件曾逼近 400 行 ratchet 的两倍，按仓库先例拆分
// （specs/plugin-hook-middleware.md）：
// - runner-chain.ts：链走查（runHookChain/selectMatchingHooks，一期最小洋葱）；
// - runner-link.ts：前台环节结算 + middleware next 工厂；
// - runner-lifecycle.ts：生命周期事件发射 / 带超时派发 / async 后台环节 / 结果解包。
// 公开 API 不变：InMemoryHookRunner 与 createInMemoryHookRunner 仍从本文件导出，
// 模块内消费者与守护测试的导入路径不感知拆分。
import type { HookInput, Logger, SessionEvent } from "@acode/contracts";
import { resolveHookRunAdmission } from "./runner-helpers.js";
import { runHookChain, selectMatchingHooks } from "./runner-chain.js";
import type {
  HookRegistration,
  HookRunOptions,
  HookRunResult,
  HookRunner,
  HookRunnerOptions,
} from "./types.js";

export class InMemoryHookRunner implements HookRunner {
  private readonly defaultTimeoutMs: number;
  private readonly emitEvent?: (event: SessionEvent) => Promise<void>;
  private readonly hooks: HookRegistration[];
  private readonly logger?: Logger;

  constructor(options: HookRunnerOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60000;
    this.emitEvent = options.emitEvent;
    this.hooks = [...(options.hooks ?? [])];
    this.logger = options.logger;
  }

  register(hook: HookRegistration): void {
    this.hooks.push(hook);
  }

  async run(input: HookInput, options: HookRunOptions = {}): Promise<HookRunResult> {
    const matchingHooks = selectMatchingHooks(this.hooks, input, options);
    const result: HookRunResult = {
      additionalContexts: [],
    };
    const hookInvocationId = crypto.randomUUID();

    // skipLifecycle 的 hook 不发事件，不能计入客户端等待完成的 hookCount。
    // 修复：先解析全部 matchingHooks 的 admission，把 skipLifecycle 的从参与列表
    // 剔除后再计算 clientVisibleHookCount（计数在 runHookChain 入口完成），保证
    // hookCount === 实际会发事件的 hook 数。
    //
    // 注意：这里的 admission 结果只用于 skipLifecycle 剔除与 hookCount 计算——
    // 二者取决于「配置是否启用」这一稳定属性。allowed 授权决定绝不能沿用本阶段的
    // 缓存：一次事件匹配多个顺序执行的 Hook 时，前序 Hook 运行期间发生的
    // revoke / policy 收紧 / trust store reload 必须对尚未开始的 Hook 立即生效，
    // 因此链走查在每个 Hook 实际 dispatch 前重新调用 resolveHookRunAdmission。
    const participatingHooks: { hook: HookRegistration }[] = [];
    for (const hook of matchingHooks) {
      const admission = resolveHookRunAdmission(hook, input, this.logger);
      if (admission.skipLifecycle) continue;
      participatingHooks.push({ hook });
    }

    await runHookChain({
      ctx: {
        defaultTimeoutMs: this.defaultTimeoutMs,
        emitEvent: this.emitEvent,
        logger: this.logger,
      },
      event: input,
      hookInvocationId,
      options,
      participatingHooks,
      result,
    });

    return result;
  }
}

export function createInMemoryHookRunner(options?: HookRunnerOptions): InMemoryHookRunner {
  return new InMemoryHookRunner(options);
}
