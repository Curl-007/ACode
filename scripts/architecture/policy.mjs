import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export function posix(value) {
  return value.split(path.sep).join("/");
}

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension));
}

async function walk(root, files) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (["node_modules", "dist", "out", "coverage", ".git"].includes(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(target, files);
    else if (entry.isFile() && isSourceFile(target)) files.push(target);
  }
}

function validatePolicy(raw, cwd) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.modules)) {
    throw new Error("architecture-policy.yaml 必须包含 version: 1 和 modules 数组");
  }
  const ids = new Set();
  const modules = raw.modules.map((module) => {
    if (!module?.id || ids.has(module.id))
      throw new Error(`模块 id 重复或为空: ${module?.id ?? ""}`);
    ids.add(module.id);
    if (!Array.isArray(module.roots) || module.roots.length === 0) {
      throw new Error(`模块 ${module.id} 必须声明 roots`);
    }
    return {
      id: module.id,
      roots: module.roots.map((root) => path.resolve(cwd, root)),
      managed: module.managed === true,
      requires: [...new Set(module.requires ?? [])],
      publicEntrypoints: (module.publicEntrypoints ?? []).map((entry) => posix(entry)),
      // 通配公开入口（ARCH-04 resolver 缺口②）：repo-relative posix glob，`*` 单段、
      // `**` 跨段。必须含 `*`（精确入口应走 publicEntrypoints）。未匹配到任何文件的
      // pattern 是 fail-closed（等同无入口，范围内 deep-import 仍报违规），不会放宽边界。
      publicEntrypointPatterns: (module.publicEntrypointPatterns ?? []).map((pattern) => {
        const value = posix(String(pattern));
        if (!value.includes("*"))
          throw new Error(
            `模块 ${module.id} 的 publicEntrypointPatterns 必须含通配符 *（精确入口请用 publicEntrypoints）: ${value}`,
          );
        return value;
      }),
      // 迁移中模块的内部边白名单（ARCH-04 resolver 缺口④）：publicEntrypoints 尚不能
      // 覆盖存量实现文件直引时，逐条冻结既有 (from → to) repo-relative 边；未登记的新边
      // 报 deep-import，把「惰性保持合法」变成「新增需显式登记」，止住内部边增长。
      internalEdgeAllowlist: (module.internalEdgeAllowlist ?? [])
        .map((edge) => ({ from: posix(String(edge?.from ?? "")), to: posix(String(edge?.to ?? "")) }))
        .filter((edge) => edge.from && edge.to),
      layers: module.layers ?? {},
      layerOrder: module.layerOrder ?? Object.keys(module.layers ?? {}),
      owner: module.owner ?? null,
      aliasRules: [...(module.aliasRules ?? [])],
    };
  });
  const moduleIds = new Set(modules.map((module) => module.id));
  for (const module of modules) {
    for (const dependency of module.requires) {
      if (!moduleIds.has(dependency))
        throw new Error(`模块 ${module.id} 依赖未知模块 ${dependency}`);
    }
  }
  const global = {
    maxFileLines: raw.global?.maxFileLines ?? 400,
    maxContractLines: raw.global?.maxContractLines ?? 300,
    forbidCycles: raw.global?.forbidCycles !== false,
    forbidDeepImports: raw.global?.forbidDeepImports !== false,
    managedOnly: raw.global?.managedOnly !== false,
    maxPublicMethods: raw.global?.maxPublicMethods ?? 12,
    // asset 导入豁免（ARCH-04 resolver 缺口③）：这些扩展名的 specifier 是构建期静态资源
    // （CSS/图片/字体），不是模块依赖边，不计入 deep-import / module-dependency /
    // unresolved-workspace-import 违规。**在 policy 显式声明**，不硬编码在 checker 里；
    // 默认空集合 = 不豁免（fail-closed），仓库按需登记。扩展名统一小写、以 `.` 开头。
    assetExtensions: (raw.global?.assetExtensions ?? [])
      .map((extension) => String(extension).toLowerCase())
      .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`)),
  };
  const exceptions = (raw.exceptions ?? []).map((exception) => ({
    ...exception,
    paths: exception.paths ?? [],
  }));
  return {
    version: 1,
    modules,
    global: {
      ...global,
      aliasRules: [...(raw.global?.aliasRules ?? raw.aliasRules ?? [])],
    },
    exceptions,
  };
}

export function layerForFile(file, module) {
  const matches = module.roots
    .flatMap((root) =>
      Object.entries(module.layers).map(([name, directory]) => ({
        name,
        directory: path.resolve(root, directory),
      })),
    )
    .filter(({ directory }) => file === directory || file.startsWith(`${directory}${path.sep}`))
    .sort((a, b) => b.directory.length - a.directory.length);
  return matches[0]?.name ?? null;
}

// 把 repo-relative posix glob 编译成正则：`**` 跨段（含 `/`），`*` 单段（不含 `/`），
// 其余字符转义。用于 publicEntrypointPatterns（ARCH-04 resolver 缺口②）。
function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

// 从 package.json exports 的 value 提取源码 target：value 可能是 string，或 conditional
// object（{types,import,require,default}）——递归取第一个可用作依赖边的 string 分支。
// `.d.ts`/`.d.mts`/`.d.cts` 纯类型声明**不作为架构依赖边**（不构成运行时模块依赖，且
// policy 有意不把 .d.ts 登记为公开入口，如 @acode/client/globals → src/globals.d.ts）；
// 返回 null 让 resolveImport 回退 src 约定，避免把类型声明解析成 deep-import 违规。
function exportsTargetSource(exportsValue) {
  if (typeof exportsValue === "string")
    return /\.d\.[cm]?ts$/.test(exportsValue) ? null : exportsValue;
  if (exportsValue && typeof exportsValue === "object") {
    for (const nested of Object.values(exportsValue)) {
      const found = exportsTargetSource(nested);
      if (found) return found;
    }
  }
  return null;
}

export function publicEntrypointMatches(target, targetModule, cwd) {
  // 精确入口（既有语义）：绝对路径相等。
  const exact = targetModule.publicEntrypoints.some((entry) => {
    const candidates = [
      path.resolve(cwd, entry),
      ...targetModule.roots.map((root) => path.resolve(root, entry)),
    ];
    return candidates.includes(target);
  });
  if (exact) return true;
  // 通配入口（ARCH-04 resolver 缺口②）：pattern 是 repo-relative posix glob，只匹配已
  // 声明范围，范围外 deep-import 仍报违规；未匹配到任何文件的 pattern 是 fail-closed
  //（等同无入口），不会放宽边界。
  const patterns = targetModule.publicEntrypointPatterns ?? [];
  if (patterns.length === 0) return false;
  const relative = posix(path.relative(cwd, target));
  if (relative.startsWith("..")) return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(relative));
}

// asset 导入识别（ARCH-04 resolver 缺口③）：specifier 以 policy 显式声明的 asset 扩展名
// 结尾（去掉 vite 的 `?url`/`?raw` query 与 hash）即视为静态资源，不计入 deep-import /
// module-dependency / unresolved-workspace-import 违规。扩展名集合在 policy.global
// .assetExtensions 声明（不硬编码在 checker 里），默认空集合 = 不豁免（fail-closed）。
// 伪装成 asset 的 TS deep-import（如 `./foo.ts`）扩展名不在集合内，不被豁免。
export function isAssetSpecifier(specifier, policy) {
  const extensions = policy?.global?.assetExtensions ?? [];
  if (extensions.length === 0) return false;
  const clean = String(specifier).split("?")[0].split("#")[0];
  return extensions.some((extension) => clean.endsWith(extension));
}

// 迁移中模块的内部边白名单判定（ARCH-04 resolver 缺口④）：publicEntrypoints 尚不能覆盖
// 存量实现文件直引时（如 session 的 24 条 services→session 边），用逐条冻结的 (from → to)
// repo-relative posix 边放行既有依赖；未登记的新边不被放行 → 报 deep-import，止住增长。
// 白名单只精确匹配 (from,to) 对，不做前缀/通配，范围最窄且可审计。
export function internalEdgeAllowed(file, target, targetModule, cwd) {
  const allowlist = targetModule.internalEdgeAllowlist ?? [];
  if (allowlist.length === 0) return false;
  const from = posix(path.relative(cwd, file));
  const to = posix(path.relative(cwd, target));
  if (from.startsWith("..") || to.startsWith("..")) return false;
  return allowlist.some((edge) => edge.from === from && edge.to === to);
}

// deep-import 门禁的边界存在性判定：目标模块声明了任一边界（精确入口 / 通配入口 /
// 内部边白名单）才受 deep-import 校验。抽到 policy.mjs 保持 index.mjs 精简（oxlint
// max-lines 400）。全空 = 无边界 = 该模块尚未纳管 deep-import（如留空且无白名单的迁移态）。
export function moduleHasBoundary(module) {
  return (
    module.publicEntrypoints.length > 0 ||
    (module.publicEntrypointPatterns?.length ?? 0) > 0 ||
    (module.internalEdgeAllowlist?.length ?? 0) > 0
  );
}

export function manifestRequires(source) {
  const match = source.match(/requires\s*:\s*\[([^\]]*)\]/s);
  if (!match) return null;
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
}

export function countPublicMethods(source) {
  const sourceFile = ts.createSourceFile("contract.ts", source, ts.ScriptTarget.Latest, true);
  let count = 0;
  function visit(node) {
    if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
      for (const member of node.members) {
        if (
          ts.isMethodSignature(member) ||
          ts.isMethodDeclaration(member) ||
          ts.isCallSignatureDeclaration(member)
        )
          count += 1;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return count;
}

export async function loadPolicy(cwd = process.cwd()) {
  const filename = path.join(cwd, "architecture-policy.yaml");
  const content = await fs.readFile(filename, "utf8");
  return validatePolicy(parseYaml(content), cwd);
}

export function moduleForFile(file, policy) {
  const candidates = policy.modules
    .filter((module) =>
      module.roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`)),
    )
    .sort(
      (a, b) =>
        Math.max(...b.roots.map((root) => root.length)) -
        Math.max(...a.roots.map((root) => root.length)),
    );
  return candidates[0] ?? null;
}

export async function discoverFiles(policy) {
  const files = [];
  for (const module of policy.modules) {
    for (const root of module.roots) await walk(root, files);
  }
  return [...new Set(files)].sort();
}

function resolveKnownFile(base, knownFiles) {
  if (SOURCE_EXTENSIONS.some((extension) => base.endsWith(extension))) {
    base = base.slice(0, base.lastIndexOf("."));
  }
  const candidates = [];
  for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(path.join(base, `index${extension}`));
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? null;
}

function aliasTarget(specifier, rule) {
  const pattern = String(rule.pattern ?? rule.from ?? rule.prefix ?? "");
  const target = String(rule.target ?? rule.to ?? rule.root ?? "");
  if (!pattern || !target) return null;
  const marker = pattern.indexOf("*");
  if (marker < 0) return specifier === pattern ? target : null;
  const prefix = pattern.slice(0, marker);
  const suffix = pattern.slice(marker + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  const middle = specifier.slice(prefix.length, specifier.length - suffix.length);
  return target.replaceAll("*", middle);
}

// 从 package.json exports 表解析子路径 → 源码 target 字符串（ARCH-04 resolver 缺口①）。
// subpath 为空表示包根（key "."），否则 key 为 `./<subpath>`。先精确匹配，再匹配含单个
// `*` 的 pattern（如 @acode/server 的 `./remote/*.js` → `./src/remote/*.ts`）。返回 target
// 字符串（相对包根，形如 `./src/x.ts`）或 null（未命中、或命中纯 .d.ts 声明）。
function resolveExportsTarget(exportsMap, subpath) {
  if (!exportsMap || typeof exportsMap !== "object") return null;
  const key = subpath ? `./${subpath}` : ".";
  if (key in exportsMap) {
    const direct = exportsTargetSource(exportsMap[key]);
    if (direct) return direct;
  }
  for (const [pattern, value] of Object.entries(exportsMap)) {
    const marker = pattern.indexOf("*");
    if (marker < 0) continue;
    const prefix = pattern.slice(0, marker);
    const suffix = pattern.slice(marker + 1);
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    const middle = key.slice(prefix.length, key.length - suffix.length || undefined);
    const target = exportsTargetSource(value);
    if (target) return target.replaceAll("*", middle);
  }
  return null;
}

/** Resolve relative imports, policy aliases, workspace package names and TS-style paths. */
export function resolveImport(from, specifier, knownFiles, options = {}) {
  if (specifier.startsWith(".")) {
    return resolveKnownFile(path.resolve(path.dirname(from), specifier), knownFiles);
  }
  const aliases = [...(options.aliasRules ?? []), ...(options.module?.aliasRules ?? [])];
  for (const rule of aliases) {
    const target = aliasTarget(specifier, rule);
    if (target) {
      const candidate = resolveKnownFile(
        path.resolve(options.cwd ?? process.cwd(), target),
        knownFiles,
      );
      if (candidate) return candidate;
    }
  }
  for (const [name, entry] of Object.entries(options.workspacePackages ?? {})) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    // 兼容两种 shape：旧 `{name: rootString}`、新 `{name: {root, exports}}`（discovery.mjs
    // 现产出后者，携带 exports map 以解析 remap 型子路径）。
    const root = typeof entry === "string" ? entry : entry?.root;
    const exportsMap = typeof entry === "string" ? null : entry?.exports;
    if (!root) continue;
    const subpath = specifier === name ? "" : specifier.slice(name.length + 1);
    // ① exports map 权威解析（补 ARCH-04 缺口①：remap 型子路径，如 shared/runtime-env →
    // src/runtimeEnv.ts，`<root>/src/<subpath>` 约定推不出）。
    const exportTarget = resolveExportsTarget(exportsMap, subpath);
    if (exportTarget) {
      const resolved = resolveKnownFile(path.resolve(root, exportTarget), knownFiles);
      if (resolved) return resolved;
    }
    // ② 回退 src 约定（无 exports map、或子路径未在 exports 声明时；保持既有解析面不变）。
    const candidate = resolveKnownFile(path.join(root, "src", subpath), knownFiles);
    if (candidate) return candidate;
  }
  return null;
}

export function isResolvableWorkspaceSpecifier(specifier, options = {}) {
  if ([...(options.aliasRules ?? [])].some((rule) => aliasTarget(specifier, rule) !== null)) {
    return true;
  }
  return Object.keys(options.workspacePackages ?? {}).some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

export function importsOf(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (ts.isStringLiteral(node.moduleReference.expression))
        imports.push(node.moduleReference.expression.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports;
}

export function isException(policy, rule, file, cwd) {
  const relative = posix(path.relative(cwd, file));
  return policy.exceptions.some(
    (exception) =>
      exception.rule === rule &&
      exception.paths.some(
        (pattern) => relative === pattern || relative.startsWith(pattern.replace(/\*\*$/, "")),
      ),
  );
}
