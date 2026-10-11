---
name: visualize
description: "Create interactive visualizations directly in the conversation: charts, diagrams, simulations, and interface mockups rendered in a sandboxed card. Use when the user needs to see or explore something — 'what happens when', comparisons, trends, layouts. Not for static figures, tables (use Markdown), or project files."
---

# Visualize

A visualization lives **in the conversation**: the user reads it next to the prose
that explains it, scrolls it into view, and interacts with it. It is not a project
file, not a website, and not an attachment.

## When to visualize — and when not to

Visualize only when an interactive or spatial rendering materially improves what
the user can see or decide:

- a trend, distribution, or comparison that prose or a table cannot carry;
- a simulation or "what happens when X changes" with adjustable inputs;
- a layout, mockup, or structure whose shape is the answer;
- a process whose motion or ordering is the point.

Do **not** visualize when:

- the user asked for a table — return a Markdown table directly;
- a static structure is fully explained by labeled nodes and edges — return a
  fenced Mermaid block instead;
- the deliverable is a file, site, or project change — that is normal work with
  normal tools, even if the result contains charts;
- the data fits in one or two sentences.

One visualization per idea. Do not stack panels that each deserve their own
explanation.

## The contract

### 1. Write the fragment

Call `WriteVisualizationFragment` with a `name` (lowercase-hyphen ASCII, ends
`.html`, e.g. `queue-backpressure.html`) and the `content`: an **HTML fragment**,
never a full document.

Fragment rules:

- No `<!doctype>`, `<html>`, `<head>`, `<body>` — the host wraps you.
- Write literal markup with real newlines; never embed the fragment inside a
  Python/JS/shell string that escapes it.
- The root element gets a unique `id`; select it with
  `document.getElementById(...)` — never `document.currentScript`.
- Keep total size under 1 MiB. Aggregate, bin, or downsample large datasets;
  drop precision and unused fields before inlining data.
- CSS and JavaScript only when base classes are insufficient. **No `fetch`,
  XHR, WebSocket, or any network call** — `connect-src` is `none` and the call
  will fail silently.
- Static assets may load from these CDNs only: `cdnjs.cloudflare.com`,
  `esm.sh`, `cdn.jsdelivr.net`, `unpkg.com`, `fonts.googleapis.com`,
  `fonts.gstatic.com`, `fonts.bunny.net`. Anything else is blocked.
- `window.acodeViz.getWidgetState()/setWidgetState(...)` persists widget state
  for the lifetime of the card (in-memory): use it for sliders and toggles so a
  re-render does not reset the view.

### 2. Theme

Every color must read the theme — never hardcode palettes. The wrapper injects
these CSS variables: `--background`, `--foreground`, `--card`,
`--card-foreground`, `--muted`, `--muted-foreground`, `--primary`,
`--primary-foreground`, `--border`, `--destructive`, `--blue`, `--green`,
`--red`, `--yellow`, `--orange`, `--purple`. Use `currentColor` inside SVG.
Text must keep contrast against its actual background.

### 3. Reference it exactly once, in the final response

After writing (or updating) the fragment, put this line in the **final response**
where the visual should appear — as its own line, never inside a code fence:

```text
::visualize{"name":"queue-backpressure.html"}
```

Rules for the reference:

- `name` must match the fragment you wrote this turn.
- Add `"mode":"wide"` only for full-screen app mockups or several compact
  panels that must sit side by side; never widen a single dense plot.
- Emit the reference only in the turn's final response, never in progress
  updates; never wrap it in backticks or announce it as a file, link, or
  attachment.
- Updating a visualization later in the conversation: rewrite the fragment
  with the same `name` (same-name writes update), then emit the reference
  again in that turn's final response.
- Your user-facing prose describes only what the visual helps the user see or
  decide — keep it brief and do not repeat the data.

### 4. Failure is visible

If the fragment was rejected (oversize, not a fragment, bad name) the tool
returns the reason — fix and rewrite. If you emit a reference for a name you
never wrote, it renders as plain text; that is your signal to write first.

## Examples of good and bad calls

- "Show how the retry backlog grows under different arrival rates" → one
  simulation fragment with a rate slider and a live chart. Good.
- "Compare these three architectures" → a labeled diagram per option in one
  fragment, or Mermaid if static. Prefer Mermaid when nothing moves.
- "Make me a dashboard page" → that is project work; do not visualize.
- "Summarize this table" → return a Markdown table.
