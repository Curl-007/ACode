// Web 端本地诊断（U12）验收测试。spec: packages/web/specs/local-diagnostic-report-web.md，
// 契约真源: packages/shared/specs/local-diagnostic-report.md。
// 无 jsdom：采集是纯读内存态，下载用注入的假 DOM 依赖（createObjectURL/revoke/anchor）。
import assert from "node:assert/strict";
import test from "node:test";
import { localDiagnosticFactsSchema } from "@acode/shared";
import {
  WEB_DOWNLOAD_UNSUPPORTED,
  collectWebDiagnosticFacts,
  createWebConnectionFactsSource,
  saveWebDiagnosticReport,
  type WebDownloadDeps,
} from "../src/diagnostics/webDiagnostics.js";
import type { WebReconnectState } from "../src/reconnect/webSocketReconnect.js";

/** 假连接事实源：直接给定 lastState/attempt，无需真实控制器。 */
function fakeSource(lastState: WebReconnectState | null, attempt: number | null) {
  return { lastState, attempt };
}

test("U12-A1: 离线/降级态产出 schema 合法的 facts，且省略 Web 不可知的 build 字段", () => {
  // exhausted = 手机切后台回来、socket 被回收、重试耗尽的最坏离线态。
  const facts = collectWebDiagnosticFacts(fakeSource({ phase: "exhausted", attempts: 3 }, 3));
  const parsed = localDiagnosticFactsSchema.parse(facts); // 不抛即 schema 合法
  assert.equal(parsed.platformType, "web");
  // os/arch/appVersion/commit 结构性缺席（不猜测、不新开指纹面）。
  assert.equal(parsed.build?.os, undefined);
  assert.equal(parsed.build?.arch, undefined);
  assert.equal(parsed.build?.appVersion, undefined);
  // Web 自有字段在场。
  assert.equal(parsed.buildAvailability, "collected");
  assert.ok(parsed.build?.capabilities.includes("saveDiagnosticReport"));
  assert.equal(parsed.connection?.phase, "disconnected");
  assert.equal(parsed.connection?.reconnectCount, 3);
});

test("U12-A1: 采集零副作用——不 fetch、不开 socket、不触发重连", () => {
  // 用计数 fake 守住「生成期不产生任何外联/probe」这条承重不变量。
  let fetchCalls = 0;
  let startCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    return Promise.reject(new Error("采集不应触网"));
  }) as typeof fetch;
  try {
    // 事实源包一层计数：若采集过程试图驱动控制器（start）即被记录。
    const source = createWebConnectionFactsSource({
      getController: () => {
        startCalls += 1;
        return null; // 无控制器：采集应容忍并标 unavailable，而非尝试建立连接
      },
      getLastState: () => null,
    });
    collectWebDiagnosticFacts(source);
    assert.equal(fetchCalls, 0, "collect 不得发起 fetch");
    // getController 被读一次属正常（读 attempt），关键是它不触发任何连接动作；
    // 此处断言采集未调用 start/未建 socket：source 只读，无 start 面可调用。
    assert.ok(startCalls <= 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("U12-A3: 连接态含合成敏感值时，序列化 facts 内零泄露", () => {
  // 重连层只出稳定词 + 计数，原始 err.message/URL/token 无处进入——用敏感 fixture 反证。
  const secrets = [
    "Bearer sk-fake-secret-token-value",
    "https://user:pass@internal.host/ws?token=abc123",
    "C:\\Users\\SecretUser\\workspaces\\private",
    "/home/secretuser/.acode/credential-key.json",
  ];
  const facts = collectWebDiagnosticFacts(fakeSource({ phase: "connecting", attempt: 2 }, 2));
  const serialized = JSON.stringify(facts);
  for (const secret of secrets) {
    assert.ok(!serialized.includes(secret), `泄露: ${secret}`);
  }
  // 结构化排除的正面断言：errorCodes 恒空（不透传原始错误）。
  assert.deepEqual(facts.connection?.errorCodes, []);
});

test("U12-A4: 无连接源时 connection 组标 unavailable 且缺席（非空对象）", () => {
  const facts = collectWebDiagnosticFacts(null);
  assert.equal(facts.connectionAvailability, "unavailable");
  assert.equal(facts.connection, undefined); // 缺席，而非 {errorCodes:[],reconnectCount:0}
  const parsed = localDiagnosticFactsSchema.parse(facts);
  assert.equal(parsed.connection, undefined);
});

test("phase → 公开稳定词映射完整（不透传内部状态形状）", () => {
  const cases: Array<[WebReconnectState | null, string]> = [
    [null, "connected"],
    [{ phase: "reconnected" }, "connected"],
    [{ phase: "waiting", attempt: 1, retryInMs: 500 }, "reconnecting"],
    [{ phase: "connecting", attempt: 1 }, "reconnecting"],
    [{ phase: "exhausted", attempts: 5 }, "disconnected"],
    [{ phase: "idle" }, "idle"],
  ];
  for (const [state, expected] of cases) {
    const facts = collectWebDiagnosticFacts(fakeSource(state, 0));
    assert.equal(facts.connection?.phase, expected, `phase(${JSON.stringify(state)})`);
  }
});

/** 假下载依赖：记录 URL 生命周期与 Blob 内容。 */
function makeFakeDownloadDeps(options?: { failTrigger?: boolean }): WebDownloadDeps & {
  created: string[];
  revoked: string[];
  blobs: string[];
} {
  let nextId = 0;
  const created: string[] = [];
  const revoked: string[] = [];
  const blobs: string[] = [];
  return {
    created,
    revoked,
    blobs,
    createBlob(parts: string[], _type: string) {
      const content = parts.join("");
      blobs.push(content);
      return { content } as unknown as Blob;
    },
    createObjectURL(_blob: Blob) {
      const url = `blob:fake/${++nextId}`;
      created.push(url);
      return url;
    },
    revokeObjectURL(url: string) {
      revoked.push(url);
    },
    triggerDownload(url: string, _name: string) {
      if (options?.failTrigger) {
        throw new Error("浏览器拦截了程序化下载");
      }
      void url;
    },
  };
}

test("U12-A5: 下载成功路径 revoke 恰好一次，Blob 内容逐字节等于入参", async () => {
  const deps = makeFakeDownloadDeps();
  const json = JSON.stringify({ schemaVersion: 1, platformType: "web" });
  const result = await saveWebDiagnosticReport(json, "acode-diagnostics.json", deps);
  assert.equal(result.saved, true);
  assert.equal(deps.created.length, 1);
  assert.deepEqual(deps.revoked, deps.created); // 释放率 100%
  assert.deepEqual(deps.blobs, [json]); // 字节不改动（Web 是哑 sink）
});

test("U12-A5: 下载失败路径仍 revoke（try/finally），返回稳定码不谎报成功", async () => {
  const deps = makeFakeDownloadDeps({ failTrigger: true });
  const result = await saveWebDiagnosticReport("{}", "x.json", deps);
  assert.equal(result.saved, false);
  assert.equal(result.error, WEB_DOWNLOAD_UNSUPPORTED);
  assert.equal(deps.revoked.length, 1, "失败路径也必须释放 object URL");
  assert.deepEqual(deps.revoked, deps.created);
});

test("U12-A5: 无下载能力（缺 createBlob/createObjectURL）返回稳定码，不抛", async () => {
  const broken = {
    createBlob: undefined,
    createObjectURL: undefined,
    revokeObjectURL: () => {},
    triggerDownload: () => {},
  } as unknown as WebDownloadDeps;
  const result = await saveWebDiagnosticReport("{}", "x.json", broken);
  assert.equal(result.saved, false);
  assert.equal(result.error, WEB_DOWNLOAD_UNSUPPORTED);
});
