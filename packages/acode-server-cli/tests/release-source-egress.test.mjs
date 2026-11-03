// Release 下载源出口策略的门禁（specs/release-source-egress.md）。
//
// 加固前 `releaseDownload.ts` 的两个站点是裸 `fetch(url, { redirect: "follow" })`：无协议白名单、
// 无主机校验、无内网/环回/链路本地/metadata 阻断，而这条链投递的是**代码**（catalog → archive）。
// 本文件把该性质钉成测试，重点是三件在开发机上不显然的事：
//   ① `z.string().url()` 会放行 `file:` / `data:`，协议白名单必须独立于 schema；
//   ② `redirect: "follow"` 会让首跳校验形同虚设——服务端一个 302 就能把请求送到
//      `http://169.254.169.254/latest/meta-data/`，故必须 manual + **逐跳**校验；
//   ③ 内网镜像放行开关只放行主机校验，**不放行协议白名单**。
import test from "node:test";
import assert from "node:assert/strict";

const {
  inspectReleaseSourceUrl,
  assertPublicReleaseSource,
  fetchPublicReleaseSource,
  resolveAllowPrivateReleaseSource,
  ReleaseSourceBlockedError,
  RELEASE_SOURCE_ALLOW_PRIVATE_ENV,
} = await import("../src/runtime/releaseSourcePolicy.ts");

/** 恒不解析的 DNS stub：任何走到 DNS 的路径都视为测试写错（用于断言"根本没查 DNS"）。 */
const neverLookup = async () => {
  throw new Error("测试不应触发 DNS 解析");
};

/** 一律解析到公网地址的 stub：供只关心跳转/状态机、不关心 DNS 的用例使用（避免真发 DNS 查询）。 */
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

/** 构造一个返回固定地址表的 DNS stub，并记录被请求的参数。 */
function stubLookup(addresses) {
  const calls = [];
  return {
    calls,
    lookup: async (hostname, options) => {
      calls.push({ hostname, options });
      return addresses;
    },
  };
}

/** 构造一个按 URL 前缀决定响应的 fetch stub，并记录每次调用收到的 init。 */
function stubFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const route = routes.find(([prefix]) => String(url).startsWith(prefix));
    if (!route) throw new Error(`测试未预期的请求：${url}`);
    return route[1];
  };
  return { calls, impl };
}

function redirectResponse(location) {
  const headers = new Headers(location === null ? {} : { location });
  return { status: 302, ok: false, headers, body: null };
}

function okResponse() {
  return { status: 200, ok: true, headers: new Headers(), body: null };
}

test("协议白名单：http/https 放行，file:/data:/gopher:/ftp: 拒绝", () => {
  for (const url of ["https://example.com/c.json", "http://example.com/c.json"]) {
    const verdict = inspectReleaseSourceUrl(url, { dnsLookup: neverLookup });
    assert.equal(verdict.ok, true, `${url} 应放行`);
  }
  // 明文 http 放行但必须可观测（spec 残余登记：代码投递走明文意味着归档可被中途替换）。
  const plaintext = inspectReleaseSourceUrl("http://example.com/c.json", { dnsLookup: neverLookup });
  assert.equal(plaintext.ok && plaintext.plaintextHttp, true);
  assert.equal(
    inspectReleaseSourceUrl("https://example.com/c.json", { dnsLookup: neverLookup }).plaintextHttp,
    false,
  );

  for (const url of [
    "file:///etc/passwd",
    "data:text/plain,hello",
    "gopher://example.com/_x",
    "ftp://example.com/c.json",
  ]) {
    const verdict = inspectReleaseSourceUrl(url, { dnsLookup: neverLookup });
    assert.equal(verdict.ok, false, `${url} 应被拒`);
    assert.equal(verdict.code, "unsupported_protocol");
  }
});

test("协议白名单不受内网放行开关影响（开关只放行主机校验）", () => {
  // 能设这个开关的人本来就能设 manifest URL 本身，故开关不削弱威胁模型；但 file:/data:
  // 对内网镜像同样没有合法用途，而它们能把本地文件读进解析器——所以必须仍然拒绝。
  for (const url of ["file:///etc/passwd", "data:text/plain,hello"]) {
    const verdict = inspectReleaseSourceUrl(url, {
      allowPrivateSource: true,
      dnsLookup: neverLookup,
    });
    assert.equal(verdict.ok, false, `${url} 即便开了放行开关也应被拒`);
    assert.equal(verdict.code, "unsupported_protocol");
  }
});

test("主机名字面量：localhost / *.localhost / *.local / 单标签一律拒", () => {
  for (const host of ["localhost", "release.localhost", "mirror.local", "intranet"]) {
    const verdict = inspectReleaseSourceUrl(`https://${host}/catalog.json`, {
      dnsLookup: neverLookup,
    });
    assert.equal(verdict.ok, false, `${host} 应被拒`);
    assert.equal(verdict.code, "blocked_host");
  }
});

test("IP 字面量：环回/私网/链路本地/CGNAT/组播/保留与云 metadata 全拒，公网放行", () => {
  const blocked = [
    "127.0.0.1", // loopback
    "10.0.0.5", // private
    "192.168.1.1", // private
    "172.16.0.1", // private
    "169.254.169.254", // **云 metadata 服务**
    "0.0.0.0", // unspecified
    "100.64.0.1", // CGNAT
    "198.18.0.1", // benchmark
    "224.0.0.1", // multicast
    "240.0.0.1", // reserved
    "::1", // IPv6 loopback
    "fc00::1", // unique-local
    "fe80::1", // link-local
    "ff00::1", // multicast
    "::ffff:7f00:1", // IPv4-mapped loopback（BlockList 的 CIDR 匹配才判得到）
    "64:ff9b::a9fe:a9fe", // NAT64 WKP 内嵌 169.254.169.254
    "2002::1", // 6to4
    "2001::1", // Teredo
  ];
  for (const ip of blocked) {
    const host = ip.includes(":") ? `[${ip}]` : ip;
    const verdict = inspectReleaseSourceUrl(`https://${host}/catalog.json`, {
      dnsLookup: neverLookup,
    });
    assert.equal(verdict.ok, false, `${ip} 应被拒`);
    assert.equal(verdict.code, "blocked_address", `${ip} 的拒绝理由应是地址而非主机名`);
  }

  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
    const verdict = inspectReleaseSourceUrl(`https://${ip}/catalog.json`, { dnsLookup: neverLookup });
    assert.equal(verdict.ok, true, `${ip} 是公网地址，应放行`);
  }
});

test("DNS 预检：解析出的**全部**地址都必须公网，只查第一个不够", async () => {
  // 攻击者可以让公网地址排在前、内网地址排在后；只校验 addresses[0] 会被绕过。
  await assert.rejects(
    assertPublicReleaseSource("https://release.example.com/catalog.json", {
      dnsLookup: stubLookup([
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]).lookup,
    }),
    (error) => error instanceof ReleaseSourceBlockedError && error.code === "blocked_address",
  );

  const stub = stubLookup([{ address: "93.184.216.34", family: 4 }]);
  const url = await assertPublicReleaseSource("https://release.example.com/catalog.json", {
    dnsLookup: stub.lookup,
  });
  assert.equal(url.hostname, "release.example.com");
  // 必须要求 all + verbatim：只要一个地址就是回到"只查第一个"的老路。
  assert.deepEqual(stub.calls[0].options, { all: true, verbatim: true });

  await assert.rejects(
    assertPublicReleaseSource("https://release.example.com/catalog.json", {
      dnsLookup: stubLookup([]).lookup,
    }),
    (error) => error instanceof ReleaseSourceBlockedError && error.code === "dns_no_address",
  );
});

test("字面量 IP 与放行开关都不走 DNS", async () => {
  await assertPublicReleaseSource("https://93.184.216.34/catalog.json", { dnsLookup: neverLookup });
  // 开关放行时连解析都不做（内网镜像的主机名可能根本不在公网 DNS 里）。
  const url = await assertPublicReleaseSource("https://mirror.corp.internal/catalog.json", {
    allowPrivateSource: true,
    dnsLookup: neverLookup,
  });
  assert.equal(url.hostname, "mirror.corp.internal");
});

test("放行开关：env 为 \"1\" 才生效，显式选项优先于 env", () => {
  assert.equal(
    resolveAllowPrivateReleaseSource({ env: { [RELEASE_SOURCE_ALLOW_PRIVATE_ENV]: "1" } }),
    true,
  );
  for (const value of ["0", "true", "", "yes"]) {
    assert.equal(
      resolveAllowPrivateReleaseSource({ env: { [RELEASE_SOURCE_ALLOW_PRIVATE_ENV]: value } }),
      false,
      `值 ${JSON.stringify(value)} 不应被当成放行（与本包 ACODE_SERVER_SKIP_SERVICE_REGISTRATION 同形态）`,
    );
  }
  assert.equal(resolveAllowPrivateReleaseSource({ env: {} }), false);
  assert.equal(
    resolveAllowPrivateReleaseSource({
      allowPrivateSource: false,
      env: { [RELEASE_SOURCE_ALLOW_PRIVATE_ENV]: "1" },
    }),
    false,
    "显式 false 必须压过 env（调用方可强制收紧，不可强制放宽）",
  );
});

test("redirect: follow 的老路会被 302 绕过——逐跳校验必须拦下跳向 metadata 的第二跳", async () => {
  const metadata = "http://169.254.169.254/latest/meta-data/iam/security-credentials/";
  const { calls, impl } = stubFetch([
    ["https://release.example.com/", redirectResponse(metadata)],
    // 刻意**不**登记 metadata 那一跳的路由：一旦守卫失效真的去请求它，stub 会抛
    // "测试未预期的请求"，于是本用例以另一种方式失败，不会静默通过。
  ]);

  await assert.rejects(
    fetchPublicReleaseSource(
      "https://release.example.com/catalog.json",
      {},
      { fetchImpl: impl, dnsLookup: publicLookup },
    ),
    (error) => error instanceof ReleaseSourceBlockedError && error.code === "blocked_address",
  );
  // 关键断言：第二跳**根本没有发出请求**（先校验、后建连）。
  assert.equal(calls.length, 1, `应只请求首跳，实际 ${calls.length} 次：${calls.map((c) => c.url).join(", ")}`);
  assert.equal(calls[0].init.redirect, "manual", "必须用 manual，follow 会让首跳校验形同虚设");
});

test("多跳重定向逐跳校验，且相对 Location 按当前跳解析", async () => {
  const { calls, impl } = stubFetch([
    ["https://release.example.com/a", redirectResponse("/b")],
    ["https://release.example.com/b", redirectResponse("https://cdn.example.com/c")],
    ["https://cdn.example.com/c", okResponse()],
  ]);
  const dnsLookup = stubLookup([{ address: "93.184.216.34", family: 4 }]).lookup;

  const response = await fetchPublicReleaseSource(
    "https://release.example.com/a",
    {},
    { fetchImpl: impl, dnsLookup },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://release.example.com/a", "https://release.example.com/b", "https://cdn.example.com/c"],
  );
});

test("重定向跳数超上限即拒，不静默截断也不无限跟随", async () => {
  const { calls, impl } = stubFetch([["https://release.example.com/", redirectResponse("/loop")]]);
  await assert.rejects(
    fetchPublicReleaseSource(
      "https://release.example.com/loop",
      {},
      { fetchImpl: impl, maxRedirects: 3, dnsLookup: publicLookup },
    ),
    (error) => error instanceof ReleaseSourceBlockedError && error.code === "too_many_redirects",
  );
  assert.equal(calls.length, 4, "首跳 + 3 跳后应停下");
});

test("3xx 但没有 Location 不是跳转：按原样交回调用方处理状态", async () => {
  const { impl } = stubFetch([["https://release.example.com/", redirectResponse(null)]]);
  const response = await fetchPublicReleaseSource(
    "https://release.example.com/catalog.json",
    {},
    { fetchImpl: impl, dnsLookup: publicLookup },
  );
  assert.equal(response.status, 302);
});

test("DNS 预检继承调用方的 signal：已取消则不发解析", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(
    assertPublicReleaseSource("https://release.example.com/catalog.json", {
      dnsLookup: neverLookup,
      signal: controller.signal,
    }),
    /cancelled by test/,
  );
});

// 上面 12 个用例测的都是策略模块**自身**。若 releaseDownload.ts 根本没接上，它们照样全绿——
// 所以必须有接线钉子。形态沿用本仓既有惯例（源码静态扫描），因为 releaseDownload.ts 的 fetch
// 不可注入，无法用行为断言覆盖。
test("接线钉子：release 下载的两个站点都经守卫出口，包内运行时无裸 fetch", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../src");
  const read = (...parts) => readFileSync(join(srcDir, ...parts), "utf8");
  // 说明性注释里必然出现被禁字面量（例如解释"为什么不再用 redirect:follow"），
  // 故所有静态断言都先滤掉整行注释，只对代码行生效。
  const codeOf = (text) =>
    text
      .split("\n")
      .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
      .join("\n");

  const releaseDownload = read("runtime", "releaseDownload.ts");
  assert.match(
    releaseDownload,
    /from "\.\/releaseSourcePolicy\.js"/,
    "releaseDownload.ts 必须从 releaseSourcePolicy 导入守卫",
  );
  // 两个站点：fetchReleaseJson（catalog / runtime manifest）与 downloadOnce（归档 / 组件）。
  // 少一个就意味着那条 URL 绕过了校验，故按**数量**钉住而不是按"至少一处"。
  const guardCalls = codeOf(releaseDownload).match(/fetchPublicReleaseSource\(/g) ?? [];
  assert.equal(guardCalls.length, 2, `守卫应恰好接在 2 个 fetch 站点上，实际 ${guardCalls.length}`);
  assert.doesNotMatch(
    codeOf(releaseDownload),
    /(?:^|[^\w.])fetch\(/,
    "releaseDownload.ts 不得再有裸 fetch()——那会绕过出口守卫",
  );

  // redirect: "follow" 会让首跳校验形同虚设。运行时必须清零；打包期 stageCli.ts 是唯一
  // 书面例外（只做协议白名单，理由见 specs/release-source-egress.md「打包期例外」）。
  const stageCli = read("packaging", "stageCli.ts");
  assert.match(stageCli, /inspectReleaseSourceUrl\(/, "stageCli.ts 的下载必须先过协议白名单");
  assert.match(
    codeOf(stageCli),
    /allowPrivateSource:\s*true/,
    "stageCli.ts 必须显式声明它只做协议校验、不做主机校验（避免日后被误读成已全面加固）",
  );

  const runtimeOffenders = [];
  for (const entry of ["runtime/releaseDownload.ts", "runtime/updatePreparation.ts"]) {
    if (/redirect:\s*"follow"/.test(codeOf(read(...entry.split("/"))))) runtimeOffenders.push(entry);
  }
  assert.deepEqual(
    runtimeOffenders,
    [],
    `运行时不得再用 redirect:"follow"：${runtimeOffenders.join(", ")}`,
  );
});
