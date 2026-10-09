// 编译校验的消费示例（架构 context 阅读包展示；不执行任何 IO——ProviderRegistry
// 是纯内存结构，示例只构造空 Registry 与类型级调用，不读配置、不触网）。
import {
  ProviderRegistry,
  type ModelSelection,
  type ModelSelectionValidation,
  type ProviderRegistryView,
} from "./contract.js";

/** Registry 是唯一事实源：视图带 revision，冻结且只读。 */
export function exampleEmptyRegistryView(): ProviderRegistryView {
  const registry = new ProviderRegistry();
  return registry.getView();
}

/** 选择校验：provider/model 不存在或 option 非法都返回带 code 的判别结果。 */
export function exampleValidateSelection(
  registry: ProviderRegistry,
  selection: ModelSelection,
): ModelSelectionValidation {
  return registry.validateSelection(selection);
}

/** 整体替换 + 订阅：replace 单调递增 revision 并同步通知全部监听者。 */
export function exampleReplaceAndSubscribe(registry: ProviderRegistry): number {
  const seen: number[] = [];
  const unsubscribe = registry.onDidChange((event) => {
    seen.push(event.revision);
  });
  registry.replace([], "example-refresh");
  unsubscribe();
  return registry.getView().revision;
}
