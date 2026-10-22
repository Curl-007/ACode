/**
 * 服务层日志脱敏单例（specs/log-privacy-redaction.md services R1-R5）。
 *
 * serviceLogger 的 write() 是服务层日志唯一漏斗；本模块持有该漏斗使用的
 * redactor 单例。身份来源是本进程 env 派生（os.homedir/userInfo +
 * HOME/USERPROFILE/USERNAME/USER/LOGNAME/COMPUTERNAME/USERDOMAIN）：
 * Windows 注册表真名是桌面 main 的增强（desktop specs R4-R5），服务层不重复
 * 实现注册表访问——桌面场景下 host 日志终局仍过 main 漏斗，注册表真名在那里兜底。
 *
 * 懒初始化：首次写日志才构建身份（模块加载零副作用，测试可安全 import）。
 */
// 命名空间导入而非命名导入：browser/vite dev 下 node:os 被 externalize 成属性访问
// 即抛的 stub，命名导入会在模块图求值期解构绑定、直接炸掉 renderer 挂载（本模块
// 承诺「模块加载零副作用」，顶层命名导入违背该承诺——dev desktop 黑屏实测回归）。
// 命名空间导入把属性访问推迟到 safe* 调用期，且调用点全部有 try/catch + env 派生兜底。
import * as nodeOs from "node:os";

import {
  buildLogRedactionIdentity,
  createHostNameRegistry,
  createLogRedactor,
  type HostNameRegistry,
  type LogRedactor,
  type RedactionNameKind,
} from "@acode/shared";

let registrySingleton: HostNameRegistry | undefined;
let redactorSingleton: LogRedactor | undefined;

function safeUserInfoUsername(): string {
  try {
    return nodeOs.userInfo().username ?? "";
  } catch {
    // 容器/服务账户下 userInfo() 可能没有 passwd 条目；env 派生兜底。
    return "";
  }
}

function safeHomedir(): string {
  try {
    return nodeOs.homedir();
  } catch {
    return "";
  }
}

function safeHostname(): string {
  try {
    return nodeOs.hostname();
  } catch {
    return "";
  }
}

/** 服务层主机名注册表单例（运行期收名的唯一入口）。 */
function getServiceLogHostNameRegistry(): HostNameRegistry {
  registrySingleton ??= createHostNameRegistry();
  return registrySingleton;
}

/**
 * 运行期收名：远端连接建立点（SSH/远程 workspace）调用，把对端主机名
 * 登记进脱敏注册表；后续服务层日志行即命中替换。
 */
export function registerServiceLogHostName(name: string, kind: RedactionNameKind = "host"): void {
  getServiceLogHostNameRegistry().register(kind, name);
}

/** 服务层脱敏器单例。 */
function getServiceLogRedactor(): LogRedactor {
  if (redactorSingleton) {
    return redactorSingleton;
  }
  const env = process.env;
  redactorSingleton = createLogRedactor({
    identity: buildLogRedactionIdentity({
      env: {
        homedir: safeHomedir(),
        userInfoUsername: safeUserInfoUsername(),
        envUsername: env.USERNAME ?? "",
        envUser: env.USER ?? "",
        envLogname: env.LOGNAME ?? "",
        envUserProfile: env.USERPROFILE ?? "",
        computerName: env.COMPUTERNAME ?? "",
        userDomain: env.USERDOMAIN ?? "",
        platform: process.platform,
      },
      extraHostNames: [safeHostname()],
    }),
    registry: getServiceLogHostNameRegistry(),
    onError: (error) => {
      // fail-closed 触发时的诊断出口：不走 serviceLogger（避免递归）。
      console.warn(
        "[log-privacy] service log redaction failed; line withheld:",
        error instanceof Error ? error.name : typeof error,
      );
    },
  });
  return redactorSingleton;
}

/**
 * 漏斗内的单参数脱敏（spec R2）：
 * - 字符串 → redactLine；
 * - Error → 展平为 `name: message + stack` 字符串后脱敏
 *   （Error 直接 JSON 化会得到 `{}`，堆栈里的用户路径必须在这里脱掉）；
 * - 其他对象 → 原样透传，不改变日志形状（终局字符串化漏斗负责脱敏，
 *   双层串联依赖脱敏幂等不变量）。
 *
 * 关于对象参数（review R2-04 / security §2 第三条）：对象在源头透传、由终局
 * 字符串化漏斗（桌面 main write() / host reportHostLog）JSON 化后脱敏。曾评估
 * 在源头对对象 JSON 序列化并脱敏以覆盖非桌面裸 console 进程，但该改动会破坏
 * 既有调用点——acode-agent 的 session start timing 观测面（spec R3）经 console
 * 拦截读取对象的结构化字段（workspaceKey/outcome/sparePid 等）做身份归属断言，
 * 源头字符串化+路径脱敏会让该断言无法成立。finding 明确「当前无实际泄漏」且
 * 以「不破坏既有调用点」为改动前提，故维持对象透传契约；非桌面进程的对象内容
 * 脱敏缺口作为跨文件事项登记（见 review fix-status），由主审统一裁决。
 */
export function redactServiceLogArg(arg: unknown): unknown {
  const redactor = getServiceLogRedactor();
  if (typeof arg === "string") {
    return redactor.redactLine(arg);
  }
  if (arg instanceof Error) {
    return redactor.redactArgValue(arg);
  }
  return arg;
}

/** 测试钩子：重置单例（仅测试使用）。 */
export function resetServiceLogRedactorForTest(): void {
  redactorSingleton = undefined;
  registrySingleton = undefined;
}
