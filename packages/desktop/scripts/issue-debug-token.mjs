#!/usr/bin/env node
/**
 * 签名短时调试令牌签发工具（specs/desktop-startup-hardening.md §3，本地开发用）。
 *
 * 令牌格式：`<unix毫秒>.<base64url(userDataPath)>.<base64url(ed25519签名)>`，
 * 签名对象为前两段拼接文本；打包态桌面应用只对内嵌公钥
 * （src/main/debugTokenGate.ts EMBEDDED_DEBUG_TOKEN_PUBLIC_KEYS）验签，
 * 令牌年龄上限 300s（含 60s 时钟 skew 容忍），payload 必须等于
 * ACODE_DESKTOP_USER_DATA_DIR 声明的路径。
 *
 * ⚠️ 私钥永不入仓库：默认保存在 ~/.acode/dev/acode-debug-token-signing-key.pem
 * （0600）。不要把私钥提交、贴进 issue 或复制到仓库内任何路径；私钥丢失/泄露时
 * 用 --generate-keypair 重新生成，替换 debugTokenGate.ts 内嵌公钥并发版。
 *
 * 用法：
 *   node scripts/issue-debug-token.mjs --user-data-dir <path> [--private-key <pem>]
 *   node scripts/issue-debug-token.mjs --generate-keypair [--out <pem路径>]
 *
 * 签发结果打到 stdout（可直接 `ACODE_DEBUG_TOKEN=$(node scripts/issue-debug-token.mjs
 * --user-data-dir "$DIR")` 捕获）；诊断信息走 stderr。启动打包态调试时同时设置
 * ACODE_DEBUG_TOKEN 与 ACODE_DESKTOP_USER_DATA_DIR（同一路径字符串，精确匹配）。
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signData,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 私钥默认路径（仓库外）。可用 ACODE_DEBUG_TOKEN_SIGNING_KEY_FILE 覆写。 */
export const DEFAULT_SIGNING_KEY_PATH = join(
  homedir(),
  ".acode",
  "dev",
  "acode-debug-token-signing-key.pem",
);
export const SIGNING_KEY_ENV_OVERRIDE = "ACODE_DEBUG_TOKEN_SIGNING_KEY_FILE";

/** 生成 ed25519 密钥对：私钥 PKCS#8 PEM（仓外保存），公钥 SPKI DER base64（内嵌源码）。 */
export function generateDebugTokenKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    publicKeySpkiBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/** 从私钥 PEM 导出对应公钥的 SPKI DER base64（用于核对内嵌常量）。 */
export function publicKeySpkiBase64FromPrivate(privateKeyPem) {
  const publicKey = createPublicKey(createPrivateKey(privateKeyPem));
  return publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

/** 签发令牌。issuedAtMs 可注入（测试）；生产调用取当前时间，5 分钟内有效。 */
export function issueDebugToken({ userDataPath, privateKeyPem, issuedAtMs = Date.now() }) {
  if (typeof userDataPath !== "string" || userDataPath.trim() === "") {
    throw new Error("userDataPath is required");
  }
  const payloadB64Url = Buffer.from(userDataPath, "utf8").toString("base64url");
  const signedPayload = `${issuedAtMs}.${payloadB64Url}`;
  const signature = signData(null, Buffer.from(signedPayload, "utf8"), createPrivateKey(privateKeyPem));
  return `${signedPayload}.${signature.toString("base64url")}`;
}

function resolveSigningKeyPath(cliValue) {
  return resolve(cliValue || process.env[SIGNING_KEY_ENV_OVERRIDE] || DEFAULT_SIGNING_KEY_PATH);
}

function runGenerateKeypair(outPath) {
  const target = resolve(outPath || DEFAULT_SIGNING_KEY_PATH);
  if (existsSync(target)) {
    process.stderr.write(`私钥已存在，拒绝覆盖：${target}\n（确需轮换请先手动移除旧私钥）\n`);
    return 1;
  }
  const { privateKeyPem, publicKeySpkiBase64 } = generateDebugTokenKeypair();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, privateKeyPem, { mode: 0o600 });
  try {
    chmodSync(target, 0o600);
  } catch {
    // Windows 上 POSIX mode 位不生效，写入时已带 mode，忽略。
  }
  process.stderr.write(`私钥已写入（仓库外，勿提交）：${target}\n`);
  process.stderr.write(
    "把下面这行公钥替换进 src/main/debugTokenGate.ts 的 EMBEDDED_DEBUG_TOKEN_PUBLIC_KEYS 并发版：\n",
  );
  process.stdout.write(`${publicKeySpkiBase64}\n`);
  return 0;
}

function runIssue(userDataDir, privateKeyPath) {
  if (!userDataDir) {
    process.stderr.write("缺少 --user-data-dir <path>（令牌 payload 绑定的 userData 路径）\n");
    return 1;
  }
  const keyPath = resolveSigningKeyPath(privateKeyPath);
  if (!existsSync(keyPath)) {
    process.stderr.write(
      `私钥不存在：${keyPath}\n先运行 --generate-keypair 生成，或经 ${SIGNING_KEY_ENV_OVERRIDE} 指定。\n`,
    );
    return 1;
  }
  const privateKeyPem = readFileSync(keyPath, "utf8");
  const token = issueDebugToken({ userDataPath: userDataDir, privateKeyPem });
  process.stderr.write(
    `已签发（300s 内有效）；配套设置 ACODE_DESKTOP_USER_DATA_DIR=${userDataDir}\n`,
  );
  process.stdout.write(`${token}\n`);
  return 0;
}

function readCliFlag(args, name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(args) {
  if (args.includes("--generate-keypair")) {
    return runGenerateKeypair(readCliFlag(args, "out"));
  }
  return runIssue(readCliFlag(args, "user-data-dir"), readCliFlag(args, "private-key"));
}

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  process.exitCode = main(process.argv.slice(2));
}
