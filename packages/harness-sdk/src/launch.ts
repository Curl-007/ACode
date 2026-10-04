// launch 模式的 runtime 目录治理与凭据继承（ACode 自有库，红线：不做第三方 IDE 凭据拷贝）。
//
// 凭据存储形态（实施首日核实，packages/shared/src/node/credentialMasterKey.ts）：
// - 密文：{dataBaseDir}/.acode/v2/credentials.json（值始终 enc:v2 加密，磁盘无明文）；
// - 主密钥解析优先级：OS 钥匙串（macOS Keychain / Windows DPAPI blob 文件 /
//   Linux libsecret）→ credential-key.json 密钥文件 → env。
//
// 继承结论（spec 附录同步登记）：
// - 隔离机制是 ACODE_DATA_BASE_DIR 指向 runtime 目录（.acode 全目录随之隔离，
//   会话库不与 Desktop 混）；凭据没有独立目录 env，「引用式继承」在当前形态下不可实现。
// - 可行且不绕过主密钥的继承 = **加密文件整体拷贝**：credentials.json 与其随行密钥
//   材料（credential-key.json 或 Windows DPAPI blob credential-key.dpapi.json）成对
//   字节拷贝（0600），全程零解密零明文——与既有 copyDataDirectory 迁移同语义。
// - 主密钥在 OS 钥匙串且无随行密钥文件（macOS Keychain / Linux libsecret 模式）时
//   无法在隔离目录复现材料：**fail 并报告**（不绕过钥匙串、不降级明文）。
// - 例外（M7 修正）：`ACODE_CREDENTIAL_SECRET` env 模式不是「钥匙串持有」——
//   env 随 launch 传子进程，凭据可继承（只拷密文文件，无需随行密钥材料）。

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** ACode 自有凭据库的文件清单（密文 + 随行密钥材料；绝不包含第三方 IDE 凭据）。 */
const CREDENTIAL_FILES = ["credentials.json"] as const;
const KEY_MATERIAL_FILES = ["credential-key.json", "credential-key.dpapi.json"] as const;

export interface LaunchRuntimePaths {
  /** runtime 根目录（隔离 state home 的 dataBaseDir）。 */
  runtimeDir: string;
  /** runtime 内 .acode/v2 配置目录。 */
  configDir: string;
  /** 用户默认配置目录（凭据继承来源）。 */
  userConfigDir: string;
}

export interface PrepareRuntimeOptions {
  /** 缺省 ~/.acode/sdk/<uuid>/。 */
  runtimeDir?: string;
  /** 缺省 true：只继承 ACode 自有凭据库（见文件头继承结论）。 */
  inheritCredentials?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface PreparedRuntime {
  paths: LaunchRuntimePaths;
  /** launch 子进程需要的 env 增量（调用方合并进 spawn env）。 */
  envPatch: Record<string, string>;
  credentialInheritance:
    | { status: "none"; reason: string }
    | { status: "inherited"; copiedFiles: string[]; zeroPlaintext: true }
    | { status: "failed"; reason: string };
}

export async function prepareLaunchRuntime(
  options: PrepareRuntimeOptions = {},
): Promise<PreparedRuntime> {
  const env = options.env ?? process.env;
  const inheritCredentials = options.inheritCredentials ?? true;
  const runtimeDir = options.runtimeDir ?? join(homedir(), ".acode", "sdk", randomUUID());
  const configDir = join(runtimeDir, ".acode", "v2");
  await mkdir(configDir, { recursive: true, mode: 0o700 });

  // 修复（K7 测试发现的真实缺陷）：凭据源目录必须镜像 ACode services 层 paths.ts 的
  // 解析链 `ACODE_DATA_BASE_DIR → HOME → homedir()`。此前用 node:os homedir()，
  // Windows 上它只认 USERPROFILE、忽略 HOME 覆盖——launch 隔离测试（及任何设置了
  // HOME 的宿主）会静默读到真实用户凭据库并把它拷进 runtime 目录。镜像同链后，
  // HOME 覆盖与 services 层 getDataBaseDir() 语义一致。
  const sourceDataBaseDir = env.ACODE_DATA_BASE_DIR?.trim() || env.HOME?.trim() || homedir();
  const userConfigDir = join(sourceDataBaseDir, ".acode", "v2");
  const paths: LaunchRuntimePaths = { runtimeDir, configDir, userConfigDir };

  if (!inheritCredentials) {
    return {
      paths,
      envPatch: { ACODE_DATA_BASE_DIR: runtimeDir },
      credentialInheritance: { status: "none", reason: "inheritCredentials=false" },
    };
  }

  const exists = async (path: string): Promise<boolean> => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  };

  const credentialsExist = await exists(join(userConfigDir, "credentials.json"));
  if (!credentialsExist) {
    // 无凭据可继承（未登录的干净环境）——空继承不是失败。
    return {
      paths,
      envPatch: { ACODE_DATA_BASE_DIR: runtimeDir },
      credentialInheritance: { status: "none", reason: "no credentials.json in user config dir" },
    };
  }

  // 找随行密钥材料：文件模式 / Windows DPAPI blob 可成对拷贝；
  // 都不在场时区分两种归因（M7(2)）：
  // - `ACODE_CREDENTIAL_SECRET` env 模式（主密钥解析第 4 级来源）：不是「钥匙串持有」——
  //   env 会随 launch 传给子进程，凭据可继承，只拷密文 credentials.json 即可；
  // - 无 env 密钥 → 主密钥在 OS 钥匙串（macOS Keychain / Linux libsecret），fail 不绕过。
  const keyMaterials: string[] = [];
  for (const name of KEY_MATERIAL_FILES) {
    if (await exists(join(userConfigDir, name))) keyMaterials.push(name);
  }
  const envMasterKey = env.ACODE_CREDENTIAL_SECRET?.trim();
  if (keyMaterials.length === 0 && envMasterKey) {
    // env 密钥模式：子进程走同一解析链（ACODE_CREDENTIAL_SECRET 随 spawn env 传递），
    // 密文不需要随行密钥文件也能在 runtime 内解密；仍然零解密零明文拷贝。
    await copyFile(join(userConfigDir, "credentials.json"), join(configDir, "credentials.json"));
    await writeFile(
      join(configDir, "sdk-credential-inheritance.json"),
      `${JSON.stringify(
        {
          inheritedAt: new Date().toISOString(),
          files: ["credentials.json"],
          keySource: "env:ACODE_CREDENTIAL_SECRET",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return {
      paths,
      envPatch: { ACODE_DATA_BASE_DIR: runtimeDir },
      credentialInheritance: {
        status: "inherited",
        copiedFiles: ["credentials.json"],
        zeroPlaintext: true,
      },
    };
  }
  if (keyMaterials.length === 0) {
    return {
      paths,
      envPatch: { ACODE_DATA_BASE_DIR: runtimeDir },
      credentialInheritance: {
        status: "failed",
        reason:
          "credential master key lives in the OS keychain (macOS Keychain / Linux libsecret) without a traveling key file; reference-style inheritance is unavailable and copying would bypass the keychain (red line). Launch with inheritCredentials:false or log in inside the isolated runtime.",
      },
    };
  }

  const copiedFiles: string[] = [];
  for (const name of [...CREDENTIAL_FILES, ...keyMaterials]) {
    const source = join(userConfigDir, name);
    const target = join(configDir, name);
    // 字节整体拷贝（enc:v2 密文 + 密钥材料），不解密、不改写、不加明文副本。
    await copyFile(source, target);
    copiedFiles.push(name);
  }
  // 标记继承来源，便于诊断「runtime 凭据与主库漂移」；不含任何凭据内容。
  await writeFile(
    join(configDir, "sdk-credential-inheritance.json"),
    `${JSON.stringify({ inheritedAt: new Date().toISOString(), files: copiedFiles }, null, 2)}\n`,
    "utf8",
  );

  return {
    paths,
    envPatch: { ACODE_DATA_BASE_DIR: runtimeDir },
    credentialInheritance: { status: "inherited", copiedFiles, zeroPlaintext: true },
  };
}
