import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { latestRealUserPlainTextQuery } from "./memory-semantic-recall.js";

/**
 * ultracode 关键词触发（specs/script-workflow-revival.md 批次 C2）。
 *
 * 用户在**普通 prompt** 里打出 `ultracode` 这个词，即视为本轮显式选择脚本工作流编排，
 * 于是给模型注入一条 system-reminder 确认这件事，并点名该用哪个工具。
 *
 * 为什么需要它：`RunWorkflow` 的工具描述要求「用户显式选择」才允许调用，而模型判断
 * 「显式」的唯一依据就是用户自己的措辞。没有这条 reminder，一个打了关键词的用户得到的
 * 是模型自行揣测；有了它，选择这件事由 harness 判定并明确告知，模型不必猜。
 *
 * 与 `/ultracode` 命令的分工（两者不会重复触发）：命令走 bootstrap 的 builtin prompt 展开，
 * 展开正文已经指示了该用哪个工具与先加载哪个技能；而展开前言里有一行 harness 自己写的
 * `Run custom command /ultracode.`，那不是用户措辞，所以匹配规则排除斜杠形态
 * （见 ULTRACODE_KEYWORD_PATTERN）。关键词路径覆盖的是「用户没用命令、只是在话里提了这个词」。
 *
 * 生命周期与 memory_semantic_recall 同款：per-request 动态段、不落 session。正文完全由
 * 当轮用户文本派生，冷恢复后下一 turn 重新判定即可——持久化反而会把「某轮的措辞」
 * 伪装成「会话事实」，而会话级的常开是另一件事（见文件末尾的未做说明）。
 */

/** 触发词。刻意是小写字面量：匹配时大小写不敏感，这里只作为唯一真源存在。 */
export const ULTRACODE_KEYWORD = "ultracode";

/**
 * 整词匹配，大小写不敏感，且**排除斜杠命令形态**（`/ultracode`）。
 *
 * 整词而不是子串：`ultracode` 会作为子串出现在别的词里（例如某个项目自己的 `ultracodegen`
 * 脚本名），子串匹配会把一次无意的提及变成「用户要求起几十个 agent」。这个方向的误判代价
 * 是不对称的——多起一次编排是真实的钱与时间。
 *
 * 排除 `/ultracode`：命令路径由 bootstrap 的 builtin 展开负责，而
 * `expandCustomCommandPrompt` 生成的前言里有一行 `Run custom command /ultracode.`——
 * 那是 **harness 写的**，不是用户措辞。若不排除，一次 `/ultracode <任务>` 会额外注入一条
 * 声称「用户在自己的消息里打了这个词」的 reminder：既重复（展开正文已经指示了工具与技能），
 * 又对来源说谎。负向后顾只吃掉紧跟斜杠的那一次出现，用户在散文里打的词照常命中。
 */
const ULTRACODE_KEYWORD_PATTERN = /(?<!\/)\bultracode\b/iu;

export function containsUltracodeKeyword(text: string | null | undefined): boolean {
  if (!text) return false;
  return ULTRACODE_KEYWORD_PATTERN.test(text);
}

/**
 * 本轮是否应当注入 ultracode reminder。
 *
 * `dynamicWorkflowEnabled === false` 时返回 false——灰度关着的时候十个 dwf 工具与
 * RunWorkflow 都不注册，此时告诉模型「用户已选择多代理编排、去用 RunWorkflow」等于
 * 把它指向一个不存在的工具。技能面（dynamic-workflow-gate.ts）与命令面
 * （builtin-prompt-command.ts）做的是同一件事，这里必须同结论。
 * 极性与工具注册层一致：只有显式 false 才算关（缺席 = 不参与灰度 = 保留）。
 */
export function shouldEmitUltracodeKeywordReminder(input: {
  dynamicWorkflowEnabled?: boolean;
  entries: readonly RuntimeMessageEntry[];
}): boolean {
  if (input.dynamicWorkflowEnabled === false) return false;
  return containsUltracodeKeyword(latestRealUserPlainTextQuery(input.entries));
}

/**
 * reminder 正文。
 *
 * 三件事，一件都不能少：
 *   1. 说明**是谁**做的选择（用户自己的措辞），这样模型不会把它当成 harness 的自作主张；
 *   2. 点名 `RunWorkflow` 而不是笼统的「多代理编排」——仓库里有两套工作流系统，
 *      说「用工作流」会让模型在 CreateWorkflow 与 RunWorkflow 之间掷骰子；
 *   3. 保留技能前置：RunWorkflow 在未加载 `script-workflows` 前会拒绝接受脚本，
 *      不提醒就会白跑一次被拒的调用。
 *
 * 同时明确**本轮限定**：这不是会话级常开，下一轮回到工具描述里的常规门槛。
 * 不说清这一点，模型会把一次关键词当成整个会话的授权，之后每轮都起编排。
 */
export function buildUltracodeKeywordReminderBody(): string {
  return [
    `The user included the keyword "${ULTRACODE_KEYWORD}" in their own message, opting THIS TURN into script-workflow orchestration.`,
    "Use the `RunWorkflow` tool to fulfil the request — not `CreateWorkflow` (that is the other workflow system and takes a different script form), and not the `Agent` tool.",
    "Load the `script-workflows` skill first: `RunWorkflow` refuses a script until that skill has been loaded in this session.",
    "This opt-in covers the current turn only. On later turns the normal rule in the tool description applies again unless the user opts in again.",
  ].join(" ");
}

// 未做（刻意，且已在 spec 登记）：**会话级常开**。参考产品用一个 10 分钟的 sticky 窗口
// 把「打一次关键词」升级成「接下来一段时间每轮都默认起编排」。这里不实现，因为它要引入
// 一份带过期时间的会话态，而那份状态的所有者、与 compact/rewind/冷恢复的交互、以及退出
// 路径都需要先定清楚——一份没人拥有、恢复语义不明的计时器，比没有这个功能更糟。
