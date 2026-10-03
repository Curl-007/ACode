import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { createHash } from "node:crypto";

/**
 * 凭据主密钥的 OS 钥匙串访问（R1-a，设计文档 docs/credential-os-keychain-design.md）。
 *
 * 机制（D1 裁决：平台原生工具统一路径，desktop 与 CLI 共用本单一实现）：
 * - macOS：Keychain generic-password（`security` 二进制）。经 `security` 创建的条目
 *   ACL 归属 `security` 自身，两进程读取不触发钥匙串弹窗。
 * - Windows：DPAPI(CurrentUser) 保护的 blob 文件（`<凭据目录>/credential-key.dpapi.json`）。
 *   Windows 无中央钥匙串原语存裸密钥，DPAPI blob 是标准做法：物理上同目录，但只有
 *   同机同 Windows 用户能解——目录外带到异机/异用户即不可解密，达成逻辑分离。
 * - Linux：libsecret（`secret-tool`，GNOME Keyring / KDE Wallet）。需要 D-Bus 会话与
 *   运行中的 secret service，headless/容器普遍不可用 → 调用方降级文件模式。
 *
 * 否决项（设计文档 D1）：Electron safeStorage（自有信封格式跨进程不通，桌面与 CLI
 * 共用 credentials.json 会破裂）；keytar（原生 node-gyp 依赖）。
 *
 * **同步**（D2 裁决）：平台工具经 `spawnSync` 一次性调用；调用方（credentialMasterKey）
 * 对 found/unavailable 结果做进程级缓存，cipher 同步接口与文件锁调用点零改动。
 *
 * **语义纪律**：本模块是 dumb secret store——不理解密钥长度/格式（校验归调用方），
 * 结果四态显式（found/absent/unavailable/error），从不抛错。「材料可见但读不出」
 * （blob 存在而 PowerShell 不可用、条目损坏）必须报 error 而非 unavailable——
 * 调用方对 error 必须 fail-loud，静默降级会生成新密钥、把既有 enc:v2 凭据变成永久垃圾
 * （与密钥文件路径「保留现场报错，绝不回退生成」同一哲学）。
 */

/** 钥匙串服务名（macOS Keychain service / Linux label 前缀）。 */
export const CREDENTIAL_KEYCHAIN_SERVICE = "acode";

/** Linux libsecret 条目属性名（secret-tool 的 attribute=value 检索键）。 */
const SECRET_TOOL_ATTRIBUTE = "acode-credential-key";

/** Windows DPAPI blob 文件名（与 credential-key.json 同目录，天然按数据目录隔离）。 */
export const WINDOWS_DPAPI_BLOB_FILE_NAME = "credential-key.dpapi.json";

export type CredentialKeychainReadResult =
  | { status: "found"; secret: string }
  | { status: "absent" }
  | { status: "unavailable"; reason: string }
  | { status: "error"; reason: string };

export type CredentialKeychainWriteResult =
  /** 写入成功，或竞争落败后回读到赢家的材料（两种情况 secret 都是最终生效值）。 */
  | { status: "written"; secret: string }
  | { status: "unavailable"; reason: string }
  | { status: "error"; reason: string };

export interface CredentialKeychainAccess {
  /** 读取条目；四态显式，从不抛错。 */
  read(keyFilePath: string): CredentialKeychainReadResult;
  /** 竞争安全写入；返回最终生效的材料（重复条目时回读赢家）。 */
  write(keyFilePath: string, secret: string): CredentialKeychainWriteResult;
  /**
   * 尽力删除条目，从不抛错（R1-b 迁移的回滚原语：验证失败时必须清掉刚写入的条目，
   * 否则「钥匙串优先于密钥文件」的解析链会让坏材料压过权威文件）。删除失败无返回值
   * 语义——调用方随后仍保持文件模式，坏条目会在下次迁移尝试时被重复写入-验证流程
   * 覆盖或再次清理。
   */
  delete(keyFilePath: string): void;
}

export interface CredentialKeychainDeps {
  /** 缺省 process.platform。 */
  platform?: NodeJS.Platform;
  /** 测试注入点；缺省 node:child_process spawnSync。 */
  spawn?: typeof spawnSync;
}

/**
 * 条目账户名（D3 裁决）：含 keyFilePath 指纹——多数据目录/测试临时目录互不覆盖；
 * 桌面与 CLI 按 credential-storage.md「同一 keyFilePath 钉给 cipher」规则收敛到同一条目。
 * Windows 不用账户名（blob 文件路径天然按目录隔离），但保留同一指纹函数作单一事实源。
 */
export function credentialKeychainAccount(keyFilePath: string): string {
  const fingerprint = createHash("sha256")
    .update(normalize(keyFilePath), "utf-8")
    .digest("hex")
    .slice(0, 16);
  return `credential-master-key@${fingerprint}`;
}

/** Windows DPAPI blob 的完整路径（凭据密钥文件同目录）。 */
export function windowsDpapiBlobPath(keyFilePath: string): string {
  return join(dirname(keyFilePath), WINDOWS_DPAPI_BLOB_FILE_NAME);
}

interface SpawnLike {
  (command: string, args: readonly string[], options?: Record<string, unknown>): {
    status: number | null;
    stdout?: Buffer | string;
    stderr?: Buffer | string;
    error?: Error & { code?: string };
  };
}

function toText(value: Buffer | string | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.toString("utf-8");
}

function isSpawnENOENT(result: { error?: Error & { code?: string } }): boolean {
  return result.error?.code === "ENOENT";
}

// ── macOS：Keychain generic-password ──────────────────────────────────

function createDarwinKeychain(spawn: SpawnLike): CredentialKeychainAccess {
  return {
    read(keyFilePath) {
      // -w 输出密码本体；条目不存在时 security 以退出码 44 + "could not be found" 返回。
      const result = spawn("security", [
        "find-generic-password",
        "-s",
        CREDENTIAL_KEYCHAIN_SERVICE,
        "-a",
        credentialKeychainAccount(keyFilePath),
        "-w",
      ]);
      if (isSpawnENOENT(result)) {
        return { status: "unavailable", reason: "security binary not found" };
      }
      if (result.status === 0) {
        const secret = toText(result.stdout).trim();
        if (secret === "") {
          return { status: "error", reason: "keychain entry is empty" };
        }
        return { status: "found", secret };
      }
      const stderr = toText(result.stderr);
      if (/could not be found/i.test(stderr)) {
        return { status: "absent" };
      }
      return { status: "error", reason: `security find-generic-password failed: ${stderr.trim() || `exit ${result.status}`}` };
    },
    write(keyFilePath, secret) {
      // 不带 -U：条目已存在时失败（errSecDuplicateItem），走竞争回读——两个进程并发
      // 首次生成时收敛到赢家的材料，与密钥文件 `wx` 排他创建同一纪律。
      // 注意：secret 经命令行参数传递，同用户进程在 spawn 瞬间可经 ps 看到——在威胁
      // 模型内（同用户攻击者本就可读密钥文件/进程内存），文件模式现状严格更弱。
      const result = spawn("security", [
        "add-generic-password",
        "-s",
        CREDENTIAL_KEYCHAIN_SERVICE,
        "-a",
        credentialKeychainAccount(keyFilePath),
        "-w",
        secret,
      ]);
      if (isSpawnENOENT(result)) {
        return { status: "unavailable", reason: "security binary not found" };
      }
      if (result.status === 0) {
        return { status: "written", secret };
      }
      const stderr = toText(result.stderr);
      if (/already exists/i.test(stderr)) {
        const winner = this.read(keyFilePath);
        if (winner.status === "found") {
          return { status: "written", secret: winner.secret };
        }
        return { status: "error", reason: `duplicate keychain entry could not be read back: ${winner.status}` };
      }
      // 钥匙串锁定等环境性失败 → error（调用方降级文件模式并告警）。
      return { status: "error", reason: `security add-generic-password failed: ${stderr.trim() || `exit ${result.status}`}` };
    },
    delete(keyFilePath) {
      try {
        spawn("security", [
          "delete-generic-password",
          "-s",
          CREDENTIAL_KEYCHAIN_SERVICE,
          "-a",
          credentialKeychainAccount(keyFilePath),
        ]);
      } catch {
        // 尽力而为（见接口注释）：删除失败由下次迁移尝试兜底。
      }
    },
  };
}

// ── Windows：DPAPI(CurrentUser) blob 文件 ───────────────────────────────

const POWERSHELL_UNPROTECT = (b64: string): string =>
  `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${b64}'), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;

const POWERSHELL_PROTECT = (b64: string): string =>
  `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('${b64}'), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;

function spawnPowershell(spawn: SpawnLike, command: string) {
  // Windows PowerShell 5.1（powershell.exe）在 Win10+ 恒在位；.NET Framework 的
  // System.Security 程序集提供 ProtectedData（pwsh 7 的可用性不稳，不作为目标）。
  return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
}

function createWin32Keychain(spawn: SpawnLike): CredentialKeychainAccess {
  return {
    read(keyFilePath) {
      const blobPath = windowsDpapiBlobPath(keyFilePath);
      let blobRaw: string;
      try {
        blobRaw = readFileSync(blobPath, "utf-8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return { status: "absent" };
        return { status: "error", reason: `DPAPI blob unreadable (${code})` };
      }
      let protectedB64: string;
      try {
        const parsed = JSON.parse(blobRaw) as { version?: number; blob?: string };
        if (parsed.version !== 1 || typeof parsed.blob !== "string") {
          throw new Error("unsupported blob shape");
        }
        protectedB64 = parsed.blob;
      } catch {
        // blob 存在但损坏：error 而非 absent——静默降级会生成新密钥孤立既有凭据。
        return { status: "error", reason: `DPAPI blob malformed: ${blobPath}` };
      }
      const result = spawnPowershell(spawn, POWERSHELL_UNPROTECT(protectedB64));
      if (isSpawnENOENT(result)) {
        // 材料可见但工具缺席 = error（同上纪律：绝不让调用方误判为「无材料」）。
        return { status: "error", reason: "DPAPI blob exists but powershell.exe is unavailable" };
      }
      if (result.status !== 0) {
        // 异用户/异机（DPAPI 解不开）或受限语言模式：blob 是本机本用户的既有材料，
        // 解不开属现场损坏，fail-loud。
        return {
          status: "error",
          reason: `DPAPI unprotect failed: ${toText(result.stderr).trim() || `exit ${result.status}`}`,
        };
      }
      const secret = toText(result.stdout).trim();
      if (secret === "") {
        return { status: "error", reason: "DPAPI unprotect returned empty secret" };
      }
      return { status: "found", secret };
    },
    write(keyFilePath, secret) {
      const blobPath = windowsDpapiBlobPath(keyFilePath);
      const result = spawnPowershell(spawn, POWERSHELL_PROTECT(secret));
      if (isSpawnENOENT(result)) {
        return { status: "unavailable", reason: "powershell.exe not found" };
      }
      if (result.status !== 0) {
        const stderr = toText(result.stderr).trim();
        // 受限语言模式/策略拦截 → unavailable（新装场景无任何既有材料，降级文件模式安全）。
        return { status: "unavailable", reason: `DPAPI protect failed: ${stderr || `exit ${result.status}`}` };
      }
      const protectedB64 = toText(result.stdout).trim();
      if (protectedB64 === "") {
        return { status: "error", reason: "DPAPI protect returned empty blob" };
      }
      mkdirSync(dirname(blobPath), { recursive: true });
      try {
        // `wx` 排他创建：并发首次生成时只有一个进程写入成功，落败方回读赢家——
        // 与密钥文件同一竞争纪律。
        writeFileSync(blobPath, `${JSON.stringify({ version: 1, blob: protectedB64 }, null, 2)}\n`, {
          encoding: "utf-8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          return { status: "error", reason: `DPAPI blob write failed (${code})` };
        }
        const winner = this.read(keyFilePath);
        if (winner.status === "found") {
          return { status: "written", secret: winner.secret };
        }
        return { status: "error", reason: `duplicate DPAPI blob could not be read back: ${winner.status}` };
      }
      try {
        chmodSync(blobPath, 0o600);
      } catch {
        // Windows 上 mode 不一定生效，收紧失败不阻断（NTFS ACL 是真实边界）。
      }
      return { status: "written", secret };
    },
    delete(keyFilePath) {
      try {
        unlinkSync(windowsDpapiBlobPath(keyFilePath));
      } catch {
        // 尽力而为：ENOENT 即已删；其余失败由下次迁移尝试兜底。
      }
    },
  };
}

// ── Linux：libsecret（secret-tool）────────────────────────────────────

function createLinuxKeychain(spawn: SpawnLike): CredentialKeychainAccess {
  return {
    read(keyFilePath) {
      // secret-tool 从属性检索条目，密码走 stdout；无条目时退出 0 且 stdout 为空。
      const result = spawn("secret-tool", [
        "lookup",
        SECRET_TOOL_ATTRIBUTE,
        credentialKeychainAccount(keyFilePath),
      ]);
      if (isSpawnENOENT(result)) {
        return { status: "unavailable", reason: "secret-tool not found (libsecret)" };
      }
      if (result.status !== 0) {
        const stderr = toText(result.stderr);
        // headless：无 D-Bus 会话/无 secret service（"Cannot autolaunch D-Bus"、
        // "The name org.freedesktop.secrets was not provided" 等）→ 环境性不可用。
        if (/dbus|secret service|freedesktop\.secrets|autolaunch/i.test(stderr)) {
          return { status: "unavailable", reason: `no secret service (${stderr.trim().slice(0, 120)})` };
        }
        return { status: "error", reason: `secret-tool lookup failed: ${stderr.trim() || `exit ${result.status}`}` };
      }
      const secret = toText(result.stdout).trim();
      if (secret === "") {
        return { status: "absent" };
      }
      return { status: "found", secret };
    },
    write(keyFilePath, secret) {
      // secret-tool store 是 last-writer-wins（无排他语义）。竞争收敛策略：写前读
      // （已有条目直接采用赢家）→ 写（密码走 stdin，无 ps 暴露）→ 写后回读采用最终值。
      // 残余竞争窗为毫秒级读-写间隙，设计文档 D1 已登记（桌面平台 macOS/Windows
      // 各有排他语义，Linux 并发首装是罕见路径）。
      const existing = this.read(keyFilePath);
      if (existing.status === "found") {
        return { status: "written", secret: existing.secret };
      }
      if (existing.status === "error") {
        return { status: "error", reason: existing.reason };
      }
      if (existing.status === "unavailable") {
        return { status: "unavailable", reason: existing.reason };
      }
      const result = spawn(
        "secret-tool",
        [
          "store",
          "--label=ACode credential master key",
          SECRET_TOOL_ATTRIBUTE,
          credentialKeychainAccount(keyFilePath),
        ],
        { input: secret },
      );
      if (isSpawnENOENT(result)) {
        return { status: "unavailable", reason: "secret-tool not found (libsecret)" };
      }
      if (result.status !== 0) {
        const stderr = toText(result.stderr);
        if (/dbus|secret service|freedesktop\.secrets|autolaunch/i.test(stderr)) {
          return { status: "unavailable", reason: `no secret service (${stderr.trim().slice(0, 120)})` };
        }
        return { status: "error", reason: `secret-tool store failed: ${stderr.trim() || `exit ${result.status}`}` };
      }
      // 写后回读：并发场景下采用最终生效值（可能已被另一进程覆盖）。
      const verify = this.read(keyFilePath);
      if (verify.status === "found") {
        return { status: "written", secret: verify.secret };
      }
      return { status: "error", reason: `secret-tool store succeeded but read-back returned ${verify.status}` };
    },
    delete(keyFilePath) {
      try {
        spawn("secret-tool", [
          "clear",
          SECRET_TOOL_ATTRIBUTE,
          credentialKeychainAccount(keyFilePath),
        ]);
      } catch {
        // 尽力而为（见接口注释）。
      }
    },
  };
}

// ── 工厂 ──────────────────────────────────────────────────────────────

function createUnavailableKeychain(reason: string): CredentialKeychainAccess {
  return {
    read: () => ({ status: "unavailable", reason }),
    write: () => ({ status: "unavailable", reason }),
    delete: () => {},
  };
}

export function createCredentialKeychain(
  deps: CredentialKeychainDeps = {},
): CredentialKeychainAccess {
  const platform = deps.platform ?? process.platform;
  const spawn = (deps.spawn ?? spawnSync) as unknown as SpawnLike;
  switch (platform) {
    case "darwin":
      return createDarwinKeychain(spawn);
    case "win32":
      return createWin32Keychain(spawn);
    case "linux":
      return createLinuxKeychain(spawn);
    default:
      return createUnavailableKeychain(`OS keychain not supported on platform ${platform}`);
  }
}
