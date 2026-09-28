/**
 * asar 完整性刷新（安全加固 P2 #3，specs/electron-hardening.md §5「完整性刷新」）。
 *
 * 背景：electron-builder 在 beforeCopyExtraFiles 阶段（afterPack 之前）对当时的 app.asar
 * header 计算 SHA256 并写入产物——Windows 写进 exe 的 INTEGRITY/ELECTRONASAR 资源，
 * macOS 写进 Info.plist 的 ElectronAsarIntegrity。本包 afterPack 既有链路会重写 app.asar
 * （注入运行时依赖 + 清理 sourcemap），导致内嵌哈希过期；开启
 * enableEmbeddedAsarIntegrityValidation 后过期哈希会让安装包启动即校验失败（变砖）。
 *
 * 对策：afterPack 所有 asar 重写完成之后，用与 electron-builder 相同的 computeData 重算
 * header 哈希并回写产物；任一步失败直接抛错让打包失败（fail-closed），
 * 不允许带着过期完整性哈希出包。
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const desktopPackageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
// 深解析 app-builder-lib 内部实现，与其自身共用同一份 resedit/plist 依赖与哈希语义。
// electron-builder 26.8.1 已锁定（packages/desktop/package.json），升级时须同步核对本文件。
const appBuilderLibPackageJsonPath = resolve(
  desktopPackageRoot,
  "node_modules/app-builder-lib/package.json",
);
const appBuilderLibRequire = createRequire(appBuilderLibPackageJsonPath);

function loadAppBuilderLibModule(relativePath) {
  return appBuilderLibRequire(resolve(dirname(appBuilderLibPackageJsonPath), relativePath));
}

/**
 * 复用 electron-builder 的 computeData 对**最终**产物计算 asar 完整性。
 * 与 platformPackager.doPack 的原始调用同参（extraResourceMatchers 为空——本包
 * extraResources 不含 .asar，与原调用过滤后的结果一致）。
 */
export async function computeFinalAsarIntegrity(resourcesDir, resourcesRelativePath) {
  const { computeData } = loadAppBuilderLibModule("out/asar/integrity.js");
  return computeData({
    resourcesPath: resourcesDir,
    resourcesRelativePath,
    resourcesDestinationPath: resourcesDir,
    extraResourceMatchers: [],
  });
}

/** Windows exe 内 INTEGRITY 资源的条目 JSON 形态（与 electron-builder addWinAsarIntegrity 一致）。 */
export function buildWindowsIntegrityResourceList(asarIntegrity) {
  return Object.entries(asarIntegrity).map(([file, { algorithm, hash }]) => ({
    file: file.replaceAll("/", "\\"),
    alg: algorithm,
    value: hash,
  }));
}

/** macOS Info.plist 的 ElectronAsarIntegrity 字典形态（与 electron-builder toPlistObject 一致）。 */
export function buildMacIntegrityPlistObject(asarIntegrity) {
  const result = {};
  for (const [filePath, headerHash] of Object.entries(asarIntegrity)) {
    result[filePath] = { algorithm: headerHash.algorithm, hash: headerHash.hash };
  }
  return result;
}

/**
 * 替换 exe 资源里的 ELECTRONASAR 完整性条目。
 * 必须替换而非追加：electron-builder 已在 beforeCopyExtraFiles 写入一条，
 * 追加会产生两条同名资源，Electron 读取行为未定义。
 */
async function replaceWindowsAsarIntegrityResource(executablePath, asarIntegrity) {
  const { NtExecutable, NtExecutableResource } = appBuilderLibRequire("resedit");
  const integrityList = buildWindowsIntegrityResourceList(asarIntegrity);
  const buffer = await readFile(executablePath);
  const executable = NtExecutable.from(buffer);
  const resource = NtExecutableResource.from(executable);
  const existing = resource.entries.filter(
    (entry) => entry.type === "INTEGRITY" && entry.id === "ELECTRONASAR",
  );
  if (existing.length !== 1) {
    throw new Error(
      `asar 完整性刷新要求 exe 恰好有一条 ELECTRONASAR 资源，实际 ${existing.length} 条: ${executablePath}`,
    );
  }
  existing[0].bin = Buffer.from(JSON.stringify(integrityList));
  resource.outputResource(executable);
  await writeFile(executablePath, Buffer.from(executable.generate()));
}

/** 重写 macOS Info.plist 的 ElectronAsarIntegrity 字典。 */
async function replaceMacAsarIntegrityPlist(infoPlistPath, asarIntegrity) {
  const { parsePlistFile, savePlistFile } = loadAppBuilderLibModule("out/util/plist.js");
  const appPlist = await parsePlistFile(infoPlistPath);
  if (!appPlist || typeof appPlist !== "object") {
    throw new Error(`asar 完整性刷新无法解析 Info.plist: ${infoPlistPath}`);
  }
  appPlist.ElectronAsarIntegrity = buildMacIntegrityPlistObject(asarIntegrity);
  await savePlistFile(infoPlistPath, appPlist);
}

/**
 * afterPack 末尾调用：对最终产物重算并回写 asar 完整性。
 *
 * @param {{
 *   electronPlatformName: "win32" | "darwin" | "linux" | string,
 *   resourcesDir: string,      // win/linux: <appOutDir>/resources；darwin: <.app>/Contents/Resources
 *   executablePath?: string,   // win32 必填（<appOutDir>/<productName>.exe）
 *   infoPlistPath?: string,    // darwin 必填（<.app>/Contents/Info.plist）
 * }} input
 */
export async function refreshPackagedAsarIntegrity(input) {
  const { electronPlatformName, resourcesDir } = input;
  // 键名与 electron-builder computeData 一致：resourcesRelativePath + 文件名。
  const resourcesRelativePath = electronPlatformName === "darwin" ? "Resources" : "resources";
  const asarIntegrity = await computeFinalAsarIntegrity(resourcesDir, resourcesRelativePath);
  if (Object.keys(asarIntegrity).length === 0) {
    throw new Error(`asar 完整性刷新未找到产物 asar: ${resourcesDir}`);
  }
  if (electronPlatformName === "win32") {
    if (!input.executablePath) {
      throw new Error("win32 asar 完整性刷新缺少 executablePath");
    }
    await replaceWindowsAsarIntegrityResource(input.executablePath, asarIntegrity);
    return;
  }
  if (electronPlatformName === "darwin") {
    if (!input.infoPlistPath) {
      throw new Error("darwin asar 完整性刷新缺少 infoPlistPath");
    }
    await replaceMacAsarIntegrityPlist(input.infoPlistPath, asarIntegrity);
    return;
  }
  throw new Error(`平台 ${electronPlatformName} 未开启 asar 完整性校验，不应调用刷新`);
}
