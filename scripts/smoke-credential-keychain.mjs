#!/usr/bin/env node
/**
 * 凭据主密钥 OS 钥匙串真机冒烟（R1 验证工具，非 CI 测试电池成员）。
 *
 * 用法（仓库根目录）：node --import tsx scripts/smoke-credential-keychain.mjs
 *
 * 与 packages/shared/tests/credential-keychain.test.mjs（mock spawn、全分支、进 CI）
 * 互补：本脚本走**真实平台机制**（macOS security / Windows PowerShell DPAPI /
 * Linux secret-tool），验证 mock 测不出的传输层事实——2026-10-03 Windows 首轮
 * 即抓到 base64url→.NET FromBase64String 恒失败的真 bug（mock 不做真实解码）。
 *
 * 安全边界：所有场景都在 mkdtemp 临时目录 + 指纹化条目命名（credentialKeychainAccount
 * 含 keyFilePath 哈希）下运行，绝不触碰真实数据目录/既有钥匙串条目；结束时清理
 * 本脚本创建的条目。macOS 首跑可能弹一次钥匙串授权（条目 ACL 归 security 工具，
 * 后续读写不再弹）。凭据材料只打印长度/摘要状态，从不输出本体。
 *
 * 判定：任一场景 ✗ 则退出码 1。延迟段只报告不断言（数值随机器/缓存状态浮动，
 * 基线见 docs/capability-uplift-plan.md 批次 4 第四轮记录）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const { createCredentialKeychain, windowsDpapiBlobPath } = await import(
  "../packages/shared/src/node/credentialKeychain.ts"
);
const { resolveCredentialMasterKey } = await import(
  "../packages/shared/src/node/credentialMasterKey.ts"
);

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return Boolean(condition);
}
function section(title) {
  console.log(`\n── ${title} ──`);
}
function fingerprint(buf) {
  return createHash("sha256").update(buf).digest("hex").slice(0, 8);
}
function timeSync(fn) {
  const t0 = performance.now();
  const value = fn();
  return { ms: Math.round(performance.now() - t0), value };
}

const keychain = createCredentialKeychain(); // 真实平台访问器（默认工厂）
const tempDirs = [];
function freshTempKeyFilePath() {
  const dir = mkdtempSync(join(tmpdir(), "acode-keychain-smoke-"));
  tempDirs.push(dir);
  return join(dir, "credential-key.json");
}

console.log(`platform: ${process.platform} (${process.release.name} ${process.versions.node})`);

// ── 1. 环境探测：平台工具在位性 ─────────────────────────────────────
section("环境探测");
const toolProbe = {
  win32: ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]],
  darwin: ["security", ["help"]],
  linux: ["secret-tool", ["--version"]],
}[process.platform];
let toolAvailable = false;
if (toolProbe) {
  const probe = spawnSync(toolProbe[0], toolProbe[1], { encoding: "utf-8" });
  toolAvailable = probe.error?.code !== "ENOENT";
  check(`${toolProbe[0]} 在位`, toolAvailable, probe.error?.message ?? "");
} else {
  console.log(`  · 平台 ${process.platform} 无钥匙串机制，访问器应报 unavailable`);
}

// ── 2. 访问器往返：write → read → 重复写收敛 → delete ──────────────
section("访问器往返");
{
  const keyFilePath = freshTempKeyFilePath();
  // 材料刻意选 base64url 形态含 -/_ 且无填充（Windows 传输规范化的真机回归点）。
  const material = Buffer.concat([Buffer.from([0xfb, 0xef, 0xfe]), randomBytes(29)]);
  const secret = material.toString("base64url");

  const w = timeSync(() => keychain.write(keyFilePath, secret));
  if (check("write → written", w.value.status === "written", JSON.stringify({ ...w.value, secret: "<redacted>" }))) {
    const r = timeSync(() => keychain.read(keyFilePath));
    check("read → found", r.value.status === "found", r.value.status);
    if (r.value.status === "found") {
      const back = Buffer.from(r.value.secret, "base64url");
      check("材料字节一致（含 base64url→规范 base64 传输往返）", back.equals(material), `fp ${fingerprint(back)} ≠ ${fingerprint(material)}`);
    }
    // 重复写 = 竞争收敛路径（macOS 重复条目回读赢家 / Windows wx EEXIST / Linux 写前读）。
    const other = randomBytes(32).toString("base64url");
    const w2 = keychain.write(keyFilePath, other);
    check("重复 write → written（收敛，不报错）", w2.status === "written", w2.status);
    if (w2.status === "written") {
      const winner = Buffer.from(w2.secret, "base64url");
      check("收敛到先写入的赢家材料", winner.equals(material), "赢家材料不一致");
    }
    console.log(`  · 延迟：write ${w.ms}ms / read ${r.ms}ms`);
  }
  keychain.delete(keyFilePath);
  const afterDelete = keychain.read(keyFilePath);
  check("delete → read absent", afterDelete.status === "absent", afterDelete.status);
}

// ── 3. 损坏材料 fail-loud（resolver 层）────────────────────────────
section("损坏材料 fail-loud");
{
  const keyFilePath = freshTempKeyFilePath();
  const w = keychain.write(keyFilePath, "not-a-32-byte-key"); // 长度非法的"材料"
  if (w.status === "written") {
    let threw = false;
    try {
      resolveCredentialMasterKey({ keyFilePath, env: {} });
    } catch (error) {
      threw = /malformed/i.test(error.message);
    }
    check("非法长度条目 → resolver 抛错保留现场（绝不生成新密钥）", threw);
    keychain.delete(keyFilePath);
  } else {
    console.log(`  · 跳过（write 非 written：${w.status}——环境无钥匙串时由场景 4 验证降级）`);
  }
  if (process.platform === "win32") {
    // Windows 特有：blob JSON 损坏 → read error（不是 absent）。
    const blobPath = windowsDpapiBlobPath(keyFilePath);
    writeFileSync(blobPath, "{ not json", "utf-8");
    const r = keychain.read(keyFilePath);
    check("blob 损坏 → read error（fail-loud，非 absent）", r.status === "error", r.status);
    keychain.delete(keyFilePath);
  }
}

// ── 4. resolver：新装生成（钥匙串优先，材料不落盘）────────────────
section("resolver 新装生成");
{
  const keyFilePath = freshTempKeyFilePath();
  const warnings = [];
  const t = timeSync(() => resolveCredentialMasterKey({ keyFilePath, env: {}, onWarn: (m) => warnings.push(m) }));
  const first = t.value;
  check(`首次解析 source=${first.source}`, ["keychain", "keyFile"].includes(first.source), first.source);
  check("密钥 32 字节", first.key.length === 32, `${first.key.length}`);
  if (first.source === "keychain") {
    check("材料不落盘（无 credential-key.json）", !existsSync(keyFilePath));
    if (process.platform === "win32") {
      check("DPAPI blob 已创建", existsSync(windowsDpapiBlobPath(keyFilePath)));
    }
    const t2 = timeSync(() => resolveCredentialMasterKey({ keyFilePath, env: {}, onWarn: (m) => warnings.push(m) }));
    check("二次解析材料一致", t2.value.key.equals(first.key));
    const t3 = timeSync(() => resolveCredentialMasterKey({ keyFilePath, env: {}, onWarn: (m) => warnings.push(m) }));
    check("三次解析走进程缓存（材料一致）", t3.value.key.equals(first.key));
    console.log(`  · 延迟：首次 ${t.ms}ms / 二次 ${t2.ms}ms / 三次(缓存) ${t3.ms}ms`);
  } else {
    check("降级文件模式必须伴随告警（D5 诚实降级）", warnings.some((m) => /keychain unavailable/i.test(m)), warnings.join("|"));
    console.log(`  · 首次 ${t.ms}ms（文件模式）`);
  }
  keychain.delete(keyFilePath);
}

// ── 5. resolver：遗留密钥文件一次性迁移（R1-b）────────────────────
section("遗留密钥文件迁移");
{
  const keyFilePath = freshTempKeyFilePath();
  const legacy = randomBytes(32);
  writeFileSync(
    keyFilePath,
    `${JSON.stringify({ key: legacy.toString("base64url"), version: 1 }, null, 2)}\n`,
    "utf-8",
  );
  const warnings = [];
  const resolved = resolveCredentialMasterKey({ keyFilePath, env: {}, onWarn: (m) => warnings.push(m) });
  if (resolved.source === "keychain") {
    check("迁移后材料字节不变（零重加密）", resolved.key.equals(legacy), `fp ${fingerprint(resolved.key)} ≠ ${fingerprint(legacy)}`);
    check("密钥文件已删除", !existsSync(keyFilePath));
    check("INFO 迁移通知已发出", warnings.some((m) => m.startsWith("INFO:")), warnings.join("|"));
    const again = resolveCredentialMasterKey({ keyFilePath, env: {}, onWarn: () => {} });
    check("迁移幂等（二次解析仍 keychain 且材料一致）", again.source === "keychain" && again.key.equals(legacy));
  } else {
    // 钥匙串不可用（headless Linux 等）：保持文件模式是正确行为。
    check("钥匙串不可用 → 保持文件模式 + 跳过迁移告警", resolved.source === "keyFile" && existsSync(keyFilePath) && warnings.some((m) => /migration to the OS keychain was skipped/i.test(m)), `source=${resolved.source}`);
  }
  keychain.delete(keyFilePath);
}

// ── 6. 平台工具启动基线（延迟归因用）──────────────────────────────
section("平台工具启动基线");
if (process.platform === "win32") {
  const bare = timeSync(() => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf-8" }));
  console.log(`  · 裸 powershell.exe 启动：${bare.ms}ms（DPAPI 调用与它的差值 = 程序集加载 + Protect/Unprotect）`);
} else if (process.platform === "darwin") {
  const bare = timeSync(() => spawnSync("security", ["help"], { encoding: "utf-8" }));
  console.log(`  · 裸 security 启动：${bare.ms}ms`);
} else {
  console.log("  · （linux secret-tool 无常驻进程，启动开销可忽略）");
}

// ── 清理与判定 ─────────────────────────────────────────────────────
for (const dir of tempDirs) {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${failures === 0 ? "PASS" : `FAIL（${failures} 项）`}`);
process.exit(failures === 0 ? 0 : 1);
