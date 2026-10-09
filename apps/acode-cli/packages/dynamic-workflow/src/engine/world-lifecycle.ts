/** run 级 world 生命周期：引擎拥有取消与 drain，不关闭共享 driver/adapter。 */
export class WorldLifecycle {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  readonly signal: AbortSignal = this.controller.signal;
  private externalSignal?: AbortSignal;
  private readonly forwardAbort = () => this.controller.abort(this.externalSignal?.reason);

  connect(externalSignal?: AbortSignal): void {
    this.externalSignal = externalSignal;
    if (externalSignal?.aborted) this.forwardAbort();
    else externalSignal?.addEventListener("abort", this.forwardAbort, { once: true });
  }

  track<T>(start: () => Promise<T>): Promise<T> {
    // 登记先于 driver 调用：driver 同步失败/重入结算也必须被 drain 覆盖。
    const operation = Promise.resolve().then(start);
    const drained = operation.then(
      () => undefined,
      () => undefined,
    );
    this.pending.add(drained);
    void drained.then(() => this.pending.delete(drained));
    return operation;
  }

  finish(error: unknown, settle: () => void): void {
    // 原缺陷只透传用户 abort；正常 return/失败会留下 Promise.race 输家的真实命令继续写入。
    this.controller.abort(error);
    this.externalSignal?.removeEventListener("abort", this.forwardAbort);
    if (this.pending.size === 0) settle();
    else void Promise.all(this.pending).then(settle);
  }
}
