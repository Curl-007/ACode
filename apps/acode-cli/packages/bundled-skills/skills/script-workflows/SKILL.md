---
name: script-workflows
description: "Use when writing, debugging, or resubmitting a JavaScript workflow script for the RunWorkflow tool: the `export const meta` header contract, the agent()/parallel()/pipeline()/phase()/log()/args/budget globals, choosing fan-out topology, pipeline-vs-parallel barrier discipline, structured output via opts.schema, per-agent model/tools/isolation overrides, resume caching on (prompt, opts), and handling a backgrounded run. NOT for CreateWorkflow — that is the other workflow system and its scripts are not interchangeable."
when_to_use: "Only for RunWorkflow scripts, and only after the user explicitly opted into this system (named ultracode, or asked for a script workflow / multi-agent fan-out in their own words). A plain request to \"use a workflow\" belongs to CreateWorkflow instead. A single delegation or a few independent lookups belong to the Agent tool."
---

# Writing script workflows

This skill is the whole authoring contract for `RunWorkflow`. The tool description is short on
purpose; the script API, the rules a script must satisfy and the fields each `agent()` call takes
are here. `RunWorkflow` refuses to accept a script until this skill has been loaded in the
session. Running a predefined workflow by `name`, or resuming by `resumeFromRunId`, is exempt —
neither is authoring.

## 1. Two workflow systems exist. Pick the right one before writing anything.

| | `CreateWorkflow` (dwf) | `RunWorkflow` (this skill) |
| --- | --- | --- |
| Language | TypeScript, typechecked against a facade | plain JavaScript, no typecheck |
| First statement | must **not** be `export` (the body is compiled inside a function) | **must** be `export const meta = {...}` |
| Spawning | `agent(name, persona).ask<T>(instructions)` — two steps | `agent(prompt, opts)` — one call, one result |
| Data from the world | `world.run/read/grep/glob`, `git.*`, `files.*` | none — delegate to a subagent instead |
| Deliverables | `artifact.chart/table/metrics/board`, `report()` | the script's `return` value |
| Run id | `dwfrun_*` | `wf_*` |

The scripts are **not interchangeable**. Submitting a dwf script here fails on the missing
`export const meta`; submitting one of these there fails on `export` being illegal inside a
function body. Load the other skill (`dynamic-workflows`) if the user asked for that system.

**Routing is decided by the user's wording, never by the shape of the task.** `/ultracode`, or the
user naming ultracode, routes here. `/workflow`, or a plain "use a workflow" / "用工作流", routes to
`CreateWorkflow`. A task that merely looks orchestration-shaped routes to neither — use the `Agent`
tool or do the work yourself. Results feeding later steps, a loop with a stopping condition,
control flow branching on a result: those describe how to build a workflow once one is warranted;
they are never a reason to start one.

**An explicit request is binding.** Once the user has opted in, the routing question is closed: not
`Agent`, not doing it inline, not "this is too small". What remains is only how big the script
should be, and the smallest task still gets a small workflow.

## 2. Script shape

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [
    { title: 'Review', detail: 'one agent per dimension' },
    { title: 'Verify', detail: 'adversarially verify each finding' },
  ],
}

phase('Review')
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS }),
  (review) => parallel(review.findings.map((f) => () =>
    agent(`Try to refute: ${f.title}`, { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT })
      .then((v) => ({ ...f, verdict: v }))
  )),
)
return results.flat().filter(Boolean).filter((f) => f.verdict?.isReal)
```

`meta` rules — all enforced, all fail before anything runs:

- It must be the **first statement** in the script.
- It must be a **pure literal**: no variables, no function calls, no spreads, no template
  interpolation, no computed keys, no methods or accessors. Negative numeric literals are fine.
- `name` and `description` are required non-empty strings. `phases` defaults to `[]`.
  `whenToUse` is optional. `phase.title` is required; `phase.detail` and `phase.model` are optional.
- Phase titles must be unique, and should match the titles you pass to `phase()` — that is what
  groups the progress display.
- Unknown keys are rejected (the schema is strict).

Body rules:

- Plain JavaScript. It runs in an async context, so top-level `await` and a final `return` are both
  legal. `return` is how the run hands its result back.
- No `import`, no `require`, no filesystem, no Node APIs, no `fetch`, no `setTimeout`. The script
  runs in an isolated realm containing only the globals listed in §3 — reaching for anything else is
  a `ReferenceError`.
- `console.log` / `info` / `warn` / `error` / `debug` are available and all forward to `log()`, so
  they reach the user as progress lines rather than a stderr dump.
- No `eval` or `new Function` (code generation from strings is disabled in the realm).
- Script size limit is 512 KB.

## 3. The globals

- **`agent(prompt: string, opts?) → Promise<any>`** — spawn one subagent and await its result.
  Without `schema` the result is the subagent's final text as a string. Returns `null` when the
  subagent could not produce a result, so `.filter(Boolean)` before using a batch.
- **`parallel(thunks: Array<() => Promise<any>>) → Promise<any[]>`** — run thunks concurrently.
  This is a **barrier**: it awaits all of them. A thunk that throws resolves to `null` in its slot;
  the call itself never rejects.
- **`pipeline(items, stage1, stage2, ...) → Promise<any[]>`** — run each item through every stage
  independently, **no barrier between stages**. Item A can be in stage 3 while item B is still in
  stage 1. Each stage callback receives `(prevResult, originalItem, index)`. A stage that throws
  drops that item to `null` and skips its remaining stages.
- **`phase(title: string) → void`** — start a progress group. Subsequent `agent()` calls are
  grouped under it unless they set `opts.phase`.
- **`log(message: string) → void`** — emit a progress line to the user.
- **`args`** — the value passed as the tool's `args` input, verbatim. Pass arrays and objects as
  real JSON values in the tool call, not as a JSON-encoded string: a stringified list arrives as one
  string, so `args.filter` / `args.map` throw.
- **`budget`** — `{ total, spent(), remaining() }`. See §8 before relying on it.
- **`workflow(nameOrRef, args?)`** — **not implemented**. It throws
  `"Nested workflow() is reserved for a later workflow runtime version."` Do not call it. Run
  several workflows as separate `RunWorkflow` calls across turns instead, reading each result
  before deciding the next.

### `agent()` options — what actually happens

Every option below is real and honored. Anything not listed here is not available.

| Option | Effect |
| --- | --- |
| `label` | Display label for the subagent, and the description shown for it. Also the natural place to put an index so N parallel agents stay distinguishable. |
| `phase` | Assigns this agent to a progress group explicitly. **Use this inside `pipeline()`/`parallel()` stages** instead of relying on the global `phase()` — concurrent stages race on it. |
| `schema` | See §7. Prompt-level instruction plus JSON extraction from the response. |
| `model` | Model override. **Must be provider-qualified** (`providerId/modelId`); anything else throws `Workflow child model must be provider-qualified`. Omit to inherit the session model — that is almost always right. |
| `agentType` | Custom subagent type, resolved from the same registry the `Agent` tool uses. Defaults to the built-in workflow subagent. |
| `tools` | Allowlist of tool names for this subagent. |
| `instructions` | Extra instructions prepended to the prompt as their own block. |
| `systemPrompt` | Replaces the inherited system prompt for this subagent. |
| `skills` | Adds a line to the prompt naming skills to use **if available**. This is a hint, not an allowlist — it does not install or restrict anything. |
| `timeoutMs` | Per-agent timeout. |
| `isolation` | `'worktree'` — run this agent in a fresh git worktree. See §9. |

There is no `effort` option. Subagents cannot spawn further subagents, cannot call
`RunWorkflow` or `CreateWorkflow`, and have no tool that asks a person anything.

## 4. Default to `pipeline()`

Wall-clock with a barrier is the sum of the slowest per stage; with `pipeline()` it is the slowest
single-item chain. Reach for `parallel()` between stages only when stage N genuinely needs
cross-item context from **all** of stage N-1:

- dedup or merge across the full result set before expensive downstream work;
- early-exit when the total count is zero ("0 findings → skip verification entirely");
- stage N's prompt references "the other findings" for comparison.

A barrier is **not** justified by "I need to flatten/map/filter first" (do it inside a stage),
"the stages are conceptually separate" (separate ≠ synchronized), or "it's cleaner code"
(barrier latency is real: if 5 finders run and the slowest takes 3× the fastest, a barrier wastes
two thirds of the fast finders' idle time).

Smell test — if you wrote

```js
const a = await parallel(...)
const b = transform(a)     // flatten / map / filter, no cross-item dependency
const c = await parallel(b.map(...))
```

that middle transform does not need the barrier. Rewrite as a pipeline with the transform inside a
stage. When in doubt: pipeline.

## 5. Caps and concurrency

- Concurrent subagents are capped at `max(1, min(16, availableParallelism() - 2))`. Excess calls
  queue and run as slots free up, so passing 100 items to `pipeline()` is fine — they all complete,
  only a handful run at any moment.
- **Total `agent()` calls across one run are capped at 1000, and exceeding it throws** — the error is
  `Workflow agent call limit exceeded: 1000`, and because nothing inside the script can catch a cap
  that the runtime raises on every subsequent call, the run fails as a whole. This is a runaway-loop
  backstop, not a budget you can plan against: a legitimate workflow that needs 1000 agents is a
  workflow you should have split across turns.
- **There is no round cap.** The 1000-agent ceiling is the only thing that stops a loop which never
  goes dry, and it stops it by failing the run. So every loop you write must carry its own hard
  iteration limit well below that ceiling — see §8 for why `budget` will not save you.

## 6. Determinism

`Date.now()`, `new Date()` with no arguments, and `Math.random()` all throw. A resumed run replays
cached results, so a script whose control flow depends on the clock or on randomness cannot be
replayed faithfully. `Date.parse(x)`, `Date.UTC(...)`, and `new Date(ms)` are available.

Pass timestamps in via `args`, or stamp results after the run returns. For N independent samples,
vary the prompt or label by index instead of using randomness.

## 7. Structured output — read this before trusting `schema`

`opts.schema` does two things: it appends "Return only JSON that conforms to the provided JSON
Schema. Do not wrap it in Markdown." plus the schema to the subagent's prompt, and it then extracts
and `JSON.parse`s the first JSON value found in the response (unwrapping a ```json fence if present).

What it does **not** do: validate the parsed value against the schema, and retry on mismatch. If the
subagent returns JSON of the wrong shape, your script receives it as-is. So:

- Keep schemas small and shallow; a subagent is more likely to conform to one it can hold in view.
- Read defensively: `f.verdict?.isReal`, `Array.isArray(x) ? x : []`. A missing field is a normal
  outcome, not an exceptional one.
- If the value is load-bearing, have a later agent confirm it rather than trusting the shape.
- Non-JSON output throws `Workflow agent returned non-JSON structured output`, which surfaces as a
  `null` slot in `parallel()`/`pipeline()`.

## 8. `budget` is a stub today — do not build a loop on it

`budget.total` is `null` unless a caller supplied a budget, and **nothing in the product supplies
one**. So `budget.remaining()` returns `Infinity` and `budget.spent()` reflects tokens accumulated
within this run. A loop guarded by `while (budget.remaining() > 50_000)` therefore never terminates
on its own — it runs until it hits the 1000-agent ceiling from §5, and hitting that ceiling **fails
the whole run** instead of stopping it gracefully, so you lose every result the loop had accumulated.

One more wrinkle if you are tempted to report the budget instead of looping on it: the run's return
value crosses a JSON boundary, and `Infinity` is not a JSON literal. `return { left:
budget.remaining() }` arrives as `{ left: null }`. Comparisons inside the script work normally; only
the value you hand back is affected.

Write loops with an explicit counter instead:

```js
const found = []
for (let round = 0; round < MAX_ROUNDS && !dry(round); round += 1) {
  const batch = (await parallel(FINDERS.map((f) => () =>
    agent(f.prompt, { phase: 'Find', schema: BUGS })))).filter(Boolean).flatMap((r) => r.bugs)
  const fresh = batch.filter((b) => !seen.has(key(b)))
  if (!fresh.length) break
  fresh.forEach((b) => seen.add(key(b)))
  found.push(...fresh)
}
```

If you bound coverage in any way (top-N, no retry, sampling), `log()` what was dropped. Silent
truncation reads as "covered everything" when it did not.

## 9. Worktree isolation

`agent(prompt, { isolation: 'worktree' })` runs that agent in a fresh git worktree — a separate
working copy, so parallel agents that mutate files cannot tread on each other or on the main
checkout. It costs roughly 200–500 ms of setup plus disk **per agent**, so use it only when agents
actually write in parallel and would otherwise conflict.

Cleanup is material-first: an unchanged worktree and its branch are removed; a dirty one, one with
commits ahead, or one whose inspection failed is **kept**, and its path, branch, base ref and the
reason are recorded in that agent's result envelope so the work is never silently destroyed.
Fails loudly rather than degrading to the shared cwd — a non-git directory, an unborn HEAD, or a
failed `git worktree add` is an error, not a quiet fallback.

## 10. Resume

Every invocation persists its script and returns the path in the tool result. To iterate, edit that
file with Write/Edit and call `RunWorkflow` again with the same `scriptPath` — do not resend the
whole script.

`resumeFromRunId` replays a prior run: completed `agent()` calls whose `(prompt, opts, phase)` are
unchanged return their cached results instantly, and the first changed or new call and everything
after it runs live. Same script plus same `args` means a full cache hit. This is why the determinism
bans in §6 exist.

Two consequences for how you write scripts:

- **Give parallel agents distinguishable `label`s** (usually including the index). The cache key is
  derived from the call's position and its inputs; labels are how you and the run history tell N
  siblings apart.
- Resume is **same-session only**, and the prior run must have exited first. Resuming a run that is
  still in flight is refused with an error naming the run — stop it with `TaskStop` or wait, because
  two live copies would write the same journal and corrupt the cache.

## 11. The run is backgrounded

`RunWorkflow` returns immediately with `{ status: "backgrounded", runId, backgroundTaskId,
scriptPath, traceId }`. Do not poll. A task notification arrives when the run finishes. If you must
block, use `TaskOutput` with the run id; to stop it, `TaskStop` with the same id.

The run is deliberately decoupled from the turn that started it — cancelling your turn does not
cancel the run.

## 12. Quality patterns

Compose freely; pick by task and scale to what the user asked for. "Find any bugs" is a few finders
and a single verify vote; "thoroughly audit this" is a larger finder pool, a 3–5 vote adversarial
pass and a synthesis stage.

- **Adversarial verify** — spawn N independent skeptics per finding, each prompted to refute it,
  defaulting to refuted when uncertain. Kill the finding if a majority refutes. This is what stops
  plausible-but-wrong findings from surviving.
- **Perspective-diverse verify** — when a finding can fail in more than one way, give each verifier
  a distinct lens (correctness, security, performance, does-it-reproduce) instead of N identical
  refuters. Diversity catches failure modes redundancy cannot.
- **Judge panel** — generate N independent attempts from different angles (MVP-first, risk-first,
  user-first), score them with parallel judges, synthesize from the winner while grafting the best
  ideas from the runners-up. Beats one-attempt-iterated when the solution space is wide.
- **Loop-until-dry** — for unknown-size discovery, keep spawning finders until K consecutive rounds
  return nothing new, with a hard round cap (§8). A plain `while (count < N)` misses the tail.
  Dedup against everything *seen*, not against everything *confirmed*, or rejected findings
  reappear every round and the loop never converges.
- **Multi-modal sweep** — parallel agents each searching a different way (by container, by content,
  by entity, by time). Each is blind to what the others surface; useful when one angle will not find
  everything.
- **Completeness critic** — a final agent asking "what is missing: a modality not run, a claim
  unverified, a source unread?" What it finds becomes the next round of work.

Subagents are told their final text **is** the return value, not a message to a human, so they
return raw data rather than confirmations. Do not tell a subagent to re-read files the project
instructions already gave it; name the specific rule a stage needs, if any.

Ground every claim a workflow reports in something an agent actually read or ran in that session,
and have the script say what was verified versus what was not. A workflow exists to produce
first-class work — the deliverable a senior practitioner would hand over — not a faster draft of
what one reply could have said.
