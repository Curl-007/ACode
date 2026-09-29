import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

/**
 * specs/webfetch-public-egress.md 的验收测试（深度扫描分诊残留观察项 #1 的落地）。
 *
 * 威胁模型：WebFetch 的 URL 是模型可控输入，prompt injection 可诱导抓取「解析到内网
 * IP 的公网域名」——字面守卫拦不住 DNS 重绑定。R1 要求直连路径强制公网 DNS 预检 +
 * 过检解析建连（TOCTOU-safe）；R2 要求代理路径缺省严格拒绝、显式 opt-in 才降级并
 * 可观察；R4 要求降级授权只属于 WebFetch。
 *
 * (1)-(4) 测策略函数行为（注入假 DNS，纯函数可确定性地覆盖重绑定面）；
 * (5)-(6) 钉住接线与授权面（源断言，仓库既有测试惯例）。
 */

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const { assertPublicEgressDestination } = await import(
  "../packages/adapters/src/http/public-egress-policy.ts"
);

/** 假 DNS：返回固定解析结果，确定性覆盖「域名 → 内网 IP」的重绑定面。 */
const fakeLookup = (addresses) => async () => addresses;
const PUBLIC_V4 = [{ address: "93.184.216.34", family: 4 }];

async function expectBlocked(rawUrl, lookup, note) {
  await assert.rejects(
    assertPublicEgressDestination(new URL(rawUrl), lookup),
    (err) => {
      assert.equal(err.code, "egress_blocked", `${note}：错误码不是 egress_blocked`);
      return true;
    },
    `${note}：未被拒绝`,
  );
}

test("(1) 解析到环回/私网/链路本地地址的域名一律拒绝（DNS 重绑定面）", async () => {
  await expectBlocked("https://rebind.example/x", fakeLookup([{ address: "127.0.0.1", family: 4 }]), "环回");
  await expectBlocked("https://rebind.example/x", fakeLookup([{ address: "10.0.0.5", family: 4 }]), "私网 10.x");
  await expectBlocked("https://rebind.example/x", fakeLookup([{ address: "192.168.1.1", family: 4 }]), "私网 192.168");
  await expectBlocked("https://rebind.example/x", fakeLookup([{ address: "169.254.169.254", family: 4 }]), "云元数据");
  await expectBlocked("https://rebind.example/x", fakeLookup([{ address: "::1", family: 6 }]), "IPv6 环回");
  // 多地址解析中只要有一个非公网即整体拒绝（重绑定的多记录形态）。
  await expectBlocked(
    "https://rebind.example/x",
    fakeLookup([{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]),
    "公私混合",
  );
});

test("(2) 公网解析与公网 IP 字面量放行；零地址拒绝", async () => {
  await assertPublicEgressDestination(new URL("https://example.com/x"), fakeLookup(PUBLIC_V4));
  // IP 字面量不经 DNS，直接按地址判定。
  await assertPublicEgressDestination(new URL("https://8.8.8.8/x"), fakeLookup([]));
  await expectBlocked("https://empty.example/x", fakeLookup([]), "DNS 零地址");
});

test("(3) localhost/.local/单标签主机名/私网 IP 字面量在策略层拒绝（与字面守卫双保险）", async () => {
  await expectBlocked("https://localhost/x", fakeLookup(PUBLIC_V4), "localhost");
  await expectBlocked("https://nas.local/x", fakeLookup(PUBLIC_V4), ".local");
  await expectBlocked("https://intranet/x", fakeLookup(PUBLIC_V4), "单标签主机名");
  await expectBlocked("https://192.168.0.1/x", fakeLookup([]), "私网 IP 字面量");
});

test("(4) 已中止的 signal 透传到 DNS 预检（继承请求超时/取消边界）", async () => {
  await assert.rejects(
    assertPublicEgressDestination(new URL("https://example.com/x"), fakeLookup(PUBLIC_V4), {
      signal: AbortSignal.abort(new Error("request-cancelled")),
    }),
    /request-cancelled/u,
  );
});

test("(5) 接线钉住：WebFetch 携带 public egress + 显式代理降级授权，适配器缺省严格档保留", async () => {
  const net = await read("apps/acode-cli/packages/core/src/tool/handlers/webfetch-network.ts");
  assert.match(net, /egressPolicy: "public",/u, "WebFetch 请求未携带 egressPolicy: public（R1）");
  assert.match(
    net,
    /allowProxiedPublicEgress: true,/u,
    "WebFetch 未显式携带代理降级授权（R2 opt-in 必须是显式的）",
  );

  const adapter = await read("apps/acode-cli/packages/adapters/src/http/index.ts");
  assert.match(
    adapter,
    /if \(!request\.allowProxiedPublicEgress\) \{/u,
    "适配器代理分支未由 allowProxiedPublicEgress 门控——缺省严格拒绝语义（R2）丢失",
  );
  assert.match(
    adapter,
    /assertPublicEgressProxyBoundary\(url, proxy\.proxyUrl\);/u,
    "缺省档不再执行代理边界拒绝",
  );
  assert.match(
    adapter,
    /publicEgressDnsVerified/u,
    "egress 缺少 publicEgressDnsVerified 可观察字段（R2 降级必须如实记录）",
  );

  const port = await read("apps/acode-cli/packages/contracts/src/interfaces/http-client.port.ts");
  assert.match(port, /allowProxiedPublicEgress\?: boolean;/u, "契约缺少降级授权字段");
  assert.match(port, /publicEgressDnsVerified\?: boolean;/u, "契约缺少 DNS 预检可观察字段");
});

test("(6) R4 唯一授权点：allowProxiedPublicEgress 只出现在契约、适配器与 webfetch-network", async () => {
  const allowed = new Set([
    "packages/contracts/src/interfaces/http-client.port.ts",
    "packages/adapters/src/http/index.ts",
    "packages/core/src/tool/handlers/webfetch-network.ts",
  ]);
  const walk = async function* (dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".turbo") {
        continue;
      }
      const full = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) yield* walk(full);
      else if (entry.name.endsWith(".ts")) yield full;
    }
  };
  const violations = [];
  for await (const file of walk(new URL("../packages/", import.meta.url))) {
    const href = decodeURIComponent(file.href).replace(/\\/gu, "/");
    const marker = href.indexOf("apps/acode-cli/packages/");
    if (marker < 0) continue;
    const rel = href.slice(marker + "apps/acode-cli/".length);
    if (allowed.has(rel)) continue;
    const text = await readFile(file, "utf8");
    if (text.includes("allowProxiedPublicEgress")) violations.push(rel);
  }
  assert.deepEqual(
    violations,
    [],
    `allowProxiedPublicEgress 出现在授权面白名单之外（R4）：${violations.join(", ")}`,
  );
});
