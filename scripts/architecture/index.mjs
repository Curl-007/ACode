import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { discoverTsconfigAliases, discoverWorkspacePackages } from "./discovery.mjs";
import { cycleViolations } from "./graph.mjs";
import { architectureCoverage } from "./coverage.mjs";
import { countPhysicalLines, gitHeadLineCount, RATCHET_EXEMPT_PATTERN } from "./ratchet.mjs";
import { changedFilesFromGit, readBaseline, updateBaseline } from "./state.mjs";

import {
  countPublicMethods,
  discoverFiles,
  importsOf,
  isException,
  layerForFile,
  loadPolicy,
  manifestRequires,
  moduleForFile,
  posix,
  publicEntrypointMatches,
  resolveImport,
  isResolvableWorkspaceSpecifier,
} from "./policy.mjs";

function fingerprint(rule, file, detail = "") {
  return createHash("sha256").update(`${rule}\0${file}\0${detail}`).digest("hex").slice(0, 16);
}

// 基线必须跨机器稳定：walk 产出的是绝对路径，若直接入指纹，基线就只认生成它的那台
// 机器（CI 的 /home/runner/… 永远对不上本地的 C:/…，baseline 恒为 0、全量判 new，
// 2026-10-07 release/0.0.4 的 CI verify 即死于此）。这里把绝对路径折成相对进程 cwd
// （checkArchitecture 的 cwd 即仓库根）的形式；折不出去（跨盘/外部路径）时原样保留。
function repoRelative(file) {
  if (!path.isAbsolute(file)) return file;
  const rel = path.relative(process.cwd(), file);
  return rel.startsWith("..") ? file : rel;
}

function isSharedV4ToLegacyProtocolImport(file, target, cwd) {
  const importer = posix(path.relative(cwd, file));
  const imported = posix(path.relative(cwd, target));
  return (
    importer.startsWith("packages/shared/src/acode-protocol-v4/") &&
    imported.startsWith("packages/shared/src/acode-protocol/")
  );
}

// legacy ratchet 的豁免面：测试/评测文件不参与「超限文件只减不增」基线，
// 避免门禁阻碍补测试（长测试文件是常态，且测试不是生产代码债）。

function violation({ rule, file, detail, message, module, global = false }) {
  const relative = posix(repoRelative(file));
  return {
    rule,
    file: relative,
    module: module?.id ?? null,
    detail,
    message,
    fingerprint: fingerprint(rule, relative, detail),
    global,
  };
}

export async function checkArchitecture({ cwd = process.cwd(), changedFiles = null } = {}) {
  const policy = await loadPolicy(cwd);
  const files = await discoverFiles(policy);
  const workspacePackages = await discoverWorkspacePackages(policy);
  const tsconfigAliases = await discoverTsconfigAliases(policy);
  const aliasRules = [...policy.global.aliasRules, ...tsconfigAliases];
  const knownFiles = new Set(files);
  const modulesByFile = new Map(files.map((file) => [file, moduleForFile(file, policy)]));
  const edges = new Map(files.map((file) => [file, []]));
  const violations = [];
  const manifestRequiresByModule = new Map();

  const today = new Date().toISOString().slice(0, 10);
  for (const exception of policy.exceptions) {
    if (exception.expires && exception.expires < today) {
      violations.push(
        violation({
          rule: "expired-exception",
          file: path.join(cwd, "architecture-policy.yaml"),
          detail: exception.id ?? exception.rule,
          message: `例外 ${exception.id ?? exception.rule} 已于 ${exception.expires} 过期`,
          global: true,
        }),
      );
    }
  }

  for (const module of policy.modules.filter((item) => item.managed)) {
    const moduleFiles = files.filter((file) => modulesByFile.get(file)?.id === module.id);
    const manifest = moduleFiles.find((file) => path.basename(file) === "module.ts");
    if (manifest)
      manifestRequiresByModule.set(
        module.id,
        manifestRequires(await fs.readFile(manifest, "utf8")) ?? module.requires,
      );
    const required = ["module.ts", "contract.ts"];
    for (const artifact of required) {
      if (!moduleFiles.some((file) => path.basename(file) === artifact)) {
        const file = module.roots[0];
        violations.push(
          violation({
            rule: "missing-module-artifact",
            file,
            detail: artifact,
            module,
            message: `模块 ${module.id} 缺少 ${artifact}`,
          }),
        );
      }
    }
  }

  // 声明的公开入口必须真实存在：防止「策略声明了 contract 但文件不存在」的幻影
  // 入口误导治理（2026-10-05 深度审查发现 session 模块声明的 contract.ts 从未落地，
  // 该声明已随本次校验的引入从策略中移除；校验本身防止未来再出现同类幻影）。
  for (const module of policy.modules) {
    for (const entry of module.publicEntrypoints) {
      const candidates = [
        path.resolve(cwd, entry),
        ...module.roots.map((root) => path.resolve(root, entry)),
      ];
      let found = false;
      for (const candidate of candidates) {
        try {
          await fs.stat(candidate);
          found = true;
          break;
        } catch {}
      }
      if (!found) {
        violations.push(
          violation({
            rule: "missing-public-entrypoint",
            file: path.join(cwd, "architecture-policy.yaml"),
            detail: `${module.id}:${entry}`,
            module,
            message: `模块 ${module.id} 声明的公开入口不存在: ${entry}`,
            global: true,
          }),
        );
      }
    }
  }

  for (const file of files) {
    const module = modulesByFile.get(file);
    if (!module) continue;
    // legacy 仍不冒充全面纳管，但 imports 必须进入反向图，并遵守目标 managed 模块入口。
    const legacyRatchet = policy.global.managedOnly && !module.managed;
    const source = await fs.readFile(file, "utf8");
    // 与 gitHeadLineCount 使用相同的物理行定义，避免末尾换行造成假回长。
    const lines = countPhysicalLines(source);
    if (
      lines > policy.global.maxFileLines &&
      !isException(policy, "max-file-lines", file, cwd) &&
      !(legacyRatchet && RATCHET_EXEMPT_PATTERN.test(posix(file)))
    ) {
      violations.push(
        violation({
          rule: "max-file-lines",
          file,
          // ratchet 语义：未纳管模块的指纹不含行数——存量超限文件继续增长不产生
          // 新违规（它们已在基线里），但任何新的超限文件都是新指纹即失败；
          // 文件缩回上限内后再次超限同样是新违规（一旦干净必须保持干净）。
          // 纳管模块保持严格语义：行数入指纹，任何增长都是新违规。
          detail: legacyRatchet ? "legacy-over-limit" : String(lines),
          module,
          message: legacyRatchet
            ? `文件 ${lines} 行，超过上限 ${policy.global.maxFileLines} 行（legacy ratchet：超限文件只减不增）`
            : `文件 ${lines} 行，超过上限 ${policy.global.maxFileLines} 行`,
        }),
      );
    }
    if (!legacyRatchet) {
      if (path.basename(file).startsWith("contract.") && lines > policy.global.maxContractLines) {
        violations.push(
          violation({
            rule: "max-contract-lines",
            file,
            detail: String(lines),
            module,
            message: `契约 ${lines} 行，超过上限 ${policy.global.maxContractLines} 行`,
          }),
        );
      }
      const disableCount = source
        .split(/\r?\n/)
        .filter((line) => /(?:oxlint|eslint)-disable/.test(line)).length;
      if (disableCount > 0 && !isException(policy, "disable-count", file, cwd)) {
        violations.push(
          violation({
            rule: "disable-count",
            file,
            detail: String(disableCount),
            module,
            message: `文件包含 ${disableCount} 条 lint disable`,
          }),
        );
      }
      if (
        path.basename(file) === "contract.ts" &&
        countPublicMethods(source) > policy.global.maxPublicMethods
      ) {
        violations.push(
          violation({
            rule: "max-public-methods",
            file,
            detail: String(countPublicMethods(source)),
            module,
            message: `契约公开方法超过上限 ${policy.global.maxPublicMethods}`,
          }),
        );
      }
    }
    const importerLayer = legacyRatchet ? null : layerForFile(file, module);
    const layerOrder = module.layerOrder ?? [];
    for (const specifier of importsOf(file, source)) {
      if (
        importerLayer === "domain" &&
        /^(node:|fs$|path$|http$|https$|net$|child_process$|timers$)/.test(specifier)
      ) {
        violations.push(
          violation({
            rule: "domain-io",
            file,
            detail: specifier,
            module,
            message: "domain 层不能依赖 IO、进程、网络或定时器",
          }),
        );
      }
      const target = resolveImport(file, specifier, knownFiles, {
        aliasRules,
        cwd,
        module,
        workspacePackages,
      });
      if (!target) {
        if (
          !legacyRatchet &&
          isResolvableWorkspaceSpecifier(specifier, {
            aliasRules: [...aliasRules, ...module.aliasRules],
            workspacePackages,
          })
        ) {
          violations.push(
            violation({
              rule: "unresolved-workspace-import",
              file,
              detail: specifier,
              module,
              message: `工作区导入无法解析到源码文件: ${specifier}`,
            }),
          );
        }
        continue;
      }
      if (isSharedV4ToLegacyProtocolImport(file, target, cwd)) {
        violations.push(
          violation({
            rule: "v4-imports-legacy-protocol",
            file,
            detail: target,
            module,
            message: "protocol v4 不能反向依赖 legacy acode-protocol；共享 schema 必须位于中立模块",
          }),
        );
      }
      edges.get(file).push(target);
      const targetModule = modulesByFile.get(target);
      if (targetModule?.id === module.id) {
        const targetLayer = layerForFile(target, module);
        if (
          importerLayer &&
          targetLayer &&
          layerOrder.includes(importerLayer) &&
          layerOrder.includes(targetLayer) &&
          layerOrder.indexOf(importerLayer) < layerOrder.indexOf(targetLayer)
        ) {
          violations.push(
            violation({
              rule: "layer-direction",
              file,
              detail: target,
              module,
              message: `层 ${importerLayer} 不能依赖更高层 ${targetLayer}`,
            }),
          );
        }
      }
      if (
        !legacyRatchet &&
        module.id === "ui" &&
        /(?:^|\/)(repo|runtime|services?)(?:\/|$)/i.test(posix(target))
      ) {
        violations.push(
          violation({
            rule: "ui-implementation-import",
            file,
            detail: target,
            module,
            message: "UI 层不能直接依赖 Repo、Runtime 或 Service 实现",
          }),
        );
      }
      if (!targetModule || targetModule.id === module.id) {
        continue;
      }
      const declaredRequires = manifestRequiresByModule.get(module.id) ?? module.requires;
      if (!legacyRatchet && !declaredRequires.includes(targetModule.id)) {
        violations.push(
          violation({
            rule: "module-dependency",
            file,
            detail: target,
            module,
            message: `模块 ${module.id} 未声明依赖 ${targetModule.id}`,
          }),
        );
      }
      if (
        policy.global.forbidDeepImports &&
        targetModule.publicEntrypoints.length > 0 &&
        (!legacyRatchet || (targetModule.managed && !RATCHET_EXEMPT_PATTERN.test(posix(file))))
      ) {
        const targetRelative = posix(path.relative(cwd, target));
        const allowed = publicEntrypointMatches(target, targetModule, cwd);
        if (!allowed) {
          violations.push(
            violation({
              rule: "deep-import",
              file,
              detail: target,
              module,
              message: `跨模块只能通过公开入口访问 ${targetRelative}`,
            }),
          );
        }
      }
    }
    if (importerLayer === "domain" && /\b(fetch|setTimeout|setInterval)\s*\(/.test(source)) {
      violations.push(
        violation({
          rule: "domain-io",
          file,
          detail: "runtime-call",
          module,
          message: "domain 层不能依赖 IO、进程、网络或定时器",
        }),
      );
    }
  }

  if (policy.global.forbidCycles)
    violations.push(...cycleViolations(edges, policy, modulesByFile, violation));
  const baseline = await readBaseline(cwd);
  const baselineFingerprints = new Set(baseline.violations.map((item) => item.fingerprint));
  const changed = changedFiles
    ? new Set(changedFiles.map((file) => path.resolve(cwd, file)))
    : null;
  if (changed) {
    const reverse = new Map(files.map((file) => [file, []]));
    for (const [from, targets] of edges)
      for (const target of targets) reverse.get(target)?.push(from);
    const queue = [...changed];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const dependent of reverse.get(current) ?? []) {
        if (!changed.has(dependent)) {
          changed.add(dependent);
          queue.push(dependent);
        }
      }
    }
  }
  const scoped = changed
    ? violations.filter((item) => item.global || changed.has(path.resolve(cwd, item.file)))
    : violations;
  const regrown = [];
  const baselineViolations = [];
  const newViolations = [];
  for (const item of scoped) {
    if (!baselineFingerprints.has(item.fingerprint)) {
      newViolations.push(item);
      continue;
    }
    // Legacy ratchet 的 fingerprint 不含行数；一旦 HEAD 中该文件已经收回上限，
    // 工作树再次超限就是回长，必须重新成为 new，而不能靠旧 baseline 永久放行。
    if (item.rule === "max-file-lines" && item.detail === "legacy-over-limit") {
      const headLines = await gitHeadLineCount(cwd, path.resolve(cwd, item.file));
      if (headLines !== null && headLines <= policy.global.maxFileLines) {
        regrown.push({
          ...item,
          rule: "max-file-lines-regrown",
          message: `${item.message}；文件在 HEAD 已收回上限后再次超限`,
        });
        newViolations.push(regrown[regrown.length - 1]);
        continue;
      }
    }
    baselineViolations.push(item);
  }
  // ratchet 总量从未过滤的全量违规统计（--changed 模式下 scoped 只是子集，
  // 报告里需要看到全仓存量趋势，判断「只减不增」是否在兑现）。
  const legacyOverLimit = violations.filter(
    (item) => item.rule === "max-file-lines" && item.detail === "legacy-over-limit",
  ).length;
  return {
    policy,
    violations: scoped,
    baselineViolations,
    newViolations,
    regrown,
    baseline,
    coverage: architectureCoverage(policy, files, modulesByFile),
    summary: { legacyOverLimit },
  };
}

// generateContext / formatReport / formatMarkdownReport 已抽至 reporting.mjs
// （ratchet 落地后本文件超出 oxlint max-lines）；此处 re-export 保持既有导入面
// （architecture-check.mjs 与技能脚本从本模块导入）。
export { generateContext, formatReport, formatMarkdownReport } from "./reporting.mjs";

export { loadPolicy, updateBaseline, changedFilesFromGit };
