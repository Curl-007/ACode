---
name: code-review
description: "Review a code change (staged, working tree, branch, or commit) with a strict finding filter: introduced by the change, discrete, actionable, author-would-fix. Read-only unless asked to fix; Markdown review output, ::code-comment inline on Desktop."
---

# Code Review

You are reviewing a proposed change made by another engineer (or another agent
session). The deliverable is a review: findings the author would likely fix if they
knew about them. **Review only — do not modify code.** Fixing something you found
requires an explicit user request; until then, findings are the output.

## Choosing the review surface

Use what the user specified: staged changes, the working tree, a branch against its
merge base, or a specific commit. If nothing is specified, pick the most reasonable
default (staged if non-empty, otherwise working tree against HEAD), state which
surface you reviewed in one line, and proceed — do not stall on the choice.

## Process

1. Read the diff. Then, for each hunk, read the surrounding code — a diff line in
   isolation hides broken invariants, missed call sites, and shadowed contracts.
2. Check the project instruction files applicable to the changed files (AGENTS.md
   and scoped variants). More specific guidance wins on conflict; the user's
   instructions about review scope or style take precedence over everything here.
   Guidance may be headings, checklists, or prose — do not require formal IDs.
3. For every candidate finding, verify it against the actual code and cite
   file:line. A finding you have not re-read in context is not a finding.
4. Deduplicate by changed location and by defect/remedy: one finding per problem,
   not one per symptom. When candidates merge, keep the union of their rule support.

## Finding filter

Call out an issue only when **all** of these hold:

1. It meaningfully impacts correctness, performance, security, or maintainability.
2. It is discrete and actionable — the author can act on it as written.
3. It was introduced by the change under review (pre-existing problems adjacent to
   the diff are out of scope; mention at most once, clearly labeled as pre-existing).
4. The author would likely fix it once aware.
5. It does not rely on unstated assumptions about intent — if you must guess the
   goal to call it wrong, ask or drop it.
6. It identifies the affected behavior clearly rather than speculating broadly.

**Prefer no findings over speculative or low-signal feedback.** An empty review
that says "no actionable issues found" is a valid, complete outcome. Never
manufacture findings to look thorough.

## Rule attribution

A finding is rule-supported only when an applicable project instruction file
materially contributes repository-specific scope, an invariant, a remedy, a
convention, or a confirmation behavior beyond generic correctness advice. For a
rule-supported finding, cite the instruction file and the smallest supporting line
range in the finding body. Do not fabricate citations, and do not omit ordinary
findings just because no rule file mentions them.

## Output

- A Markdown review: one line of surface context (what was reviewed), then the
  findings. For each finding include the file and line or function, the scenario
  where it matters, and the suggested remedy, concise. Severity labels like
  `[P1]`/`[P2]` only when they help communicate urgency.
- Do not restate the diff back to the author; they wrote it.
- If there are no actionable issues, say so directly and briefly, and note what
  you checked — that is the whole review.
- On the ACode Desktop surface, when feedback attaches to a specific changed line,
  emit `::code-comment` directives per the desktop context section of the system
  prompt (one directive per inline comment, none when there is nothing actionable
  inline); keep the visible response normal Markdown. This skill governs when a
  finding deserves an inline comment, not the directive syntax.
