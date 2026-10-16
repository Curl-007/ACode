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

## Guidance modules

The contract below is the whole deal for a simple visual. Anything with layout
math, data encoding, or controls has a dedicated reference. Before building,
`Read` the one that matches the artifact — a single quiet Read, never narrated
to the user, then build:

| You are about to build                              | Read first                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| Any hand-placed SVG: flowchart, structure, mechanism | `references/diagram.md`                                                |
| A chart of data: series, colors, axes, canvas       | `references/chart.md`                                                  |
| A UI mockup, dashboard, or app-screen replica       | `references/mockup.md` + `references/design-tokens.md`                 |
| A widget with controls: sliders, toggles, steppers  | `references/interactive.md`                                            |

`references/design-tokens.md` is generated from this repository's `DESIGN.md` —
the ACode design vocabulary a mockup should resemble. Never edit it by hand;
edit `DESIGN.md` and re-run the generator named in its header.

## Non-negotiables for every visual

**Complexity budget — hard limits.** At card width, density reads as noise:

- Box and card subtitles: at most 5 words. Detail belongs in the surrounding
  prose or behind an interaction, never inside the box.
- Color: at most 2 ramps per visual. If the colors encode meaning, add a
  one-line legend; otherwise stay on one neutral ramp.
- A horizontal tier holds at most 4 full-width boxes (~140px each). At 5 or
  more, pick one of three escapes: shrink the boxes (≤110px), wrap to two rows,
  or split into an overview visual plus a detail visual.
- Self-check: if your prose says "click to learn more", the top-level view must
  actually be sparse. Never promise brevity and then front-load everything.

**Delivery honesty.** If your response text promises N visuals, make N
`WriteVisualizationFragment` calls — never promise a follow-up visual and omit
it; shrink the claim instead. Between two visuals there must be connecting
prose: what the next one shows and how it builds on the previous one. Never
stack two references back to back.

**Accessibility floor.**

- HTML widgets begin with a visually hidden one-sentence summary of what the
  visual shows — the host injects no `sr-only` utility, so style it inline:
  `<h2 style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap">`.
- SVG: `role="img"` with `<title>` and `<desc>` as the first children.
- Canvas: `role="img"`, a descriptive `aria-label`, and fallback text between
  the tags carrying the actual values.
- Never encode meaning in color alone: every color-coded series or state also
  carries a second channel — dash pattern, marker shape, hatch fill, or a text
  label — and the legend shows both.

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
- The card iframe is `sandbox="allow-scripts"` only: same-origin storage is
  unavailable (`localStorage`, `document.cookie`, IndexedDB all throw), and
  popups, top navigation, and form submission are dead. The card sizes itself
  to your in-flow content height — there is no fullscreen surface. Workarounds
  (faux viewport, expanded-layout toggle, `acodeViz` state): see
  `references/mockup.md` and `references/interactive.md`.
- **Mermaid and Chart.js ship with the app** — pinned, served locally, working
  offline. Reference them by their exact versioned paths, never by CDN URL:

  ```html
  <script src="visualization-vendor/npm_mermaid@11.17.2_mermaid.min.js"></script>
  <script src="visualization-vendor/npm_chart.js@4.5.0_chart.umd.min.js"></script>
  ```

  They expose `window.mermaid` and `window.Chart`. For Mermaid, call
  `mermaid.initialize({ startOnLoad: false })` once, then
  `await mermaid.render(id, definition)` and insert the returned `svg` into
  your root element. Any other spelling (a CDN URL, a different version) drops
  the offline guarantee and may be blocked.
- Other static assets may load from these CDNs only: `cdnjs.cloudflare.com`,
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
