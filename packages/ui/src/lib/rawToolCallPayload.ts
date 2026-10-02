// 工具调用 raw payload 的最小读取原语（无依赖、无别名导入）。
//
// 为什么单独成文件：这两个函数原先住在 `ToolCallBlocks/fileSummaryTypes.ts`，那个文件
// 为了 diff 预览引入了 `@/lib/patchDiffPreview.js` 等别名依赖，于是任何想在
// `node --import tsx --test` 下直接测「从 raw payload 投影出一个字段」的用例都会被
// 别名解析卡住（`Cannot find package '@/lib'`）。把纯读取原语放在这里，投影逻辑
// （如 lib/permissionJustification.ts）与它的测试就都不依赖 React/别名图。
// fileSummaryTypes.ts 原样再导出这两个符号，既有消费者不受影响。

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readRawToolCallInput(raw: unknown): unknown {
  if (!isPlainRecord(raw)) {
    return null;
  }

  if ("rawInput" in raw && raw.rawInput !== undefined) {
    return raw.rawInput;
  }

  // ACode protocol 的 permission/request payload 按 schema 把工具参数放在 input，
  // 旧 UI 只读兼容输入字段 rawInput，Write/Edit 会退化成整段 JSON 展示而不是文件 diff。
  return "input" in raw ? raw.input : null;
}
