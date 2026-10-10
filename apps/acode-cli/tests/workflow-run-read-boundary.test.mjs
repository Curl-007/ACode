import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

const readModel = await import("../packages/workflow-run-read/src/index.ts");

test("W1-R1: run read model exposes pure label and lineage projections", () => {
  assert.deepEqual(
    readModel.resolveDynamicWorkflowRunLabel({
      runId: "run_1",
      scriptText: "\n  first line\nsecond line",
    }),
    { label: "first line", labelSource: "script" },
  );
  assert.deepEqual(readModel.lineageFields("run_parent", undefined), { resumedFrom: "run_parent" });
  assert.equal(
    readModel.supersededByOf(undefined, { status: "completed", supersededBy: "run_fake" }),
    undefined,
  );
  assert.equal(
    readModel.supersededByOf(undefined, { status: "stopped", supersededBy: "run_next" }),
    "run_next",
  );
});

test("W1-R1: elapsed projection handles missing capability, lineage cycles and hop bound", () => {
  const missing = { getRun: () => undefined };
  assert.equal(readModel.runLineageActiveMs(missing), undefined);

  const rows = new Map();
  const journal = {
    listRunLifeSpans: (runId) =>
      runId === "run_a" ? [{ startedAt: 100, lastActivityAt: 260 }] : [],
    getRun: (runId) => rows.get(runId),
  };
  rows.set("run_a", { resumedFrom: "run_b" });
  rows.set("run_b", { resumedFrom: "run_a" });
  assert.equal(readModel.runLineageActiveMs(journal, "run_a"), 160);

  for (let i = 0; i < 70; i += 1) {
    rows.set(`run_${i}`, { resumedFrom: i === 69 ? undefined : `run_${i + 1}` });
  }
  const bounded = {
    listRunLifeSpans: (runId) => (runId === "run_0" ? [{ startedAt: 1, lastActivityAt: 2 }] : []),
    getRun: (runId) => rows.get(runId),
  };
  assert.equal(readModel.runLineageActiveMs(bounded, "run_0"), 1);
});

test("W1-R1: journal capability is visible and no longer implemented in bootstrap", async () => {
  const bootstrapRoot = new URL("../packages/bootstrap/src/app/", import.meta.url);
  for (const file of [
    "dynamic-workflow-run-elapsed.ts",
    "dynamic-workflow-run-journal.ts",
    "dynamic-workflow-run-label.ts",
    "dynamic-workflow-run-lineage.ts",
  ]) {
    await assert.rejects(access(new URL(file, bootstrapRoot)));
  }
  const observation = await readFile(
    new URL("../packages/cli-workflow/src/dynamic-workflow-run-observation.ts", import.meta.url),
    "utf8",
  );
  assert.match(observation, /@acode\/workflow-run-read/);
  assert.doesNotMatch(observation, /\.\/dynamic-workflow-run-(elapsed|label|lineage)\.js/);
  assert.equal(typeof readModel.resolveDynamicWorkflowJournalStore, "function");
});

test("W1-R3a-1: artifact projections and item reads are public read-model APIs", async () => {
  const journal = {
    listArtifactRows: () => [
      {
        status: "completed",
        artifactId: "board_1",
        result: { id: "board_1", kind: "table", version: 1, title: "old" },
      },
      {
        status: "completed",
        artifactId: "board_1",
        result: { id: "board_1", kind: "table", version: 2, title: "new", primary: true },
      },
      { status: "failed", artifactId: "ignored", result: undefined },
    ],
    listNodes: () => [{ kind: "report", artifactId: "board_1" }],
    listArtifactItems: (_runId, _artifactId, query) => [
      { sequence: 11, siteId: "site", ordinal: 3, item: { value: query.limit } },
    ],
  };
  assert.deepEqual(readModel.artifactsOf("run_1", journal).artifacts, [
    {
      id: "board_1",
      kind: "table",
      title: "new",
      version: 2,
      versions: [
        { version: 1, title: "old", publishedAt: 0 },
        { version: 2, title: "new", publishedAt: 0, primary: true },
      ],
      itemCount: 1,
      primary: true,
    },
  ]);
  assert.deepEqual(readModel.listArtifactItemsFrom(journal, "run_1", "board_1", { limit: 4 }), [
    { sequence: 11, siteId: "site", ordinal: 3, item: { value: 4 } },
  ]);
  assert.equal(typeof readModel.artifactRowId({ artifactId: "board_1" }), "string");
});

test("W1-R3a-1: workspace projection enforces parent ownership and bounds result bytes", async () => {
  const journal = {
    getRun: (runId) => (runId === "run_owned" ? { parentSessionId: "sess_1" } : undefined),
    listWorldNodes: () => [
      {
        siteId: "site",
        ordinal: 1,
        kind: "world-read",
        input: { op: "files.read", args: ["README.md"] },
        status: "completed",
        resultBytes: 20,
        timeCreated: 10,
        timeUpdated: 20,
      },
    ],
    getNode: () => ({
      kind: "world-read",
      status: "completed",
      result: "0123456789",
    }),
  };
  assert.deepEqual(
    await readModel.listWorkspaceNodesFrom({ journal, parentSessionId: "sess_1" }, "run_owned"),
    [
      {
        siteId: "site",
        ordinal: 1,
        kind: "world-read",
        op: "files.read",
        args: ["README.md"],
        status: "completed",
        summary: { resultBytes: 20 },
        createdAt: 10,
        updatedAt: 20,
      },
    ],
  );
  assert.equal(
    await readModel.listWorkspaceNodesFrom({ journal, parentSessionId: "sess_1" }, "run_other"),
    undefined,
  );
  const bounded = await readModel.readWorkspaceNodeResultFrom(
    { journal, parentSessionId: "sess_1" },
    "run_owned",
    "site",
    1,
    { maxBytes: 5 },
  );
  assert.equal(bounded?.status, "completed");
  assert.equal(bounded?.truncated, true);
  assert.equal(bounded?.result, "01234");
});

test("W1-R3a-1: bootstrap no longer owns artifact/workspace projection files", async () => {
  const bootstrapRoot = new URL("../packages/bootstrap/src/app/", import.meta.url);
  for (const file of [
    "dynamic-workflow-run-artifact-projection.ts",
    "dynamic-workflow-run-artifact-queries.ts",
    "dynamic-workflow-run-artifact-read.ts",
    "dynamic-workflow-run-workspace.ts",
  ]) {
    await assert.rejects(access(new URL(file, bootstrapRoot)));
  }
});
