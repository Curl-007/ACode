// 市场 zip 解包 store 信任档守护测试（价值提取第二轮 T1-m3）。
// 规格：apps/acode-cli/specs/file-containment-trust-tiers.md R1；
//       packages/services/specs/file-containment-trust-tiers.md R3/R4。
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { buildZip } from "./helpers/build-zip.mjs";

const { resolveHttpZipSource } = await import("../packages/adapters/src/plugins/zip-source.ts");

async function serveZip(zipBuffer) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/zip" });
    response.end(zipBuffer);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  return {
    url: `http://127.0.0.1:${address.port}/plugin.zip`,
    async close() {
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

async function withZipSource(zipBuffer, run) {
  const served = await serveZip(zipBuffer);
  let resolved;
  try {
    resolved = await run(served.url);
    return resolved;
  } finally {
    await resolved?.cleanup?.();
    await served.close();
  }
}

test("垃圾条目跳过：__MACOSX/.DS_Store 不落盘且不污染单根判定", async () => {
  const zipBuffer = buildZip([
    { data: Buffer.from("{}"), name: "fixture-plugin/.acode-plugin/plugin.json" },
    { data: Buffer.from("# readme"), name: "fixture-plugin/README.md" },
    { data: Buffer.from("junk"), name: "fixture-plugin/.DS_Store" },
    { data: Buffer.from("junk"), name: "__MACOSX/fixture-plugin/._README.md" },
  ]);
  await withZipSource(zipBuffer, async (url) => {
    // 垃圾条目若计入顶层段，requireSingleRoot 会因 {fixture-plugin, __MACOSX} 双根拒绝。
    const resolved = await resolveHttpZipSource({ requireSingleRoot: true, stripRoot: true, url });
    try {
      assert.equal(
        await readFile(join(resolved.path, "README.md"), "utf8"),
        "# readme",
      );
      await assert.rejects(() => stat(join(resolved.path, ".DS_Store")));
      await assert.rejects(() => stat(join(resolved.path, "..", "__MACOSX")));
    } finally {
      await resolved.cleanup();
    }
  });
});

test("归一化碰撞：A.txt 与 a.txt 同档拒绝且无半成品残留", async () => {
  const zipBuffer = buildZip([
    { data: Buffer.from("upper"), name: "fixture/A.txt" },
    { data: Buffer.from("lower"), name: "fixture/a.txt" },
  ]);
  const served = await serveZip(zipBuffer);
  try {
    await assert.rejects(
      () => resolveHttpZipSource({ url: served.url }),
      /collide after filesystem name normalization|collide/iu,
    );
  } finally {
    await served.close();
  }
});

test("完全同名重复条目：后者生效（不拒绝）", async () => {
  const zipBuffer = buildZip([
    { data: Buffer.from("first"), name: "fixture/dup.txt" },
    { data: Buffer.from("second-larger"), name: "fixture/dup.txt" },
  ]);
  await withZipSource(zipBuffer, async (url) => {
    const resolved = await resolveHttpZipSource({ stripRoot: true, url });
    try {
      assert.equal(await readFile(join(resolved.path, "dup.txt"), "utf8"), "second-larger");
    } finally {
      await resolved.cleanup();
    }
  });
});

test("store 档不开比率闸：高压缩比条目不误杀（既有归档形态保留，钉住档位分配）", async () => {
  // 4MB 全零 deflate 后约 4KB，聚合/逐条目比率都远超 50:1——上游 plugin 档会误杀
  // 这类真实市场归档形态（既有回归归档实测 209:1），store 档比率闸刻意关闭。
  const zipBuffer = buildZip([
    { data: Buffer.alloc(4 * 1024 * 1024, 0), method: 8, name: "fixture/compressible.bin" },
  ]);
  await withZipSource(zipBuffer, async (url) => {
    const resolved = await resolveHttpZipSource({ stripRoot: true, url });
    try {
      const stats = await stat(join(resolved.path, "compressible.bin"));
      assert.equal(stats.size, 4 * 1024 * 1024);
    } finally {
      await resolved.cleanup();
    }
  });
});

test("单文件声明闸：谎报 51MB 的条目在读取任何数据前拒绝（既有 50MB 常量语义保留）", async () => {
  const zipBuffer = buildZip([
    {
      data: Buffer.from("tiny"),
      declaredUncompressedSize: 51 * 1024 * 1024,
      // deflate 形态绕开 yauzl 对 stored 条目"压缩=未压缩"的即时校验，
      // 让谎报尺寸到达会话的单文件声明闸（阶段一，先于任何数据读取）。
      method: 8,
      name: "fixture/lying.bin",
    },
  ]);
  const served = await serveZip(zipBuffer);
  try {
    await assert.rejects(
      () => resolveHttpZipSource({ url: served.url }),
      /single file limit/iu,
    );
  } finally {
    await served.close();
  }
});

test("条目长度上限：文件名 256 字符拒绝", async () => {
  const zipBuffer = buildZip([
    { data: Buffer.from("x"), name: `fixture/${"n".repeat(252)}.txt` },
  ]);
  const served = await serveZip(zipBuffer);
  try {
    await assert.rejects(
      () => resolveHttpZipSource({ url: served.url }),
      /filename too long/iu,
    );
  } finally {
    await served.close();
  }
});

test("store 档不禁嵌套归档：inner.zip 条目照常解包（既有语义保留）", async () => {
  const innerZip = buildZip([{ data: Buffer.from("inner"), name: "a.txt" }]);
  const zipBuffer = buildZip([
    { data: Buffer.from("{}"), name: "fixture/.acode-plugin/plugin.json" },
    { data: innerZip, name: "fixture/assets/inner.zip" },
  ]);
  await withZipSource(zipBuffer, async (url) => {
    const resolved = await resolveHttpZipSource({ url });
    try {
      const stats = await stat(join(resolved.path, "assets", "inner.zip"));
      assert.equal(stats.size, innerZip.length);
    } finally {
      await resolved.cleanup();
    }
  });
});

test(
  "可执行位策略：owner-exec 条目落盘 0o700，非 exec 条目无执行位",
  { skip: process.platform === "win32" ? "Windows 无 unix exec 位语义" : false },
  async () => {
    const zipBuffer = buildZip([
      { data: Buffer.from("#!/bin/sh"), name: "fixture/run.sh", unixMode: 0o100755 },
      { data: Buffer.from("notes"), name: "fixture/notes.md", unixMode: 0o100644 },
    ]);
    await withZipSource(zipBuffer, async (url) => {
      const resolved = await resolveHttpZipSource({ stripRoot: true, url });
      try {
        const execStats = await stat(join(resolved.path, "run.sh"));
        assert.equal(execStats.mode & 0o777, 0o700);
        const plainStats = await stat(join(resolved.path, "notes.md"));
        assert.equal(plainStats.mode & 0o111, 0);
      } finally {
        await resolved.cleanup();
      }
    });
  },
);

test("词法闸：.. 条目拒绝；反斜杠条目被解码层归一无逃逸（双保险）", async () => {
  // ".." 形态：yauzl 解码层 validateFileName 先拒（invalid relative path），
  // 会话词法闸是同规则的第二道保险（tar 等其他解码面依赖它）。
  const dotdotZip = buildZip([{ data: Buffer.from("x"), name: "fixture/../escape.txt" }]);
  const dotdotServed = await serveZip(dotdotZip);
  try {
    await assert.rejects(
      () => resolveHttpZipSource({ url: dotdotServed.url }),
      /unsafe|rejected|invalid relative path/iu,
    );
  } finally {
    await dotdotServed.close();
  }

  // 反斜杠形态：yauzl（strictFileNames=false）把 "\" 归一为 "/" 后才交给会话，
  // 条目按归一路径安全落盘——不产生字面反斜杠文件、不发生逃逸。
  const backslashZip = buildZip([{ data: Buffer.from("defanged"), name: "fixture\\evil.txt" }]);
  await withZipSource(backslashZip, async (url) => {
    const resolved = await resolveHttpZipSource({ stripRoot: true, url });
    try {
      assert.equal(await readFile(join(resolved.path, "evil.txt"), "utf8"), "defanged");
      await assert.rejects(() => stat(join(resolved.path, "fixture\\evil.txt")));
    } finally {
      await resolved.cleanup();
    }
  });
});

test("sha256 闸保留：校验和不匹配拒绝", async () => {
  const zipBuffer = buildZip([{ data: Buffer.from("x"), name: "fixture/a.txt" }]);
  const served = await serveZip(zipBuffer);
  try {
    await assert.rejects(
      () =>
        resolveHttpZipSource({
          sha256: "a".repeat(64),
          url: served.url,
        }),
      /sha256 mismatch/u,
    );
  } finally {
    await served.close();
  }
});
