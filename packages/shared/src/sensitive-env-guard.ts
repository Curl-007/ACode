/**
 * 子进程 env 的敏感凭据键判定（安全加固 P2）。
 *
 * 背景：Bash 工具与 MCP stdio 子进程此前全量继承 agent 的 process.env（仅删固定黑名单），
 * 用户 shell 里的云厂商凭据、SCM token、SSH agent socket、registry token、数据库口令
 * 全部流入不可信执行面（模型生成的任意命令、第三方 MCP server）。本模块把
 * 「哪些键属于敏感凭据」收敛为单一事实源，供工具/MCP 子进程边界默认剥离。
 *
 * 仅含纯函数与常量、无任何 import：可被 node --test 直接加载做不变量守护测试，
 * 浏览器/渲染进程可安全引用。规格见
 * apps/acode-cli/specs/subprocess-env-credential-allowlist.md。
 */

/** 全局 opt-in 变量：用户在自己的 shell/桌面启动环境声明允许继承的敏感键（精确名或 PREFIX*）。 */
export const ACODE_TOOL_ENV_INHERIT_ALLOWLIST_ENV_KEY = "ACODE_TOOL_ENV_INHERIT_ALLOWLIST";

/**
 * 精确键名单（大写形态；匹配大小写不敏感）。只收「值本身即秘密」或「指向秘密的指针」
 * 的高置信键；长尾由前缀/后缀规则兜底。
 */
const SENSITIVE_CREDENTIAL_EXACT_KEYS: readonly string[] = [
  // SSH：agent socket 持有即签名能力；askpass 可被劫持为口令钓鱼面。
  "SSH_AUTH_SOCK",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
  // SCM token
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_PAT",
  "GITLAB_TOKEN",
  "GITLAB_PRIVATE_TOKEN",
  "GITLAB_CI_JOB_TOKEN",
  "GITEA_TOKEN",
  "BITBUCKET_TOKEN",
  "BITBUCKET_APP_PASSWORD",
  // 包管理 registry
  "NPM_TOKEN",
  "NPM_API_TOKEN",
  "NODE_AUTH_TOKEN",
  "YARN_NPM_AUTH_TOKEN",
  "GEM_HOST_API_KEY",
  "TWINE_PASSWORD",
  "CARGO_REGISTRY_TOKEN",
  "NUGET_API_KEY",
  "PYPI_TOKEN",
  // 云厂商（前缀规则之外的补充）
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GCLOUD_ACCESS_TOKEN",
  "DIGITALOCEAN_ACCESS_TOKEN",
  "DIGITALOCEAN_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_GLOBAL_API_KEY",
  "HEROKU_API_KEY",
  "VERCEL_TOKEN",
  "NETLIFY_AUTH_TOKEN",
  "NGROK_AUTHTOKEN",
  // AI 厂商
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "COHERE_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "HUGGINGFACE_TOKEN",
  // 数据库 / 基础设施
  "DATABASE_URL",
  "POSTGRES_PASSWORD",
  "PGPASSWORD",
  "MYSQL_PWD",
  "MONGO_INITDB_ROOT_PASSWORD",
  "REDIS_PASSWORD",
  "VAULT_TOKEN",
  "DOPPLER_TOKEN",
  "KUBECONFIG",
  // 消息 / 支付
  "SLACK_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_WEBHOOK_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_API_KEY",
  "SENDGRID_API_KEY",
  "MAILGUN_API_KEY",
  "TWILIO_AUTH_TOKEN",
  // 通用秘密命名
  "JWT_SECRET",
  "SESSION_SECRET",
  "ENCRYPTION_KEY",
  "MASTER_KEY",
  "SECRET_KEY",
  "PRIVATE_KEY",
];

/** 前缀规则（大写形态）。命中即视为敏感——宁可多剥（allowlist 可恢复），不可漏剥。 */
const SENSITIVE_CREDENTIAL_PREFIXES: readonly string[] = [
  "AWS_",
  "AZURE_",
  "GOOGLE_",
  "GCLOUD_",
  "GITHUB_",
  "GH_",
  "TF_VAR_",
];

/** 后缀规则（大写形态）：厂商长尾 key 的通用命名，精度高（这类命名几乎总是秘密）。 */
const SENSITIVE_CREDENTIAL_SUFFIXES: readonly string[] = [
  "_API_KEY",
  "_ACCESS_TOKEN",
  "_SECRET_KEY",
  "_SECRET",
  "_TOKEN",
  "_PASSWORD",
  "_PASSWD",
  "_PRIVATE_KEY",
  "_AUTH",
  "_AUTHTOKEN",
];

/** npm 形态：npm_config_* 中含 auth/token/password 者（registry 凭据的 env 注入形态）。 */
const NPM_CONFIG_SECRET_PATTERN = /^NPM_CONFIG_.*(?:AUTH|TOKEN|PASSWORD)/;

/**
 * 某 env 键是否属于敏感凭据（大小写不敏感）。
 * 封闭规则集：精确名单 + 前缀 + 后缀 + npm 形态；不接受运行时扩展
 * （扩展走代码评审，防止配置面被用来「解除剥离」）。
 */
export function isSensitiveCredentialEnvKey(key: string): boolean {
  const upperKey = key.trim().toUpperCase();
  if (upperKey.length === 0) return false;
  if (SENSITIVE_CREDENTIAL_EXACT_KEYS.includes(upperKey)) return true;
  if (SENSITIVE_CREDENTIAL_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) return true;
  if (SENSITIVE_CREDENTIAL_SUFFIXES.some((suffix) => upperKey.endsWith(suffix))) return true;
  return NPM_CONFIG_SECRET_PATTERN.test(upperKey);
}

/**
 * 解析 allowlist 变量：逗号分隔，条目为精确键名或 `PREFIX*` 通配；统一大写形态。
 * 非法条目（空串）丢弃；整体非法（非字符串）返回空数组。
 */
export function parseToolEnvInheritAllowlist(raw: string | undefined): readonly string[] {
  if (typeof raw !== "string") return [];
  const entries: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim().toUpperCase();
    if (entry.length > 0) entries.push(entry);
  }
  return entries;
}

/** 某键是否被 allowlist 放行（精确匹配或 `PREFIX*` 前缀匹配；大小写不敏感）。 */
export function isToolEnvInheritAllowed(key: string, allowlist: readonly string[]): boolean {
  const upperKey = key.trim().toUpperCase();
  if (upperKey.length === 0) return false;
  return allowlist.some((entry) => {
    if (entry.endsWith("*")) {
      const prefix = entry.slice(0, -1);
      return prefix.length > 0 && upperKey.startsWith(prefix);
    }
    return entry === upperKey;
  });
}
