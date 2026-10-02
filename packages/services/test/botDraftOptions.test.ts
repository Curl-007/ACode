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

// 验收 2/5：引擎联合只剩 native(glm)（spec: agent-engine-external-slots-removal.md）。
// 旧槽位值（codex/opencode/gemini）与未知脏数据不再被拒绝，而是在 schema 层归一为 glm
// ——这是旧持久化 bot 配置无需迁移的兼容前提。
test("draftOptions.provider and currentOptions.cli normalize legacy engine values to glm", () => {
  for (const legacy of ["glm", "codex", "opencode", "gemini", "nope"]) {
    const draft = botDraftOptionsSchema.safeParse({ provider: legacy, mode: "build" });
    assert.equal(draft.success, true, `${legacy} draft should parse`);
    assert.equal(draft.success && draft.data.provider, "glm", `${legacy} should normalize to glm`);

    const current = botCurrentOptionsSchema.safeParse({ cli: legacy, mode: "build" });
    assert.equal(current.success, true, `${legacy} currentOptions should parse`);
    assert.equal(current.success && current.data.cli, "glm");
  }
});

// host 归一：normalizeBotCurrentOptions 保留 mode 并把旧引擎值归一为 glm。
test("normalizeBotCurrentOptions preserves mode and normalizes legacy cli", () => {
  const normalized = normalizeBotCurrentOptions({ cli: "gemini" as never, mode: "plan" });
  assert.equal(normalized.cli, "glm");
  assert.equal(normalized.mode, "plan");

  // 非法/未知 cli 回退 native，不抛错（旧数据兼容）。
  assert.equal(normalizeBotCurrentOptions({ cli: "bogus" as never }).cli, "glm");
  // 缺省不写 cli，保持既有 bot 行为零变化。
  assert.equal("cli" in normalizeBotCurrentOptions({ mode: "yolo" }), false);
});

// 草稿归一（host config 层）：provider 透传，modelSelection/mode 仅在合法时保留。
// 引擎归一发生在 schema 层（见验收 2），config 层只做形状整理。
test("normalizeBotDraftOptions preserves provider and mode", () => {
  assert.equal(normalizeBotDraftOptions({ provider: "glm" }).provider, "glm");
  assert.equal(
    normalizeBotDraftOptions({ provider: "glm", mode: "build" }).mode,
    "build",
  );
  // 空 mode 不写回，避免污染 .strict() 草稿 schema。
  assert.equal("mode" in normalizeBotDraftOptions({ provider: "glm" }), false);
});

// /engine 命令已随外部引擎槽位下线移除：DEFAULT_BOT_COMMANDS 不再写入 engine，
// 严格 schema 仍宽容接受旧配置残留的 engine 字段（/cli 先例）。
test("DEFAULT_BOT_COMMANDS omits engine and schema tolerates legacy field", () => {
  assert.equal(DEFAULT_BOT_COMMANDS.engine, undefined);
  assert.equal(botAllowedCommandsSchema.safeParse({ ...DEFAULT_BOT_COMMANDS }).success, true);
  assert.equal(
    botAllowedCommandsSchema.safeParse({ ...DEFAULT_BOT_COMMANDS, engine: false }).success,
    true,
  );
});

// 验收 4：/engine 与 /引擎 按未知命令解析（命令已下线）。
test("parseBotCommand treats /engine tokens as unknown", () => {
  assert.deepEqual(parseBotCommand("/engine"), { type: "unknown", name: "engine", raw: "/engine" });
  assert.deepEqual(parseBotCommand("/引擎 glm"), {
    type: "unknown",
    name: "引擎",
    raw: "/引擎 glm",
  });
  // /mode 仍解析（下游不再回 modeLocked）。
  assert.deepEqual(parseBotCommand("/mode build"), { type: "mode.set", value: "build" });
  assert.deepEqual(parseBotCommand("/mode"), { type: "mode.list" });
});
