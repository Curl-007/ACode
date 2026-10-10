import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";

// User state is outside architecture inputs. In particular, never inspect the
// repository's `.acode/` data while discovering workspace manifests/configs.
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "out", ".git", ".acode"]);

function commonAncestor(paths) {
  if (paths.length === 0) return process.cwd();
  const segments = paths.map((value) => path.resolve(value).split(path.sep));
  const first = segments[0];
  let length = first.length;
  for (const current of segments.slice(1)) {
    length = Math.min(length, current.length);
    while (length > 0 && first.slice(0, length).join(path.sep) !== current.slice(0, length).join(path.sep))
      length -= 1;
  }
  return first.slice(0, Math.max(1, length)).join(path.sep) || path.parse(first[0]).root;
}

function policySearchRoot(policy) {
  return commonAncestor(policy.modules.flatMap((module) => module.roots));
}

/** Discover workspace package names under policy roots for import resolution. */
export async function discoverWorkspacePackages(policy) {
  const packages = {};
  async function visit(root, depth) {
    // 从仓库共同祖先开始搜索时，apps/<app>/packages/<package> 的 manifest
    // 通常位于第 4 层；保留有限深度，避免误扫深层生成目录。
    if (depth > 6) return;
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    const packageFile = entries.find((entry) => entry.isFile() && entry.name === "package.json");
    if (packageFile) {
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(root, packageFile.name), "utf8"));
        if (typeof manifest.name === "string" && manifest.name.trim())
          packages[manifest.name] = root;
      } catch {}
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name)) continue;
      await visit(path.join(root, entry.name), depth + 1);
    }
  }
  await visit(policySearchRoot(policy), 0);
  return packages;
}

/** Discover TypeScript path aliases declared below policy roots. */
export async function discoverTsconfigAliases(policy) {
  const aliases = [];
  const seen = new Set();
  async function visit(root, depth) {
    if (depth > 6) return;
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await visit(path.join(root, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile() || !/^tsconfig(?:\..+)?\.json$/.test(entry.name)) continue;
      const file = path.join(root, entry.name);
      try {
        const parsed = ts.parseConfigFileTextToJson(file, await fs.readFile(file, "utf8"));
        if (parsed.error || !parsed.config || typeof parsed.config !== "object") continue;
        const config = parsed.config;
        const baseUrl = path.resolve(path.dirname(file), config.compilerOptions?.baseUrl ?? ".");
        for (const [pattern, targets] of Object.entries(config.compilerOptions?.paths ?? {})) {
          for (const target of Array.isArray(targets) ? targets : []) {
            if (typeof target === "string") {
              const alias = { pattern, target: path.resolve(baseUrl, target) };
              const key = `${alias.pattern}\0${alias.target}`;
              if (!seen.has(key)) {
                seen.add(key);
                aliases.push(alias);
              }
            }
          }
        }
      } catch {}
    }
  }
  await visit(policySearchRoot(policy), 0);
  return aliases;
}
