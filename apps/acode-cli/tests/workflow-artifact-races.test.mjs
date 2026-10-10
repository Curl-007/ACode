import assert from "node:assert/strict";
import { test } from "node:test";

const { ARTIFACT_CAPS, InMemoryJournalStore, WorkflowEngine, WorkflowError, validate } =
  await import("../packages/dynamic-workflow/src/index.ts");

function makeArtifactLife(runId = "artifact-race") {
  const journal = new InMemoryJournalStore();
  const requests = [];
  const controls = [];
  const driver = {
    journal,
    emit() {},
    createActorSession() {
      return Promise.resolve({ id: "unused" });
    },
    startAsk() {},
    respondToSubmit() {},
    cancelAsk() {},
    executeWorldRead() {
      return Promise.resolve(undefined);
    },
    executeArtifactPublish(request) {
      requests.push(request);
      return new Promise((resolve, reject) => controls.push({ resolve, reject }));
    },
  };
  const engine = new WorkflowEngine({
    runId,
    caps: { maxConcurrency: 1 },
    askSpecs: new Map(),
    driver,
    validate,
  });
  return { engine, journal, requests, controls };
}

const artifactRecord = (request, uri) => ({
  id: request.id,
  kind: request.op,
  version: request.version,
  uri,
  bytes: 1,
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("DWF-04: same-id concurrent publish is FIFO and versions remain unique", async () => {
  const life = makeArtifactLife("artifact-race-order");
  const first = life.engine.publishArtifact("artifact#1", "markdown", ["report", "one"]);
  const second = life.engine.publishArtifact("artifact#2", "markdown", ["report", "two"]);
  await tick();
  assert.deepEqual(
    life.requests.map((request) => request.version),
    [1],
  );

  life.controls[0].resolve(artifactRecord(life.requests[0], "acode-artifact://v1"));
  const firstRef = await first;
  await tick();
  assert.deepEqual(
    life.requests.map((request) => request.version),
    [1, 2],
  );
  life.controls[1].resolve(artifactRecord(life.requests[1], "acode-artifact://v2"));
  const secondRef = await second;

  assert.deepEqual(firstRef, { id: "report", version: 1 });
  assert.deepEqual(secondRef, { id: "report", version: 2 });
  const completed = life.journal
    .listNodes("artifact-race-order")
    .filter((node) => node.kind === "artifact" && node.status === "completed");
  assert.deepEqual(
    completed.map((node) => node.result),
    [
      artifactRecord(life.requests[0], "acode-artifact://v1"),
      artifactRecord(life.requests[1], "acode-artifact://v2"),
    ],
  );
  life.engine.complete("done");
  await life.engine.settled;
});

test("DWF-04: failed publish does not consume the queued version", async () => {
  const life = makeArtifactLife("artifact-race-failure");
  const first = life.engine.publishArtifact("artifact#1", "markdown", ["report", "bad"]);
  const second = life.engine.publishArtifact("artifact#2", "markdown", ["report", "good"]);
  await tick();
  assert.equal(life.requests[0].version, 1);
  life.controls[0].reject(new WorkflowError("DriverError", "store unavailable"));
  await assert.rejects(first, /store unavailable/);
  await tick();
  assert.equal(life.requests[1].version, 1);
  life.controls[1].resolve(artifactRecord(life.requests[1], "acode-artifact://retry-v1"));
  assert.deepEqual(await second, { id: "report", version: 1 });
  const rows = life.journal
    .listNodes("artifact-race-failure")
    .filter((node) => node.kind === "artifact");
  assert.deepEqual(
    rows.map((node) => node.status),
    ["failed", "completed"],
  );
  life.engine.complete("done");
  await life.engine.settled;
});

test("DWF-04: concurrent new ids cannot overshoot the run artifact-id cap", async () => {
  const life = makeArtifactLife("artifact-race-id-cap");
  const publishes = Array.from({ length: ARTIFACT_CAPS.maxArtifactsPerRun + 1 }, (_, index) =>
    life.engine.publishArtifact(`artifact#${index + 1}`, "markdown", [`report-${index + 1}`, "x"]),
  );
  await tick();
  assert.equal(life.requests.length, 1, "new-id admission should be serialized");

  for (let index = 0; index < ARTIFACT_CAPS.maxArtifactsPerRun; index++) {
    life.controls[index].resolve(
      artifactRecord(life.requests[index], `acode-artifact://id-${index + 1}`),
    );
    await tick();
  }
  await Promise.all(publishes.slice(0, ARTIFACT_CAPS.maxArtifactsPerRun));
  await assert.rejects(publishes[ARTIFACT_CAPS.maxArtifactsPerRun], (error) => {
    assert.ok(error instanceof WorkflowError);
    assert.equal(error.code, "ArtifactCapExceeded");
    return true;
  });
  life.engine.complete("done");
  await life.engine.settled;
});
