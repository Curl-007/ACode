// auto 分类器批 2 验收（apps/acode-cli/specs/auto-mode-risk-classifier.md 第二批
// R8/R9/R10）：工具裁决注记（corpus + <tool-dossier> 块）、transcript 文件来源
// 台账（service/seam 喂入 + <transcript-provenance> 块 + 同步作用域退化形态）、
// 系统提示词三段增补 golden。真 PermissionService + stub 分类器端口。
import assert from "node:assert/strict";
import { test } from "node:test";

const classifier = await import("../packages/core/src/permission/auto-risk-classifier.ts");
const corpus = await import("../packages/core/src/permission/tool-adjudication-corpus.ts");
const ledger = await import("../packages/core/src/permission/file-provenance-ledger.ts");
const { PermissionService } = await import("../packages/core/src/permission/service.ts");

const WORKSPACE = "/tmp/auto-classifier-batch2-ws";

function makeService(extra = {}) {
  return new PermissionService({
    allowedTools: new Set(extra.allowedTools ?? []),
    disallowedTools: new Set(),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
  });
}

function ctx(toolName, input, mode, riskLevel, extra = {}) {
  return {
    toolName,
    input,
    riskLevel,
    mode,
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
    ...extra,
  };
}

// ── R8 工具裁决注记 ──────────────────────────────────────────────────────────

test("R8: 静态语料库三字段齐备且为英文；注册 API 覆盖生效、reset 还原", () => {
  const bash = corpus.getToolAdjudicationAnnotation("Bash");
  assert.ok(bash);
  assert.ok(bash.harm.length > 20);
  assert.equal(bash.recoverability, "conditional");
  assert.equal(bash.persistence, "durable");
  // 主要面覆盖：写族/网络/舰队/交互都在语料库
  for (const tool of [
    "Write",
    "Edit",
    "ApplyPatch",
    "Read",
    "WebFetch",
    "WebSearch",
    "DeleteSessions",
    "ArchiveSession",
    "StartSession",
    "SetSessionPermissionMode",
    "SaveWorkflow",
    "AskUserQuestion",
    "Skill",
  ]) {
    const annotation = corpus.getToolAdjudicationAnnotation(tool);
    assert.ok(annotation, `语料库缺 ${tool}`);
    assert.ok(
      ["recoverable", "conditional", "irreversible"].includes(annotation.recoverability),
      `${tool} recoverability 非法`,
    );
    assert.ok(
      ["transient", "session", "durable"].includes(annotation.persistence),
      `${tool} persistence 非法`,
    );
    // 恒英文（模型面，prompt-language-policy）
    for (const text of [annotation.harm, annotation.recoverabilityNote, annotation.persistenceNote]) {
      if (text) assert.equal(/[\u4e00-\u9fff]/.test(text), false, `${tool} 注记含中文`);
    }
  }
  // 注册 API 覆盖 + reset 还原静态语料
  corpus.registerToolAdjudicationAnnotation("Bash", {
    harm: "test override",
    recoverability: "irreversible",
    persistence: "transient",
  });
  assert.equal(corpus.getToolAdjudicationAnnotation("Bash").harm, "test override");
  corpus.resetToolAdjudicationAnnotationsForTest();
  assert.ok(corpus.getToolAdjudicationAnnotation("Bash").harm !== "test override");
});

test("R8: user message 含 <tool-dossier> 三字段；无注记工具不含块（零回归面）", () => {
  const withAnnotation = classifier.buildAutoRiskClassifierUserMessage({
    toolName: "Bash",
    riskLevel: "high",
    serializedInput: '{"command":"rm x"}',
    forensicWindow: "clean up the repo",
  });
  assert.ok(withAnnotation.includes("<tool-dossier>"));
  assert.ok(withAnnotation.includes("harm: "));
  assert.ok(withAnnotation.includes("recoverability: conditional"));
  assert.ok(withAnnotation.includes("persistence: durable"));
  assert.ok(withAnnotation.includes("</tool-dossier>"));
  const without = classifier.buildAutoRiskClassifierUserMessage({
    toolName: "SomeUnknownTool",
    riskLevel: "medium",
    serializedInput: "{}",
    forensicWindow: "",
  });
  assert.ok(!without.includes("<tool-dossier>"));
  // 第一批结构保留：<tool-call> 与 <recent-user-intent> 恒在
  assert.ok(without.includes("<tool-call>") && without.includes("<recent-user-intent>"));
});

// ── R9 transcript 文件来源台账 ───────────────────────────────────────────────

test("R9: service 终局 allow 喂台账（Write/Edit file_path；ApplyPatch 解析多文件）", () => {
  ledger.resetFileProvenanceLedgerForTest();
  const service = makeService({ allowedTools: ["Write", "Edit", "ApplyPatch"] });
  const base = { sessionId: "sess_prov" };
  // 路径必须在 workspace 内：越界写会被 pathEscapeWrite 熔断降 ask（那不是 allow，
  // 不喂台账——正是「ask 不喂」语义的一部分）。
  service.checkPermission(ctx("Write", { file_path: `${WORKSPACE}/a.ts` }, "build", "medium", base));
  service.checkPermission(ctx("Edit", { file_path: `${WORKSPACE}/b.ts` }, "build", "medium", base));
  service.checkPermission(
    ctx(
      "ApplyPatch",
      {
        patch_text: [
          "*** Begin Patch",
          `*** Add File: ${WORKSPACE}/new.ts`,
          "+x",
          `*** Update File: ${WORKSPACE}/old.ts`,
          "-a",
          "+b",
          `*** Delete File: ${WORKSPACE}/gone.ts`,
          "*** End Patch",
        ].join("\n"),
      },
      "build",
      "medium",
      base,
    ),
  );
  const entries = ledger.listTranscriptFileProvenance("sess_prov");
  const paths = entries.map((entry) => entry.path);
  assert.deepEqual(paths, [
    `${WORKSPACE}/a.ts`,
    `${WORKSPACE}/b.ts`,
    `${WORKSPACE}/new.ts`,
    `${WORKSPACE}/old.ts`,
  ]);
  // Delete File 行不建立来源（台账语义 = 创建/覆盖）
  assert.ok(!paths.includes(`${WORKSPACE}/gone.ts`));
  // ask/deny 不喂：未白名单的 Write（build → ask）不落台账
  const plain = makeService();
  plain.checkPermission(
    ctx("Write", { file_path: `${WORKSPACE}/ask.ts` }, "build", "medium", base),
  );
  assert.ok(
    !ledger
      .listTranscriptFileProvenance("sess_prov")
      .some((entry) => entry.path === `${WORKSPACE}/ask.ts`),
  );
  // 非写族工具 allow 不喂（Read）
  plain.checkPermission(ctx("Read", { file_path: `${WORKSPACE}/a.ts` }, "build", "low", base));
  assert.equal(
    ledger.listTranscriptFileProvenance("sess_prov").some((entry) => entry.tool === "Read"),
    false,
  );
});

test("R9: 台账上限逐首、跨 session 不串、extract 纯函数", () => {
  ledger.resetFileProvenanceLedgerForTest();
  for (let index = 0; index < ledger.FILE_PROVENANCE_MAX_ENTRIES_PER_SESSION + 100; index += 1) {
    ledger.recordTranscriptFileProvenance({
      sessionId: "sess_cap",
      path: `/ws/f${index}.ts`,
      tool: "Write",
    });
  }
  const entries = ledger.listTranscriptFileProvenance("sess_cap");
  assert.equal(entries.length, ledger.FILE_PROVENANCE_MAX_ENTRIES_PER_SESSION);
  assert.equal(entries.at(-1).path, `/ws/f${ledger.FILE_PROVENANCE_MAX_ENTRIES_PER_SESSION + 99}.ts`);
  assert.equal(ledger.listTranscriptFileProvenance("sess_other").length, 0);
  // 摘要只取最近 N 行
  const digest = ledger.buildTranscriptProvenanceDigest("sess_cap");
  assert.equal(digest.split("\n").length, ledger.FILE_PROVENANCE_DIGEST_MAX_LINES);
  // 空态/缺席态如实报
  assert.ok(ledger.buildTranscriptProvenanceDigest("sess_empty").includes("no files recorded"));
  assert.ok(ledger.buildTranscriptProvenanceDigest(undefined).includes("ledger unavailable"));
  // extract 纯函数：非法输入空数组
  assert.deepEqual(ledger.extractProvenancePaths("Write", {}), []);
  assert.deepEqual(ledger.extractProvenancePaths("Write", null), []);
  assert.deepEqual(ledger.extractProvenancePaths("Read", { file_path: "/x" }), []);
});

test("R9: 灰区接缝——provenance 块进 classify 请求；分类器 allow 重写喂台账", async () => {
  ledger.resetFileProvenanceLedgerForTest();
  ledger.recordTranscriptFileProvenance({
    sessionId: "sess_seam",
    path: `${WORKSPACE}/created-by-turn.ts`,
    tool: "Write",
  });
  let seenRequest;
  const stubClassifier = {
    async classify(request) {
      seenRequest = request;
      return {
        kind: "verdict",
        verdict: "allow",
        confidence: 0.95,
        reasonCode: "serves_stated_intent",
        reason: "test",
        via: "model",
      };
    },
  };
  const service = makeService();
  const grayDecision = service.checkPermission(
    ctx("Write", { file_path: `${WORKSPACE}/gray.ts` }, "auto", "medium", {
      sessionId: "sess_seam",
    }),
  );
  assert.equal(grayDecision.autoGrayZone, true, "前置条件：auto 下 Write 进灰区");
  const resolved = await classifier.resolveAutoGrayZoneDecision({
    classifier: stubClassifier,
    decision: grayDecision,
    mode: "auto",
    toolName: "Write",
    executionInput: { file_path: `${WORKSPACE}/gray.ts` },
    sessionId: "sess_seam",
    turnId: "turn_1",
    traceContext: { traceId: "t", spanId: "s", sessionId: "sess_seam", turnId: "turn_1" },
  });
  assert.equal(resolved.decision, "allow");
  assert.equal(resolved.ruleId, "auto.classifier.allow");
  // 请求携带 provenanceDigest（与同步作用域同源同值）
  assert.ok(seenRequest.provenanceDigest.includes(`${WORKSPACE}/created-by-turn.ts (Write)`));
  // 分类器 allow 重写喂台账（灰区 ask 不喂、allow 重写补喂，无双喂）
  const paths = ledger.listTranscriptFileProvenance("sess_seam").map((entry) => entry.path);
  assert.equal(paths.filter((path) => path === `${WORKSPACE}/gray.ts`).length, 1);
});

test("R9: 同步作用域——作用域内 builder 渲染台账行；缺席退化如实报（fail-safe 形态）", () => {
  // 作用域内：显式参数优先，其次作用域
  const scoped = classifier.runWithProvenanceScope("- /ws/x.ts (Write)", () =>
    classifier.buildAutoRiskClassifierUserMessage({
      toolName: "SomeUnknownTool",
      riskLevel: "medium",
      serializedInput: "{}",
      forensicWindow: "",
    }),
  );
  assert.ok(scoped.includes("<transcript-provenance>"));
  assert.ok(scoped.includes("- /ws/x.ts (Write)"));
  // 作用域外（无参数无作用域）：退化如实报「台账不可用」——rubric 据此从严
  const unscoped = classifier.buildAutoRiskClassifierUserMessage({
    toolName: "SomeUnknownTool",
    riskLevel: "medium",
    serializedInput: "{}",
    forensicWindow: "",
  });
  assert.ok(unscoped.includes("ledger unavailable"));
  // 作用域退出后恢复（嵌套不泄漏）
  classifier.runWithProvenanceScope("inner", () => {
    const nested = classifier.buildAutoRiskClassifierUserMessage({
      toolName: "T",
      riskLevel: "low",
      serializedInput: "{}",
      forensicWindow: "",
    });
    assert.ok(nested.includes("inner"));
  });
  const after = classifier.buildAutoRiskClassifierUserMessage({
    toolName: "T",
    riskLevel: "low",
    serializedInput: "{}",
    forensicWindow: "",
  });
  assert.ok(!after.includes("inner"));
});

// ── R10 系统提示词增补 ───────────────────────────────────────────────────────

test("R10: 系统提示词三段增补 golden + 第一批要素零回归 + 恒英文", () => {
  const prompt = classifier.AUTO_RISK_CLASSIFIER_SYSTEM_PROMPT;
  // 批 2 段 1：最后防线定位句 + 参数闭世界声明
  assert.ok(prompt.includes("last line of defense"));
  assert.ok(prompt.includes("assume nobody will review it after you"));
  assert.ok(prompt.includes("establishes nothing about what the user asked"));
  // 批 2 段 2：transcript 来源证据的破坏性分类
  assert.ok(prompt.includes("<transcript-provenance>"));
  assert.ok(prompt.includes("irreversible_destructive"));
  assert.ok(prompt.includes("never allow"));
  // 批 2 段 3：删除授权的建立与清除（点名 delete/remove/trash 才算）
  assert.ok(prompt.includes("delete, remove or"));
  assert.ok(prompt.includes("trash"));
  assert.ok(prompt.includes('"organize"'));
  assert.ok(prompt.includes('"clean up"'));
  assert.ok(prompt.includes("failed deletion attempt establishes"));
  assert.ok(prompt.includes("Authorization never carries over"));
  // 不可信数据声明覆盖新块
  assert.ok(prompt.includes("<tool-call>, <transcript-provenance> and <recent-user-intent>"));
  // 第一批要素零回归
  assert.ok(prompt.includes("UNTRUSTED DATA"));
  assert.ok(prompt.includes("not a conversation"));
  assert.ok(prompt.includes("Never guess allow"));
  assert.ok(prompt.includes("insufficient_evidence"));
  // 恒英文
  assert.equal(/[\u4e00-\u9fff]/.test(prompt), false, "分类器提示词恒英文");
});

test("不变量: sidecar 同步前缀（classify 到消息构造无 await）——作用域机制的结构前提", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const sidecar = readFileSync(
    fileURLToPath(
      new URL("../packages/core/src/runtime/methods/auto-risk-classifier-sidecar.ts", import.meta.url),
    ),
    "utf8",
  ).replace(/\r\n/g, "\n");
  // runClassifierSidecar 体内 buildClassifierMessages 必须先于首个 await 出现
  const body = sidecar.slice(sidecar.indexOf("async function runClassifierSidecar"));
  const buildIndex = body.indexOf("buildClassifierMessages(runtime, req)");
  const firstAwait = body.indexOf("await ");
  assert.ok(buildIndex > 0, "sidecar 不再经 buildClassifierMessages 构造消息");
  assert.ok(
    buildIndex < firstAwait,
    "同步前缀不变量被破坏：消息构造移到首个 await 之后，provenance 作用域将退化",
  );
});
