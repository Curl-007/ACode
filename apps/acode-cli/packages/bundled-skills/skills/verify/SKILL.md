---
name: verify
description: "Verify a code change actually does what it should by exercising it end-to-end and observing behavior — drive the affected flow at its real surface, not tests or typecheck. Run before committing nontrivial changes; skips diffs with no runtime surface."
---

# Verify

**Verification is runtime observation.** You build the app, run it, drive it to the
point where the changed code executes, and capture what you see. That capture is
your evidence. Nothing else is.

Three hard rules:

- **Don't run the test suite. Don't typecheck.** Not here — that proves CI can run,
  not that the change works. Not as a warm-up, not "just to be sure", not as a
  regression sweep afterwards. The time goes into running the app instead.
  (Boundary: this governs the verify pass. Tests you run while implementing, as
  your own self-check before claiming done, are part of the implementation work —
  they are just not evidence for this skill's verdict.)
- **Don't import-and-call.** Importing an internal function and logging its result
  is a unit test you just wrote; the function did what the function does — you knew
  that from reading it. The app never ran. Whatever calls that function in the real
  codebase ends at a CLI, a socket, or a window. Go there.
- **Evidence is a captured observation** — pane output, response body, screenshot,
  the agent's actual reply. "The code looks right" is not evidence.

## Find the change

Establish the full diff range first — a branch may be many commits, and the change
may still be uncommitted:

```bash
git log --oneline @{u}..        # commits ahead of upstream (if set)
git diff @{u}.. --stat          # full range, not just HEAD~1
git diff origin/HEAD... --stat  # no upstream: committed vs base
git diff HEAD --stat            # uncommitted: working tree vs HEAD
```

State the commit count you are verifying. If the diff is too large to read inline,
redirect it to a file and Read it. In a repo where none of these shows a diff, say
so and stop. With no repo, the scope is whatever the user named — ask if they did
not name one.

**The diff is ground truth. Any description of it is a claim.** Read both. When
the claim and the diff materially disagree, that disagreement is itself a finding —
report it; do not pick a side silently.

## Surface

The surface is where a user — human or programmatic — meets the change. Observe
there:

| Change reaches | Surface | You |
|---|---|---|
| CLI / TUI | terminal | run the real command via Bash; capture output and exit code |
| Server / API | socket | start it, send the request the change touches, read the response body |
| Web GUI | pixels | start the dev server; drive it with a browser automation skill or plugin when one is available, and screenshot; if none is available, say so and verify what you can at the HTTP surface, marked as degraded |
| Desktop / Electron GUI | window | drive it through its debug protocol or OS-level automation when available; otherwise report BLOCKED with what tooling is missing |
| Library / SDK | package boundary | exercise the public export from a sample script — import the package, never `./src/...` |
| Prompt / skill / AGENTS.md | the agent | run a headless agent session against a representative input and capture its behavior — the config's effect on the agent is the observable |
| CI workflow | the CI run | dispatch the workflow and read the resulting run |

**An internal function is not a surface.** Something in the repo calls it, and that
caller chain ends at one of the rows above — follow it there. A permission gate's
surface is not the function's return value; it is the CLI prompting (or auto-allowing)
when you type the command.

**No runtime surface at all** — docs-only, types with no emit, build config with no
behavioral diff: report **SKIP — no runtime surface: (reason)**, one line. Do not
run tests to fill the space.

**Tests inside the diff are the author's evidence, not a surface.** CI runs them;
re-running them is re-running CI. Tests-only diff → SKIP, one line. Mixed src and
tests → verify the src, ignore the test files. Reading a test to learn what to check
is fine — it is a spec. Then go run the app.

## Get a handle

Check the project's skill directories **first, even if you think you know how to
build and run this repo**: `.agents/skills/` and `.acode/skills/`, at the repo root
and — in a monorepo — also at each package/app directory the diff touches. A
project-level run or verify skill is the repo's proven path: its author already
cold-started and committed what worked.

- **A matching project skill exists** → invoke it and follow it verbatim. Do not
  paraphrase its steps; do not skip its patches or env lines.
- **It fails on mechanics unrelated to your change (stale)** → tell the user; offer
  to update the skill. Do not FAIL the change for skill rot.
- **Nothing relevant** → cold start from AGENTS.md / README / package.json scripts.
  Timebox it to roughly 15 minutes. Stuck → **BLOCKED**, naming exactly where it
  stopped. Got through → **persist what you learned**: write a short project-level
  verify skill (in the directory level you probed) capturing the build / launch /
  drive recipe that worked, so the next session skips this cold start. If a project
  verify skill already exists, edit it only when it steered you wrong — a documented
  command failed or a needed step was missing. Never rewrite working content for style.

## Drive it

Take the smallest path that makes the changed code execute:

- Changed a flag or config → run with that flag or config.
- Changed a handler or route → hit that route.
- Changed error handling → trigger the error.
- Changed an internal function → find the command, request, or render that reaches
  it, and run that.

**Read your plan back before executing it.** If every step is build, typecheck, or
run test file, you have planned a CI rerun, not a verification. Replace steps until
one reaches the surface — or report BLOCKED.

**End-to-end, through the real interface.** Pieces passing in isolation do not
prove the flow works; seams are where bugs hide. If users click a button, verify by
clicking the button — not by curling the API underneath it.

## Verdict and evidence

- **PASS** — you ran the app and the change did what it should at its surface.
  Not: tests pass, build is clean, code looks right.
- **FAIL** — you ran it and it does not; or it breaks something adjacent; or claim
  and diff materially disagree.
- **BLOCKED** — you could not reach a state where the change is observable (build
  broke, dependency missing, no driver for the surface). This is not a verdict on
  the change. Say exactly where it stopped and what would unblock it.
- **SKIP** — no runtime surface exists. One line, with the reason.

**No partial pass.** "3 of 4 checks passed" is FAIL until all 4 pass or the
exception is explicitly explained and agreed. **When in doubt, FAIL** — a false
PASS ships broken code; a false FAIL costs one more human look. Ambiguous output is
FAIL with the raw capture attached; do not interpret it into a pass.

**Evidence has to reach the reader.** Inline the load-bearing captures — pane
output, response bodies, screenshots — in your report. A file path is evidence only
if the reader can open it.

**The verdict is table stakes; your observations are the signal.** You are the only
reviewer who actually ran the thing. Anything that made you pause, work around, or
go "huh" belongs in the report — filter for "would I mention this if the author were
sitting next to me", not for "is this definitely a bug".
