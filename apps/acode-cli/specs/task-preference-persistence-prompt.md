# 任务级沟通偏好的持续性（一段文本）

提示词优化批次二（2026-10-03，Codex 还原件结构性对照批）项二。给
`behavior.dynamic` 的沟通指导补一条**偏好持续性**规则：用户在本任务内设定的
沟通偏好（更新频率、详略、节奏、呈现方式）是**任务级状态**，不是一次性请求；
中途不得因为后台事件到达就静默回落默认风格。

文本自撰英文（`prompt-language-policy.md` R1/R7）。

## 背景

- 已观察的失效形态：用户说「别一步步汇报，做完再说」，两次工具调用后模型回到
  逐动作播报；或用户要求详细进度，一条后台任务通知插入后又缩回单行答复。
  共同根因：模型把偏好句子当**单轮修饰**处理，新事件（尤其 task-notification /
  后台消息）到来时按缺省风格重新起笔。
- 既有承载检查：`COMMUNICATION_PROMPTS`（`context/dynamic-sections.ts:27-47`）
  管「怎么写」（可读性、结论先行、匹配问题形态），`CONTEXT_MANAGEMENT_PROMPTS`
  管上下文经济与自治纪律；**均无跨轮持续性语义**。纪律节第 4 条管通知的信任
  姿态，不管沟通风格。无重复承载。
- ACode 的后台通知频繁（task-notification、steering 消息），该失效面比单线程
  产品更大——通知文本自带「新事件」语境，最容易触发风格重置。

## 产品规则

### R1 文本要素（承载点：COMMUNICATION_PROMPTS.additional.beforeDefault 末尾新段）

一段（≤ 3 句），要素：

1. 用户关于更新频率、详略、节奏、呈现方式的指示是**当前任务的持续偏好**，
   不是一次性请求；持续到任务完成或用户改变偏好为止。
2. 新事件（后台通知、工具结果、turn 切换）到来时按既定偏好继续，
   **不得静默回落默认风格**。
3. 与既有边界不冲突：偏好约束「怎么说」，不豁免「必须说」——最终消息完整性
   纪律（turn 末交付所有用户需要的内容）与如实汇报纪律优先于风格偏好。

### R2 承载与分组

- 进 `behavior.dynamic`（dynamic 组、persistable 段）：与其余沟通指导同段同
  cache 分组；manifest 再生成。
- 不进 reminder（对照 `reminder-extensions.md` R4：system 段每请求在场，
  无需周期重申；若 eval 显示长会话后失效再立项）。
- 不改 `CONTEXT_MANAGEMENT_PROMPTS`（那边管上下文经济，本条管沟通一致性）。

## 验收场景

1. 文本在场：`buildDynamicBehaviorSection().content` 含持续性三要素关键句；
   位于沟通指导区（"Match the response to the question" 段之后）；
   既有各段逐字保留；无 CJK。
2. manifest 再生成后 check 过；仅 `behavior.dynamic` hash 变化。
3. 验证命令（仓库根执行，如实记录）：`pnpm typecheck`、`pnpm lint`、
   `node --import tsx --test apps/acode-cli/tests/*.test.mjs`。

## 不在本项范围

- 偏好的**结构化持久化**（跨任务记忆用户风格偏好）：那是 memory 段的既有
  职能（feedback 类记忆），不另建状态。
- output style 机制（`built-in-output-styles.md`）：风格是会话级配置，
  本条是任务内即兴偏好的持续性，两者承载不同、互不复述。
