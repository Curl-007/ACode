// /ultracode 命令面：两套工作流系统的入口必须同时可见、同时被灰度门约束、同时是保留名。
// 依据：apps/acode-cli/specs/script-workflow-revival.md（批次 C 的命令面部分）。
//
// 这组测试钉的是「三个面同结论」：命令目录（App 的 `/` 面板与加号菜单）、正文展开
// （builtin-prompt-command）、工具面（core 的 GATED_WORKFLOW_TOOL_NAMES）。少一处就会出现
// 「目录里有入口 / 展开不出正文 / 工具不存在」这类分裂——而这类分裂对用户是不可解释的。

import assert from "node:assert/strict";
import test from "node:test";

const BOOTSTRAP = "../packages/bootstrap/src";
const CLI = "../packages/cli/src";

const { BUILTIN_ACODE_SLASH_COMMAND_HELP_ENTRIES } = await import(
  "../../../packages/shared/src/acode-slash-command-help.ts"
);
const { resolveACodeBuiltinPromptCommand } = await import(
  `${BOOTSTRAP}/builtin-prompt-command.ts`
);
const { listProtocolSlashCommands } = await import(`${BOOTSTRAP}/acode-protocol/slash-commands.ts`);
const {
  APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES,
  isReservedACodeSlashCommandName,
} = await import(`${BOOTSTRAP}/slash-command-surface.ts`);
const { parseSlashCommand } = await import(`${CLI}/command-center/slash-commands.ts`);

function helpEntry(name) {
  return BUILTIN_ACODE_SLASH_COMMAND_HELP_ENTRIES.find((entry) => entry.name === name);
}

// ---------------------------------------------------------------------------
// help 表：TUI 候选、/help、保留字的唯一来源
// ---------------------------------------------------------------------------

test("help 表里 /ultracode 与 /workflow 并列，且四件套齐全", () => {
  const ultracode = helpEntry("ultracode");
  assert.ok(ultracode, "/ultracode 必须在 BUILTIN_ACODE_SLASH_COMMAND_HELP_ENTRIES 里");
  assert.equal(ultracode.name, "ultracode");
  assert.ok(ultracode.summary.length > 0);
  assert.ok(ultracode.usage.startsWith("/ultracode"));
  assert.ok(ultracode.details.length >= 3);

  // details 必须把「这是另一套系统」说穿：用户看见两个相邻的工作流命令，
  // 第一反应一定是「它们有什么区别」。
  const joined = ultracode.details.join("\n");
  assert.match(joined, /RunWorkflow/);
  assert.match(joined, /script-workflows/);
  assert.match(joined, /export const meta/);
  assert.match(joined, /not interchangeable|另一套|other workflow system/);
});

test("保留字：ultracode 与 workflow 都不能被用户/插件的同名命令遮蔽", () => {
  assert.equal(isReservedACodeSlashCommandName("ultracode"), true);
  assert.equal(isReservedACodeSlashCommandName("/ultracode"), true, "带斜杠也要命中（归一化）");
  assert.equal(isReservedACodeSlashCommandName("ULTRACODE"), true, "大小写不敏感");
  assert.equal(isReservedACodeSlashCommandName("workflow"), true);
});

test("CLI parse：/ultracode 识别为 known 并带 args（否则会落到 unknown 分支报错）", () => {
  assert.deepEqual(parseSlashCommand("/ultracode audit the auth layer"), {
    args: "audit the auth layer",
    name: "ultracode",
    rawName: "ultracode",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/ultracode"), {
    args: "",
    name: "ultracode",
    rawName: "ultracode",
    type: "known",
  });
  // /workflow 不受影响。
  assert.equal(parseSlashCommand("/workflow x").name, "workflow");
});

// ---------------------------------------------------------------------------
// 正文展开
// ---------------------------------------------------------------------------

test("展开：/ultracode 指向 RunWorkflow 与 script-workflows，并显式劝退 CreateWorkflow", () => {
  const prompt = resolveACodeBuiltinPromptCommand("/ultracode audit the auth layer", {
    dynamicWorkflowEnabled: true,
  });
  assert.ok(prompt, "开关开启时必须展开出正文");
  assert.match(prompt, /RunWorkflow/);
  assert.match(prompt, /script-workflows/);
  assert.match(prompt, /export const meta/);
  assert.match(prompt, /audit the auth layer/, "$ARGUMENTS 必须被替换进正文");
  // 劝退另一套是硬要求：模型很可能刚在上一轮读过 dynamic-workflows，
  // 不点名它就会把那边的规则套过来。
  assert.match(prompt, /Do not use `CreateWorkflow`/);
  // 不许指向不存在的命令。
  assert.doesNotMatch(prompt, /\/workflows\b/);
});

test("展开：/workflow 仍指向 CreateWorkflow 与 dynamic-workflows（未被串味）", () => {
  const prompt = resolveACodeBuiltinPromptCommand("/workflow do a thing", {
    dynamicWorkflowEnabled: true,
  });
  assert.match(prompt, /CreateWorkflow/);
  assert.match(prompt, /dynamic-workflows/);
  assert.match(prompt, /do a thing/);
  assert.doesNotMatch(prompt, /RunWorkflow/, "/workflow 不该把模型引向另一套系统");
});

test("展开：dynamicWorkflowEnabled 缺席 → 两个命令都展开（缺席即开启）", () => {
  // 极性必须与工具面一致：core 的 includeDynamicWorkflow 也是「只有显式 false 才下架」。
  // 极性搞反的事故记录在 runtime/methods/embedded-search-branch.ts:31-38。
  assert.ok(resolveACodeBuiltinPromptCommand("/ultracode x"));
  assert.ok(resolveACodeBuiltinPromptCommand("/workflow x"));
});

test("展开：dynamicWorkflowEnabled === false → 两个命令都不展开", () => {
  // 返回 undefined 而不是报错：命令名是保留名，自定义命令解析也不会接手，
  // 于是原文作为普通 prompt 交给模型——与命令目录隐藏该入口是同一个结论。
  assert.equal(
    resolveACodeBuiltinPromptCommand("/ultracode x", { dynamicWorkflowEnabled: false }),
    undefined,
  );
  assert.equal(
    resolveACodeBuiltinPromptCommand("/workflow x", { dynamicWorkflowEnabled: false }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// 命令目录（App 的 `/` 面板与 composer 加号菜单都只读这份）
// ---------------------------------------------------------------------------

test("目录：两个工作流命令相邻展示，顺序由 APP_PROTOCOL_VISIBLE 决定", () => {
  const names = [...APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES];
  const workflowIndex = names.indexOf("workflow");
  const ultracodeIndex = names.indexOf("ultracode");
  assert.ok(workflowIndex >= 0 && ultracodeIndex >= 0, "两个命令都必须对 App 可见");
  assert.equal(
    ultracodeIndex,
    workflowIndex + 1,
    "相邻展示：用户才看得见这是两个不同的系统，而不是一个命令的两种拼写",
  );
});

test("目录：开关开启时两个命令都在；显式 false 时一起消失", async () => {
  const listed = await listProtocolSlashCommands({
    cwd: process.cwd(),
    dynamicWorkflowEnabled: true,
  });
  const listedNames = listed.map((command) => command.name);
  assert.ok(listedNames.includes("workflow"));
  assert.ok(listedNames.includes("ultracode"));

  const hidden = await listProtocolSlashCommands({
    cwd: process.cwd(),
    dynamicWorkflowEnabled: false,
  });
  const hiddenNames = hidden.map((command) => command.name);
  assert.ok(!hiddenNames.includes("workflow"), "灰度关时 /workflow 必须出目录");
  assert.ok(!hiddenNames.includes("ultracode"), "灰度关时 /ultracode 必须一起出目录");
  // 其余内置命令不受牵连。
  assert.ok(hiddenNames.includes("goal"));
  assert.ok(hiddenNames.includes("init"));
});

test("目录条目形状：description 取 summary、inputHint 取 usage", async () => {
  const listed = await listProtocolSlashCommands({
    cwd: process.cwd(),
    dynamicWorkflowEnabled: true,
  });
  const ultracode = listed.find((command) => command.name === "ultracode");
  assert.equal(ultracode.source, "builtin");
  assert.equal(ultracode.description, helpEntry("ultracode").summary);
  assert.equal(ultracode.inputHint, helpEntry("ultracode").usage);
});

// ---------------------------------------------------------------------------
// 与工具面同源
// ---------------------------------------------------------------------------

test("命令面与工具面同源：灰度关时 RunWorkflow 与两个命令一起下架", async () => {
  // 这条把「三个面同结论」钉成一个断言，而不是靠三处各自的测试碰巧一致。
  const { GATED_WORKFLOW_TOOL_NAMES } = await import(
    `../packages/core/src/tool/handlers/workflow-tool-names.ts`
  );
  assert.ok(GATED_WORKFLOW_TOOL_NAMES.has("RunWorkflow"));

  const hidden = await listProtocolSlashCommands({
    cwd: process.cwd(),
    dynamicWorkflowEnabled: false,
  });
  const hiddenNames = new Set(hidden.map((command) => command.name));
  assert.ok(!hiddenNames.has("ultracode"));
  assert.equal(
    resolveACodeBuiltinPromptCommand("/ultracode x", { dynamicWorkflowEnabled: false }),
    undefined,
  );
});
