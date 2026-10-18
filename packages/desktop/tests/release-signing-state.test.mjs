// 三态判定单测：全有/全无/部分存在 + 报错文案列出缺失项 + 空串归一。
// 规则与验收见 specs/release-signing-smoke.md §1；实现单一入口
// scripts/release-signing-state.mjs 的纯函数 resolveSigningState。
import assert from "node:assert/strict";
import test from "node:test";

import {
  resolvePlatformGroup,
  resolveSigningState,
  SIGNING_SECRET_GROUPS,
} from "../scripts/release-signing-state.mjs";

const DARWIN_KEYS = SIGNING_SECRET_GROUPS.darwin;
const WIN_KEYS = SIGNING_SECRET_GROUPS.win32;

test("macOS 全部凭据存在 → full", () => {
  const env = {
    CSC_LINK: "base64-p12-payload",
    CSC_KEY_PASSWORD: "p12-password",
    APPLE_ID: "release@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
    APPLE_TEAM_ID: "TEAMID1234",
  };
  const result = resolveSigningState(env, DARWIN_KEYS);
  assert.equal(result.state, "full");
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.present, [...DARWIN_KEYS]);
});

test("macOS 全部凭据缺失（包括空串与纯空白）→ none", () => {
  // GitHub Actions 未配置的 secrets 以空串注入 env，必须与 undefined 同判。
  const result = resolveSigningState(
    { CSC_LINK: "", CSC_KEY_PASSWORD: "   ", APPLE_ID: undefined },
    DARWIN_KEYS,
  );
  assert.equal(result.state, "none");
  assert.deepEqual(result.present, []);
  assert.equal(result.missing.length, DARWIN_KEYS.length);
});

test("macOS 部分凭据存在 → partial，且缺失项逐一列出", () => {
  const result = resolveSigningState(
    {
      CSC_LINK: "base64-p12-payload",
      CSC_KEY_PASSWORD: "p12-password",
      APPLE_ID: "release@example.com",
      // APPLE_APP_SPECIFIC_PASSWORD 与 APPLE_TEAM_ID 缺失
    },
    DARWIN_KEYS,
  );
  assert.equal(result.state, "partial");
  assert.deepEqual(result.missing, ["APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]);
  assert.deepEqual(result.present, ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID"]);
});

test("Windows 组：全有 full / 全无 none / 单缺即 partial", () => {
  assert.equal(
    resolveSigningState({ CSC_LINK: "x", CSC_KEY_PASSWORD: "y" }, WIN_KEYS).state,
    "full",
  );
  assert.equal(
    resolveSigningState({ CSC_LINK: "", CSC_KEY_PASSWORD: undefined }, WIN_KEYS).state,
    "none",
  );
  const partial = resolveSigningState({ CSC_LINK: "x", CSC_KEY_PASSWORD: "" }, WIN_KEYS);
  assert.equal(partial.state, "partial");
  assert.deepEqual(partial.missing, ["CSC_KEY_PASSWORD"]);
});

test("Linux 组为空 → 恒 none（无签名面）", () => {
  const result = resolveSigningState({ ANYTHING: "1" }, SIGNING_SECRET_GROUPS.linux);
  assert.equal(result.state, "none");
  assert.deepEqual(result.secretKeys, []);
});

test("平台别名归一：mac→darwin、win→win32，未知平台报错", () => {
  assert.equal(resolvePlatformGroup("mac"), "darwin");
  assert.equal(resolvePlatformGroup("darwin"), "darwin");
  assert.equal(resolvePlatformGroup("WIN"), "win32");
  assert.equal(resolvePlatformGroup("win32"), "win32");
  assert.equal(resolvePlatformGroup("linux"), "linux");
  assert.throws(() => resolvePlatformGroup("android"), /未知平台/);
  assert.throws(() => resolvePlatformGroup(undefined), /未知平台/);
});
