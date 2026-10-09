// 编译校验的消费示例（架构 context 阅读包展示；不执行任何 IO——不读写文件、
// 不触网、不起定时器）：路径与依赖源由宿主注入（declare / 示例字面量），
// 只演示 contract.ts 公开面的典型用法。
import type { ProviderRegistryFacadeSource } from "@acode/provider";
import {
  createNodeModelSelectionFacade,
  type NodeProviderConfigRuntime,
  type NodeProviderConfigRuntimeOptions,
} from "./contract.js";

/**
 * Config 运行时的最小装配形态：Built-in 文件 + Personal 文件两个路径即可组装
 * （watch/polling/远端同步/凭据库都是可选注入项）。示例只验证类型形态，
 * 不真正构造运行时（构造即挂文件 watch 与轮询定时器）。
 */
export const exampleRuntimeOptions = {
  acodeBuiltinFilePath: "/tmp/example/acode-builtin.json",
  personalFilePath: "/tmp/example/personal-provider.json",
  personalPollingIntervalMs: false,
  watch: false,
} satisfies NodeProviderConfigRuntimeOptions;

declare const runtime: NodeProviderConfigRuntime;
declare const registrySource: ProviderRegistryFacadeSource;

/** 运行时持有唯一的 configService 装配（Built-in + Personal 双层合并漏斗）。 */
export async function exampleResolveActiveFile(): Promise<string> {
  return runtime.resolveACodeBuiltinActiveFilePath();
}

/** 模型选择 Facade：身份分类（builtin/start/off-peak）+ legacy 归一由 Node 侧注入。 */
export function exampleModelSelectionFacade() {
  return createNodeModelSelectionFacade(registrySource);
}
