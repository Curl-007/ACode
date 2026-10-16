import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// specs/boot-placeholder.md 验收：payload 校验 fail-safe、默认骨架合成、argv 注入 round-trip、
// did-finish-load sync 重放、paint 源三方一致（main 常量 vs index.html 内联拷贝）、
// paint 三相位行为（head/body/sync + startup-ready 幂等守卫）。
const {
  BOOT_PLACEHOLDER_ARG_PREFIX,
  BOOT_PLACEHOLDER_MAX_SHAPES,
  BOOT_PLACEHOLDER_PAINT_SOURCE,
  attachBootPlaceholderWindow,
  buildBootPlaceholderArgument,
  buildBootPlaceholderSyncScript,
  parseBootPlaceholderArgv,
  resolveBootPlaceholderPayload,
  synthesizeDefaultBootPlaceholderFrame,
  validateBootPlaceholderFrame,
  validateBootPlaceholderShapes,
} = await import("../src/main/bootPlaceholder.ts");

const htmlSource = await readFile(new URL("../src/renderer/index.html", import.meta.url), "utf8");

/** 归一化：去全部空白 + 去悬挂逗号，令两份拷贝只比 token 序列（格式化工具安全）。 */
function normalizePaintSource(source) {
  return source.replace(/\s+/g, "").replace(/,\)/g, ")").replace(/,\}/g, "}").replace(/,]/g, "]");
}

function extractInlinePaintSource(html) {
  const start = html.indexOf("// acode-boot-placeholder-paint:start");
  const end = html.indexOf("// acode-boot-placeholder-paint:end");
  assert.ok(start >= 0 && end > start, "index.html 必须带 paint 源标记注释");
  let body = html.slice(start, end);
  body = body.slice(body.indexOf("\n") + 1);
  body = body.trim();
  const prefix = "var paintACodeBootPlaceholder =";
  assert.ok(body.startsWith(prefix), "内联拷贝必须以 var paintACodeBootPlaceholder = 开头");
  body = body.slice(prefix.length).trim();
  assert.ok(body.endsWith(";"), "内联拷贝赋值必须以分号结束");
  return body.slice(0, -1).trim();
}

function makeShape(overrides = {}) {
  return { top: 0.1, left: 0.2, width: 0.3, height: 0.4, radius: 0.01, ...overrides };
}

function makeFrame(overrides = {}) {
  return {
    shapes: [makeShape()],
    sidebarWidth: 0.22,
    collapsed: false,
    zoomFactor: 1,
    ...overrides,
  };
}

// ---------- 校验器（原版 hc/gc 同构语义） ----------

test("validateBootPlaceholderFrame 接受合法 frame 并原样保留 shapes", () => {
  const frame = makeFrame({ shapes: [makeShape(), makeShape({ top: 0.5 })] });
  assert.deepEqual(validateBootPlaceholderFrame(frame), frame);
});

test("validateBootPlaceholderFrame 对标量字段 fail-safe", () => {
  assert.equal(validateBootPlaceholderFrame(undefined), undefined);
  assert.equal(validateBootPlaceholderFrame(null), undefined);
  assert.equal(validateBootPlaceholderFrame("frame"), undefined);
  assert.equal(validateBootPlaceholderFrame(makeFrame({ sidebarWidth: -1 })), undefined);
  assert.equal(validateBootPlaceholderFrame(makeFrame({ sidebarWidth: 1e4 + 1 })), undefined);
  assert.equal(validateBootPlaceholderFrame(makeFrame({ sidebarWidth: Number.NaN })), undefined);
  assert.equal(validateBootPlaceholderFrame(makeFrame({ collapsed: "no" })), undefined);
  assert.equal(validateBootPlaceholderFrame(makeFrame({ zoomFactor: 0 })), undefined);
  assert.equal(validateBootPlaceholderFrame(makeFrame({ zoomFactor: Number.NaN })), undefined);
});

test("validateBootPlaceholderShapes 非法条目整组判无效、超上限截断", () => {
  assert.equal(validateBootPlaceholderShapes("not-an-array"), undefined);
  // shapes 非数组时 frame 仍成立，降级为空数组（原版 gc(t.shapes) ?? [] 同款）。
  assert.deepEqual(validateBootPlaceholderFrame(makeFrame({ shapes: undefined })).shapes, []);
  assert.equal(validateBootPlaceholderShapes([makeShape(), null]), undefined);
  assert.equal(validateBootPlaceholderShapes([makeShape({ radius: -0.1 })]), undefined);
  assert.equal(
    validateBootPlaceholderShapes([makeShape({ width: Number.POSITIVE_INFINITY })]),
    undefined,
  );
  const many = Array.from({ length: BOOT_PLACEHOLDER_MAX_SHAPES + 40 }, () => makeShape());
  assert.equal(validateBootPlaceholderShapes(many).length, BOOT_PLACEHOLDER_MAX_SHAPES);
});

// ---------- argv round-trip ----------

test("buildBootPlaceholderArgument / parseBootPlaceholderArgv round-trip", () => {
  const payload = resolveBootPlaceholderPayload({ persistedFrame: makeFrame() });
  const arg = buildBootPlaceholderArgument(payload);
  assert.ok(arg.startsWith(BOOT_PLACEHOLDER_ARG_PREFIX));
  assert.deepEqual(parseBootPlaceholderArgv(["--device-id=x", arg]), payload);
});

test("parseBootPlaceholderArgv 对缺失/损坏输入 fail-safe", () => {
  assert.equal(parseBootPlaceholderArgv([]), undefined);
  assert.equal(parseBootPlaceholderArgv(["--device-id=x"]), undefined);
  assert.equal(parseBootPlaceholderArgv([`${BOOT_PLACEHOLDER_ARG_PREFIX}{broken json`]), undefined);
  assert.equal(parseBootPlaceholderArgv([`${BOOT_PLACEHOLDER_ARG_PREFIX}"str"`]), undefined);
  // enabled 仅严格 true 才启用；frame 非法时置 undefined（绘制侧要求 enabled 必带 frame）。
  const parsed = parseBootPlaceholderArgv([
    `${BOOT_PLACEHOLDER_ARG_PREFIX}${JSON.stringify({ enabled: "yes", frame: { bogus: 1 } })}`,
  ]);
  assert.deepEqual(parsed, { enabled: false, frame: undefined });
});

// ---------- payload 构造 ----------

test("resolveBootPlaceholderPayload 无持久数据回退手工合成默认骨架", () => {
  const payload = resolveBootPlaceholderPayload({});
  assert.equal(payload.enabled, true);
  assert.deepEqual(payload.frame, synthesizeDefaultBootPlaceholderFrame());
});

test("resolveBootPlaceholderPayload 设置显式关闭时不启用且不带 frame", () => {
  assert.deepEqual(resolveBootPlaceholderPayload({ settingEnabled: false }), { enabled: false });
  // undefined（缺省）= 启用（spec §1 恒启用判定，唯一开关是设置）。
  assert.equal(resolveBootPlaceholderPayload({ settingEnabled: undefined }).enabled, true);
});

test("resolveBootPlaceholderPayload 持久化 frame 损坏时回退默认骨架", () => {
  const payload = resolveBootPlaceholderPayload({
    persistedFrame: { shapes: "broken", sidebarWidth: -5, collapsed: false, zoomFactor: 1 },
  });
  assert.deepEqual(payload.frame, synthesizeDefaultBootPlaceholderFrame());
});

test("合成默认骨架自校验通过且几何在比值域内", () => {
  const frame = synthesizeDefaultBootPlaceholderFrame();
  assert.deepEqual(validateBootPlaceholderFrame(frame), frame);
  assert.ok(frame.shapes.length > 0 && frame.shapes.length <= BOOT_PLACEHOLDER_MAX_SHAPES);
  assert.equal(frame.collapsed, false);
  assert.equal(frame.zoomFactor, 1);
  // 默认侧栏 264px / 参考视口 1200px。
  assert.equal(frame.sidebarWidth, 0.22);
  for (const shape of frame.shapes) {
    for (const value of Object.values(shape)) {
      assert.ok(value >= 0 && value <= 1, `默认骨架比值越界: ${value}`);
    }
  }
});

// ---------- sync 重放 attach ----------

function createFakeWebContents({ destroyed = false, zoomFactor = 1 } = {}) {
  const listeners = new Map();
  return {
    destroyed,
    zoomFactor,
    executed: [],
    isDestroyed() {
      return this.destroyed;
    },
    on(event, listener) {
      listeners.set(event, listener);
    },
    removeListener(event, listener) {
      if (listeners.get(event) === listener) {
        listeners.delete(event);
      }
    },
    executeJavaScript(code) {
      this.executed.push(code);
      return Promise.resolve();
    },
    fire(event) {
      listeners.get(event)?.();
    },
    hasListeners(event) {
      return listeners.has(event);
    },
  };
}

test("attachBootPlaceholderWindow 在 did-finish-load 以 sync 相位重放并带 shellZoomFactor", async () => {
  const webContents = createFakeWebContents({ zoomFactor: 1.25 });
  const payload = resolveBootPlaceholderPayload({ persistedFrame: makeFrame() });
  const dispose = attachBootPlaceholderWindow({
    webContents,
    resolvePayload: () => payload,
  });
  webContents.fire("did-finish-load");
  assert.equal(webContents.executed.length, 1);
  const script = webContents.executed[0];
  assert.equal(
    script,
    buildBootPlaceholderSyncScript({ ...payload, shellZoomFactor: 1.25 }),
    "重放脚本必须与 sync 脚本构造器产物一致",
  );
  assert.ok(script.includes('"sync"'), "sync 相位必须以 sync 重放");
  assert.ok(script.includes('"shellZoomFactor":1.25'), "重放需带当前 shell zoom");
  assert.ok(script.startsWith(`(${BOOT_PLACEHOLDER_PAINT_SOURCE})(`));
  dispose();
  assert.equal(webContents.hasListeners("did-finish-load"), false);
});

test("attachBootPlaceholderWindow 对销毁/未启用 payload 不重放", () => {
  const destroyed = createFakeWebContents();
  destroyed.destroyed = true;
  attachBootPlaceholderWindow({
    webContents: destroyed,
    resolvePayload: () => resolveBootPlaceholderPayload({}),
  });
  destroyed.fire("did-finish-load");
  assert.equal(destroyed.executed.length, 0);

  const disabled = createFakeWebContents();
  attachBootPlaceholderWindow({
    webContents: disabled,
    resolvePayload: () => ({ enabled: false }),
  });
  disabled.fire("did-finish-load");
  assert.equal(disabled.executed.length, 0);
});

// ---------- paint 源一致性 ----------

test("paint 源与 index.html 内联拷贝逐 token 一致（防单边漂移）", () => {
  const inline = extractInlinePaintSource(htmlSource);
  assert.equal(
    normalizePaintSource(inline),
    normalizePaintSource(BOOT_PLACEHOLDER_PAINT_SOURCE),
    "index.html 内联 paint 函数与 main 常量漂移了；两侧必须同步修改",
  );
});

test("index.html 保留两相位调用、startup-ready 协调与移除清理", () => {
  assert.ok(
    htmlSource.includes(
      'paintACodeBootPlaceholder(globalThis.__ACODE_BOOT_PLACEHOLDER__, "head");',
    ),
  );
  assert.ok(
    htmlSource.includes(
      'paintACodeBootPlaceholder(globalThis.__ACODE_BOOT_PLACEHOLDER__, "body");',
    ),
  );
  // 骨架容器先于 #root（首帧内容），移除挂进既有 startup-ready 清理定时器。
  assert.ok(
    htmlSource.indexOf('<div id="acode-boot-placeholder"') < htmlSource.indexOf('<div id="root">'),
  );
  assert.ok(htmlSource.includes('document.getElementById("acode-boot-placeholder")?.remove();'));
  assert.ok(htmlSource.includes("body.acode-startup-ready #acode-boot-placeholder"));
  assert.ok(htmlSource.includes("html[data-acode-boot-placeholder] #acode-boot-placeholder"));
  // CSP 红线：本特性不新增/放松任何 CSP 指令（内联脚本走既有 'unsafe-inline'）。
  const csp = htmlSource.match(/Content-Security-Policy"[^>]*content="([^"]+)"/);
  assert.ok(csp, "CSP meta 必须仍存在");
  assert.equal(
    (csp[1].match(/script-src[^;]*/)[0].match(/'unsafe-eval'|'unsafe-hashes'/g) ?? []).length,
    0,
    "不得因 boot placeholder 引入 unsafe-eval/unsafe-hashes 等新放松",
  );
});

// ---------- paint 三相位行为（vm + 手搓 DOM 替身执行共享源） ----------

function createStubElement() {
  const attributes = {};
  const styleValues = {};
  return {
    attributes,
    styleValues,
    style: {
      setProperty(name, value) {
        styleValues[name] = value;
      },
      removeProperty(name) {
        delete styleValues[name];
      },
    },
    setAttribute(name, value) {
      attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete attributes[name];
    },
    getAttribute(name) {
      return name in attributes ? attributes[name] : null;
    },
    hasAttribute(name) {
      return name in attributes;
    },
    children: [],
    set textContent(value) {
      if (value === "") {
        this.children.length = 0;
      }
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
}

function createPaintDom({ theme = "zai-dark", startupReady = false, withHost = true } = {}) {
  const root = createStubElement();
  const body = {
    classList: {
      contains: (name) => name === "acode-startup-ready" && startupReady,
    },
  };
  const host = withHost ? createStubElement() : null;
  const dom = {
    root,
    host,
    document: {
      documentElement: root,
      body,
      getElementById: (id) => (id === "acode-boot-placeholder-shapes" ? host : null),
      createElement: () => createStubElement(),
    },
    window: {
      innerWidth: 1200,
      innerHeight: 800,
      localStorage: { getItem: (key) => (key === "acode-theme" ? theme : null) },
      matchMedia: () => ({ matches: false }),
    },
  };
  dom.run = (placeholder, phase) => {
    const context = vm.createContext({ document: dom.document, window: dom.window, Math });
    return vm.runInContext(
      `(${BOOT_PLACEHOLDER_PAINT_SOURCE})(${JSON.stringify(placeholder)}, ${JSON.stringify(phase)})`,
      context,
    );
  };
  return dom;
}

const PAINT_PAYLOAD = Object.freeze(
  resolveBootPlaceholderPayload({
    persistedFrame: makeFrame({
      shapes: [makeShape({ top: 0.1, left: 0.02, width: 0.2, height: 0.05, radius: 0.01 })],
      sidebarWidth: 0.25,
    }),
  }),
);

test("head 相位：启用时置根属性/主题/侧栏宽度，宿主未就绪不画 shapes", () => {
  const dom = createPaintDom({ theme: "zai-light", withHost: false });
  dom.run(PAINT_PAYLOAD, "head");
  assert.equal(dom.root.attributes["data-acode-boot-placeholder"], "");
  assert.equal(dom.root.attributes["data-acode-boot-theme"], "light");
  assert.equal(dom.root.attributes["data-acode-boot-placeholder-frame"], "sidebar");
  assert.equal(dom.root.styleValues["--acode-boot-placeholder-sidebar-width"], `${0.25 * 1200}px`);
  assert.equal(dom.host, null);
});

test("head 相位：payload 缺失/未启用/无 frame 时完全 no-op", () => {
  for (const payload of [
    undefined,
    { enabled: false },
    { enabled: true },
    { enabled: "true", frame: PAINT_PAYLOAD.frame },
  ]) {
    const dom = createPaintDom();
    dom.run(payload, "head");
    assert.equal(dom.root.hasAttribute("data-acode-boot-placeholder"), false);
    assert.equal(dom.host.children.length, 0);
  }
});

test("head 相位：collapsed frame 不出侧栏 strip 但仍标记 frame", () => {
  const dom = createPaintDom({ withHost: false });
  dom.run(
    resolveBootPlaceholderPayload({
      persistedFrame: makeFrame({ collapsed: true, sidebarWidth: 0 }),
    }),
    "head",
  );
  assert.equal(dom.root.attributes["data-acode-boot-placeholder-frame"], "collapsed");
  assert.equal("--acode-boot-placeholder-sidebar-width" in dom.root.styleValues, false);
});

test("body 相位：head 已启用时按视口比值绘制全部 shapes", () => {
  const dom = createPaintDom({ withHost: false });
  dom.run(PAINT_PAYLOAD, "head");
  // 模拟解析进入 body：宿主节点就绪后重放 body 相位。
  const bodyDom = createPaintDom();
  bodyDom.root.attributes["data-acode-boot-placeholder"] = "";
  bodyDom.root.attributes["data-acode-boot-placeholder-frame"] = "sidebar";
  bodyDom.run(PAINT_PAYLOAD, "body");
  assert.equal(bodyDom.host.children.length, 1);
  const painted = bodyDom.host.children[0];
  assert.equal(painted.style.top, `${0.1 * 800}px`);
  assert.equal(painted.style.left, `${0.02 * 1200}px`);
  assert.equal(painted.style.width, `${0.2 * 1200}px`);
  assert.equal(painted.style.height, `${0.05 * 800}px`);
  assert.equal(painted.style.borderRadius, `${0.01 * 800}px`);
  // head 未启用时 body 相位不得凭空绘制。
  const inert = createPaintDom();
  inert.run(PAINT_PAYLOAD, "body");
  assert.equal(inert.host.children.length, 0);
});

test("sync 相位：按最新视口重绘（zoom 重放 settle 后对齐）", () => {
  const dom = createPaintDom({ withHost: false });
  dom.run(PAINT_PAYLOAD, "head");
  const syncDom = createPaintDom();
  syncDom.root.attributes["data-acode-boot-placeholder"] = "";
  syncDom.root.attributes["data-acode-boot-placeholder-frame"] = "sidebar";
  syncDom.root.styleValues["--acode-boot-placeholder-sidebar-width"] = "300px";
  // Chromium 在 did-finish-load 后重放 zoom：innerWidth 1200 → 960（zoom 1.25）。
  syncDom.window.innerWidth = 960;
  syncDom.run({ ...PAINT_PAYLOAD, shellZoomFactor: 1.25 }, "sync");
  assert.equal(
    syncDom.root.styleValues["--acode-boot-placeholder-sidebar-width"],
    `${0.25 * 960}px`,
  );
  assert.equal(syncDom.host.children.length, 1);
  assert.equal(syncDom.host.children[0].style.width, `${0.2 * 960}px`);
});

test("sync 相位：head 未启用或 startup-ready 后不得复活骨架", () => {
  // head 从未启用：sync 直接 no-op。
  const neverEnabled = createPaintDom();
  neverEnabled.run(PAINT_PAYLOAD, "sync");
  assert.equal(neverEnabled.root.hasAttribute("data-acode-boot-placeholder"), false);
  assert.equal(neverEnabled.host.children.length, 0);

  // startup-ready 已置位：清属性退出（骨架生命周期已结束）。
  const ready = createPaintDom({ startupReady: true });
  ready.root.attributes["data-acode-boot-placeholder"] = "";
  ready.root.attributes["data-acode-boot-placeholder-frame"] = "sidebar";
  ready.root.attributes["data-acode-boot-theme"] = "dark";
  ready.root.styleValues["--acode-boot-placeholder-sidebar-width"] = "300px";
  ready.host.children.push(createStubElement());
  ready.run(PAINT_PAYLOAD, "sync");
  assert.equal(ready.root.hasAttribute("data-acode-boot-placeholder"), false);
  assert.equal(ready.root.hasAttribute("data-acode-boot-placeholder-frame"), false);
  assert.equal(ready.root.hasAttribute("data-acode-boot-theme"), false);
});

test("paint 源内部异常不外抛（首帧脚本 fail-safe）", () => {
  const dom = createPaintDom();
  // localStorage 抛错（隐私模式替身）不得冒泡。
  dom.window.localStorage = {
    getItem() {
      throw new Error("denied");
    },
  };
  assert.doesNotThrow(() => dom.run(PAINT_PAYLOAD, "head"));
  assert.equal(dom.root.attributes["data-acode-boot-placeholder"], "");
  // 主题读取失败回退默认 dark（ui store 缺省 zai-dark 同语义）。
  assert.equal(dom.root.attributes["data-acode-boot-theme"], "dark");
});
