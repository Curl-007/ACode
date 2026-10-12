import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  extractAssistantVisualizeReferences,
  projectAssistantVisualizeReferences,
} from "../src/lib/assistantVisualizeReference.js";
import {
  buildVisualizationSandboxDocument,
  fetchVisualizationFragment,
  isOversizedVisualization,
  isVisualizationArtifactRow,
  parseVisualizationArtifactRef,
  VISUALIZATION_CHUNK_BYTES,
  VISUALIZATION_CSP_DIRECTIVE,
  VISUALIZATION_IFRAME_SANDBOX,
  VISUALIZATION_REF_PREFIX,
  type ReadVisualizationChunk,
  type VisualizationArtifactIdentity,
} from "../src/lib/visualizationSandbox.js";
import { VISUALIZATION_LIMITS } from "@acode/shared/acode-protocol-v4";
import type { ConversationVisualizationReadChunk } from "../src/v4/conversationRowContext.js";

/**
 * 对话内可视化卡片（specs/gen-ui-visualize-card.md）的安全回归守护。
 * 组件渲染没有 DOM 测试先例（包内测试全部是纯逻辑 node:test），这里守护同规格
 * 列出的可断言不变量：CSP 串、sandbox 能力面、ref 解析、正文剥离与分块读取纪律。
 */

const CSP_CDN_SOURCES = [
  "cdnjs.cloudflare.com",
  "esm.sh",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "fonts.bunny.net",
];

function chunk(
  bytes: Uint8Array,
  totalBytes: number,
  nextOffset: number | null,
): ConversationVisualizationReadChunk {
  return { bytes, mediaType: "text/html", totalBytes, nextOffset };
}

const encoder = new TextEncoder();

test("sandbox 能力面只有 allow-scripts，绝不出现 allow-same-origin", () => {
  assert.equal(VISUALIZATION_IFRAME_SANDBOX, "allow-scripts");
  assert.ok(!VISUALIZATION_IFRAME_SANDBOX.includes("allow-same-origin"));
  assert.ok(!VISUALIZATION_IFRAME_SANDBOX.includes("allow-popups"));
  assert.ok(!VISUALIZATION_IFRAME_SANDBOX.includes("allow-forms"));
  assert.ok(!VISUALIZATION_IFRAME_SANDBOX.includes("allow-top-navigation"));
});

test("CSP 拦截外联数据通道（connect-src 'none'）且默认全拒", () => {
  assert.ok(VISUALIZATION_CSP_DIRECTIVE.includes("default-src 'none'"));
  assert.ok(VISUALIZATION_CSP_DIRECTIVE.includes("connect-src 'none'"));
  assert.ok(VISUALIZATION_CSP_DIRECTIVE.includes("form-action 'none'"));
  assert.ok(VISUALIZATION_CSP_DIRECTIVE.includes("base-uri 'none'"));
  // 白名单 CDN 只出现在 script/style/img/font 四个面；connect 面不得携带任何主机。
  const connectDirective = VISUALIZATION_CSP_DIRECTIVE.split("; ").find((directive) =>
    directive.startsWith("connect-src"),
  );
  assert.equal(connectDirective, "connect-src 'none'");
  for (const source of CSP_CDN_SOURCES) {
    assert.ok(VISUALIZATION_CSP_DIRECTIVE.includes(source));
  }
});

test("沙箱文档注入 meta CSP、主题变量、widgetState shim 与高度上报脚本", () => {
  const document = buildVisualizationSandboxDocument(
    '<div id="app">hello</div>',
    "--background:#fff;--foreground:#111",
  );
  assert.ok(
    document.includes(
      `<meta http-equiv="Content-Security-Policy" content="${VISUALIZATION_CSP_DIRECTIVE}">`,
    ),
  );
  assert.ok(document.includes("--background:#fff;--foreground:#111"));
  assert.ok(document.includes("window.acodeViz"));
  assert.ok(document.includes("acode-viz-height"));
  // widgetState shim 必须先于 fragment，高度脚本必须在 fragment 之后（body 已存在）。
  assert.ok(document.indexOf("window.acodeViz") < document.indexOf('<div id="app">'));
  assert.ok(document.indexOf("acode-viz-height") > document.indexOf('<div id="app">'));
});

test("解析 visualization ref：sessionId/name 切分与形状校验", () => {
  assert.deepEqual(parseVisualizationArtifactRef(`${VISUALIZATION_REF_PREFIX}s1/chart-a`), {
    sessionId: "s1",
    name: "chart-a",
  });
  assert.deepEqual(parseVisualizationArtifactRef(`${VISUALIZATION_REF_PREFIX}s1/chart.a.b`), {
    sessionId: "s1",
    name: "chart.a.b",
  });
  // 大写 / 斜杠 / 空段 / 非 html 前缀都不认。
  assert.equal(parseVisualizationArtifactRef(`${VISUALIZATION_REF_PREFIX}s1/Bad`), null);
  assert.equal(parseVisualizationArtifactRef(`${VISUALIZATION_REF_PREFIX}s1/a/b`), null);
  assert.equal(parseVisualizationArtifactRef(`${VISUALIZATION_REF_PREFIX}s1/`), null);
  assert.equal(parseVisualizationArtifactRef(`${VISUALIZATION_REF_PREFIX}/x`), null);
  assert.equal(parseVisualizationArtifactRef("acode-artifact://s1/x"), null);
});

test("分派判据：只有 html + 可视化 ref 的 artifactRow 进沙箱卡", () => {
  const base = {
    rowId: 1,
    turnId: "t",
    createdAt: 0,
    createdAtSeq: 0,
    kind: "artifact",
    artifactVersionId: "v1",
    logicalArtifactKey: "k",
    displayName: "demo",
    mimeType: "text/html",
    sizeBytes: 3,
    sha256: "0".repeat(64),
    state: "current",
  } as const;
  assert.equal(
    isVisualizationArtifactRow({ ...base, artifactType: "html", ref: "acode-visualization://s/x" }),
    true,
  );
  assert.equal(
    isVisualizationArtifactRow({ ...base, artifactType: "pdf", ref: "acode-visualization://s/x" }),
    false,
  );
  assert.equal(
    isVisualizationArtifactRow({ ...base, artifactType: "html", ref: "acode-artifact://s/x" }),
    false,
  );
});

test("正文剥离：指令变等长空白且行结构保持，坏引用原样保留", () => {
  const content = [
    "第一段",
    '::visualize{"name":"chart-a","mode":"wide"}',
    "第二段",
    '::visualize{"name":"bad name"}',
    "结尾",
  ].join("\n");
  const references = extractAssistantVisualizeReferences(content);
  assert.equal(references.length, 1);
  assert.equal(references[0]?.name, "chart-a");
  assert.equal(references[0]?.mode, "wide");
  const projected = projectAssistantVisualizeReferences(content, { streaming: false });
  const lines = projected.visibleText.split("\n");
  // 指令行只剩空白；行数不变；非法 name 的指令按原文保留（与 CLI「降级可见」同语义）。
  assert.equal(lines.length, 5);
  assert.equal(lines[1]?.trim(), "");
  assert.equal(lines[1]?.length, '::visualize{"name":"chart-a","mode":"wide"}'.length);
  assert.equal(lines[3], '::visualize{"name":"bad name"}');
});

test("流式尾部：半截指令整体隐藏，代码块内的协议样例不参与解析", () => {
  const streamingTail = '说明文字\n::visualize{"name":"char';
  assert.equal(
    projectAssistantVisualizeReferences(streamingTail, { streaming: true }).visibleText,
    // 与 citation 的尾部语义一致：切到指令起点，指令前的换行保留。
    "说明文字\n",
  );
  const codeSample = '```html\n::visualize{"name":"chart-a"}\n```';
  assert.equal(extractAssistantVisualizeReferences(codeSample).length, 0);
  assert.equal(
    projectAssistantVisualizeReferences(codeSample, { streaming: false }).visibleText,
    codeSample,
  );
});

test("读取循环：多块拼装逐字节等于原片段，块参数按 512KiB 游标推进", async () => {
  const fragment = "图表内容 ABC-123，跨越两块。".repeat(60_000);
  const bytes = encoder.encode(fragment);
  assert.ok(bytes.byteLength > VISUALIZATION_CHUNK_BYTES);
  const calls: Array<{ offset: number; limit: number }> = [];
  const readChunk = async (params: { offset: number; limit: number }) => {
    calls.push({ offset: params.offset, limit: params.limit });
    const end = Math.min(params.offset + params.limit, bytes.byteLength);
    const nextOffset = end >= bytes.byteLength ? null : end;
    return chunk(bytes.subarray(params.offset, end), bytes.byteLength, nextOffset);
  };
  const settled = await fetchVisualizationFragment(
    readChunk,
    { sessionId: "s1", name: "chart-a" },
    new AbortController().signal,
  );
  assert.ok("fragment" in settled);
  if ("fragment" in settled) {
    assert.equal(settled.fragment, fragment);
  }
  // 游标逐块 +512KiB 推进，最后一块 nextOffset 收敛为 null。
  for (let index = 1; index < calls.length; index += 1) {
    assert.equal(calls[index]?.offset, calls[index - 1]?.offset! + VISUALIZATION_CHUNK_BYTES);
  }
  assert.equal(calls[0]?.offset, 0);
  assert.ok(calls.length >= 2);
});

test("读取循环：总字节超读取契约上限判 oversized，不再继续读第二块", async () => {
  let reads = 0;
  const readChunk = async () => {
    reads += 1;
    return chunk(new Uint8Array(16), VISUALIZATION_LIMITS.maxBytes + 1, 16);
  };
  // 上限以 shared 的读取契约为准（VISUALIZATION_LIMITS.maxBytes，与线上 schema 同源）；
  // 写入侧另有 1 MiB 拒收门（CLI 工具），读取端不重复铸阈值。
  assert.ok(isOversizedVisualization(VISUALIZATION_LIMITS.maxBytes + 1));
  assert.ok(!isOversizedVisualization(VISUALIZATION_LIMITS.maxBytes));
  const settled = await fetchVisualizationFragment(
    readChunk,
    { sessionId: "s1", name: "chart-a" },
    new AbortController().signal,
  );
  assert.ok("oversized" in settled);
  assert.equal(reads, 1);
});

test("读取循环：读取失败抛错（卡片据此进 loadFailed 降级态）", async () => {
  const readChunk = async () => {
    throw new Error("fault.visualization.readUnavailable");
  };
  await assert.rejects(
    fetchVisualizationFragment(
      readChunk,
      { sessionId: "s1", name: "chart-a" },
      new AbortController().signal,
    ),
    { message: "fault.visualization.readUnavailable" },
  );
});

/**
 * 读取 effect 收敛守护（specs/gen-ui-visualize-card.md「读取 effect 的收敛纪律」）。
 *
 * 背景：`parseVisualizationArtifactRef(row.ref)` 每次调用都返回**全新**的
 * `{ sessionId, name }` 对象字面量（本文件上方的解析测试即证），引用天然不稳定。
 * 组件在渲染体里直接派生 `identity` 并放进读取 effect 依赖数组时，React 逐元素
 * `Object.is` 比对必然每轮不等 → effect 每次渲染都重跑 → cleanup 中断在途
 * `conversationVisualizationRead` + `setState({phase:"loading"})`（新字面量，无法 bail）
 * 触发下一次渲染，形成没有不动点的活锁：iframe 永远停在 loading、字节缓存永不填充、
 * RPC 以渲染速率无界洪泛。修复是把 `identity` 用 `useMemo`（键 row.ref）稳定。
 *
 * 仓库无 DOM / 组件渲染测试环境（无 jsdom / react-test-renderer），故拆两层钉住：
 * 结构守护（读真实组件源码，red-before/green-after）+ 机制证明（下方，驱动真实
 * fetchVisualizationFragment 跑一遍 React 提交循环）。
 */
const VIZ_ROW_SOURCE = readFileSync(
  new URL("../src/v4/VisualizationArtifactRow.tsx", import.meta.url),
  "utf8",
);

test("组件把派生的 identity 用 useMemo（键 row.ref）稳定，不在渲染体裸铸新对象", () => {
  // 裸调用形态 = 每次渲染新引用 = 读取 effect 依赖永不 Object.is 相等。这条必须消失。
  assert.ok(
    !/const identity = parseVisualizationArtifactRef\(row\.ref\);/u.test(VIZ_ROW_SOURCE),
    "identity 不得在渲染体裸调用 parseVisualizationArtifactRef（引用不稳定→读取 effect 无限重跑）",
  );
  // 稳定形态：useMemo 键在稳定原语 row.ref 上。
  assert.match(
    VIZ_ROW_SOURCE,
    /const identity = useMemo\(\s*\(\) => parseVisualizationArtifactRef\(row\.ref\),\s*\[row\.ref\],?\s*\);/u,
    "identity 必须经 useMemo(键 row.ref) 稳定，读取 effect 依赖才有不动点",
  );
});

test("读取 effect 依赖数组由稳定项构成（cacheKey / readChunk / retryCount），且 identity 已稳定", () => {
  // 依赖数组仍是 [cacheKey, identity, readChunk, retryCount]（identity 在 effect 体内被使用，
  // exhaustive-deps 要求它在列）；收敛性由 identity 已被 useMemo 稳定来保证——上一条钉住。
  // 这里再钉一次依赖数组本身没有被改成把不稳定项混进来。
  const depArray = VIZ_ROW_SOURCE.match(/\}, \[([^\]]*cacheKey[^\]]*)\]\);/u);
  assert.ok(depArray, "找不到读取 effect 的依赖数组——本断言前提变了，请重新核对组件源码");
  const deps = (depArray[1] ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  for (const dep of deps) {
    assert.ok(
      ["cacheKey", "identity", "readChunk", "retryCount"].includes(dep),
      `读取 effect 依赖出现意外项 "${dep}"；只允许 cacheKey/identity(已 memo)/readChunk/retryCount`,
    );
  }
});

/**
 * 机制证明：用**真实** parseVisualizationArtifactRef + fetchVisualizationFragment 跑一遍
 * React 提交循环的最小忠实模拟——deps 按 Object.is 逐元素比对，任一不等即先跑上一轮
 * cleanup（abort 在途读）再跑新 effect；effect 里 setState 新对象字面量必触发下一次渲染。
 * 对照两种 identity 策略：不稳定（裸调用，bug 形态）vs 稳定（useMemo，修复形态）。
 * readChunk 走宏任务（setTimeout 0）模拟真实 stdio/IPC 往返，让同步渲染循环的 cleanup
 * 有机会在读到字节前 abort——这正是线上「abort 总比 resolve 先到」的时序。
 */
function simulateReadEffectLoop(opts: {
  stabilizeIdentity: boolean;
}): Promise<{ renders: number; rpcCalls: number; abortedCalls: number; phase: string }> {
  const ref = `${VISUALIZATION_REF_PREFIX}session-abc/chart-a`;
  const counters = { rpcCalls: 0, abortedCalls: 0 };
  const readChunk: ReadVisualizationChunk = async ({ signal }) => {
    counters.rpcCalls += 1;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, 0);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const bytes = encoder.encode("<p>hello</p>");
    return chunk(bytes, bytes.byteLength, null);
  };

  // useMemo 稳定的那一份 identity（stabilize 时全程复用同一引用）。
  const stableIdentity = parseVisualizationArtifactRef(ref);
  let fragmentCache: { key: string; fragment: string } | null = null;
  let phase = "loading";
  let prevCleanup: (() => void) | null = null;

  const CAP = 60;
  let renders = 0;
  let prevDeps: unknown[] | null = null;
  let converged = false;

  while (renders < CAP) {
    renders += 1;
    const identity: VisualizationArtifactIdentity | null = opts.stabilizeIdentity
      ? stableIdentity
      : parseVisualizationArtifactRef(ref);
    const cacheKey = identity ? `${identity.sessionId}/${identity.name}` : null;
    const deps: unknown[] = [cacheKey, identity, readChunk, 0 /* retryCount */];
    const changed =
      prevDeps === null || deps.some((dep, index) => !Object.is(dep, prevDeps?.[index]));
    if (!changed) {
      converged = true; // 依赖相等 → effect 不重跑 → 循环收敛
      break;
    }
    if (prevCleanup) prevCleanup();

    // effect 体（对齐组件 L103-136）
    if (!identity || cacheKey === null) {
      prevCleanup = null;
      prevDeps = deps;
      converged = true;
      break;
    }
    const cached = fragmentCache;
    if (cached && cached.key === cacheKey) {
      phase = "ready";
      prevCleanup = null;
      prevDeps = deps;
      converged = true;
      break;
    }
    const controller = new AbortController();
    let cancelled = false;
    let inFlight = true;
    phase = "loading"; // setState({phase:"loading"}) 新字面量 → 必触发下一次渲染
    void fetchVisualizationFragment(readChunk, identity, controller.signal).then(
      (result) => {
        inFlight = false;
        if (cancelled) return;
        if ("oversized" in result) {
          phase = "oversized";
          return;
        }
        fragmentCache = { key: cacheKey, fragment: result.fragment };
        phase = "ready";
      },
      () => {
        inFlight = false;
        if (cancelled) return;
        phase = "failed";
      },
    );
    prevCleanup = () => {
      cancelled = true;
      controller.abort();
      if (inFlight) counters.abortedCalls += 1;
    };
    prevDeps = deps;
  }

  // 打到 CAP 仍未收敛 = 真实场景里的无界活锁：下一轮渲染的 cleanup 会继续 abort 当前在途读。
  // 模拟被 CAP 截断，这里补跑那次 cleanup，忠实还原「abort 总比 resolve 先到、缓存永不填充」。
  if (!converged && prevCleanup) prevCleanup();

  // 排空宏任务：只有收敛（stable）分支还有一个活着的读会 resolve 到 ready。
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ renders, rpcCalls: counters.rpcCalls, abortedCalls: counters.abortedCalls, phase });
    }, 10);
  });
}

test("机制证明：identity 引用不稳定 → 读取 effect 无界重跑 + RPC 洪泛 + 永不到 ready", async () => {
  const unstable = await simulateReadEffectLoop({ stabilizeIdentity: false });
  // 没有不动点：渲染打到 CAP、每次渲染发一次读、每次 cleanup 都把在途读 abort 掉。
  assert.ok(unstable.renders >= 60, `应无界重渲染，实际 renders=${unstable.renders}`);
  assert.ok(
    unstable.rpcCalls >= 60,
    `应无界洪泛 conversationVisualizationRead，实际=${unstable.rpcCalls}`,
  );
  assert.equal(
    unstable.abortedCalls,
    unstable.rpcCalls,
    "每次在途读都被下一轮 cleanup abort（abort 总比 resolve 先到）——与实测 abortedCalls===rpcCalls 一致",
  );
  assert.equal(
    unstable.phase,
    "loading",
    "字节缓存永不填充，卡片永远停在 loading（iframe 不渲染）",
  );
});

test("机制证明：identity 经 useMemo 稳定 → 收敛到 ready，只读一次，无 abort 洪泛", async () => {
  const stable = await simulateReadEffectLoop({ stabilizeIdentity: true });
  // 首轮 setState(loading) 触发第二轮渲染；第二轮 deps Object.is 相等 → effect 不重跑 → 收敛。
  assert.equal(stable.renders, 2, `应两轮内收敛，实际 renders=${stable.renders}`);
  assert.equal(stable.rpcCalls, 1, "同一 row.ref 只读一次");
  assert.equal(stable.abortedCalls, 0, "收敛路径不 abort 任何在途读");
  assert.equal(stable.phase, "ready", "读到字节后到达 ready（iframe 得以渲染）");
});
