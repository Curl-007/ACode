// ============================================================
// 工具按需检索（tool-search）App 设置档位的取值域与归一化
// ============================================================
// 行为规格见 apps/acode-cli/specs/tool-search.md R1/R3/R11。与
// script-workflow-feature.ts 同形态的**本机产品开关**：只读 AppSettings，没有远端
// 下发 key、没有环境变量覆盖（刻意不走 dynamic-workflow-feature 的 env 改写链——
// 那条链的存在理由是发布灰度的远端否决权，tool-search 没有这个需求，取最短同构路径）。
//
// 取值域是 App 设置面的三值（auto/local/off，缺省 off）。CLI 的 `--toolsearch-mode`
// 是四值（多一个 native，波 1 未实装、执行期显式报错），其唯一权威定义在
// apps/acode-cli/packages/contracts/src/tools/tool-search.ts 的 ToolSearchModeSchema。
// packages/shared 与 apps/acode-cli/packages/contracts 是两个独立包，shared 不得深
// 导入 CLI 包，因此这里独立定义三值子集：App 三值 ⊂ CLI 四值（native 仅 CLI 显式
// 传入），字面量逐字一致，漂移由 bootstrap 物化点的类型收窄兜住（AgentRuntimeConfig
// .toolSearchMode 是 contracts 四值类型，三值可直接赋值）。

export const TOOL_SEARCH_APP_MODES = ["auto", "local", "off"] as const;
export type ToolSearchAppMode = (typeof TOOL_SEARCH_APP_MODES)[number];

/**
 * 缺省 = off（spec R1/R11）：未设置时全链零行为变化——runtime 侧缺席即 off，
 * 控制工具（ToolSearch/DeferredToolCall）不注册，请求投影与今天逐字节一致。
 * 与 dwf/script 的 fail-open 方向刻意相反：那两档缺省保「既有可用性」，
 * tool-search 缺省保「零行为变化」红线。
 */
export const DEFAULT_TOOL_SEARCH_APP_MODE: ToolSearchAppMode = "off";

/** 非法/形状错误的输入归一化为 undefined，由调用方决定落缺省档（与 normalizeScriptWorkflowMode 同构）。 */
export function normalizeToolSearchAppMode(value: unknown): ToolSearchAppMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return (TOOL_SEARCH_APP_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as ToolSearchAppMode)
    : undefined;
}
