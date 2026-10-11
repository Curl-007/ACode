import assert from "node:assert/strict";
import { test } from "node:test";

// specs/embedded-browser-site-permissions.md 验收 4 与 store 模板纪律：
// 读写 round-trip、损坏文件隔离后按空表继续、tmp-uuid rename 原子写与失败清理。
const { EmbeddedBrowserSitePermissionStore } =
  await import("../src/main/browserView/embeddedBrowserSitePermissionStore.ts");

class MemoryFs {
  constructor(initial = {}) {
    this.files = new Map(Object.entries(initial));
    this.ops = [];
    this.failNextRename = false;
  }
  async mkdir() {
    this.ops.push(["mkdir"]);
  }
  async readFile(path) {
    if (!this.files.has(path)) {
      const error = new Error(`ENOENT: ${path}`);
      error.code = "ENOENT";
      throw error;
    }
    return Buffer.from(this.files.get(path), "utf8");
  }
  async writeFile(path, data, options) {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    if (options?.flag === "wx" && this.files.has(path)) {
      const error = new Error(`EEXIST: ${path}`);
      error.code = "EEXIST";
      throw error;
    }
    this.ops.push(["writeFile", path]);
    this.files.set(path, text);
  }
  async rename(from, to) {
    if (this.failNextRename) {
      this.failNextRename = false;
      throw new Error("simulated rename crash");
    }
    if (!this.files.has(from)) {
      const error = new Error(`ENOENT: ${from}`);
      error.code = "ENOENT";
      throw error;
    }
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
    this.ops.push(["rename", from, to]);
  }
  async unlink(path) {
    if (this.files.has(path)) {
      this.files.delete(path);
      this.ops.push(["unlink", path]);
    }
  }
  async rm(path) {
    if (this.files.has(path)) {
      this.files.delete(path);
      this.ops.push(["rm", path]);
    }
  }
}

const STORE_PATH = "/userdata/embedded-browser-site-permissions.json";

test("setDecision/readTable round-trip：嵌套 origin → permission 表整体读写", async () => {
  const fs = new MemoryFs({ [STORE_PATH]: "{}" });
  const store = new EmbeddedBrowserSitePermissionStore(STORE_PATH, { fs });

  await store.setDecision("https://a.example", "camera", "allow");
  await store.setDecision("https://a.example", "notifications", "deny");
  await store.setDecision("https://b.example", "midi", "allow");

  assert.deepEqual(await store.readTable(), {
    "https://a.example": { camera: "allow", notifications: "deny" },
    "https://b.example": { midi: "allow" },
  });

  // 落盘形状与 spec 一致：{ [origin]: { [permission]: "allow" | "deny" } }
  const persisted = JSON.parse(fs.files.get(STORE_PATH));
  assert.deepEqual(persisted["https://a.example"], { camera: "allow", notifications: "deny" });
});

test("resetDecision 删单条并回收空 origin；clearAll 清空", async () => {
  const fs = new MemoryFs();
  const store = new EmbeddedBrowserSitePermissionStore(STORE_PATH, { fs });
  await store.setDecision("https://a.example", "camera", "allow");
  await store.setDecision("https://a.example", "midi", "allow");
  await store.setDecision("https://b.example", "camera", "deny");

  await store.resetDecision("https://a.example", "camera");
  assert.deepEqual(await store.readTable(), {
    "https://a.example": { midi: "allow" },
    "https://b.example": { camera: "deny" },
  });
  await store.resetDecision("https://a.example", "midi");
  assert.deepEqual(await store.readTable(), { "https://b.example": { camera: "deny" } });

  await store.clearAll();
  assert.deepEqual(await store.readTable(), {});
});

test("损坏文件隔离到 .corrupt-<ts> 并按空表继续，不抛错", async () => {
  const warnings = [];
  const fs = new MemoryFs({ [STORE_PATH]: "not-json{{{" });
  const store = new EmbeddedBrowserSitePermissionStore(STORE_PATH, {
    fs,
    now: () => 1700000000000,
    onWarning: (message) => warnings.push(message),
  });

  assert.deepEqual(await store.readTable(), {});
  assert.equal(fs.files.has(`${STORE_PATH}.corrupt-1700000000000`), true, "损坏文件必须被隔离");
  assert.equal(fs.files.has(STORE_PATH), false, "原路径不得残留损坏内容");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /隔离/);

  // 隔离后写入照常工作（下一次 mutation 重建合法文件）。
  await store.setDecision("https://a.example", "camera", "allow");
  assert.deepEqual(await store.readTable(), { "https://a.example": { camera: "allow" } });
});

test("非法表形状（半合法值）同样按损坏隔离，不进入判定链", async () => {
  const warnings = [];
  const fs = new MemoryFs({
    [STORE_PATH]: JSON.stringify({ "https://a.example": { camera: "maybe" } }),
  });
  const store = new EmbeddedBrowserSitePermissionStore(STORE_PATH, {
    fs,
    now: () => 1,
    onWarning: (message) => warnings.push(message),
  });
  assert.deepEqual(await store.readTable(), {});
  assert.equal(warnings.length, 1);
});

test("原子写：tmp-uuid 中转 rename；rename 失败时清 tmp 且不动原文件", async () => {
  const initial = JSON.stringify({ "https://a.example": { camera: "allow" } });
  const fs = new MemoryFs({ [STORE_PATH]: initial });
  const store = new EmbeddedBrowserSitePermissionStore(STORE_PATH, { fs });

  fs.failNextRename = true;
  await assert.rejects(() => store.setDecision("https://b.example", "camera", "deny"));

  // 原文件未被半成品覆盖。
  assert.equal(fs.files.get(STORE_PATH), initial);
  // tmp 文件被清理，不残留。
  const staleTmp = [...fs.files.keys()].filter((key) => key.includes(".tmp-"));
  assert.equal(staleTmp.length, 0);

  // 恢复后正常写入且走 tmp → rename 路径。
  await store.setDecision("https://b.example", "camera", "deny");
  const renames = fs.ops.filter(([op]) => op === "rename");
  assert.equal(renames.length, 1);
  assert.match(renames[0][1], /\.tmp-[0-9a-f-]{36}$/u, "中转文件必须是 tmp-uuid 命名");
  assert.deepEqual(JSON.parse(fs.files.get(STORE_PATH))["https://b.example"], { camera: "deny" });
});

test("whenIdle 退出屏障：排队的 mutation 全部落盘后才返回", async () => {
  const fs = new MemoryFs();
  const store = new EmbeddedBrowserSitePermissionStore(STORE_PATH, { fs });
  const writes = [];
  for (let index = 0; index < 5; index += 1) {
    void store.setDecision(`https://s${index}.example`, "camera", "allow");
    writes.push(index);
  }
  await store.whenIdle();
  const persisted = JSON.parse(fs.files.get(STORE_PATH));
  assert.equal(Object.keys(persisted).length, writes.length);
});

test("getCachedTable：加载前 null（fail-closed），加载后是隔离副本", async () => {
  const fs = new MemoryFs();
  const store = new EmbeddedBrowserSitePermissionStore(STORE_PATH, { fs });
  assert.equal(store.getCachedTable(), null, "首次加载前没有快照");

  await store.setDecision("https://a.example", "camera", "allow");
  const cached = store.getCachedTable();
  assert.deepEqual(cached, { "https://a.example": { camera: "allow" } });

  // 副本隔离：改返回值不得影响 store 内部状态。
  cached["https://a.example"]["camera"] = "deny";
  assert.deepEqual(await store.readTable(), { "https://a.example": { camera: "allow" } });
});
