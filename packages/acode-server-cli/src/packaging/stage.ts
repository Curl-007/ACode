import { access, chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRuntimeManifest, type ServerTarget } from "../runtime/manifest.js";
import { resolveHostTarCommand } from "./tarCommand.js";
// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：依赖闭包解析、runtime
// 资产复制与归档原语分别拆入 stageDependencyClosure.ts / stageRuntimeAssets.ts /
// stageArchive.ts；本文件保留 staging 主编排（stageRelease）与 node-pty prebuild 补齐。
import {
  collectBareModuleSpecifiers,
  findDependencyDir,
  isTargetSpecificPackage,
  resolveProductionPackageClosure,
} from "./stageDependencyClosure.js";
import {
  copyDirectoryIfPresent,
  copyNativeTools,
  copyPackageDir,
  isNodePtyRuntimePath,
  pruneKoffiRuntime,
} from "./stageRuntimeAssets.js";
import { createComponentArchive, hashPaths, runCommand } from "./stageArchive.js";

interface StageOptions {
  target: ServerTarget;
  appVersion: string;
  /** tsup 产物目录（server-cli.js / server-core.js） */
  distDir: string;
  /** 既有 CLI/Agent bundle（acode.cjs，自包含 CJS） */
  agentBundlePath: string;
  /** 已准备好的目标平台 Node 二进制 */
  nodeBinaryPath: string;
  /** 构建入口从统一合规 owner 核验后传入；组件组装不能自行拼凑许可。 */
  notices: { thirdParty: string; node: string; nodeSource: string };
  /** 依赖闭包解析与复制的来源 node_modules */
  workspaceNodeModulesDir: string;
  /** 未被 pnpm 链接到 node_modules 的 workspace 包（例如 @acode/tui）。 */
  workspacePackageDirs?: ReadonlyMap<string, string>;
  /** 发行目录的输出父目录 */
  outputDir: string;
  /** 已准备好的 native search tools 根目录（tools/<id>/<binary>）。 */
  nativeToolsDir?: string;
  /** 官方插件源码或已 seed 的 packages 目录。 */
  officialPluginsDir?: string;
  /** 是否同时产出 tar.gz（默认 true） */
  archive?: boolean;
}

interface StagedRelease {
  releaseDir: string;
  archivePath: string | null;
  componentArchivePaths: string[];
  packagedDependencies: string[];
}

const POSIX_LAUNCHER = `#!/bin/sh
# 由 acode-server staging 生成：定位发行根后用随包 Node 启动 Server CLI。
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$DIR/runtime/node" "$DIR/runtime/server-cli.js" "$@"
`;

const WINDOWS_LAUNCHER = [
  "@echo off",
  'set "DIR=%~dp0.."',
  '"%DIR%\\runtime\\node.exe" "%DIR%\\runtime\\server-cli.js" %*',
  "",
].join("\r\n");

/** 组装 `acode-server-<os>-<arch>/` 发行目录；只做本地组装，不上传、不发布。 */
export async function stageRelease(options: StageOptions): Promise<StagedRelease> {
  for (const [name, value] of Object.entries(options.notices)) {
    if (!value.trim()) throw new Error(`Missing distribution notice: ${name}`);
  }
  const releaseName = `acode-server-${options.target}`;
  const outputRoot = resolve(options.outputDir);
  const releaseDir = join(outputRoot, releaseName);
  const runtimeDir = join(releaseDir, "runtime");
  await rm(releaseDir, { force: true, recursive: true });
  // staging 是发布目录的重建操作：删除同 target 的旧组件归档，避免上一次构建的
  // hash 仍被误上传到 CDN，导致 catalog 暴露无法与本次 manifest 对齐的组件。
  await rm(join(outputRoot, "components", options.target), { force: true, recursive: true });
  await rm(join(outputRoot, ".components"), { force: true, recursive: true });
  await mkdir(join(releaseDir, "bin"), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "THIRD-PARTY-NOTICES.md"), options.notices.thirdParty);
  await writeFile(join(runtimeDir, "LICENSE.node.txt"), options.notices.node);
  await writeFile(join(runtimeDir, "NODE-SOURCES.json"), options.notices.nodeSource);
  for (const component of ["agent", "official-plugins"]) {
    await mkdir(join(runtimeDir, "licenses", component), { recursive: true });
    await writeFile(
      join(runtimeDir, "licenses", component, "THIRD-PARTY-NOTICES.md"),
      options.notices.thirdParty,
    );
  }

  // 入口 bundle 与 sourcemap 同名复制，文件名必须与 cli.ts 的相对路径解析保持一致。
  const bundleSources: string[] = [];
  for (const entryName of ["server-cli.js", "server-core.js"]) {
    const sourcePath = join(options.distDir, entryName);
    const contents = await readFile(sourcePath, "utf8");
    bundleSources.push(contents);
    await writeFile(join(runtimeDir, entryName), contents, "utf8");
  }
  await writeFile(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: releaseName, private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  await cp(options.agentBundlePath, join(runtimeDir, "acode.cjs"), { dereference: true });
  // Agent bundle 是第三个实际运行入口；只扫描 Server bundle 会漏掉外置的 TUI/Playwright。
  bundleSources.push(await readFile(options.agentBundlePath, "utf8"));

  const nodeTargetPath = join(
    runtimeDir,
    options.target.startsWith("win32-") ? "node.exe" : "node",
  );
  await cp(options.nodeBinaryPath, nodeTargetPath, { dereference: true });
  if (!options.target.startsWith("win32-")) await chmod(nodeTargetPath, 0o755);

  // runtime/node_modules 以产物扫描为事实源：bundle 引用什么就装什么（含传递依赖），
  // 不使用 tsup external 声明列表，避免声明与实际引用漂移。
  const referencedPackages = new Set<string>();
  for (const source of bundleSources) {
    for (const name of collectBareModuleSpecifiers(source)) referencedPackages.add(name);
  }
  const rawClosure = await resolveProductionPackageClosure(
    [...referencedPackages],
    options.workspaceNodeModulesDir,
    options.workspacePackageDirs,
  );
  const closure = new Map(
    [...rawClosure].filter(([packageName]) => isTargetSpecificPackage(packageName, options.target)),
  );
  const nodeModulesTargetDir = join(runtimeDir, "node_modules");
  for (const [packageName, packageDir] of closure) {
    const targetDir = join(nodeModulesTargetDir, ...packageName.split("/"));
    await mkdir(dirname(targetDir), { recursive: true });
    if (packageName === "node-pty") {
      await copyPackageDir(packageDir, targetDir, (relativePath) =>
        isNodePtyRuntimePath(relativePath, options.target),
      );
    } else {
      // Agent 的外置依赖存在 peer 版本并存（例如 ajv6 + ajv8）。只为已知 peer
      // 冲突包保留 nested node_modules，避免把 pnpm 的整棵开发依赖树复制进发行包。
      await copyPackageDir(
        packageDir,
        targetDir,
        undefined,
        packageName === "ajv-formats" || packageName === "ajv-keywords",
      );
      if (packageName === "koffi") await pruneKoffiRuntime(packageDir, targetDir, options.target);
    }
  }

  if (closure.has("node-pty")) {
    await ensureNodePtyPrebuild(options, nodeModulesTargetDir);
  }

  const tools = await copyNativeTools(
    options.nativeToolsDir,
    join(runtimeDir, "tools"),
    options.target,
  );
  const plugins = await copyDirectoryIfPresent(
    options.officialPluginsDir,
    join(runtimeDir, "packages"),
  );

  const launcherPath = join(
    releaseDir,
    "bin",
    options.target.startsWith("win32-") ? "acode.cmd" : "acode",
  );
  await writeFile(launcherPath, POSIX_LAUNCHER, "utf8");
  if (options.target.startsWith("win32-")) {
    await writeFile(launcherPath, WINDOWS_LAUNCHER, "utf8");
  } else {
    await chmod(launcherPath, 0o755);
  }

  const componentSpecs = [
    {
      id: "node-runtime",
      paths: [
        options.target.startsWith("win32-") ? "runtime/node.exe" : "runtime/node",
        "runtime/LICENSE.node.txt",
        "runtime/NODE-SOURCES.json",
      ],
    },
    {
      id: "server-runtime",
      paths: [
        "runtime/server-cli.js",
        "runtime/server-core.js",
        "runtime/package.json",
        "runtime/node_modules",
        "runtime/THIRD-PARTY-NOTICES.md",
      ],
    },
    { id: "agent-runtime", paths: ["runtime/acode.cjs", "runtime/licenses/agent"] },
    ...(plugins.length > 0
      ? [
          {
            id: "official-plugins",
            paths: ["runtime/packages", "runtime/licenses/official-plugins"],
          },
        ]
      : []),
    ...(tools.length > 0 ? [{ id: "native-search-tools", paths: ["runtime/tools"] }] : []),
  ];
  const componentMeta: Array<{
    id: string;
    sha256: string;
    paths: string[];
    sizeBytes: number;
    archivePath?: string;
  }> = [];
  const componentArchivePaths: string[] = [];
  for (const component of componentSpecs) {
    const info = await hashPaths(releaseDir, component.paths);
    componentMeta.push({ ...component, ...info });
  }
  const manifest = createRuntimeManifest(options.target, options.appVersion, {
    tools,
    plugins,
    components: componentMeta,
  });
  await writeFile(
    join(releaseDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  for (const component of componentMeta) {
    const archive = await createComponentArchive(
      releaseDir,
      outputRoot,
      options.target,
      component.id,
      component.paths,
    );
    component.archivePath = relative(outputRoot, archive.archivePath).split(sep).join("/");
    componentArchivePaths.push(archive.archivePath);
  }
  await writeFile(
    join(releaseDir, "manifest.json"),
    `${JSON.stringify({ ...manifest, components: componentMeta }, null, 2)}\n`,
    "utf8",
  );

  let archivePath: string | null = null;
  if (options.archive !== false) {
    const extension = options.target.startsWith("win32-") ? "zip" : "tar.gz";
    archivePath = join(outputRoot, `${releaseName}.${extension}`);
    await rm(archivePath, { force: true });
    // Windows 宿主显式 System32 bsdtar，不依赖调用方 PATH（原因同 tarCommand.ts）。
    const tarCommand = resolveHostTarCommand();
    if (extension === "zip") {
      if (process.platform === "win32")
        await runCommand(tarCommand, ["-acf", archivePath, releaseName], outputRoot);
      else await runCommand("zip", ["-qr", archivePath, releaseName], outputRoot);
    } else if (process.platform === "win32") {
      await runCommand(tarCommand, ["-czf", archivePath, releaseName], outputRoot);
    } else await runCommand("tar", ["-czf", archivePath, releaseName], outputRoot);
  }

  return {
    releaseDir,
    archivePath,
    componentArchivePaths,
    packagedDependencies: [...closure.keys()].sort(),
  };
}

/**
 * 确保发行包内 node-pty 有目标平台的 pty.node。官方 node-pty npm 包只带
 * darwin/win32 prebuilds，linux 平台从 workspace 的 `@lydell/node-pty-<target>`
 * 补齐（与老远端资产链同一来源）；缺失时直接报错，避免发行包的终端能力必然损坏。
 */
async function ensureNodePtyPrebuild(
  options: StageOptions,
  nodeModulesTargetDir: string,
): Promise<void> {
  const prebuildDir = join(nodeModulesTargetDir, "node-pty", "prebuilds", options.target);
  const ptyNodePath = join(prebuildDir, "pty.node");
  let hasPtyNode = true;
  try {
    await access(ptyNodePath);
  } catch {
    hasPtyNode = false;
  }
  if (!hasPtyNode) {
    // 官方包无该平台 prebuild（linux），从 @lydell 平台包补齐。
    const lydellDir = await findDependencyDir(
      dirname(resolve(options.workspaceNodeModulesDir)),
      `@lydell/node-pty-${options.target}`,
    );
    const lydellPtyNode = lydellDir
      ? join(lydellDir, "prebuilds", options.target, "pty.node")
      : null;
    if (!lydellPtyNode) {
      throw new Error(
        `Missing node-pty prebuild for ${options.target}: install @lydell/node-pty-${options.target}`,
      );
    }
    await mkdir(prebuildDir, { recursive: true });
    await cp(lydellPtyNode, ptyNodePath, { dereference: true });
  }
  // darwin 的 spawn-helper 必须可执行；npm 发布/解压不保证权限位，丢失时 node-pty
  // 会在 posix_spawn 阶段报错（老远端资产链踩过同一坑，见 prepare-prebuilds.mjs）。
  const spawnHelperPath = join(prebuildDir, "spawn-helper");
  try {
    await access(spawnHelperPath);
    await chmod(spawnHelperPath, 0o755);
  } catch {
    // 非 darwin 平台没有 spawn-helper，忽略。
  }
}
