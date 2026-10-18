# read/search 结构化工具卡 display（tool-display-read-search）

状态：实施中（UX 波 D1，2026-10-18）
来源：oh-my-pi (MIT) 显示层「typed details 载荷」机制（packages/tui/src/tools/
renderer.ts 的 NativeToolHead meta facts、packages/collab-web/src/tool-render/
tools/read.tsx 消费 ReadToolDetails 的形态）。机制参照，schema 与代码自撰。

## 背景与动机

CLI 的 Read/Grep/Glob 输出本身就是结构化的（ReadTextOutput 的行窗/截断/尾注
事实、GrepOutput 的 numFiles/numMatches/filenames），但 wire 上只有
`toolOutput.text`——桌面 UI 拿不到这些事实，只能对文本做正则启发式
（read.tsx 的 `<path>` 标签抽取、fileSummaryHeuristics 的动词猜测）。UX 波已
落地的 conflict://、read 选择器、结构摘要、URL 直读在桌面端全部退化为纯文本。

display 通道已存在且版本容错（toolCall row `output.display`，
`.optional().catch(undefined)`），本件把 read/search 两族工具接进去，UI 消费
结构化事实、启发式仅作为旧 row 的 fallback 保留。

## 产品规则

### R1 payload 形态（contracts `tools/read-search-display.ts`，唯一权威定义）

```
kind:"read"  = {
  filePath: string(1..4096)          // 解析后的真实路径或原始 URL
  startLine: int≥1, numLines: int≥0, totalLines: int≥0
  truncated?: true                   // 行窗/预算截断（含 token cap）
  conflicts?: true                   // 输出带 conflict:// 尾注（冲突检出）
  summarized?: true                  // 输出带结构化摘要尾注（骨架化阅读）
  url?: { finalUrl(1..4096), status: int 100..599,
          contentType: string(≤256), cacheHit?: true }   // URL 直读元数据
}
kind:"search" = {
  tool: "grep" | "glob"
  mode?: "content" | "files_with_matches" | "count"      // grep 专有
  numFiles: int≥0
  numMatches?: int≥0, numLines?: int≥0                    // grep 专有
  filenames: string[](≤20 条，每条 ≤512 字符)
  filenamesTruncated?: true          // 原始 filenames 超过 20 条
  truncated?: true                   // 工具自身 head_limit 截断
}
```

- **有界纪律**：display 不经 tool result budget（result-display.ts 既有教训），
  所有字段自带上限；不携带任何内容正文（content 属于 output.text 唯一所有）。
- 仅 Read 的 `type:"text"` 输出产生 display；image/video/pdf/parts/notebook
  与 file_unchanged 不产生（保持既有卡形态）。
- URL 直读元数据经 read-url.ts 的 WeakMap 侧信道传递（`readUrlDisplayMeta`）：
  ReadTextOutput 契约（397/400 行）不加字段，display 装配器按 output 对象身份
  取回结构化 url 元数据——不解析 summaryFooter 文本（反模式明令禁止）。

### R2 装配点（core `executor/read-search-result-display.ts` 新文件）

`createToolResultDisplay` 增加显式分支：`Read` → createReadResultDisplay；
`Grep`/`Glob` → createSearchResultDisplay。分支先于通用 file_diff fallback
（ReadTextOutput 有 filePath 但无 structuredPatch，语义不冲突，顺序只为明确）。
构造前用 contracts 的输出 schema safeParse（Grep/Glob）或 type 判定（Read），
解析失败返回 undefined（fail-safe：无 display 时 UI 走 fallback，不报错）。

### R3 wire 镜像（packages/shared v4 `toolDisplay.ts`）

`toolResultDisplaySchema` union 增加 `read` / `search` 两个 strict 成员，字段表
与 R1 完全一致（两侧 strict、缺成员=整块被剥的既有教训在文件头注释重申）。
schema 导出供 UI 查表解析（R4）。`toolCallDisplaySchema`（call 侧）不动——
read/search 事实全部是结果侧。

### R4 UI 消费（packages/ui）

- `ToolCallBlocks/toolResultDisplay.ts`：read/search 两 kind 进
  「kind → shared strict schema safeParse」查表（与工作流六件套同一纪律：
  UI 不手写第二套结构校验）；`ToolResultDisplay` union 增加两个 schema 推断类型。
- `renderers/read.tsx`：display 命中时 ReadSummary 以 `display.filePath` 为
  唯一权威（不再走 `<path>` 标签抽取）；secondaryText 追加行窗事实
  （`L{start}–{end} / {total}`）与徽章（冲突检出/已摘要/已截断；URL 读显示
  finalUrl 状态与缓存命中，图标换 Globe）。display 缺席 → 既有启发式链原样
  fallback（旧 row/旧 agent 兼容）。
- `renderers/search.tsx`：display 命中时追加结果事实行
  「{matches} 处匹配 · {files} 个文件」（无 matches 用 files-only 键；
  filenamesTruncated/truncated 以「+」尾注表达）。pattern 摘要仍来自 input
  透传（input 本就结构化，无需 display 重复携带）。
- i18n：zh/en 各 6 键（read 徽章 3 + url 1 + search 结果 2）。

### R5 边界与兼容

- 旧 CLI + 新 UI：无 display → fallback，零变化。
- 新 CLI + 旧 UI：display 解析失败被 `.catch(undefined)` 剥掉 → 旧行为，零崩溃。
- MCP/插件工具不受影响（分支只认 Read/Grep/Glob 三个内置名）。
- knip：新 contracts/core 文件经既有 barrel 导出（contracts index、executor
  内部导入），无新入口需求时不动 knip.jsonc。

## 状态所有者

- payload schema 唯一权威：contracts `tools/read-search-display.ts`；
  shared v4 镜像成员注释互指（同步纪律同 mcp_tool/create_workflow 先例）。
- URL 元数据唯一来源：read-url.ts（WeakMap 侧信道，对象身份键）。
- UI 结构化解析唯一通道：toolResultDisplay.ts 查表。

## 验收场景

1. Read 文件成功 → display kind:"read"（filePath/startLine/numLines/totalLines）；
   带 offset/limit 的行窗读数字如实。
2. conflict:// 检出读 → conflicts:true；结构摘要读 → summarized:true；
   超预算截断 → truncated:true。
3. URL 直读（缓存种子）→ url.{finalUrl,status,contentType,cacheHit} 完整，
   且不解析 footer 文本（builder 单测钉住 WeakMap 通道）。
4. Grep content 模式 → mode/numMatches/numLines/numFiles；filenames>20 →
   前 20 + filenamesTruncated:true。Glob → tool:"glob" + numFiles/filenames。
5. Read image/pdf 输出、Grep 畸形输出 → undefined（fail-safe，无 display）。
6. shared v4 union 接受两种新成员、拒绝字段表外键（strict）；旧成员零回归。
7. UI parseDisplay：合法 read/search display 解析保真；缺字段/多字段 → undefined
   → 渲染 fallback 不崩溃。
8. read.tsx：display 命中时不再调用 `<path>` 标签抽取（filePath 权威）；
   display 缺席时启发式链行为与改动前一致（既有测试全绿）。

## 范围外（登记）

- todo display（input 透传已结构化，D4 置换是 UI 投影问题，不新增 wire 成员）。
- lsp/web_search/memory details（后续批次，通道与查表模式已就位）。
- filenames 的 per-file 匹配行号（omp match-line-format 对应物，需 grep 输出
  扩结构化 matches——单独批次）。
