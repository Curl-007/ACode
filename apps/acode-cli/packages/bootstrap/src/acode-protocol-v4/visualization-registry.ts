// ============================================================
// ::visualize 引用的解析与注册表查询（投影层专用）
// ============================================================
// specs/gen-ui-visualize.md 的引用半边。两个职责：
//   ① 解析最终文本里的 `::visualize{...}` 指令（词法与 renderer 的
//      assistantDirectiveParser 同源约定：单/三冒号前缀 + JSON 参数体）；
//   ② 按会话注册表核对 name——只有 WriteVisualizationFragment 写过的片段才
//      翻译成 artifactRow；未命中按纯文本降级（指令留在正文里，用户可见）。
//
// 注册表是**模块级、按 sessionId 键控的 Map**而不是投影构造参数：ProductProjection 由
// conversation-topic-publisher 在深层构造（sessionId/logEpoch 两参），把 store 一路
// 穿过去要动 publisher/gateway/bridge 三层签名；模块级绑定与「端口本体由 bootstrap
// 在 runtime 构造前装配完成」的既有纪律同档。
//
// 为什么必须键控而不是单一 activeStore（2026-10-12 实机 Bug 6，specs/gen-ui-visualize.md）：
// 桌面 app-server 一个进程承载多会话 = 多 app 并存，单例是 last-writer-wins，且任一
// app dispose 置 null 会把其他在世 app 的绑定清掉——投影 lookup 静默 miss、卡片永不
// 渲染（工具写入走 app 本地 tool context 不受影响，症状是「片段已存、卡不出」）。
// 注销带实例身份校验：同会话旧 app 的迟到 dispose 不得误删新 app 的绑定。

import type { VisualizationFragmentMeta, VisualizationFragmentStorePort } from "@acode/contracts";

const storesBySession = new Map<string, VisualizationFragmentStorePort>();

/** create-app 装配时注册本会话的 store。 */
export function registerVisualizationFragmentStore(
  sessionId: string,
  store: VisualizationFragmentStorePort,
): void {
  storesBySession.set(sessionId, store);
}

/**
 * app dispose / 启动失败时注销。**仅当当前绑定就是本实例才删**：同会话重建（re-attach）
 * 后旧 app 的迟到 dispose 不得把新 app 的注册清掉。
 */
export function unregisterVisualizationFragmentStore(
  sessionId: string,
  store: VisualizationFragmentStorePort | undefined,
): void {
  if (store === undefined) return;
  if (storesBySession.get(sessionId) === store) storesBySession.delete(sessionId);
}

/** 投影层的同步注册表查询（收口处不能做 IO，见 store 端口注释）。 */
export function lookupVisualizationFragment(
  sessionId: string,
  name: string,
): VisualizationFragmentMeta | undefined {
  return storesBySession.get(sessionId)?.lookupVisualizationFragment(sessionId, name);
}

/** 每轮至多解析的引用条数（与 renderer 侧同源镜像；超出部分按纯文本留底）。 */
export const MAX_VISUALIZE_REFERENCES_PER_TURN = 8;

/** name 的线上形状（与 contracts 写入侧同规则；这里独立一份避免投影层 import 工具面）。 */
const VISUALIZATION_NAME_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/u;

export interface VisualizeReference {
  name: string;
  /** "wide" = 全宽渲染；其他值/缺席 = 标准宽。 */
  mode?: "wide";
}

/**
 * 从一段 assistant 正文里解析 `::visualize{...}` 引用。
 *
 * 词法容错与 renderer 的 extractAssistantDirectives 同档：允许 `:::` 前缀（三冒号是
 * 某些模型的爱写形态）、智能引号归一为 ASCII 后再 JSON.parse。解析失败的指令**不**
 * 从文本里消失——那是 renderer 剥离层的事，这里只产出「能翻译成 artifactRow 的引用」。
 * 代码围栏内的样例不解析：围栏状态机与 renderer 投影同构（``` 或 ~~~ 切换）。
 */
export function parseVisualizeReferences(text: string): VisualizeReference[] {
  const references: VisualizeReference[] = [];
  if (text.length === 0 || !text.includes("visualize")) return references;
  let inFence = false;
  let fenceMarker = "";
  // 逐行扫而不是全文 regex：围栏状态是行级的，全文匹配会把代码块里的协议样例当真。
  for (const line of text.split("\n")) {
    const fence = matchFenceMarker(line);
    if (fence !== null) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence;
      } else if (line.trimStart().startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;
    for (const match of line.matchAll(/:{2,3}visualize\s*(\{[^{}]*\})/gu)) {
      if (references.length >= MAX_VISUALIZE_REFERENCES_PER_TURN) return references;
      const parsed = parseReferenceBody(match[1]);
      if (parsed) references.push(parsed);
    }
  }
  return references;
}

function matchFenceMarker(line: string): string | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("```")) return "```";
  if (trimmed.startsWith("~~~")) return "~~~";
  return null;
}

function parseReferenceBody(body: string): VisualizeReference | undefined {
  // 智能引号归一（模型偶尔用弯引号写 JSON 字符串）。
  const normalized = body.replace(/[\u201c\u201d]/gu, '"').replace(/[\u2018\u2019]/gu, "'");
  let value: unknown;
  try {
    value = JSON.parse(normalized);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== "string" || !VISUALIZATION_NAME_PATTERN.test(name) || name.length > 80) {
    return undefined;
  }
  const mode = record.mode === "wide" ? ("wide" as const) : undefined;
  return mode === undefined ? { name } : { name, mode };
}
