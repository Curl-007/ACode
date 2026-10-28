import path from "node:path";
import ts from "typescript";
import { posix } from "./policy.mjs";

// v4 → legacy 协议面反向依赖守护（26R2-03）。
//
// 背景：protocol v4（packages/shared/src/acode-protocol-v4/）不得反向依赖 legacy 协议面。
// 旧谓词只用尾斜杠目录前缀 `acode-protocol/`，仅覆盖 barrel 目录，漏掉**同级文件**
// `acode-protocol-legacy-types.ts`（它是兄弟路径，不在该目录下）。4 个 v4 文件直接 import
// 它，此前完全不在守护边界内——上轮「v4→legacy 双层守护/无回归」的认证只验了 v4→barrel。
//
// 本模块把边界扩展为两类目标，并对二者采用不同策略：
//   ① barrel 目录 `acode-protocol/`：全禁（M4 整体删除，任何 v4→barrel 边都会断裂）。
//   ② 幸存文件 `acode-protocol-legacy-types.ts`：符号级白名单（文件本身幸存，但只允许
//      导入已冻结的幸存符号；新增任何非白名单符号即报违规）。
const V4_DIR = "packages/shared/src/acode-protocol-v4/";
const BARREL_DIR = "packages/shared/src/acode-protocol/";
const LEGACY_TYPES_FILE = "packages/shared/src/acode-protocol-legacy-types.ts";

// v4→legacy-types 幸存符号白名单（冻结面）。
//
// acode-protocol-legacy-types.ts 的头注自述：旧协议 barrel（acode-protocol/index.ts）于 M4
// 删除后，本文件是该协议面的**唯一幸存面**——故它不在 M4 被删，而是被甄别保留。v4 文件
// （snapshot / transport / telemetry / script-workflow-management / command）从中导入的
// 已登记 schema 是合法的长期依赖，本白名单使这些既有边保持绿；M2-2 经 review 显式登记
// acodeSessionGoalSchema（goal query / goalControl result 的 wire 契约面）。
//
// 缺陷不在这些既有边，而在守护谓词此前**完全不覆盖**这个文件——未来 v4 若新增导入一个 M4
// 会甄别删除的符号，门禁不会拦截。本集合冻结这 6 个既有幸存符号；任何**新**符号（不在集合
// 内）立即报 v4-imports-legacy-protocol。集合是冻结面：新增依赖须走中立叶子
// （acode-protocol-shared.ts 模式）或经 review 显式登记，不得随手扩充。
const V4_LEGACY_TYPES_SURVIVOR_SYMBOLS = Object.freeze(
  new Set([
    "acodePermissionResponseSchema",
    "acodeContextUsageBreakdownSchema",
    "acodeInteractionRequestOriginSchema",
    "acodeSessionContextCacheUsageSchema",
    "acodeWorkspaceRefSchema",
    "acodeSyntheticUserMessageSourceSchema",
    // M2-2（2026-10-28，spec apps/acode-cli/specs/m2-2-session-control.md）：goal wire 形态
    // 是 v4 goal query 与 goalControl command result 的契约面；legacy-types.ts 是 M4 后
    // 唯一幸存面，本符号随之幸存，显式登记（review = 本批 spec §3 所有权节）。
    "acodeSessionGoalSchema",
    // M2-3（2026-10-28，spec apps/acode-cli/specs/m2-3-session-readwrite.md §3）：
    // session 读写面六 query 的 params/result 词汇（deliveryKind 投递画像、mode 值域、
    // sessionInfo/messages result 元素形态）随 M4 幸存面收编，显式登记。
    "acodeDeliveryKindSchema",
    "acodeSessionModeSchema",
    "acodeSessionInfoSchema",
    "acodeMessageWithPartsSchema",
  ]),
);

// 通配/整体重导标记：`import * as ns` 或 `export * from` 会拉入目标文件的**全部**符号
// （含 M4 会删的），无法按符号白名单收窄，用一个必然不在白名单内的哨兵表示「整体依赖」，
// 使其 fail-closed 报违规。
const WHOLE_MODULE_MARKER = "*";

// 从 import/export 声明的 clause 收集**被导入的源符号名**（重命名 `a as b` 取源名 `a`）。
function collectClauseNames(clause, sink) {
  if (!clause) return;
  // 默认导入（`import x from`）：源符号是 default。legacy-types 无 default 导出，若出现则
  // "default" 不在白名单 → 报违规（fail-closed）。
  if (clause.name && ts.isIdentifier(clause.name)) sink.push(clause.name.text);
  const bindings = clause.namedBindings;
  if (!bindings) return;
  if (ts.isNamespaceImport(bindings)) {
    // `import * as ns from` → 整体依赖。
    sink.push(WHOLE_MODULE_MARKER);
    return;
  }
  // NamedImports / NamedExports：逐个取 propertyName ?? name（源侧符号名）。
  for (const element of bindings.elements) {
    const sourceName = element.propertyName ?? element.name;
    if (sourceName) sink.push(sourceName.text);
  }
}

// 提取文件中经指定 specifier 导入/重导的全部源符号名。
// 返回 { names, wholeModule, sideEffectOnly }：
//   - names：具名符号（含哨兵 "*" 若为 namespace import）；
//   - wholeModule：存在 `export * from <specifier>`（无 clause 的整体重导）；
//   - sideEffectOnly：只有 `import "<specifier>"`（无 clause、无绑定），不引用任何具名符号。
function importedSymbolsForSpecifier(file, source, specifier) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const names = [];
  let sawDeclaration = false;
  let sideEffectOnly = true;
  function visit(node) {
    const isImport = ts.isImportDeclaration(node);
    const isExport = ts.isExportDeclaration(node);
    if (
      (isImport || isExport) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === specifier
    ) {
      sawDeclaration = true;
      const clause = isImport ? node.importClause : node.exportClause;
      if (clause) {
        sideEffectOnly = false;
        collectClauseNames(clause, names);
      } else if (isExport) {
        // `export * from "<specifier>"`：无 exportClause 的重导 = 整体依赖。
        sideEffectOnly = false;
        names.push(WHOLE_MODULE_MARKER);
      }
      // 否则是纯 side-effect import（`import "<specifier>"`）：无符号绑定。
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { names, sawDeclaration, sideEffectOnly: sawDeclaration && sideEffectOnly };
}

/**
 * 判定一条 v4 → legacy 协议面依赖是否越界。
 * @returns {string|null} 越界时返回违规 message；合法（中立叶子 / 白名单幸存符号 / 非 v4→legacy）返回 null。
 */
export function v4LegacyProtocolBoundaryViolation({ file, target, cwd, specifier, source }) {
  const importer = posix(path.relative(cwd, file));
  const imported = posix(path.relative(cwd, target));
  if (!importer.startsWith(V4_DIR)) return null;

  // ① barrel 目录：全禁（保持既有语义与 message 不变）。
  if (imported.startsWith(BARREL_DIR)) {
    return "protocol v4 不能反向依赖 legacy acode-protocol；共享 schema 必须位于中立模块";
  }

  // ② 幸存文件 legacy-types.ts：符号级白名单。
  if (imported === LEGACY_TYPES_FILE) {
    const { names, sideEffectOnly } = importedSymbolsForSpecifier(file, source, specifier);
    // 纯 side-effect import 不绑定任何符号；文件本身幸存 M4，故不构成新符号依赖，放行。
    if (sideEffectOnly) return null;
    const disallowed = [...new Set(names)].filter(
      (name) => !V4_LEGACY_TYPES_SURVIVOR_SYMBOLS.has(name),
    );
    if (disallowed.length === 0) return null;
    const listed = disallowed.join(", ");
    return `protocol v4 只能从 acode-protocol-legacy-types.ts 导入白名单幸存符号；未登记符号: ${listed}（新增须走中立叶子 acode-protocol-shared.ts 或经 review 显式登记白名单）`;
  }

  // 其余（中立叶子 acode-protocol-shared.ts、v4 内部、其它模块）不在本守护范围。
  return null;
}
