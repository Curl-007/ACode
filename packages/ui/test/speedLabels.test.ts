// 消息级回复速度标签纯函数守护（packages/ui/specs/chat-row-facts.md 第 3 节）。
// 数据源 = 原生 turnHeader.stats（零协议扩展、零轮询）；口径：prefill = Σinput÷TTFT，
// decode = Σoutput÷ΣgenerationMs（与 TurnRateLine 同口径）。
// 核心不变量：缺席 ≠ 0——事实缺席/分母 0/分子 0 时标签为 null（整段隐藏），绝不显示 0。
import assert from "node:assert/strict";
import test from "node:test";
import { formatSpeedLabels } from "../src/v4/speedLabels.js";

const numberFormat = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

test("事实齐全时返回 ↑prefill 与 ↓decode 两个标签（含单位）", () => {
  const labels = formatSpeedLabels(
    { inputTokens: 12004, outputTokens: 886, timeToFirstTokenMs: 10000, generationMs: 10000 },
    numberFormat,
  );
  assert.equal(labels.prefillLabel, "1,200.4 tok/s");
  assert.equal(labels.decodeLabel, "88.6 tok/s");
});

test("TTFT=0（全缓存直出）时 prefill 隐藏、只显示 decode", () => {
  const labels = formatSpeedLabels(
    { inputTokens: 12004, outputTokens: 886, timeToFirstTokenMs: 0, generationMs: 10000 },
    numberFormat,
  );
  assert.equal(labels.prefillLabel, null);
  assert.equal(labels.decodeLabel, "88.6 tok/s");
});

test("stats 缺席（null / undefined，旧投影或内联兜底路径）时两个标签都隐藏", () => {
  for (const absent of [null, undefined]) {
    const labels = formatSpeedLabels(absent, numberFormat);
    assert.equal(labels.prefillLabel, null);
    assert.equal(labels.decodeLabel, null);
  }
});

test("optional 字段缺席（旧 server 快照缺 TTFT/generationMs）时对应段独立隐藏", () => {
  const noGeneration = formatSpeedLabels(
    { inputTokens: 5000, outputTokens: 400, timeToFirstTokenMs: 2500 },
    numberFormat,
  );
  assert.equal(noGeneration.prefillLabel, "2,000 tok/s");
  assert.equal(noGeneration.decodeLabel, null);

  const noTtft = formatSpeedLabels(
    { inputTokens: 5000, outputTokens: 400, generationMs: 8000 },
    numberFormat,
  );
  assert.equal(noTtft.prefillLabel, null);
  assert.equal(noTtft.decodeLabel, "50 tok/s");
});

test("分子为 0 不伪造速度：0 token 的标签是 null 而不是 \"0 tok/s\"", () => {
  const labels = formatSpeedLabels(
    { inputTokens: 0, outputTokens: 0, timeToFirstTokenMs: 1000, generationMs: 1000 },
    numberFormat,
  );
  assert.equal(labels.prefillLabel, null);
  assert.equal(labels.decodeLabel, null);
});

test("非有限值（NaN/Infinity 渗透）按缺席降级", () => {
  const labels = formatSpeedLabels(
    {
      inputTokens: Number.NaN,
      outputTokens: 100,
      timeToFirstTokenMs: Number.POSITIVE_INFINITY,
      generationMs: 1000,
    },
    numberFormat,
  );
  assert.equal(labels.prefillLabel, null);
  assert.equal(labels.decodeLabel, "100 tok/s");
});

test("单位后缀走 i18n 入参（chat.usageStatusbar.unit.tokensPerSecond），缺省保底 tok/s", () => {
  const stats = {
    inputTokens: 1000,
    outputTokens: 50,
    timeToFirstTokenMs: 1000,
    generationMs: 1000,
  };
  assert.equal(
    formatSpeedLabels(stats, numberFormat, "tok/s").prefillLabel,
    "1,000 tok/s",
  );
  // numberFormat 决定分组与小数位：zh-CN 分组符同 en；一位小数封顶。
  const zh = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
  assert.equal(formatSpeedLabels(stats, zh).decodeLabel, "50 tok/s");
});
