// 验收场景 5（specs/lsp-diagnostics-loop.md §7）：edit .ts 产生新增诊断回流单测——
// 写入含类型错误的 .ts → 钩子模型内容含 TS 诊断；再次写（无新增）不重复；
// 追加新错误只报新增；deferred 迟到诊断随下一次变更注入。
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  consumeDeferredDiagnostics,
  consumePendingModelContent,
  resetEditDiagnosticsState,
  runPostWriteDiagnostics,
  stashPendingModelContent,
} from "../src/lsp/edit-diagnostics-hook.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

function hookInput(resolvedPath: string, inputPath: string, content: string, workingDirectory: string) {
  return {
    resolvedPath,
    inputPath,
    content,
    workingDirectory,
    abortSignal: AbortSignal.timeout(30_000),
  };
}

test("edit loop: .ts write surfaces fresh diagnostics, dedupes repeats, reports only the delta", async () => {
  resetEditDiagnosticsState();
  const cwd = await makeTempDir("acode-lsp-edit-loop");
  try {
    const target = path.join(cwd, "broken.ts");
    const firstContent = "const value: number = \"not a number\";\nexport { value };\n";
    await fs.writeFile(target, firstContent, "utf8");

    // 第一次落盘：类型错误 → 模型内容含新增诊断行。
    const first = await runPostWriteDiagnostics(hookInput(target, target, firstContent, cwd));
    assert.ok(first, "P0 钩子产出诊断结果");
    assert.equal(first!.result.errored, true);
    assert.match(first!.result.summary, /error/);
    assert.ok(first!.modelContent, "有新增诊断 → 有模型内容");
    assert.match(first!.modelContent!, /broken\.ts:\d+:\d+ \[error\]/);
    assert.match(first!.result.summary, /typescript\(in-process\)|no issues|error/);

    // 模拟 handler 的挂起/消费：同键单发。
    stashPendingModelContent(target, first!.modelContent!);
    assert.ok(consumePendingModelContent(target));
    assert.equal(consumePendingModelContent(target), undefined, "单发：二次消费为空");

    // 第二次落盘同样内容：无新增诊断 → 无模型内容（不重复刷）。
    const second = await runPostWriteDiagnostics(hookInput(target, target, firstContent, cwd));
    assert.ok(second, "结果仍返回（server/summary 可用）");
    assert.equal(second!.modelContent, undefined, "无新增 → 无模型内容块");

    // 追加一个身份不同的新错误（TS2304 未定义名字 ≠ 已见的 TS2322 赋值错误）：
    // 去位置身份按消息文本判定，同文案不同行视作同一诊断（spec §2 的设计取舍）。
    const thirdContent = `${firstContent}export function useUndefined(): void { return undefinedMarker; }\n`;
    await fs.writeFile(target, thirdContent, "utf8");
    const third = await runPostWriteDiagnostics(hookInput(target, target, thirdContent, cwd));
    assert.ok(third?.modelContent, "新身份错误 → 有模型内容");
    assert.match(third!.modelContent!, /Cannot find name/);
    assert.doesNotMatch(third!.modelContent!, /not assignable/, "已见身份不再重复");
  } finally {
    resetEditDiagnosticsState();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("edit loop: deferred diagnostics are drained once on the next handler call", async () => {
  resetEditDiagnosticsState();
  const cwd = await makeTempDir("acode-lsp-deferred-loop");
  try {
    // 直接向 deferred 队列注入一条迟到诊断（writethrough 慢服务器路径的产物）。
    const owner = (await import("../src/lsp/deferred-diagnostics.js")).getDeferredDiagnosticsOwner(cwd);
    const handle = owner.deferred.begin(path.join(cwd, "late.ts"));
    handle.finalize(undefined);
    handle.onDeferredDiagnostics({
      server: "stub",
      messages: ["late.ts:2:2 [error] deferred boom"],
      summary: "1 error(s)",
      errored: true,
    });

    // edit/write handler 的接线点（handlers/edit.ts writeEditResult）在钩子后
    // drain；这里按同一顺序验证：drain 一次性取走全部积压，二次 drain 为空。
    const drainedOnce = consumeDeferredDiagnostics({ workingDirectory: cwd });
    assert.ok(drainedOnce, "迟到诊断被 drain");
    assert.match(drainedOnce!, /<system-reminder>/);
    assert.match(drainedOnce!, /late\.ts:2:2 \[error\] deferred boom/);
    const drainedTwice = consumeDeferredDiagnostics({ workingDirectory: cwd });
    assert.equal(drainedTwice, undefined, "单发：二次 drain 为空");
  } finally {
    resetEditDiagnosticsState();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("edit loop: non-TS files and disabled LSP produce no diagnostics", async () => {
  resetEditDiagnosticsState();
  const cwd = await makeTempDir("acode-lsp-plain");
  try {
    const target = path.join(cwd, "notes.md");
    await fs.writeFile(target, "# hello\n", "utf8");
    const outcome = await runPostWriteDiagnostics(hookInput(target, target, "# hello\n", cwd));
    assert.equal(outcome, undefined, "无适用服务器且非 .ts/.tsx → undefined");
  } finally {
    resetEditDiagnosticsState();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
