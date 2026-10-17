// 连接期提示通道测试（spec: packages/server/specs/ssh-prompt-mediation.md
// 验收场景 5-8；ssh-host-key-trust.md 扩展节）。纯本地回环，无真实 SSH 服务器。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  createSSHPromptChannel,
  createHostKeyChallengePromptHandler,
} from "../src/remote/sshPromptChannel.ts";
import {
  sanitizeSSHPromptText,
  summarizeSanitizedPromptText,
} from "../src/remote/sshPromptSanitize.ts";
import { normalizeSSHPromptAnswerValue } from "../src/remote/sshPromptTypes.ts";
import { SSHHostKeyDecisionError } from "../src/remote/sshAuth.ts";

test("sanitizeSSHPromptText strips invisible families and normalizes line semantics", () => {
  // Cf/默认不可见/填充符七族剥除（对齐 bash-confirm-reflex-gate 的不可见字符模式）
  assert.equal(sanitizeSSHPromptText("a\u061Cb\u200Dc\u200Bd\uFEFFe"), "abcde");
  assert.equal(sanitizeSSHPromptText("a\u{E0020}b\u3164c\uFFA0d\u2800e"), "abcde");
  // CRLF/CR/LS/PS 归一为 \n
  assert.equal(sanitizeSSHPromptText("a\r\nb\rc\u2028d\u2029e"), "a\nb\nc\nd\ne");
  // 控制符（除 \n \t）→ 空格
  assert.equal(sanitizeSSHPromptText("a\u0007b\u001bc"), "a b c");
  assert.equal(sanitizeSSHPromptText("keep\ttab"), "keep\ttab");
  // 孤立代理对 → \0，随后控制符阶段把 \0 归一为空格（与参照实现的步骤顺序一致：
  // 关键是孤立代理对不会存活到下游）
  assert.equal(sanitizeSSHPromptText(`a\ud800b`), "a b");
  // 3+ 连续换行折叠为 2，逐行去尾随空白
  assert.equal(sanitizeSSHPromptText("a  \n\n\n\nb"), "a\n\nb");
  // 4096 截断：头部 1024 + "\n…\n" + 尾部 3069
  const long = "x".repeat(5000);
  const truncated = sanitizeSSHPromptText(long);
  assert.equal(
    Array.from(truncated).length,
    1024 + Array.from("\n…\n").length + 3069,
  );
  assert.ok(truncated.includes("\n…\n"));
  // 摘要助手压平换行并截断
  assert.equal(summarizeSanitizedPromptText("a\n\nb", 2), "a…");
});

test("normalizeSSHPromptAnswerValue strips CRLF/NUL and enforces the 1023-byte cap", () => {
  assert.equal(normalizeSSHPromptAnswerValue("a\r\nb\0c"), "abc");
  assert.equal(normalizeSSHPromptAnswerValue("a".repeat(1023)).length, 1023);
  assert.equal(normalizeSSHPromptAnswerValue("a".repeat(1024)), null);
  // 多字节字符按 UTF-8 字节数计算：341×3=1023 恰好达上限（允许），342×3=1026 超限
  assert.equal(normalizeSSHPromptAnswerValue("密".repeat(341)).length, 341);
  assert.equal(normalizeSSHPromptAnswerValue("密".repeat(342)), null);
});

function makeChallenge(overrides = {}) {
  return {
    challengeId: randomUUID(),
    host: "10.0.0.5",
    port: 22,
    status: "unknown",
    candidateFingerprint: "SHA256:candidate",
    expectedFingerprints: [],
    ...overrides,
  };
}

test("ordering gate: secret prompts abort peer_unconfirmed before host key confirmation", async () => {
  const seen = [];
  const channel = createSSHPromptChannel({
    handler: async (request) => {
      seen.push(request);
      return { promptId: request.promptId, value: "answer" };
    },
    host: "10.0.0.5",
    port: 22,
  });
  assert.equal(channel.peerConfirmed, false);
  const withheld = await channel.requestSecretPrompt({ kind: "otp", text: "Enter OTP:" });
  assert.deepEqual(withheld, { answered: false, abort: "peer_unconfirmed" });
  assert.equal(seen.length, 0, "handler must not see a secret prompt before confirmation");
  // unknown/changed/revoked 裁决都不产生确认
  channel.notifyHostKeyOutcome("unknown");
  channel.notifyHostKeyOutcome("changed");
  channel.notifyHostKeyOutcome("revoked");
  assert.equal(channel.peerConfirmed, false);
  const stillWithheld = await channel.requestSecretPrompt({ kind: "otp", text: "Enter OTP:" });
  assert.equal(stillWithheld.answered, false);
  // trusted 裁决打开顺序闸
  channel.notifyHostKeyOutcome("trusted");
  assert.equal(channel.peerConfirmed, true);
  const answered = await channel.requestSecretPrompt({ kind: "otp", text: "Enter OTP:" });
  assert.deepEqual(answered, { answered: true, value: "answer" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "otp");
  assert.equal(seen[0].secret, true);
  channel.dispose();
});

test("secret prompt answers are normalized; oversize/empty/mismatch fail closed", async () => {
  const replies = [];
  let nextReply;
  const channel = createSSHPromptChannel({
    handler: async (request) => {
      const reply = nextReply(request);
      replies.push(reply);
      return reply;
    },
    host: "h",
    port: 22,
  });
  channel.notifyHostKeyOutcome("trusted");

  // \r\n\0 剥除
  nextReply = (request) => ({ promptId: request.promptId, value: "6\r54\n321\0" });
  assert.deepEqual(await channel.requestSecretPrompt({ kind: "otp", text: "t" }), {
    answered: true,
    value: "654321",
  });
  // 超 1023 字节 → undeliverable
  nextReply = (request) => ({ promptId: request.promptId, value: "x".repeat(1024) });
  assert.deepEqual(await channel.requestSecretPrompt({ kind: "otp", text: "t" }), {
    answered: false,
    abort: "undeliverable",
  });
  // secret 空应答 → dismissed
  nextReply = (request) => ({ promptId: request.promptId, value: "\r\n" });
  assert.deepEqual(await channel.requestSecretPrompt({ kind: "otp", text: "t" }), {
    answered: false,
    abort: "dismissed",
  });
  // 用户显式 dismiss
  nextReply = (request) => ({ promptId: request.promptId, abort: "dismissed" });
  assert.deepEqual(await channel.requestSecretPrompt({ kind: "otp", text: "t" }), {
    answered: false,
    abort: "dismissed",
  });
  // promptId 错位应答 → expired（fail-closed）
  nextReply = () => ({ promptId: "some-other-prompt", value: "x" });
  assert.deepEqual(await channel.requestSecretPrompt({ kind: "otp", text: "t" }), {
    answered: false,
    abort: "expired",
  });
  // handler 抛错 → dismissed
  nextReply = () => {
    throw new Error("ipc gone");
  };
  assert.deepEqual(await channel.requestSecretPrompt({ kind: "otp", text: "t" }), {
    answered: false,
    abort: "dismissed",
  });
  channel.dispose();
  // dispose 后请求一律 expired
  assert.deepEqual(await channel.requestSecretPrompt({ kind: "otp", text: "t" }), {
    answered: false,
    abort: "expired",
  });
});

test("prompt timeout and dispose settle pending prompts as expired", async () => {
  const never = () => new Promise(() => undefined);
  const timeoutChannel = createSSHPromptChannel({
    handler: never,
    host: "h",
    port: 22,
    promptTimeoutMs: 20,
  });
  timeoutChannel.notifyHostKeyOutcome("trusted");
  assert.deepEqual(await timeoutChannel.requestSecretPrompt({ kind: "otp", text: "t" }), {
    answered: false,
    abort: "expired",
  });
  timeoutChannel.dispose();

  const disposeChannel = createSSHPromptChannel({ handler: never, host: "h", port: 22 });
  disposeChannel.notifyHostKeyOutcome("trusted");
  const pending = disposeChannel.requestSecretPrompt({ kind: "otp", text: "t" });
  disposeChannel.dispose();
  assert.deepEqual(await pending, { answered: false, abort: "expired" });
});

test("host_key prompt is the first consumer: decision binding mirrors the backend rules", async () => {
  const decisions = [];
  let handlerDecision;
  const legacyHandler = async (challenge) => {
    decisions.push(challenge);
    return handlerDecision(challenge);
  };
  const channel = createSSHPromptChannel({
    handler: createHostKeyChallengePromptHandler(legacyHandler),
    host: "10.0.0.5",
    port: 22,
  });
  const challenge = makeChallenge();

  // approve：绑定回显一致 → 决策返回且顺序闸打开
  handlerDecision = (seen) => ({
    challengeId: seen.challengeId,
    action: "approve",
    candidateFingerprint: seen.candidateFingerprint,
  });
  const approved = await channel.requestHostKeyDecision(challenge);
  assert.deepEqual(approved, {
    challengeId: challenge.challengeId,
    action: "approve",
    candidateFingerprint: challenge.candidateFingerprint,
  });
  assert.equal(decisions.length, 1);
  assert.equal(channel.peerConfirmed, true, "user approve confirms the peer");

  // changed 必须显式 replace；approve 对 changed fail-closed
  const changed = makeChallenge({ status: "changed", expectedFingerprints: ["SHA256:old"] });
  handlerDecision = (seen) => ({
    challengeId: seen.challengeId,
    action: "approve",
    candidateFingerprint: seen.candidateFingerprint,
  });
  await assert.rejects(channel.requestHostKeyDecision(changed), SSHHostKeyDecisionError);

  // fingerprint 回显不一致 → fail-closed
  handlerDecision = (seen) => ({
    challengeId: seen.challengeId,
    action: "replace",
    candidateFingerprint: "SHA256:forged",
  });
  await assert.rejects(channel.requestHostKeyDecision(changed), SSHHostKeyDecisionError);

  // challengeId 缺失 → fail-closed
  handlerDecision = () => ({
    action: "replace",
    candidateFingerprint: changed.candidateFingerprint,
  });
  await assert.rejects(channel.requestHostKeyDecision(changed), SSHHostKeyDecisionError);

  // reject 直通且不产生确认
  const rejectChannel = createSSHPromptChannel({
    handler: createHostKeyChallengePromptHandler(
      async (seen) => ({
        challengeId: seen.challengeId,
        action: "reject",
        candidateFingerprint: seen.candidateFingerprint,
      }),
    ),
    host: "h",
    port: 22,
  });
  const rejected = await rejectChannel.requestHostKeyDecision(makeChallenge());
  assert.equal(rejected.action, "reject");
  assert.equal(rejectChannel.peerConfirmed, false);
  rejectChannel.dispose();

  // handler 抛错 → SSHHostKeyDecisionError 保留原始 message（与 backend 语义一致）
  const throwingChannel = createSSHPromptChannel({
    handler: createHostKeyChallengePromptHandler(async () => {
      throw new Error("renderer cancelled");
    }),
    host: "h",
    port: 22,
  });
  await assert.rejects(
    throwingChannel.requestHostKeyDecision(makeChallenge()),
    /renderer cancelled/u,
  );
  throwingChannel.dispose();
  channel.dispose();
});

test("host_key prompt text is sanitized before it reaches the handler", async () => {
  let seenRequest;
  const channel = createSSHPromptChannel({
    handler: async (request) => {
      seenRequest = request;
      return {
        promptId: request.promptId,
        decision: "reject",
        challengeId: request.hostKeyChallenge.challengeId,
        candidateFingerprint: request.hostKeyChallenge.candidateFingerprint,
      };
    },
    host: "h",
    port: 22,
  });
  await channel.requestHostKeyDecision(
    makeChallenge({ host: `evil\u061C-host\u2028.example` }),
  );
  assert.equal(seenRequest.kind, "host_key");
  assert.equal(seenRequest.secret, false);
  assert.ok(!seenRequest.text.includes("\u061C"));
  assert.ok(!seenRequest.text.includes("\u2028"));
  assert.ok(seenRequest.text.includes("evil-host"));
  channel.dispose();
});
