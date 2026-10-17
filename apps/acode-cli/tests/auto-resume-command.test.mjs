// 验收场景 7（apps/acode-cli/specs/turn-auto-resume.md）：命令解析全谱（时长格式/上限/
// msg 占位符/status 回执），回执随 locale（zh/en）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTO_RESUME_MAX_PAUSE_MS,
  formatAutoResumeDuration,
  handleAutoResumeCommand,
  normalizeAutoResumeLocale,
  parseAutoResumeCommand,
  parseAutoResumeDuration,
} from "../packages/core/src/runtime/auto-resume/command.ts";

describe("parseAutoResumeDuration - 全谱", () => {
  const valid = [
    ["45s", 45_000],
    ["30m", 1_800_000],
    ["2h", 7_200_000],
    ["1d", 86_400_000],
    ["90", 5_400_000], // 纯数字 = 分钟
    ["1h30m", 5_400_000],
    ["1H 30M", 5_400_000], // 大小写不敏感 + 空白分隔
    ["30d", AUTO_RESUME_MAX_PAUSE_MS], // 上限边界合法
    ["43200", AUTO_RESUME_MAX_PAUSE_MS], // 43200 分钟 = 30 天
  ];
  for (const [input, expected] of valid) {
    it(`parses "${input}"`, () => {
      const result = parseAutoResumeDuration(input);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.durationMs, expected);
    });
  }

  const invalid = ["", "0", "0s", "-5", "31d", "43201", "abc", "10x", "1.5h", "d", "1dd"];
  for (const input of invalid) {
    it(`rejects "${input}"`, () => {
      const result = parseAutoResumeDuration(input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.error.length > 0);
    });
  }
});

describe("parseAutoResumeCommand", () => {
  function intent(args) {
    const parsed = parseAutoResumeCommand(args);
    assert.equal(parsed.ok, true, args);
    if (!parsed.ok) throw new Error("unreachable");
    return parsed.intent;
  }

  it("status forms", () => {
    assert.deepEqual(intent(""), { kind: "status" });
    assert.deepEqual(intent("status"), { kind: "status" });
    assert.deepEqual(intent("  STATUS  "), { kind: "status" });
  });

  it("bare on/off persist config", () => {
    assert.deepEqual(intent("on"), { enabled: true, kind: "setEnabled", persist: true });
    assert.deepEqual(intent("off"), { enabled: false, kind: "setEnabled", persist: true });
  });

  it("off <duration> is an in-process pause", () => {
    assert.deepEqual(intent("off 30m"), { durationMs: 1_800_000, kind: "pause" });
    assert.deepEqual(intent("off 2h"), { durationMs: 7_200_000, kind: "pause" });
  });

  it("msg set/clear", () => {
    assert.deepEqual(intent("msg keep going {count}/{max}"), {
      kind: "setContinueMessage",
      message: "keep going {count}/{max}",
      persist: true,
    });
    assert.deepEqual(intent("msg clear"), {
      kind: "setContinueMessage",
      message: null,
      persist: true,
    });
    assert.deepEqual(intent("msg CLEAR"), {
      kind: "setContinueMessage",
      message: null,
      persist: true,
    });
    // "clear" 后仍有正文 = 用户消息本体，不是清除指令。
    assert.deepEqual(intent("msg clear the build cache"), {
      kind: "setContinueMessage",
      message: "clear the build cache",
      persist: true,
    });
  });

  it("rejects malformed input with usage text", () => {
    for (const args of ["on 5m", "off xyz", "msg", "bogus", "enable"]) {
      const parsed = parseAutoResumeCommand(args);
      assert.equal(parsed.ok, false, args);
      if (!parsed.ok) assert.ok(parsed.error?.includes("/auto-resume"));
    }
  });

  it("rejects over-long messages", () => {
    const parsed = parseAutoResumeCommand(`msg ${"x".repeat(4_001)}`);
    assert.equal(parsed.ok, false);
  });
});

describe("handleAutoResumeCommand receipts", () => {
  function createHost(overrides = {}) {
    const applied = [];
    const outcome = { configPath: "/tmp/config.json", ok: true };
    const host = {
      apply: (intent) => {
        applied.push(intent);
        return outcome;
      },
      getStatus: () => undefined,
      ...overrides,
    };
    return { applied, host, outcome };
  }

  const status = {
    configEnabled: true,
    count: 2,
    enabled: true,
    lastSignature: "rate_limit|429|3007",
    maxResumes: 8,
    pendingResumeAtMs: 1_700_000_060_000,
    repeats: 2,
  };

  it("status receipt carries toggle/message/count/repeats (en)", async () => {
    const { host } = createHost({ getStatus: () => status, now: () => 1_700_000_000_000 });
    const { response } = await handleAutoResumeCommand("status", host);
    assert.ok(response.includes("auto-resume: enabled"));
    assert.ok(response.includes("continue message: default"));
    assert.ok(response.includes("2/8"));
    assert.ok(response.includes("rate_limit|429|3007"));
    assert.ok(response.includes("next resume at"));
  });

  it("status receipt follows zh locale and shows pause expiry", async () => {
    const paused = {
      ...status,
      continueMessage: "继续 {count}",
      pausedUntilMs: 1_700_000_000_000 + 1_800_000,
    };
    const { host } = createHost({
      getLocale: () => "zh-CN",
      getStatus: () => paused,
      now: () => 1_700_000_000_000,
    });
    const { response } = await handleAutoResumeCommand("status", host);
    assert.ok(response.includes("跨回合自动继续：已启用"));
    assert.ok(response.includes("暂停至："));
    assert.ok(response.includes("继续指令：自定义"));
    assert.ok(response.includes("相同错误签名连续 2×"));
  });

  it("bare on/off receipts include the persisted configPath", async () => {
    const { applied, host } = createHost();
    const on = await handleAutoResumeCommand("on", host);
    assert.ok(on.response.includes("auto-resume enabled"));
    assert.ok(on.response.includes("/tmp/config.json"));
    const off = await handleAutoResumeCommand("off", { ...host, getLocale: () => "zh-CN" });
    assert.ok(off.response.includes("已停用跨回合自动继续"));
    assert.deepEqual(
      applied.map((intent) => intent.kind),
      ["setEnabled", "setEnabled"],
    );
  });

  it("pause receipt formats the duration", async () => {
    const { applied, host } = createHost({ now: () => 1_700_000_000_000 });
    const { response } = await handleAutoResumeCommand("off 30m", host);
    assert.ok(response.includes("paused for 30m"));
    assert.deepEqual(applied, [{ durationMs: 1_800_000, kind: "pause" }]);
  });

  it("msg receipts and host without apply surface degrade gracefully", async () => {
    const { host } = createHost();
    const set = await handleAutoResumeCommand("msg keep going", host);
    assert.ok(set.response.includes("Custom continue message saved"));
    const clear = await handleAutoResumeCommand("msg clear", host);
    assert.ok(clear.response.includes("cleared"));

    const bare = {};
    const unavailable = await handleAutoResumeCommand("on", bare);
    assert.ok(unavailable.response.includes("not available"));
    const noStatus = await handleAutoResumeCommand("status", bare);
    assert.ok(noStatus.response.includes("not available"));
  });

  it("invalid args return the usage text without touching the host", async () => {
    const { applied, host } = createHost();
    const { response } = await handleAutoResumeCommand("off nope", host);
    assert.ok(response.includes("Usage: /auto-resume"));
    assert.equal(applied.length, 0);
  });

  it("apply failure surfaces the structured error", async () => {
    const { host } = createHost({ apply: () => ({ error: "disk on fire", ok: false }) });
    const { response } = await handleAutoResumeCommand("on", host);
    assert.equal(response, "disk on fire");
  });
});

describe("locale + duration formatting helpers", () => {
  it("normalizes locale closed-set style", () => {
    assert.equal(normalizeAutoResumeLocale("zh-CN"), "zh");
    assert.equal(normalizeAutoResumeLocale("zh"), "zh");
    assert.equal(normalizeAutoResumeLocale("en-US"), "en");
    assert.equal(normalizeAutoResumeLocale("auto"), "en");
    assert.equal(normalizeAutoResumeLocale(undefined), "en");
  });

  it("formats durations for receipts", () => {
    assert.equal(formatAutoResumeDuration(1_800_000, "en"), "30m");
    assert.equal(formatAutoResumeDuration(7_200_000, "en"), "2h");
    assert.equal(formatAutoResumeDuration(90_000_000, "en"), "1d 1h");
    assert.equal(formatAutoResumeDuration(1_800_000, "zh"), "30分钟");
    assert.equal(formatAutoResumeDuration(45_000, "en"), "45s");
  });
});
