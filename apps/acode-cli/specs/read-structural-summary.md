# read 结构化摘要与路径选择器（大文件省 token 阅读面）

> 状态：实施中（UX 波第 2 件，编排器单人，配额墙窗口内）
> 机制参照：oh-my-pi (MIT) packages/coding-agent/src/tools/read.ts /
> read-summary.ts / read-selector.ts，Copyright (c) 2025 Mario Zechner &
> Stencil Labs。omp 用 tree-sitter（Rust natives）做结构摘要；ACode 解析器
> 换 **typescript 编译器 API**（core 既有依赖，ts.createSourceFile 轻量单文件
> 解析，无原生/wasm 新增），语言覆盖面收窄为 JS/TS 族，其余语言零行为变化。

## 背景与动机

ACode read 大文件现状：整读进 token 预算截断（partial view）或模型手动
offset/limit 翻页。omp 的答案是「摘要化片段 + 理想默认 + 选择器命中率」：
大文件默认返回**结构摘要**（签名+文档注释保留、长函数体折叠成带原行号的
标记），模型按需用选择器精确展开——同一份文件从「2000 行倾倒」变「80 行
骨架 + 按需展开」，token 账单与命中率双收益。

## 产品规则

### R1 摘要资格门（全部满足才摘要，否则现行为零变化）

- 扩展名 ∈ JS/TS 族（.ts/.tsx/.js/.jsx/.mjs/.cjs）；
- 整读（无 offset/limit）且非 raw 选择器；
- 行数 ≥ minTotalLines（默认 300，env `ACODE_READ_SUMMARY_MIN_LINES` 可调）；
- 文件大小 ≤ 2MiB、行数 ≤ 20000（omp 同款上限）；
- ts.createSourceFile 解析出至少一个可折叠声明（全平铺脚本不摘要）；
- 总开关 `ACODE_READ_SUMMARIZE=0/false/off` 关闭（脏值→开启，与密钥混淆
  开关同纪律）；prose（md/txt）永不进代码摘要（omp isProseSummaryPath 同款，
  ACode 无 prose 摘要器故直接跳过）。

### R2 折叠规则（typescript AST，保留语义锚点）

- **保留原样**：import/export-from（连续 >10 条折叠为计数行+首尾样例）、
  顶层语句、装饰器、JSDoc/行注释（贴着被折叠体的保留——注释是模型理解的
  主要锚点）、interface/type/enum 全文（≤ unfoldLimit 行时）。
- **折叠**：函数/方法/箭头函数体、class 成员体、超长对象/数组字面量——
  条件 = 体行数 ≥ minBodyLines（默认 8）；折叠渲染为单行标记：
  `  // … body folded: N lines (L<start>-L<end>) — read "<path>:<start>-<end>" to expand`
  （标记内含展开选择器，自解释）。
- **unfoldLimit**（默认 40 行）：体行数 ≤ 该值的声明整体保留不折叠（小函数
  是理解主力，折叠反而费二次读取）。
- 行号锚定：摘要输出按**原文件行号**编号（保留段用原行号，折叠标记占一行
  但标注原区间），与 addReadLineNumbers 显示口径一致。

### R3 路径选择器（file_path 后缀语法，read 工具面）

**阶段 1（本增量交付）**：`path:N-M` / `path:N`（单行）/ `path:N-`（开区间，
折算 offset 无 limit）/ `path:raw`（绕过摘要）/ 组合 `path:raw:N-M`。单区间
折算为既有 offset/limit 参数（零流程改动）；raw 置 suppressSummary。
**阶段 2（解析器已就位，接线登记）**：`:-N` 尾读（需先取总行数）、
`N-M,K-J` 多区间（sliceLineRanges 已实现）、`:conflicts`（复用 conflict 模块
检出仅渲染冲突块）、`:img`（SVG 渲染，omp 面 ACode 无对应）。阶段 2 形态
当前 fail-loud 给可操作替代指引（recoverable，绝不静默按字面路径读）。
- **Windows 盘符安全**（平台对称纪律，教训⑦）：仅当最后一个 `:` 后的片段
  完整匹配选择器文法才拆分；且拆分前先按原样路径 stat——文件真实存在则
  优先按路径解释（`C:\x\y.ts` 的 `:` 后是 `\x\y.ts` 不匹配文法，天然安全；
  `notes:raw` 这种真实文件名存在的极端 case 按文件优先）。
- 越界区间 fail-loud 给可操作信息（总行数+建议区间）；选择器读**永不摘要**
  （已是精确窗口）。
- contracts ReadInput.file_path describe 增补选择器语法一句（模型可发现性）。

### R4 摘要尾注（elision footer）

摘要输出尾部固定尾注：折叠统计（N 个函数体/M 行被折叠）+ 展开指引（选择器
语法一行示例）+ 提示 offset/limit 等价可用。选择器命中信息不进遥测（omp
selector-hit-rate 面 ACode 无对应遥测通道，登记不做）。

### R5 缓存

内容哈希（sha1 前 16 位）+ 路径 + 阈值参数为键的进程级 LRU（48 条，omp 同
款上界）；文件每次读取都是新鲜的，命中只复用确定性解析结果——无陈旧窗口。
解析失败（语法错误文件）memo 为 false（不重复解析坏文件），退化为现行为。

### R6 状态所有权与边界

- 摘要器是纯函数层（text+path+config → folded lines），无会话态；缓存在
  read-summary 模块内（进程级，与 stable-prefix LRU 同哲学）。
- 与 conflict 检出协同：摘要模式下冲突块**不折叠**（marker 行是顶层扫描面，
  R1 检测照常跑在摘要前原文上——检出用原始行，尾注共存）。
- 与 LSP 诊断回流（波 1 WI-1）零交集：摘要只影响 read 输出，不影响 edit/
  write 诊断钩子。
- 非 JS/TS 文件的「摘要」不做（无解析器面）：现行为（窗口+截断）不变，
  登记后续（wasm tree-sitter 或各语言轻量 outline 属独立立项）。

## 落点与所有权

- 新模块 `core/src/tool/read-summary/{fold.ts,selector.ts,cache.ts,config.ts,index.ts}`
  （各 ≤400 行；fold.ts 若超限按声明类别拆）。
- 接线：handlers/read.ts（选择器拆分+分支，最小 diff——532 行 ratchet 面，
  超预算则抽 read-selector-branch.ts helper）、read-text.ts（摘要模式接入
  formatReadTextOutput 上游）。
- contracts：ReadInput file_path describe 增补；ReadTextOutput 增可选
  `summaryElided?: { foldedBlocks: number; foldedLines: number }`（尾注数据源）。

## 验收场景

1. 折叠矩阵：函数/方法/箭头/类成员/超长字面量各形态；≤unfoldLimit 保留；
   JSDoc 保留；import 折叠计数；全平铺脚本不摘要。
2. 资格门：小文件/非 JS-TS/prose/开关关闭/解析失败 → 输出与现行为逐字节一致
   （零回归断言）。
3. 选择器：区间/单行/开区间/尾 N/多区间/raw/conflicts/组合；Windows 盘符
   不拆分（`C:\a\b.ts` 整路径解释）；真实文件名含冒号优先按文件；越界
   fail-loud。
4. 行号锚定：折叠标记的 L 区间与原文行号一致，展开读取内容与折叠体逐字节
   相等。
5. 缓存：同内容二次读命中（解析调用计数断言）；内容变即失效；坏文件 memo。
6. 冲突协同：含冲突块的大文件摘要输出中 marker 行原样保留且 conflict 注册
   照常（尾注+摘要尾注共存顺序：摘要尾注在前、冲突尾注在后）。
7. 存量零回归：read/read-text 相关既有测试全绿；partial view/truncated 语义
   与摘要互斥（摘要只在整读路径生效）。
