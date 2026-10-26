// legacy 冻结面守护测试（2026-10-22 review R2-02 修复的防再犯门禁）。
//
// 冻结规则（docs/legacy-protocol-convergence-plan.md 第 37 行 + packages/shared/specs/
// legacy-protocol-freeze.md）：legacy barrel `acode-protocol/index.ts` 只允许删减与缺陷修复，
// **不允许新增导出**；新命令/新事件/新 schema 只进 v4 或中立叶子 acode-protocol-shared.ts。
//
// 本测试机械化该规则：提取 barrel 内 `export const ...Schema` 的本地定义集合，断言它是
// 冻结基线（legacy-protocol-barrel-schema-baseline.json）的子集——即只减不增。这样既能捕获
// 直接新增，也能捕获「删一个又加一个」的静默漂移（集合子集关系比单纯计数更严）。
//
// 同时钉住 R2-02 的具体修复：acodeMcpReconnectSuspensionSchema 由提交 43afaba1（冻结日之后）
// 误置于 barrel，已迁至 acode-protocol-shared.ts；barrel 只 re-export，不得重新出现本地定义。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const barrelPath = join(here, "..", "src", "acode-protocol", "index.ts");
const baselinePath = join(here, "legacy-protocol-barrel-schema-baseline.json");
const exportsBaselinePath = join(here, "legacy-protocol-barrel-exports-baseline.json");

/** barrel 内所有 `export const <name>Schema` 本地定义（不含 re-export 与类型）。 */
function extractLocalSchemaDefinitions(source: string): string[] {
  const names = [...source.matchAll(/^export const ([A-Za-z0-9_]+Schema)(?=\s*[=:<])/gm)].map((m) => m[1]);
  return [...new Set(names)].sort();
}

/**
 * barrel 内**全部本地导出名**——`export const/function/async function/type/interface/class/enum/let/var <name>`。
 * 覆盖成文冻结规则「不允许新增导出」（convergence-plan:37 / legacy-protocol-freeze.md:12），比 schema-only
 * 集合更宽：`acodeProtocolMethods`、`acodeProtocolNotifications` 等非 Schema `export const` 与全部
 * `export type` 也在守护内。不含 `export { ... } from` / `export *` re-export——那些符号的本地定义在
 * 中立叶子或其它模块，由各自文件的冻结守护负责，barrel 只转发（既有 subset 处置保持不变）。
 *
 * 注意：本正则与 legacy-protocol-barrel-exports-baseline.json 的生成脚本逐字一致，二者必须同步。
 */
function extractLocalExportNames(source: string): string[] {
  const names = [
    ...source.matchAll(
      /^export (?:const|async function|function|type|interface|class|enum|let|var) ([A-Za-z0-9_]+)/gm,
    ),
  ].map((m) => m[1]);
  return [...new Set(names)].sort();
}

test("legacy barrel: 本地 `export const ...Schema` 定义集合是冻结基线的子集（只删不增）", () => {
  const source = readFileSync(barrelPath, "utf-8");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as {
    schemaDefinitions: string[];
  };
  const current = extractLocalSchemaDefinitions(source);
  const allowed = new Set(baseline.schemaDefinitions);
  const newlyAdded = current.filter((name) => !allowed.has(name));

  assert.deepEqual(
    newlyAdded,
    [],
    `legacy 冻结面禁止新增 schema 定义。以下 ${newlyAdded.length} 个 \`export const ...Schema\` 不在冻结基线内：` +
      `${newlyAdded.join(", ")}。新 schema 必须落中立叶子 src/acode-protocol-shared.ts 或 v4/，` +
      `legacy barrel 只 \`export { ... } from\` 纯 re-export。见 specs/legacy-protocol-freeze.md。`,
  );
});

// 1.0.4 review P3：冻结守护此前只覆盖 `export const ...Schema`（246），漏掉更广的「不允许新增导出」
// 规则——barrel 另有 14 个非 Schema `export const`（含 acodeProtocolMethods/acodeProtocolNotifications）
// 与 189 个 `export type`，向方法表加新方法或加非 schema const 都不触发守护。此测试把守护面扩展到
// 全部本地导出名（449），断言子集关系。基线 246-schema 测试与 JSON 保持不变。
test("legacy barrel: 全部本地导出名集合是冻结基线的子集（不允许新增导出）", () => {
  const source = readFileSync(barrelPath, "utf-8");
  const baseline = JSON.parse(readFileSync(exportsBaselinePath, "utf-8")) as {
    localExportNames: string[];
  };
  const current = extractLocalExportNames(source);
  const allowed = new Set(baseline.localExportNames);
  const newlyAdded = current.filter((name) => !allowed.has(name));

  assert.deepEqual(
    newlyAdded,
    [],
    `legacy 冻结面禁止新增导出。以下 ${newlyAdded.length} 个本地导出（const/function/type/interface/` +
      `class/enum/let/var）不在冻结基线内：${newlyAdded.join(", ")}。新命令/事件/schema 只进 v4 或中立叶子 ` +
      `src/acode-protocol-shared.ts；向 acodeProtocolMethods/acodeProtocolNotifications 加条目、加非 schema ` +
      `const 或 export type 都属新增导出。基线更新仅限合法删减（M1–M4 退役）或 review 批准的外移。` +
      `见 specs/legacy-protocol-freeze.md。`,
  );
});

test("legacy barrel: schema 基线是全导出基线的子集（两份基线一致，无遗漏）", () => {
  const schemaBaseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as {
    schemaDefinitions: string[];
  };
  const exportsBaseline = JSON.parse(readFileSync(exportsBaselinePath, "utf-8")) as {
    localExportNames: string[];
  };
  const all = new Set(exportsBaseline.localExportNames);
  const missing = schemaBaseline.schemaDefinitions.filter((name) => !all.has(name));
  assert.deepEqual(
    missing,
    [],
    `schema 冻结基线中的定义必须也出现在全导出基线内（后者是前者的超集）。缺失：${missing.join(", ")}`,
  );
});

test("R2-02: acodeMcpReconnectSuspensionSchema 在 barrel 内是 re-export 而非本地定义", () => {
  const source = readFileSync(barrelPath, "utf-8");

  // 不得本地定义（提交 43afaba1 的违规形态）。
  assert.equal(
    /^export const acodeMcpReconnectSuspensionSchema\b/m.test(source),
    false,
    "acodeMcpReconnectSuspensionSchema 不得在 legacy barrel 本地 `export const` 定义（R2-02）",
  );
  assert.equal(
    /^export type ACodeMcpReconnectSuspension = z\.infer/m.test(source),
    false,
    "ACodeMcpReconnectSuspension 类型不得在 legacy barrel 本地定义（应随 schema 迁至中立叶子）",
  );

  // 必须以 re-export 形式对外可见（保持既有 consumer API：mcp.ts、UI McpFailurePresentation.tsx）。
  assert.match(
    source,
    /export \{[^}]*\bacodeMcpReconnectSuspensionSchema\b[^}]*\} from "\.\.\/acode-protocol-shared\.js"/s,
    "barrel 必须从 acode-protocol-shared re-export acodeMcpReconnectSuspensionSchema（保持 consumer API）",
  );
});

test("中立叶子 acode-protocol-shared.ts 承载 acodeMcpReconnectSuspensionSchema 的唯一定义", () => {
  const leaf = readFileSync(join(here, "..", "src", "acode-protocol-shared.ts"), "utf-8");
  assert.match(
    leaf,
    /^export const acodeMcpReconnectSuspensionSchema = z/m,
    "acodeMcpReconnectSuspensionSchema 定义应落在中立叶子 acode-protocol-shared.ts",
  );
  assert.match(
    leaf,
    /^export type ACodeMcpReconnectSuspension = z\.infer<typeof acodeMcpReconnectSuspensionSchema>;/m,
    "ACodeMcpReconnectSuspension 类型应随 schema 落在中立叶子",
  );
  // 中立叶子必须保持对 legacy barrel 与 v4 目录的零依赖（M2-B 纪律），否则会形成反向依赖。
  assert.equal(
    /from "\.\/acode-protocol\/index\.js"|from "\.\/acode-protocol-v4\//.test(leaf),
    false,
    "acode-protocol-shared.ts 不得 import legacy barrel 或 v4 目录（M2-B 中立叶子纪律）",
  );
});
