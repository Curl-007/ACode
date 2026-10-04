---
name: run
description: "Launch and drive this project's app to see a change working — not just tests. Use when asked to run, start, or screenshot the app. Prefers a project run skill when one exists; falls back to per-type launch patterns."
---

# Run

**Running means launching the actual app and interacting with it.** Not the test
suite, and not importing an internal function into a scratch script — the app as a
user (human or programmatic) would meet it: the CLI at its command, the server at
its socket, the GUI at its window.

## First: does a project skill already cover this?

Scan the project's skill directories — `.agents/skills/` and `.acode/skills/`, at
the repo root and, in a monorepo, at each package/app directory in play — and read
the descriptions for one that launches or drives this app. A project run skill is
the repo's verified path: its author already cold-started from scratch and
committed what worked, including the exact install lines, env vars, and patches.

- **One matches** → read its SKILL.md and follow it verbatim. Do not paraphrase
  its steps; do not skip its patches or env lines.
- **Several plausible, no clear match** (mega-repo) → ask the user which unit to run.
- **Matched skill is stale** (fails on mechanics unrelated to what you need) → tell
  the user it is stale, show the failure, and offer to refresh it. Do not silently
  work around it.
- **Nothing about running** → fall back to the patterns below.

Also read AGENTS.md and the package.json `scripts` block before improvising —
repos usually document their canonical dev commands, and those beat any generic
pattern.

## Otherwise: match the project's shape

Pick the closest row and adapt:

| Project type | Handle | Drive |
|---|---|---|
| CLI tool | direct invocation | run a representative command; check exit code, stdout, stderr |
| Web server / API | background launch, wait for the listening line | `curl` the route that matters; read status and body |
| TUI / interactive terminal | terminal driver when one is available (tmux/pexpect-class tooling) | send keys, capture the pane; a screenshot of the pane is evidence |
| Electron / desktop GUI | launch with its debug protocol enabled, connect an automation client — when available on this machine | drive a window action, capture the result |
| Browser-driven web app | dev server + a browser automation skill or plugin, when one is installed | navigate, interact, screenshot |
| Library / SDK | none — no app to launch | smoke script at the package boundary: import the published entry, exercise the public API |

If nothing fits, start from the closest row and adapt it, and say which row you
started from.

## Drive it, don't just launch it

Launching with no interaction proves the entrypoint resolves. That is not running
the app — that is typechecking with extra steps. Drive to a point where a user
would see something:

- CLI → type a representative command; check exit code and output.
- Server → hit the route the change touches; read the body.
- TUI → send a navigation keystroke; capture the pane before and after.
- GUI → click the button; screenshot the window — **and look at the screenshot**.
  A blank frame is a failure to launch, not a rendered page.

Keep the app running only as long as the task needs; stop what you started when
done, and say what you left running if anything must stay up.

## Capture the recipe when it cost extra

If the fallback path needed extra work to come up — installing packages, setting
env vars, patching config, writing a driver script — say so in your report and
recommend persisting it: a short project-level run skill (in the skills directory
level you probed) capturing the exact launch and drive steps that worked, so the
next session does not pay the cold start again. If it came up with the documented
commands and nothing else, do not suggest anything — a skill that restates
AGENTS.md is noise.
