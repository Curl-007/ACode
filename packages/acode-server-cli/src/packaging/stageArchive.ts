// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自 ./stage.ts 拆出。
// 职责：staging 归档原语——外部命令执行（tar copyfile 元数据抑制）、递归文件清单、
// 组件路径 sha256/体积哈希、组件归档（zip/tar.gz）生成。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ServerTarget } from "../runtime/manifest.js";
import { isTarCommand, resolveHostTarCommand } from "./tarCommand.js";

export async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    // macOS 自带 tar 默认把 Finder extended attributes 写成 AppleDouble `._*` 条目。
    // 发行包会在 Linux/Windows 解压时把这些宿主元数据落成真实文件，既污染文件树，
    // 也会让组件 hash 在下载端与目标机不一致；关闭 copyfile 元数据后再生成归档。
    // Windows 侧传入的是 System32 tar.exe 绝对路径，同样命中该判断。
    const env = isTarCommand(command) ? { ...process.env, COPYFILE_DISABLE: "1" } : process.env;
    const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
    });
  });
}

export async function listFiles(root: string): Promise<string[]> {
  const entries = await (await import("node:fs/promises")).readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = entry.name;
    const absolutePath = join(root, relativePath);
    if (entry.isDirectory()) {
      for (const nested of await listFiles(absolutePath)) files.push(join(relativePath, nested));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

export async function hashPaths(
  root: string,
  paths: readonly string[],
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for (const relativePath of [...paths].sort()) {
    const absolutePath = join(root, relativePath);
    const stat = await (await import("node:fs/promises")).stat(absolutePath);
    const files = stat.isDirectory()
      ? (await listFiles(absolutePath)).map((file) => join(relativePath, file))
      : [relativePath];
    for (const file of files.sort()) {
      const contents = await readFile(join(root, file));
      hash.update(`${file}\0`);
      hash.update(contents);
      sizeBytes += contents.byteLength;
    }
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

export async function createComponentArchive(
  releaseDir: string,
  outputDir: string,
  target: ServerTarget,
  id: string,
  paths: readonly string[],
): Promise<{ archivePath: string; sha256: string; sizeBytes: number }> {
  const info = await hashPaths(releaseDir, paths);
  const componentRoot = join(outputDir, ".components", `${id}-${info.sha256.slice(0, 12)}`);
  await rm(componentRoot, { force: true, recursive: true });
  await mkdir(componentRoot, { recursive: true });
  for (const relativePath of paths) {
    const source = join(releaseDir, relativePath);
    try {
      await access(source);
    } catch {
      continue;
    }
    const targetPath = join(componentRoot, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(source, targetPath, { recursive: true, dereference: true });
  }
  const extension = target.startsWith("win32-") ? "zip" : "tar.gz";
  const archivePath = join(outputDir, "components", target, `${id}-${info.sha256}.${extension}`);
  await mkdir(dirname(archivePath), { recursive: true });
  await rm(archivePath, { force: true });
  // Windows 宿主无 zip 命令且 Git Bash 的 GNU tar 不可用（详见
  // tarCommand.ts）；所有 tar 调用显式 System32 bsdtar。POSIX 宿主打 zip 继续用 zip 命令。
  const tarCommand = resolveHostTarCommand();
  if (extension === "zip") {
    if (process.platform === "win32")
      await runCommand(tarCommand, ["-acf", archivePath, "."], componentRoot);
    else await runCommand("zip", ["-qr", archivePath, "."], componentRoot);
  } else if (process.platform === "win32") {
    await runCommand(tarCommand, ["-czf", archivePath, "."], componentRoot);
  } else await runCommand("tar", ["-czf", archivePath, "."], componentRoot);
  await rm(componentRoot, { force: true, recursive: true });
  return { archivePath, ...info };
}
