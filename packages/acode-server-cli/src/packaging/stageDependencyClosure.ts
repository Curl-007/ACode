// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自 ./stage.ts 拆出。
// 职责：发行 staging 的依赖闭包解析——bundle 裸模块扫描、package.json 读取、
// node_modules 逐级定位、生产依赖闭包收集与 target 专属包过滤（纯逻辑，可离线测试）。
import { builtinModules } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type ServerTarget } from "../runtime/manifest.js";

const NODE_BUILTIN_MODULES = new Set(builtinModules);

/**
 * 从 bundle 产物中提取顶层裸模块引用（`from "x"` / `import("x")` / `require("x")`）。
 * 结果只做语法归一化（scoped 包取前两段），是否为真实 npm 包由调用方与
 * workspace node_modules 求交集决定；node 内置模块在这里直接过滤。
 */
export function collectBareModuleSpecifiers(source: string): Set<string> {
  const names = new Set<string>();
  const specifierPattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"'\n]+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = specifierPattern.exec(source)) !== null) {
    const specifier = match[1];
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) continue;
    if (specifier.startsWith("node:")) continue;
    const segments = specifier.split("/");
    const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
    if (!packageName || NODE_BUILTIN_MODULES.has(packageName)) continue;
    names.add(packageName);
  }
  return names;
}

export async function readPackageJson(packageDir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/**
 * 按 Node 解析规则的简化版，从依赖者真实目录逐级向上定位 `node_modules/<name>`。
 * 不走 main/exports 入口解析，因此对 exports 收紧或 types-only 的包同样适用；
 * pnpm（依赖在 `.pnpm/<pkg>/node_modules` 同级）与 npm 扁平布局都能命中。
 */
export async function findDependencyDir(fromDir: string, name: string): Promise<string | null> {
  let current = resolve(fromDir);
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if ((await readPackageJson(candidate)) !== null) {
      return await realpath(candidate);
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * 从入口包集合出发递归收集生产依赖闭包（dependencies + optionalDependencies）。
 * 返回 包名 → 真实目录。同名包解析到不同真实目录时报错：扁平发行布局放不下两个版本，
 * 静默选一个会把版本漂移带进发行包。optional 依赖缺失时跳过。
 */
export async function resolveProductionPackageClosure(
  entryPackageNames: readonly string[],
  nodeModulesDir: string,
  workspacePackageDirs: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, string>> {
  const closure = new Map<string, string>();
  const queue: Array<{ name: string; fromDir: string; optional: boolean }> = entryPackageNames.map(
    (name) => ({ name, fromDir: dirname(resolve(nodeModulesDir)), optional: true }),
  );

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const packageDir =
      (await findDependencyDir(item.fromDir, item.name)) ??
      workspacePackageDirs.get(item.name) ??
      null;
    if (!packageDir) {
      if (item.optional) continue;
      throw new Error(
        `Missing production dependency in workspace: ${item.name} (from ${item.fromDir})`,
      );
    }
    const existing = closure.get(item.name);
    if (existing) {
      if (existing !== packageDir) {
        // pnpm peer 依赖可能合法地同时存在多个版本（典型是 ajv6 + ajv8）。
        // 顶层保留最先解析的版本，包自身 nested node_modules 在复制阶段保留，
        // 让 Node 的局部解析规则选择正确 peer；不能把合法的 Agent bundle 拒绝 staging。
        continue;
      }
      continue;
    }
    closure.set(item.name, packageDir);

    const packageJson = await readPackageJson(packageDir);
    const dependencies = (packageJson?.dependencies ?? {}) as Record<string, string>;
    const optionalDependencies = (packageJson?.optionalDependencies ?? {}) as Record<
      string,
      string
    >;
    for (const dependencyName of Object.keys(dependencies)) {
      queue.push({
        name: dependencyName,
        fromDir: packageDir,
        optional: dependencyName in optionalDependencies,
      });
    }
    for (const dependencyName of Object.keys(optionalDependencies)) {
      queue.push({ name: dependencyName, fromDir: packageDir, optional: true });
    }
  }
  return closure;
}

export function isTargetSpecificPackage(packageName: string, target: ServerTarget): boolean {
  if (!packageName.startsWith("@mbears/opentui-core-")) return true;
  return packageName === `@mbears/opentui-core-${target}`;
}
