#!/usr/bin/env node
/* eslint-disable max-lines -- 三方 license 盘点/声明/门禁一体脚本，数据表与校验逻辑集中维护。 */
// 三方 license 盘点/声明/门禁 一体脚本
//
// 用法：
//   node scripts/licenses.mjs notices                      生成 THIRD-PARTY-NOTICES.md（精确版本、原始版权和许可文本）
//   node scripts/licenses.mjs check                        手动门禁：出现 allowlist 之外或许可未知的包即退出码 1
//   node scripts/licenses.mjs reproducibility [--inputs-only] [--diff-only]
//                                                          台账可复现性：默认全量重生成后 diff（CI Linux、发布权威），
//                                                          --inputs-only 只重算源文件哈希（零 install、秒级、开发期信号），
//                                                          --diff-only 跳过重生成、只 diff 工作树（供已重生成过的 workflow 复用）
//   node scripts/licenses.mjs paths-filter [--coverage]     从台账 inputs 归纳 workflow 的 paths 过滤清单；
//                                                          --coverage 报覆盖率并以 100% 为硬门槛
//
// 数据口径：
// - 实装清单 = 全 workspace node_modules 的递归集合，含嵌套版本与符号链接。
// - 声明生成：third-party-npm.mjs 按生产依赖的精确版本收集真实许可文件。
// - prod 判定按锁文件生产图中的精确版本。
// - 商用/半开放检查作用于全量实装包（prod+dev）
import { generateThirdPartyNotices } from "./generate-third-party-notices.mjs";
import { readVerifiedNotices } from "./third-party-notices.mjs";
import {
  derivePathsFilter,
  formatDrift,
  measurePathsFilterCoverage,
  verifyInputsFreshness,
} from "./third-party-reproducibility.mjs";
import { readFile } from "node:fs/promises";
import {
  readWorkspaceProductionGraph,
  scanInstalledPackages,
  missingProductionPackages,
} from "./third-party-npm.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] || "notices";
if (command === "notices") {
  await generateThirdPartyNotices(ROOT);
  process.exit(0);
}

// 台账可复现性与 paths 覆盖率：判定逻辑只在 third-party-reproducibility.mjs 一处，
// 这里只做 CLI 派发，workflow 与本地共用同一实现（U13，third-party/README.md）。
if (command === "reproducibility") {
  const inputsOnly = process.argv.includes("--inputs-only");
  const diffOnly = process.argv.includes("--diff-only");
  const result = await verifyInputsFreshness(ROOT, { inputsOnly, diffOnly });
  console.log(formatDrift(result));
  if (!result.ok) {
    console.error(
      inputsOnly
        ? "\n处置：运行 `node scripts/licenses.mjs notices` 后**采用 CI Linux 重生成产物**修复台账；" +
            "不要提交本机（尤其 Windows）重生成结果，行尾与平台依赖变体会把不一致带回去。"
        : "\n处置：以 CI Linux 规范产物替换已入库台账（沿用 b926b9e/390f73c/572733a 口径）。",
    );
    process.exit(1);
  }
  process.exit(0);
}

if (command === "paths-filter") {
  const patterns = await derivePathsFilter(ROOT);
  const coverage = await measurePathsFilterCoverage(ROOT, { patterns });
  if (process.argv.includes("--coverage")) {
    const percent = (coverage.coverageRatio * 100).toFixed(1);
    console.log(
      `paths 覆盖率：${coverage.covered}/${coverage.total} = ${percent}%（清单 ${patterns.length} 条）`,
    );
    if (coverage.coverageRatio !== 1) {
      console.error(
        `✗ paths-filter 未覆盖全部台账 inputs，未覆盖 ${coverage.uncovered.length} 项，例如：\n` +
          coverage.uncovered
            .slice(0, 10)
            .map((file) => `  - ${file}`)
            .join("\n"),
      );
      process.exit(1);
    }
    console.log("✓ 覆盖率 100%：改动任一被台账追踪的文件都会触发闸门");
    process.exit(0);
  }
  // 输出可直接粘进 workflow 的 paths 列表（YAML 片段）。
  console.log(patterns.map((pattern) => `      - "${pattern}"`).join("\n"));
  process.exit(0);
}

// 标识门禁与声明生成共用 workspace 图和递归扫描，不按包名猜测生产范围。
const { required, projects } = await readWorkspaceProductionGraph(ROOT);
const ownNames = new Set(projects.map((project) => project.name));
const installed = new Map();
const MANUAL_LICENSE = {
  "exif-parser": "MIT", // 包内 LICENSE.md
  khroma: "MIT", // 包内 license 文件
  semaphore: "MIT", // 包内 README License 段
  "css-value": "MIT", // 包内 Readme License 段
  "@fig/autocomplete-helpers": "MIT", // 包内 LICENSE
};
function normLicense(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(normLicense).join(" OR ");
  return value?.type?.trim() || "(missing)";
}
const scanned = await scanInstalledPackages(ROOT, projects);
missingProductionPackages(required, scanned);
for (const [key, { pkg }] of scanned) {
  if (ownNames.has(pkg.name)) continue;
  installed.set(key, {
    name: pkg.name,
    version: pkg.version,
    license: normLicense(pkg.license ?? pkg.licenses ?? MANUAL_LICENSE[pkg.name]),
    isProd: required.has(key),
  });
}
// ---------- 分类 ----------
const GREEN =
  /^(MIT|MIT-0|ISC|BSD-2-Clause|BSD-3-Clause|BSD-4-Clause|0BSD|Unlicense|Apache-2\.0|Zlib|WTFPL|Artistic-2\.0|BlueOak-1\.0\.0|CC0-1\.0|CC-BY-4\.0|CC-BY-3\.0|BSD|Python-2\.0)$/i;
function classify(raw) {
  const s = raw.replace(/[()]/g, " ").trim();
  if (s === "(missing)" || s === "missing" || s === "") return "missing";
  if (/^UNLICENSED|SEE LICEN[CS]E IN|UNKNOWN|N\/A$/i.test(s)) return "unresolved";
  const or = s
    .split(/\s+OR\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
  if (or.length > 1 && or.some((x) => GREEN.test(x))) return "green";
  const and = s
    .split(/\s+AND\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
  if (and.length > 1 && and.every((x) => GREEN.test(x))) return "green";
  const t = or[0] || and[0] || s;
  if (/\bAGPL/i.test(t)) return "red-agpl";
  if (/\bLGPL/i.test(t)) return "yellow-lgpl";
  if (/\bGPL/i.test(t)) return "red-gpl";
  if (/^(MPL|EPL|CDDL)/i.test(t)) return "yellow-weak";
  if (/^(BUSL|BSL|Elastic|SSPL|PolyForm|FSL|CAL-1)/i.test(t)) return "red-semiopen";
  if (/^CC-BY-NC/i.test(t)) return "red-nc";
  if (/^CC-BY-(ND|SA)/i.test(t)) return "yellow-cc";
  return GREEN.test(t) ? "green" : "review";
}
for (const r of installed.values()) r.bucket = classify(r.license);

// ---------- 构建工具许可标识复核（不是二进制发行义务豁免） ----------
const WEAK_ALLOW = [[/^lightningcss/, "当前仅构建依赖；进入生产图时需重新核对 MPL 源码提供义务"]];
function weakAllowReason(r) {
  if (r.isProd) return null;
  for (const [re, why] of WEAK_ALLOW) if (re.test(r.name)) return why;
  return null;
}

if (command === "check") {
  const bad = [];
  for (const r of installed.values()) {
    if (r.bucket === "green") continue;
    if (r.bucket.startsWith("yellow") && weakAllowReason(r)) continue;
    bad.push(r);
  }
  if (bad.length) {
    console.error(`✗ license 检查失败：${bad.length} 个包超出 allowlist：`);
    for (const r of bad.sort((a, b) => a.name.localeCompare(b.name)))
      console.error(`  [${r.bucket}] ${r.name}@${r.version} → ${r.license}`);
    console.error("\n处置：替换依赖，或在 scripts/licenses.mjs 的 WEAK_ALLOW 登记人工复核结论。");
    process.exit(1);
  }
  await readVerifiedNotices(ROOT, { requireComplete: process.argv.includes("--strict") });
  const reviewRequired =
    JSON.parse(await readFile(path.join(ROOT, "third-party/inventory.json"), "utf8"))
      .reviewRequired ?? [];
  if (reviewRequired.length)
    console.warn(
      `待补齐/核验材料 ${reviewRequired.length} 项；发布前运行 node scripts/licenses.mjs check --strict，不得将基础检查通过视为合规完成。`,
    );
  const n = installed.size;
  console.log(
    `✓ 许可标识与声明新鲜度检查通过：${n} 个实装包（构建依赖复核 ${[...installed.values()].filter((r) => r.bucket.startsWith("yellow")).length} 项）；材料限制见 third-party/README.md`,
  );
} else {
  console.error("用法: node scripts/licenses.mjs [notices|check|reproducibility|paths-filter]");
  process.exit(2);
}
