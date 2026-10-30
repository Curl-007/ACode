// renderer 浏览器安全守护：desktop/web renderer 入口的值导入闭包中禁止出现 node: builtin。
// spec: packages/services/specs/session-module-boundary.md「浏览器安全不变量」。
// 修复依据（2026-10-30 白屏事故）：services 根 barrel 经 contract.ts hub 的值边会被 rolldown
// 把 hub 上 Node-only 模块（automationRepo/offPeakTaskRepo 顶层 createRequire("node:sqlite")、
// paths.ts 顶层 homedir()）保守保留进 renderer 产物——Windows 生产构建启动即白屏；vite dev
// 全图求值下 node:crypto 命名导入在模块图评估期即抛。既有门禁全部测不到：单测跑 Node 环境
// （node: 可用），e2e/CI 冒烟跑生产构建且不深入断言 renderer 挂载。本测试静态遍历值导入
// 闭包补位该盲区（type-only 边按 esbuild/oxc 语义擦除，不计入）。
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve as presolve } from "node:path";

const repoRoot = presolve(import.meta.dirname, "../../..");
const packagesDir = join(repoRoot, "packages");

/** 登记豁免：命名空间导入 + 调用点 try/catch 的「模块加载零副作用」审计模式（见文件头注释）。 */
const NODE_IMPORT_ALLOWLIST = new Set(
  [
    // services 日志脱敏单例：import * as nodeOs，属性访问全部推迟到 safe* 调用期且有 env 兜底；
    // 该模式正是上一次 dev 黑屏回归的修复产物，豁免经审计而非疏漏。
    "packages/services/src/logger/logPrivacy.ts",
  ].map((p) => join(repoRoot, ...p.split("/"))),
);

// 包名 → { dir, pj }（workspace 包进闭包；第三方裸包名由 vite 预构建处理，不在本守护范围）
const pkgInfo = new Map();
for (const name of readdirSync(packagesDir)) {
  const dir = join(packagesDir, name);
  const pjPath = join(dir, "package.json");
  if (!existsSync(pjPath)) continue;
  try {
    const pj = JSON.parse(readFileSync(pjPath, "utf8"));
    if (pj.name) pkgInfo.set(pj.name, { dir, pj });
  } catch {
    // 非包目录忽略
  }
}

function toFile(abs) {
  const cands = [
    abs,
    abs + ".ts",
    abs + ".tsx",
    abs + ".mjs",
    join(abs, "index.ts"),
    join(abs, "index.tsx"),
    abs.replace(/\.js$/, ".ts"),
    abs.replace(/\.js$/, ".tsx"),
    abs.replace(/\.jsx$/, ".tsx"),
  ];
  for (const c of cands) {
    if (existsSync(c)) {
      try {
        if (statSync(c).isFile()) return c;
      } catch {
        // 不可读候选跳过
      }
    }
  }
  return null;
}

function pickExportTarget(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") return entry.default || entry.import || entry.require;
  return null;
}

function resolvePkgSpec(spec) {
  const parts = spec.split("/");
  const scoped = spec.startsWith("@");
  const pkgName = scoped ? parts.slice(0, 2).join("/") : parts[0];
  const rest = scoped ? parts.slice(2) : parts.slice(1);
  const info = pkgInfo.get(pkgName);
  if (!info) return null;
  const sub = rest.length ? "./" + rest.join("/") : ".";
  const exports = info.pj.exports;
  let rel = null;
  if (typeof exports === "string" && sub === ".") rel = exports;
  else if (exports && typeof exports === "object") {
    const e = exports[sub];
    if (e !== undefined) rel = pickExportTarget(e);
    if (rel == null) {
      for (const [k, v] of Object.entries(exports)) {
        if (k.endsWith("/*") && sub.startsWith(k.slice(0, -1))) {
          rel = pickExportTarget(v)?.replace("*", sub.slice(k.length - 1));
          break;
        }
      }
    }
  }
  if (!rel && sub === ".") rel = info.pj.module || info.pj.main;
  if (!rel || typeof rel !== "string") return null;
  return toFile(presolve(info.dir, rel));
}

/** 找到文件所属 workspace 包（解析 package.json imports 的 "#…" 别名用）。 */
function owningPkg(file) {
  let best = null;
  for (const info of pkgInfo.values()) {
    const src = join(info.dir, "src");
    if ((file.startsWith(src + "\\") || file.startsWith(src + "/")) && (!best || src.length > best.src.length)) {
      best = { ...info, src };
    }
  }
  return best;
}

function resolveSpec(spec, fromFile) {
  spec = spec.split("?")[0];
  if (/\.(css|scss|less|mp3|wav|ogg|png|jpe?g|gif|svg|webp|woff2?|ttf|eot|wasm|md|html|json)$/i.test(spec)) {
    return { skip: true };
  }
  if (spec.startsWith("node:")) return { builtin: spec };
  if (!/^[.#@]/.test(spec)) return null; // 第三方裸包名不进闭包
  if (spec.startsWith("#")) {
    const owner = owningPkg(fromFile);
    const imports = owner?.pj?.imports;
    if (!owner || !imports) return null;
    for (const [k, v] of Object.entries(imports)) {
      if (k === spec) {
        const f = toFile(presolve(owner.dir, pickExportTarget(v)));
        return f ? { file: f } : null;
      }
      if (k.endsWith("/*") && spec.startsWith(k.slice(0, -1))) {
        const rel = pickExportTarget(v)?.replace("*", spec.slice(k.length - 1));
        const f = rel ? toFile(presolve(owner.dir, rel)) : null;
        return f ? { file: f } : null;
      }
    }
    return null;
  }
  if (spec === "@" || spec.startsWith("@/")) {
    // desktop/web 两个 vite 配置一致：@ → packages/ui/src
    return { file: toFile(join(packagesDir, "ui", "src", spec.slice(1))) };
  }
  if (spec.startsWith(".")) {
    const f = toFile(presolve(dirname(fromFile), spec));
    return f ? { file: f } : null;
  }
  const f = resolvePkgSpec(spec);
  return f ? { file: f } : null;
}

/** 提取值导入边：跳过 import type / export type 语句与全 inline-type 说明符（esbuild/oxc 擦除语义）。 */
function extractValueSpecs(file) {
  const src = readFileSync(file, "utf8");
  const specs = [];
  const re = /(?:^|[\n;})])\s*(import|export)(\s+type)?\s([^;]*?)from\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[2]) continue;
    const clause = m[3];
    const brace = clause.indexOf("{");
    if (brace !== -1) {
      const inner = clause.slice(brace + 1, clause.lastIndexOf("}"));
      const items = inner.split(",").map((s) => s.trim()).filter(Boolean);
      if (items.length > 0 && items.every((s) => s.startsWith("type "))) continue;
    }
    specs.push(m[4]);
  }
  const reSide = /(?:^|[\n;])\s*import\s*"([^"]+)"/g;
  while ((m = reSide.exec(src)) !== null) specs.push(m[1]);
  return specs;
}

/** BFS 值导入闭包，返回 [{builtin, file, chain}]（chain 为入口到命中文件的路径）。 */
function collectNodeBuiltinHits(entry) {
  assert.ok(existsSync(entry), `renderer 入口不存在（路径漂移会静默失去守护）：${entry}`);
  const prev = new Map();
  const seen = new Set([entry]);
  const queue = [entry];
  const hits = [];
  while (queue.length > 0) {
    const cur = queue.shift();
    let specs;
    try {
      specs = extractValueSpecs(cur);
    } catch {
      continue;
    }
    for (const rawSpec of specs) {
      const spec = rawSpec.split("?")[0];
      const recordHit = (builtin) => {
        const chain = [];
        let n = cur;
        while (n) {
          chain.unshift(n);
          n = prev.get(n);
        }
        hits.push({ builtin, file: cur, chain });
      };
      if (spec.startsWith("node:")) {
        recordHit(spec);
        continue;
      }
      const r = resolveSpec(rawSpec, cur);
      if (!r || r.skip || !r.file || seen.has(r.file)) continue;
      if (r.builtin) {
        recordHit(r.builtin);
        continue;
      }
      seen.add(r.file);
      prev.set(r.file, cur);
      queue.push(r.file);
    }
  }
  return { hits, visited: seen.size };
}

const rel = (p) => p.replace(repoRoot, "").replaceAll("\\", "/");

for (const [label, entry] of [
  ["desktop", join(packagesDir, "desktop", "src", "renderer", "src", "main.tsx")],
  ["web", join(packagesDir, "web", "src", "main.tsx")],
]) {
  test(`renderer 浏览器安全（${label}）：值导入闭包零 node: builtin（豁免表之外）`, () => {
    const { hits, visited } = collectNodeBuiltinHits(entry);
    assert.ok(visited > 500, `闭包规模异常（visited=${visited}），解析规则可能失效导致假绿`);
    const violations = hits.filter((h) => !NODE_IMPORT_ALLOWLIST.has(h.file));
    assert.deepEqual(
      violations.map((v) => `${v.builtin} @ ${rel(v.file)}\n  chain: ${v.chain.map(rel).join(" -> ")}`),
      [],
      `${label} renderer 值导入闭包命中 node: builtin（dev 全图求值必炸、prod 顶层调用即白屏）。` +
        `修复指引见 packages/services/specs/session-module-boundary.md「浏览器安全不变量」：` +
        `值边改直连浏览器安全叶子，或把 Node-only 实现移出被 barrel/闭包引用的模块。`,
    );
  });
}

test("豁免表自身有效：登记文件存在且确实使用命名空间导入模式", () => {
  for (const file of NODE_IMPORT_ALLOWLIST) {
    assert.ok(existsSync(file), `豁免登记文件已不存在，应删除登记：${rel(file)}`);
    const src = readFileSync(file, "utf8");
    assert.match(
      src,
      /import \* as \w+ from "node:/,
      `豁免文件未使用命名空间导入模式（命名导入会在 dev 模块图求值期即抛）：${rel(file)}`,
    );
  }
});
