import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildMainLogRedactionIdentity,
  collectWindowsLogIdentityEvidence,
  getMainLogRedactor,
  parseRegQuerySubkeys,
  parseRegQueryValues,
  registerLogHostName,
  resetMainLogRedactorForTest,
} from "../src/main/logPrivacyIdentity.js";

/**
 * main 进程日志脱敏身份（specs/log-privacy-redaction.md desktop R4-R6）：
 * reg.exe 输出解析（纯函数）、注册表真值证据收集降级、身份并集与
 * 脱敏单例行为。注册表查询只读；非 Windows 平台全部静默降级。
 */

const PROFILE_LIST_SAMPLE = [
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList",
  "    ProfilesDirectory    REG_SZ    C:\\Users",
  "    Public               REG_SZ    C:\\Users\\Public",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\S-1-5-18",
  "    ProfileImagePath    REG_SZ    C:\\Windows\\system32\\config\\systemprofile",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\S-1-5-21-111-222-333-1001",
  "    ProfileImagePath    REG_SZ    C:\\Users\\Real.Name.000",
  "    CentralProfile      REG_SZ    C:\\Users\\Real.Name",
  "",
].join("\r\n");

test("parseRegQueryValues 解析值行（REG_SZ/REG_EXPAND_SZ/REG_DWORD）", () => {
  const values = parseRegQueryValues(PROFILE_LIST_SAMPLE);
  assert.equal(values.get("ProfilesDirectory"), "C:\\Users");
  assert.equal(values.get("Public"), "C:\\Users\\Public");
  const dword = parseRegQueryValues("    State    REG_DWORD    0x1");
  assert.equal(dword.get("State"), "0x1");
});

test("parseRegQuerySubkeys 跳过被查键自身，只取子键末段", () => {
  const subkeys = parseRegQuerySubkeys(PROFILE_LIST_SAMPLE);
  assert.deepEqual(subkeys, ["S-1-5-18", "S-1-5-21-111-222-333-1001"]);
});

test("collectWindowsLogIdentityEvidence 不抛出；非 win32 返回 null", () => {
  const evidence = collectWindowsLogIdentityEvidence();
  if (process.platform !== "win32") {
    assert.equal(evidence, null);
    return;
  }
  // 真机注册表内容不可假设：只断言形态（数组/字符串或 null）。
  assert.equal(typeof evidence, "object");
  if (evidence?.profileImagePaths) {
    assert.ok(Array.isArray(evidence.profileImagePaths));
  }
});

test("buildMainLogRedactionIdentity：homedir 必在身份内，名字为并集", () => {
  const identity = buildMainLogRedactionIdentity();
  assert.ok(Array.isArray(identity.homeDirs));
  const home = homedir().replace(/[\\/]+$/, "");
  if (home.length >= 4) {
    assert.ok(
      identity.homeDirs.some((dir) => dir.toLowerCase() === home.toLowerCase()),
      `homeDirs=${JSON.stringify(identity.homeDirs)} 应包含 ${home}`,
    );
  }
  assert.ok(Array.isArray(identity.userNames));
});

test("脱敏单例：家目录路径 → <home>，运行期收名 → <host>", () => {
  resetMainLogRedactorForTest();
  const redactor = getMainLogRedactor();
  const line = redactor.redactLine(`reading ${join(homedir(), "documents", "a.txt")} now`);
  if (homedir().length >= 4) {
    assert.ok(!line.includes(homedir()), line);
  }
  registerLogHostName("CorpNet.FileServer");
  const hostLine = redactor.redactLine("mount CorpNet.FileServer share failed");
  assert.ok(hostLine.includes("<host>"), hostLine);
  assert.ok(!hostLine.includes("CorpNet.FileServer"), hostLine);
  // 单例稳定：重复获取是同一实例。
  assert.equal(getMainLogRedactor(), redactor);
});
