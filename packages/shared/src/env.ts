export type ACodeEnv = "test" | "production";
/** 安装包身份：决定应用名、app id、Electron 数据目录与更新策略；与后端环境 `ACodeEnv` 是两个轴。 */
export type ACodeProductFlavor = "production" | "preview";

// 非构建环境（如 e2e 测试的 mocha）下 define 不存在，用 typeof 检查 + fallback 避免 ReferenceError
declare const __ACODE_ENV__: string;
declare const __ACODE_PRODUCT_FLAVOR__: string;

export function normalizeACodeEnv(value: string | undefined): ACodeEnv {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export const ACODE_ENV = normalizeACodeEnv(
  typeof __ACODE_ENV__ !== "undefined" ? __ACODE_ENV__ : undefined,
);

/**
 * 身份缺省跟随后端环境（test → preview，production → production）。
 * 桌面构建通过 `ACODE_PREVIEW_IDENTITY=1` 显式注入 preview，得到连接生产后端的 Preview 包；
 * 未注入 define 的 bundle（web、CLI、测试）沿用旧的单轴语义。
 */
export function normalizeACodeProductFlavor(
  value: string | undefined,
  acodeEnv: ACodeEnv,
): ACodeProductFlavor {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "production" || normalized === "preview") {
    return normalized;
  }
  return acodeEnv === "production" ? "production" : "preview";
}

export const ACODE_PRODUCT_FLAVOR = normalizeACodeProductFlavor(
  typeof __ACODE_PRODUCT_FLAVOR__ !== "undefined" ? __ACODE_PRODUCT_FLAVOR__ : undefined,
  ACODE_ENV,
);
export const ACODE_APP_VERSION_ENV = "ACODE_APP_VERSION" as const;
export const ACODE_BUILD_COMMIT_ID_ENV = "ACODE_BUILD_COMMIT_ID" as const;
// 安全加固 P2：桌面 main 在打包态向 host/worker 下发「本进程属打包运行时」标记。
// 打包态的配置加载必须忽略用户态 env 注入（如托管策略文件路径覆盖），与 P1-7
// 更新源门禁同一哲学；dev/源码运行不设此键。
export const ACODE_APP_IS_PACKAGED_ENV = "ACODE_APP_IS_PACKAGED" as const;

/**
 * 本进程是否属于打包桌面运行时（安全加固 P2，规格见
 * packages/services/specs/agent-command-env-gate.md）。
 *
 * 标记由桌面 main 依 app.isPackaged（编译期事实）写入 host env，且在 `...inheritedEnv`
 * 之后 spread——打包态下继承值无法伪造/覆盖它。host 无 Electron app 对象，本谓词是
 * services 层判定打包态的唯一事实源：agent 命令 env 覆盖、binaryEnvVar 候选等
 * 安全关键解析在打包态统一忽略用户态 env 注入。
 *
 * dev（源码运行）、独立 CLI、acode-server-cli、远程 server 均无此标记 → 返回 false，
 * env 覆盖照常生效（那些场景里用户就是管理员）。
 */
export function isPackagedACodeDesktopRuntime(
  env: Readonly<Record<string, string | undefined>> = typeof process === "undefined"
    ? {}
    : process.env,
): boolean {
  return env[ACODE_APP_IS_PACKAGED_ENV] === "1";
}

// ── 运行时环境变量（不经过编译打包，启动时从 process.env 读取） ──
// 启用调试模式，值为 inspect-brk 的端口号，如 ACODE_DEBUG=9230
export const RUNTIME_ACODE_DEBUG =
  typeof process !== "undefined" ? process.env.ACODE_DEBUG : undefined;
