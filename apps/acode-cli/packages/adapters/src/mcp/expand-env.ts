// MCP 配置值环境变量展开（specs/mcp-startup-gate-breaker.md R4）。
//
// 机制形态参照外部成熟实现的公开行为（`${VAR}` 与 `${VAR:-default}`、POSIX `:-`
// 语义、对象/数组递归深展开、原型成员不可替换），实现自撰。为什么放在 adapter
// 连接边界：配置由宿主/插件供给，跨机器共享 `.mcp.json` 时路径与密钥不应写死；
// 在唯一消费入口（connectServerInternal）展开一次，下游（transport、缓存指纹、
// 状态投影）全部看到展开后配置，展开幂等保证重连/比较路径不会二次变形。
//
// 语义（对齐 POSIX `:-`）：
// - `${VAR}`：已设置 → 值（包括空串，原样保留）；未设置 → 保持字面 `${VAR}`。
// - `${VAR:-default}`：已设置且非空 → 值；未设置或空 → default。
// - 单趟替换：不支持嵌套 `${A${B}}`，不匹配的文本原样保留。
// - 查找顺序 = 注入 env（own property）→ 进程 env；`__proto__` 等原型成员一律
//   不算已设置（env 查找只认 own property）。

const ENV_PLACEHOLDER_PATTERN = /\$\{([^}:]+)(?::-([^}]*))?\}/g;

export interface ExpandMcpEnvOptions {
  /** 优先于进程 env 的注入表（测试与宿主覆盖面）。 */
  env?: Readonly<Record<string, string | undefined>>;
}

function lookupEnvValue(varName: string, extraEnv: Readonly<Record<string, string | undefined>>): string | undefined {
  if (Object.hasOwn(extraEnv, varName)) {
    const value = extraEnv[varName];
    return typeof value === "string" ? value : undefined;
  }
  const ambient = process.env[varName];
  return typeof ambient === "string" ? ambient : undefined;
}

function expandEnvValue(value: string, extraEnv: Readonly<Record<string, string | undefined>>): string {
  return value.replace(
    ENV_PLACEHOLDER_PATTERN,
    (_match: string, varName: string, defaultValue: string | undefined) => {
      const envValue = lookupEnvValue(varName, extraEnv);
      if (envValue !== undefined && (defaultValue === undefined || envValue !== "")) return envValue;
      if (defaultValue !== undefined) return defaultValue;
      // 未设置且无 default：保持字面（不吞占位符，配置错误可见）。
      return `\${${varName}}`;
    },
  );
}

/**
 * 深展开一个配置值中的环境变量占位符。对象与数组递归、字符串叶子替换、键名不动、
 * 其他类型原样返回。幂等：无占位符（或占位符已定型）的输入展开后等于自身。
 */
export function expandMcpEnvDeep<T>(value: T, options: ExpandMcpEnvOptions = {}): T {
  const extraEnv = options.env ?? process.env;
  if (typeof value === "string") {
    return expandEnvValue(value, extraEnv) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandMcpEnvDeep(item, { env: extraEnv })) as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = expandMcpEnvDeep(item, { env: extraEnv });
    }
    return result as T;
  }
  return value;
}
