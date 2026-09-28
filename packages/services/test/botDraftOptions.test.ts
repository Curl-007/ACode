import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_BOT_COMMANDS,
  botAllowedCommandsSchema,
  botCurrentOptionsSchema,
  botDraftOptionsSchema,
  botsConfigFileSchema,
  botsStateFileSchema,
} from "@acode/shared";
import { normalizeBotCurrentOptions, normalizeBotDraftOptions } from "../src/bots/config.js";
import { parseBotCommand } from "../src/bots/commandParser.js";

// 验收 1/5：既有配置（无 cli/mode）严格 schema round-trip 保持有效；草稿缺省引擎仍是 native(glm)，
// 缺省权限模式为受审批的 build（安全加固 P0-3：远程入口天花板，不再缺省 yolo）。
test("bot config round-trips through strict schemas without engine/mode", () => {
  const legacyBot = {
    id: "bot-1",
    name: "Legacy",
    provider: "telegram",
    enabled: true,
    allowedWorkspaces: ["*"],
    allowedCommands: {
      status: true,
      new: true,
      workspace: true,
      model: true,
      thoughtLevel: true,
      reply: true,
    },
    currentOptions: {},
    replyMode: "assistant_changes",
  };
  const parsed = botsConfigFileSchema.safeParse({ version: 3, bots: [legacyBot] });
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));

  const state = botsStateFileSchema.safeParse({
    version: 3,
    bots: {
      "bot-1": {
        botId: "bot-1",
        workspacePath: "/repo",
        mode: "draft",
        activeTaskId: null,
        draftOptions: { provider: "glm" },
        updatedAt: 1,
      },
    },
  });
  assert.equal(state.success, true, state.success ? "" : JSON.stringify(state.error.issues));
});

// 验收 2/5：写入含 cli（引擎）+ mode（权限模式）的配置后，严格 schema 仍能解析；
// 草稿 provider 接受引擎枚举的每个成员。
test("currentOptions.cli and draftOptions.provider accept the engine enum", () => {
  for (const engine of ["glm", "codex", "opencode", "gemini"] as const) {
    const draft = botDraftOptionsSchema.safeParse({ provider: engine, mode: "build" });
    assert.equal(draft.success, true, `${engine} draft should parse`);

    const current = botCurrentOptionsSchema.safeParse({ cli: engine, mode: "build" });
    assert.equal(current.success, true, `${engine} currentOptions should parse`);
    assert.equal(current.success && current.data.cli, engine);
  }

  // 未知引擎仍被拒绝（.strict 枚举），保证脏数据不会静默落库。
  assert.equal(botDraftOptionsSchema.safeParse({ provider: "nope" }).success, false);
  assert.equal(botCurrentOptionsSchema.safeParse({ cli: "nope" }).success, false);
});

// host 归一：normalizeBotCurrentOptions 必须保留并归一 cli/mode（旧实现会吞掉 cli）。
test("normalizeBotCurrentOptions preserves cli and mode", () => {
  const normalized = normalizeBotCurrentOptions({ cli: "gemini", mode: "plan" });
  assert.equal(normalized.cli, "gemini");
  assert.equal(normalized.mode, "plan");

  // 非法/未知 cli 回退 native，不抛错（旧数据兼容）。
  assert.equal(normalizeBotCurrentOptions({ cli: "bogus" }).cli, "glm");
  // 缺省不写 cli，保持既有 bot 行为零变化。
  assert.equal("cli" in normalizeBotCurrentOptions({ mode: "yolo" }), false);
});

// 草稿归一（host config 层）：provider 透传，modelSelection/mode 仅在合法时保留。
// 引擎感知归一在 botsService 内层（normalizeAgentProviderToACodeAgent），且 schema 已用引擎枚举兜底。
test("normalizeBotDraftOptions preserves engine and mode", () => {
  assert.equal(normalizeBotDraftOptions({ provider: "codex" }).provider, "codex");
  assert.equal(normalizeBotDraftOptions({ provider: "gemini" }).provider, "gemini");
  assert.equal(
    normalizeBotDraftOptions({ provider: "glm", mode: "build" }).mode,
    "build",
  );
  // 空 mode 不写回，避免污染 .strict() 草稿 schema。
  assert.equal("mode" in normalizeBotDraftOptions({ provider: "glm" }), false);
});

// allowedCommands.engine：缺省开启，且严格 schema 接受该字段。
test("DEFAULT_BOT_COMMANDS enables engine and schema accepts it", () => {
  assert.equal(DEFAULT_BOT_COMMANDS.engine, true);
  assert.equal(botAllowedCommandsSchema.safeParse({ ...DEFAULT_BOT_COMMANDS }).success, true);
  assert.equal(
    botAllowedCommandsSchema.safeParse({ ...DEFAULT_BOT_COMMANDS, engine: false }).success,
    true,
  );
});

// 验收 4：/engine 与 /引擎 解析为 engine.list / engine.set。
test("parseBotCommand handles /engine tokens", () => {
  assert.deepEqual(parseBotCommand("/engine"), { type: "engine.list" });
  assert.deepEqual(parseBotCommand("/引擎"), { type: "engine.list" });
  assert.deepEqual(parseBotCommand("/engine codex"), { type: "engine.set", value: "codex" });
  assert.deepEqual(parseBotCommand("/引擎 glm"), { type: "engine.set", value: "glm" });
  // /mode 仍解析（下游不再回 modeLocked）。
  assert.deepEqual(parseBotCommand("/mode build"), { type: "mode.set", value: "build" });
  assert.deepEqual(parseBotCommand("/mode"), { type: "mode.list" });
});
