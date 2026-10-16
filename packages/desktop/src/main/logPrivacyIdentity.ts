/**
 * main 进程日志脱敏身份收集（specs/log-privacy-redaction.md desktop R4-R6）。
 *
 * Windows 用户名优先从注册表取真值：env（USERNAME/USERPROFILE）会撒谎或缺失
 * （服务账户、runas、便携启动），只信 env 会漏掉磁盘与注册表里的真实账户名，
 * 导致 `C:\Users\RealName\...` 原样落日志。注册表证据：
 * - HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList：
 *   ProfilesDirectory + 各 SID 子键 ProfileImagePath/CentralProfile；
 * - HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\LogonUI：
 *   LastLoggedOnDisplayName/LastLoggedOnSAMUser + SessionData 各会话 LoggedOn*。
 *
 * 注册表访问用系统自带 reg.exe（execFileSync，一次性、带超时、全量 try/catch），
 * 零新增依赖；任何失败静默退回 env 派生，绝不抛出、绝不阻塞日志写入。
 *
 * 本模块同时是 main 进程脱敏单例的所有者：logger.ts 的 write() 漏斗、
 * exportLogs 支持包都从这里拿 redactor；运行期远端主机名通过
 * registerLogHostName 收名（连接建立点接线，见报告接线需求）。
 */
import { execFileSync } from "node:child_process";
import { hostname, homedir, userInfo } from "node:os";
import {
  buildLogRedactionIdentity,
  createHostNameRegistry,
  createLogRedactor,
  type HostNameRegistry,
  type LogRedactionIdentity,
  type LogRedactor,
  type RedactionNameKind,
  type WindowsProfileNameEvidence,
} from "@acode/shared";

const PROFILE_LIST_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList";
const LOGON_UI_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI";
/** 单次 reg.exe 查询超时：注册表不可达时不能让首条日志卡死主进程。 */
const REG_QUERY_TIMEOUT_MS = 500;
/** 全部注册表查询的总时间预算：超预算立即降级 env 派生（懒初始化在首条日志，必须有界）。 */
const REG_TOTAL_BUDGET_MS = 3000;
/** SID 子键枚举上限：正常机器个位数，封顶防御异常注册表。 */
const MAX_PROFILE_SID_SUBKEYS = 16;
/** LogonUI SessionData 子键枚举上限。 */
const MAX_LOGON_SESSION_SUBKEYS = 4;
/** 用户 SID 形态（S-1-5-21-…）：只枚举真实用户 profile，跳过服务账户短 SID。 */
const USER_SID_PATTERN = /^S-1-5-21-/i;

/** 解析 `reg query <key>` 输出中的值行：`    Name    REG_SZ    Value`。 */
export function parseRegQueryValues(output: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s{4}(\S+)\s+(REG_(?:SZ|EXPAND_SZ|MULTI_SZ|DWORD|QWORD|BINARY))\s+(.*)$/i.exec(
      line,
    );
    if (match) {
      values.set(match[1]!, match[3]!.trim());
    }
  }
  return values;
}

/** 解析 `reg query <key>` 输出中的子键行（完整键路径，取末段；跳过被查键自身）。 */
export function parseRegQuerySubkeys(output: string): string[] {
  const subkeys: string[] = [];
  let sawQueriedKeyHeader = false;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("HKEY_")) {
      continue;
    }
    if (!sawQueriedKeyHeader) {
      // 首个 HKEY_ 行是被查询键自身，不是子键。
      sawQueriedKeyHeader = true;
      continue;
    }
    subkeys.push(trimmed.slice(trimmed.lastIndexOf("\\") + 1));
  }
  return subkeys;
}

function runRegQuery(args: string[], deadline: number): string | null {
  if (process.platform !== "win32" || Date.now() > deadline) {
    return null;
  }
  try {
    return execFileSync("reg.exe", ["query", ...args], {
      encoding: "utf8",
      timeout: Math.min(REG_QUERY_TIMEOUT_MS, Math.max(0, deadline - Date.now())),
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // 注册表不可达/键不存在/超时：一律静默降级（spec R5），env 派生兜底。
    return null;
  }
}

/**
 * 收集 Windows 注册表真名证据（一次性同步，仅 win32，总预算 3s）。
 * 每步失败都只缩小覆盖面：ProfileList 不可达仍有 LogonUI，反之亦然。
 */
export function collectWindowsLogIdentityEvidence(): WindowsProfileNameEvidence | null {
  if (process.platform !== "win32") {
    return null;
  }
  const deadline = Date.now() + REG_TOTAL_BUDGET_MS;
  const evidence: WindowsProfileNameEvidence = {};
  const profileListOutput = runRegQuery([PROFILE_LIST_KEY], deadline);
  if (profileListOutput !== null) {
    evidence.profilesDirectory = parseRegQueryValues(profileListOutput).get("ProfilesDirectory");
    const sidSubkeys = parseRegQuerySubkeys(profileListOutput)
      .filter((name) => USER_SID_PATTERN.test(name))
      .slice(0, MAX_PROFILE_SID_SUBKEYS);
    const imagePaths: string[] = [];
    for (const sid of sidSubkeys) {
      const profileOutput = runRegQuery([`${PROFILE_LIST_KEY}\\${sid}`], deadline);
      if (profileOutput === null) {
        continue;
      }
      const values = parseRegQueryValues(profileOutput);
      for (const name of ["ProfileImagePath", "CentralProfile"]) {
        const value = values.get(name);
        if (value) {
          imagePaths.push(value);
        }
      }
    }
    evidence.profileImagePaths = imagePaths;
  }
  const logonNames: string[] = [];
  const logonOutput = runRegQuery([LOGON_UI_KEY], deadline);
  if (logonOutput !== null) {
    const values = parseRegQueryValues(logonOutput);
    for (const name of ["LastLoggedOnDisplayName", "LastLoggedOnSAMUser"]) {
      const value = values.get(name);
      if (value) {
        logonNames.push(value);
      }
    }
  }
  const sessionDataOutput = runRegQuery([`${LOGON_UI_KEY}\\SessionData`], deadline);
  if (sessionDataOutput !== null) {
    for (const sessionKey of parseRegQuerySubkeys(sessionDataOutput).slice(
      0,
      MAX_LOGON_SESSION_SUBKEYS,
    )) {
      const sessionOutput = runRegQuery([`${LOGON_UI_KEY}\\SessionData\\${sessionKey}`], deadline);
      if (sessionOutput === null) {
        continue;
      }
      const values = parseRegQueryValues(sessionOutput);
      for (const name of ["LoggedOnDisplayName", "LoggedOnSAMUser"]) {
        const value = values.get(name);
        if (value) {
          logonNames.push(value);
        }
      }
    }
  }
  if (logonNames.length > 0) {
    evidence.logonNames = logonNames;
  }
  return evidence;
}

function safeUserInfoUsername(): string {
  try {
    return userInfo().username ?? "";
  } catch {
    // 容器/服务账户下 userInfo() 可能抛错（无 passwd 条目）；env 派生兜底。
    return "";
  }
}

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return "";
  }
}

/** env 派生 + 注册表真值 → 身份快照（并集：env 撒谎或缺失也能正确 redact）。 */
export function buildMainLogRedactionIdentity(): LogRedactionIdentity {
  const env = process.env;
  return buildLogRedactionIdentity({
    env: {
      homedir: homedir(),
      userInfoUsername: safeUserInfoUsername(),
      envUsername: env.USERNAME ?? "",
      envUser: env.USER ?? "",
      envLogname: env.LOGNAME ?? "",
      envUserProfile: env.USERPROFILE ?? "",
      computerName: env.COMPUTERNAME ?? "",
      userDomain: env.USERDOMAIN ?? "",
      platform: process.platform,
    },
    windowsEvidence: collectWindowsLogIdentityEvidence(),
    extraHostNames: [safeHostname()],
  });
}

let registrySingleton: HostNameRegistry | undefined;
let redactorSingleton: LogRedactor | undefined;

/** main 进程主机名注册表单例（运行期收名的唯一入口）。 */
function getLogHostNameRegistry(): HostNameRegistry {
  registrySingleton ??= createHostNameRegistry();
  return registrySingleton;
}

/**
 * 运行期收名：远端连接建立点（SSH/远程 workspace）调用，把对端主机名
 * 登记进脱敏注册表；后续日志行即命中替换。类别默认 host。
 */
export function registerLogHostName(name: string, kind: RedactionNameKind = "host"): void {
  getLogHostNameRegistry().register(kind, name);
}

/** main 进程脱敏器单例：logger.write() 漏斗与支持包共用。 */
export function getMainLogRedactor(): LogRedactor {
  if (redactorSingleton) {
    return redactorSingleton;
  }
  redactorSingleton = createLogRedactor({
    identity: buildMainLogRedactionIdentity(),
    registry: getLogHostNameRegistry(),
    onError: (error) => {
      // fail-closed 触发时的诊断出口：不走 logger（避免递归），只提示一次形态。
      console.warn(
        "[log-privacy] redaction failed; line withheld:",
        error instanceof Error ? error.name : typeof error,
      );
    },
  });
  return redactorSingleton;
}

/** 测试钩子：重置单例（仅测试使用）。 */
export function resetMainLogRedactorForTest(): void {
  redactorSingleton = undefined;
  registrySingleton = undefined;
}
