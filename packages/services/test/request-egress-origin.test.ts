// 携凭据出站目标 origin 的出口校验（services/specs/credentialed-egress-origin.md）。
//
// 加固前：`NodeApiClient.request` 的目标 origin 由 env / 设置项决定，统一校验只有
// `normalizeACodeEndpointOrigin`（非空 + 可解析 + http/https），无主机校验、无环回/私网/
// 链路本地/metadata 阻断，而这些请求携带 OAuth/login access token。
//
// 断言分三类（沿用本包既有惯例）：
//   1. 纯叶子 `inspectRequestTarget` / `resolveAllowNonPublicRequestTarget` 行为直测；
//   2. **真实 NodeApiClient + stub fetch** 的接线端到端——证明守卫在凭证读取与建连之前生效，
//      且被拦时 fetch 根本没被调用（这一类是关键：只测叶子无法证明接上了）；
//   3. 跨文件源码不变量——打包态 drop 闭集必须覆盖 endpoint 族键，且必须覆盖放行开关本身，
//      否则开关就成了绕过闭集的后门。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ENDPOINT_ALLOW_PRIVATE_ORIGIN_ENV,
  RequestTargetBlockedError,
  inspectRequestTarget,
  resolveAllowNonPublicRequestTarget,
} from "../src/providers/api/requestEgressPolicy.js";
import { NodeApiClient } from "../src/providers/api/nodeApiClient.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const readRepoFile = (...parts: string[]): string => readFileSync(join(repoRoot, ...parts), "utf8");

/** 强制档：不受环境里可能存在的 ACODE_ENV / 放行开关影响，保证用例确定性。 */
const ENFORCING = { allowNonPublic: false } as const;

test("协议白名单：http/https 放行，其余一律拒（含 file: 与 data:）", () => {
  for (const url of ["https://api.example.com/v1/x", "http://api.example.com/v1/x"]) {
    assert.equal(inspectRequestTarget(url, ENFORCING).ok, true, `${url} 应放行`);
  }
  for (const url of ["file:///etc/passwd", "data:text/plain,token", "gopher://api.example.com/_x"]) {
    const verdict = inspectRequestTarget(url, ENFORCING);
    assert.equal(verdict.ok, false, `${url} 应被拒`);
    assert.equal(verdict.ok || verdict.code, "unsupported_protocol");
  }
});

test("主机名字面量：localhost / *.localhost / *.local / 单标签一律拒", () => {
  for (const host of ["localhost", "api.localhost", "backend.local", "intranet"]) {
    const verdict = inspectRequestTarget(`https://${host}/v1/x`, ENFORCING);
    assert.equal(verdict.ok, false, `${host} 应被拒`);
    assert.equal(verdict.ok || verdict.code, "blocked_host");
  }
});

test("IP 字面量：环回/私网/链路本地/云 metadata/NAT64 内嵌全拒，公网放行", () => {
  const blocked = [
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.1",
    "172.16.0.1",
    "169.254.169.254", // 云 metadata：把 access token 送到这里是最具体的滥用形态
    "0.0.0.0",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:7f00:1", // IPv4-mapped loopback
    "64:ff9b::a9fe:a9fe", // NAT64 WKP 内嵌 169.254.169.254
  ];
  for (const ip of blocked) {
    const host = ip.includes(":") ? `[${ip}]` : ip;
    const verdict = inspectRequestTarget(`https://${host}/v1/x`, ENFORCING);
    assert.equal(verdict.ok, false, `${ip} 应被拒`);
    assert.equal(verdict.ok || verdict.code, "blocked_address");
  }
  for (const url of ["https://api.example.com/v1/x", "https://93.184.216.34/v1/x"]) {
    assert.equal(inspectRequestTarget(url, ENFORCING).ok, true, `${url} 应放行`);
  }
});

test("三条放行来源，且显式选项只能收紧不能放宽", () => {
  assert.equal(resolveAllowNonPublicRequestTarget({ allowNonPublic: true }), true);
  assert.equal(resolveAllowNonPublicRequestTarget({ env: {} }), false, "无 env 信号时默认强制");
  assert.equal(
    resolveAllowNonPublicRequestTarget({ env: { ACODE_ENV: "test" } }),
    true,
    "test 姿态放行（开发/e2e 要打本地 server）",
  );
  assert.equal(
    resolveAllowNonPublicRequestTarget({ env: { [ENDPOINT_ALLOW_PRIVATE_ORIGIN_ENV]: "1" } }),
    true,
    "自建后端的显式放行开关",
  );
  assert.equal(
    resolveAllowNonPublicRequestTarget({ env: { [ENDPOINT_ALLOW_PRIVATE_ORIGIN_ENV]: "true" } }),
    false,
    '开关只认严格 "1"（与本包 ACODE_SERVER_SKIP_SERVICE_REGISTRATION 同形态）',
  );
  // 关键：调用方可以用选项强制收紧，压过 env 的放行信号。
  assert.equal(
    resolveAllowNonPublicRequestTarget({ allowNonPublic: false, env: { ACODE_ENV: "test" } }),
    false,
  );
  assert.equal(
    inspectRequestTarget("https://localhost:4000/v1/x", {
      allowNonPublic: false,
      env: { ACODE_ENV: "test" },
    }).ok,
    false,
    "显式收紧后即便 test 姿态也拦",
  );
});

test("放行开关只作用于主机/地址校验，不作用于协议白名单", () => {
  // 放行档下 localhost 可用（开发/e2e/自建后端的合法需要）……
  assert.equal(inspectRequestTarget("https://localhost:4000/v1/x", { allowNonPublic: true }).ok, true);
  // ……但 file:/data: 仍然被拒：它们对自建后端与 e2e 同样没有合法用途。
  for (const url of ["file:///etc/passwd", "data:text/plain,token"]) {
    const verdict = inspectRequestTarget(url, { allowNonPublic: true });
    assert.equal(verdict.ok, false, `${url} 即便放行档也应被拒`);
    assert.equal(verdict.ok || verdict.code, "unsupported_protocol");
  }
});

test("接线：NodeApiClient 在 fetch 之前拦下非公网目标，且 fetch 根本没被调用", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const client = new NodeApiClient({
    fetchImpl,
    requestTargetEgress: { allowNonPublic: false, env: {} },
  });

  await assert.rejects(
    client.request("https://169.254.169.254/latest/meta-data/iam/security-credentials/"),
    (error: unknown) =>
      error instanceof RequestTargetBlockedError && error.code === "blocked_address",
  );
  assert.deepEqual(calls, [], "被拦时不得发出任何请求（先校验、后建连）");

  await assert.rejects(
    client.request("https://localhost:4000/v1/customer"),
    (error: unknown) => error instanceof RequestTargetBlockedError && error.code === "blocked_host",
  );
  assert.deepEqual(calls, [], "localhost 同样不得发出请求");

  // 反向：公网目标必须照常放行，否则本守卫就是"把所有请求都拦掉"的假绿。
  await client.request("https://api.example.com/v1/customer");
  assert.equal(calls.length, 1, `公网目标应到达 fetch，实际 ${calls.length} 次`);
});

test("打包态 drop 闭集覆盖 endpoint 族键，且覆盖放行开关本身", () => {
  const source = readRepoFile("packages/desktop/src/main/startupSanitation.ts");
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join("\n");
  const start = code.indexOf("PACKAGED_BOOT_ENV_DROP_KEYS");
  assert.ok(start >= 0, "找不到 PACKAGED_BOOT_ENV_DROP_KEYS 声明");
  const body = code.slice(code.indexOf("[", start), code.indexOf("];", start));
  const dropped = new Set([...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]));

  // 决定携凭据出站 origin 的键族必须全部在闭集里。
  for (const key of [
    "ACODE_BASE_URL",
    "ACODE_ENDPOINT_ORIGIN",
    "ZAI_BUSINESS_BASE_URL",
    "ZAI_OAUTH_ORIGIN",
    "BIGMODEL_API_BASE_URL",
    "ACODE_BIGMODEL_USAGE_QUOTA_URL",
    "BIGMODEL_USAGE_QUOTA_URL",
  ]) {
    assert.ok(dropped.has(key), `${key} 决定携凭据出站 origin，必须在打包态 drop 闭集内`);
  }
  // 放行开关必须一并删除，否则它就成了绕过整个闭集的后门。
  assert.ok(
    dropped.has(ENDPOINT_ALLOW_PRIVATE_ORIGIN_ENV),
    `${ENDPOINT_ALLOW_PRIVATE_ORIGIN_ENV} 必须被打包态删除，否则可用它绕过本闭集`,
  );
  // test 姿态的钥匙也必须在闭集里（既有事实，这里钉住它与本模块的咬合关系）。
  assert.ok(dropped.has("ACODE_ENV"), "ACODE_ENV 必须在闭集内，否则打包态可自称 test 绕过强制档");
});

test("跨文件不变量：转发给远端 server 的 origin 类键必须都在打包态 drop 闭集内", () => {
  const connectSource = readRepoFile("packages/server/src/remote/connect.ts");
  const code = connectSource
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join("\n");
  const start = code.indexOf("REMOTE_RUNTIME_ENV_KEYS");
  assert.ok(start >= 0, "找不到 REMOTE_RUNTIME_ENV_KEYS 声明");
  const forwarded = new Set(
    [...code.slice(code.indexOf("[", start), code.indexOf("]", start)).matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    ),
  );

  const sanitation = readRepoFile("packages/desktop/src/main/startupSanitation.ts");
  const sanitationCode = sanitation
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join("\n");
  const dropStart = sanitationCode.indexOf("PACKAGED_BOOT_ENV_DROP_KEYS");
  const dropped = new Set(
    [
      ...sanitationCode
        .slice(
          sanitationCode.indexOf("[", dropStart),
          sanitationCode.indexOf("];", dropStart),
        )
        .matchAll(/"([^"]+)"/g),
    ].map((match) => match[1]),
  );

  // 只约束 origin/URL 类键：REMOTE_RUNTIME_ENV_KEYS 里还有 ACODE_DYNAMIC_WORKFLOW_MODE 这类
  // 功能旗标，它们不决定出站目标，不属本不变量射程。
  const originLike = [...forwarded].filter((key) => /_URL$|_ORIGIN$|BASE_URL$/.test(key));
  assert.ok(originLike.length > 0, "应当至少识别出若干 origin 类键，否则本断言空转");
  for (const key of originLike) {
    assert.ok(
      dropped.has(key),
      `${key} 会被转发给远端 server 且决定出站 origin，必须在打包态 drop 闭集内（否则桌面 shell env 经转发链影响远端）`,
    );
  }
});
