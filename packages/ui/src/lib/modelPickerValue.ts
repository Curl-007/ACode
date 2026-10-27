// 模型选择器字符串 ↔ ModelSelection 的 UI 侧转换（custom 模型感知）。
//
// ⚠️ **不要把这些函数「简化」成直接 import `@acode/shared` 的同名函数**——那会静默破坏
// 自定义模型选择。UI 的 picker 值是展示态 `custom:provider:model`，而 shared 版
// `parseModelPickerValue` 要求 `provider/model` 形态，遇到 `custom:` 串会**抛错**
// （`packages/shared/src/model-selection.ts:48`：无 `/` 分隔符即 throw）。
// 实测（packages/ui/test/modelPickerValue.test.ts 的【陷阱】组钉住）：
//   custom:zai:glm-4.7      → UI 解出 {providerId:"zai", modelId:"glm-4.7"}；shared 抛错
//   custom:builtin:oai:gpt  → UI 解出 {providerId:"builtin:oai", modelId:"gpt"}（legacy 三段形态）；shared 抛错
// 本模块的存在理由就是这层 custom 解码；它与 `lib/acodeCustomModelValue.ts`（encode/decode 包装）
// 同族，故意分开：那个管编解码，这个管 picker 字符串与 ModelSelection 的往返。
//
// 来历：原住 `lib/acodeSessionProjection.ts`（legacy 投影迁移桥）。2026-10-28 随 legacy M1
// 第一批消费方迁移搬到这里——这两个函数是**纯字符串工具**，与 session 投影无关，
// 留在投影桥里会让 M1「删掉 acodeSessionProjection」被 10 个模型选择器消费方无谓阻塞。
import {
  decodeCustomModelValue,
  formatModelPickerValue as formatSharedModelSelection,
  parseModelPickerValue as parseSharedModelSelection,
  type ModelSelection,
} from "@acode/shared";

/** ModelSelection → picker 展示串（`provider/model`，带 reasoningLevel 时附后缀）。 */
export function formatModelPickerValue(ref: ModelSelection | undefined): string {
  return formatSharedModelSelection(ref);
}

/**
 * picker 展示串 → ModelSelection。
 *
 * 先解 custom 形态（展示态 `custom:provider:model`），解不出才回落 shared 的标准解析。
 * ACode Protocol 必须收到严格的 providerId/modelId 结构，故 custom 串在这里就被拆开。
 */
export function parseModelPickerValue(value: string): ModelSelection {
  const customModel = decodeCustomModelValue(value);
  if (customModel?.providerId && customModel.modelName) {
    return {
      providerId: customModel.providerId,
      modelId: customModel.modelName,
    };
  }

  return parseSharedModelSelection(value);
}
