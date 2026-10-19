/**
 * 发布签名可用性三态判定（规则与验收见 specs/release-signing-smoke.md §1；
 * 语义移植自 oh-my-pi v18.12.1 docs/macos-signing-notarization.md，MIT）：
 *
 * - full    组内全部 secrets 非空 → 本次打包执行签名（macOS 另启 notarytool 公证）；
 * - none    组内全部 secrets 为空 → 保持未签名，输出明示（不许静默）；
 * - partial 组内部分存在 → 立即失败，错误列出缺失项与已存在项（只出现键名，绝不回显值）。
 *
 * 空字符串/纯空白按「不存在」计：GitHub Actions 里未配置的 `secrets.X` 会以空串
 * 注入 env，必须与「真的没配」同判，否则 none 会被误判成 partial。
 *
 * CLI（CI release.yml desktop 作业与本地复核共用；单测只测纯函数）：
 *   node scripts/release-signing-state.mjs --platform mac|darwin|win|win32|linux
 *
 * GITHUB_ENV 约定（仅在 CI 环境存在 GITHUB_ENV 时写出）：
 * - 一律写 CSC_IDENTITY_AUTO_DISCOVERY：full(mac)=true，其余=false——保持既有
 *   未签名行为，同时让 full 态允许 electron-builder 在临时钥匙串中自动发现
 *   CSC_LINK 导入的身份（见 electron-builder.config.js 的 mac.identity 注释）；
 * - full(mac) 另写 ACODE_ENABLE_MAC_SIGN=1，作为 electron-builder 签名开关。
 * 这些键均非机密值；secrets 本体由 workflow env 映射，本脚本只输出键名与数量。
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 各平台的签名凭据组。Windows 取 electron-builder 26 现行 PFX/signtool 形态
 * （CSC_LINK + CSC_KEY_PASSWORD，windowsSignToolManager；Azure Trusted Signing
 * 形态未启用，引入时必须同步修订 spec §1 判定表）。
 */
export const SIGNING_SECRET_GROUPS = Object.freeze({
  darwin: Object.freeze([
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]),
  win32: Object.freeze(["CSC_LINK", "CSC_KEY_PASSWORD"]),
  linux: Object.freeze([]),
});

const PLATFORM_ALIASES = Object.freeze({
  mac: "darwin",
  darwin: "darwin",
  win: "win32",
  win32: "win32",
  linux: "linux",
});

function isPresent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 三态判定的唯一纯逻辑。测试与 CLI 共同消费，禁止在此之外的代码重复实现语义。
 *
 * @param {Record<string, string | undefined>} env 类 process.env 的键值表
 * @param {readonly string[]} secretKeys 平台 secrets 组（SIGNING_SECRET_GROUPS 的成员）
 * @returns {{state: "full" | "none" | "partial", present: string[], missing: string[], secretKeys: readonly string[]}}
 */
export function resolveSigningState(env, secretKeys) {
  const present = [];
  const missing = [];
  for (const key of secretKeys) {
    (isPresent(env?.[key]) ? present : missing).push(key);
  }
  // 空组（linux）视为 none：没有签名面就是「全部不存在」，不制造第三个概念。
  if (secretKeys.length === 0 || present.length === 0) {
    return { state: "none", present, missing, secretKeys };
  }
  if (missing.length === 0) {
    return { state: "full", present, missing, secretKeys };
  }
  return { state: "partial", present, missing, secretKeys };
}

export function resolvePlatformGroup(platform) {
  const normalized =
    PLATFORM_ALIASES[
      String(platform ?? "")
        .trim()
        .toLowerCase()
    ];
  if (!normalized) {
    throw new Error(
      `[release-signing-state] 未知平台 "${String(platform)}"，支持：mac|darwin|win|win32|linux`,
    );
  }
  return normalized;
}

function stateSummaryText(state) {
  if (state === "full") {
    return (
      "签名凭据齐全（full）：本次构建执行签名" +
      "（macOS 另启公证，凭据由 electron-builder 从环境读取）"
    );
  }
  if (state === "none") {
    return "未配置签名凭据（none）：保持未签名构建（现状行为，非降级事故）";
  }
  return "签名凭据部分存在（partial）：禁止静默降级，本次构建失败";
}

function githubEnvLines({ state, platformGroup }) {
  // CSC_IDENTITY_AUTO_DISCOVERY 恒由本脚本给出，workflow 不再静态写入，
  // 避免 step env 覆盖 GITHUB_ENV 造成 full 态无法自动发现导入身份。
  const lines = [
    `CSC_IDENTITY_AUTO_DISCOVERY=${state === "full" && platformGroup === "darwin" ? "true" : "false"}`,
  ];
  if (state === "full" && platformGroup === "darwin") {
    lines.push("ACODE_ENABLE_MAC_SIGN=1");
  }
  return lines;
}

async function main(argv) {
  const flagIndex = argv.indexOf("--platform");
  const platform = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  if (platform === undefined) {
    console.error("[release-signing-state] 缺少 --platform <mac|win|linux>");
    process.exitCode = 2;
    return;
  }

  const platformGroup = resolvePlatformGroup(platform);
  const result = resolveSigningState(process.env, SIGNING_SECRET_GROUPS[platformGroup]);

  const summary =
    `[release-signing-state] platform=${platformGroup} state=${result.state}\n` +
    `${stateSummaryText(result.state)}\n` +
    (result.secretKeys.length > 0
      ? `已存在（仅键名）：${result.present.join(", ") || "（无）"}\n缺失：${result.missing.join(", ") || "（无）"}`
      : "该平台无签名面（Linux AppImage/deb 不签名）");
  console.log(summary);

  if (result.state === "partial") {
    // omp 核心教训：部分凭据存在时最危险的是静默降级成未签名发布。
    // 错误文案必须能让维护者一眼看到缺哪个键，因此逐项列出，不折叠成计数。
    console.error(
      `[release-signing-state] ::error:: 签名凭据部分存在，拒绝继续打包。\n` +
        `缺失的环境变量（secrets）：${result.missing.join(", ")}\n` +
        `已配置的环境变量（secrets，仅键名）：${result.present.join(", ")}\n` +
        `处置：到仓库 Settings → Secrets and variables → Actions 补齐全部缺失项，` +
        `或删除多余项使组内全空（保持未签名）；本脚本不允许部分签名。`,
    );
    process.exitCode = 1;
    return;
  }

  // 步骤输出供 workflow 表达式引用（只暴露状态与布尔位，不含任何值）。
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `state=${result.state}\nsigning-enabled=${result.state === "full" ? "true" : "false"}\n`,
    );
  }
  if (process.env.GITHUB_ENV) {
    appendFileSync(
      process.env.GITHUB_ENV,
      `${githubEnvLines({ state: result.state, platformGroup }).join("\n")}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Release signing state\n\n- platform: \`${platformGroup}\`\n- state: **${result.state}**\n\n${stateSummaryText(result.state)}\n`,
    );
  }
  // none 态明示写盘一份状态标记，供 verify_assets 侧交叉核对（可选消费）。
  if (process.env.ACODE_SIGNING_STATE_FILE && result.state === "none") {
    writeFileSync(process.env.ACODE_SIGNING_STATE_FILE, `unsigned\n`);
  }
}

// 直接运行判定（与 import 供单测消费区分）：Windows 路径经 pathToFileURL 归一，
// 避免 file:// 前缀斜杠数差异让 CLI 判定失效。
const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  await main(process.argv.slice(2));
}
