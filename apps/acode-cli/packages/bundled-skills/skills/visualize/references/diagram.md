# Diagrams — hand-placed SVG

Read this before writing any `<svg>` with boxes, arrows, or labels. Diagrams
have the highest failure rate of every visual type because every element sits
at coordinates you computed yourself. The rules below turn the common failures
into arithmetic you do **before** writing the element.

## The two rules that prevent most failures

### 1. Intersection-check every connector before drawing it

Before committing a `<line>` or `<path>`, test the segment against the rect of
every box you have already placed — not just its source and target. If the
segment passes through the interior of any other box, it will visibly slash
through it. Reroute as an L-shaped `<path>` (two orthogonal legs) around the
obstacle, or move the obstacle. Run the same test against placed text labels:
an arrow crossing a label makes both unreadable.

### 2. Size every box from its longest label

At 14px sans-serif, a plain Latin character is roughly 8px wide in a title
weight and 7px in a subtitle weight. Before writing a `<rect>`:

```text
width = max(title_chars × 8, subtitle_chars × 7) + 24
```

The +24 is inner padding (12px per side). Worked example: the subtitle
"Retries, backoff, jitter" is 24 characters → 24 × 7 + 24 = 192px minimum; a
140px box overflows visibly. Calibration: CJK characters render about twice as
wide as Latin at the same size — count each as 2 units. Subscripts,
superscripts, and math or chemical glyphs (∑, ∫, C₆H₁₂O₆) run 30–50% wider than
plain text — pad the estimate accordingly. When in doubt go wider: extra
padding looks calm, overflow looks broken.

## Compute the viewBox, never guess it

After every element is placed, derive max_x and max_y — the right-most and
bottom-most painted points, counting text baselines plus ~4px for descenders
and half the stroke width on strokes. Then:

```text
viewBox = "0 0 (max_x + 20) (max_y + 20)"
```

A guessed viewBox is the number-one cause of clipped labels and severed arrow
heads. If you cannot state max_y as a number you derived from placed
coordinates, you are guessing — go back and compute it.

## Tier packing — a WRONG/RIGHT pair

Four boxes on one horizontal tier, canvas 760px wide, 20px side margins
(boxes must stay inside x ∈ [20, 740]; usable width 720px):

- **WRONG**: w=200, x = 20, 200, 380, 560. The pitch is 180 but each box is
  200 wide — every adjacent pair overlaps by 20px, and the last box ends at
  x=760, flush with the canvas edge, so its right border is clipped.
- **RIGHT**: gap=20 → w = (720 − 3×20) / 4 = 165, round down to 160. Total =
  4×160 + 3×20 = 700; centering gives x = 30, 210, 390, 570 (pitch 180 = w +
  gap, no overlap), right edge at 730 ≤ 740.

Compute `n×w + (n−1)×gap` against the usable width **before** placing any box,
and check the pitch (w + gap) against the x-step you actually write.
For trees, work bottom-up: size the leaf tier first, then make each parent at
least as wide as the span of its children.

## Spacing constants

- ≥60px between sibling boxes; 24px padding inside boxes; ≥12px between text
  and any box edge.
- Stop arrowheads ~10px short of the target box edge — a head touching the
  border reads as a collision.
- A two-line box (title + subtitle) needs ≥56px height with ~22px between the
  two baselines.
- Center text with `text-anchor="middle"` plus `dominant-baseline="central"`,
  and set y to the centre of **the slot the text occupies** — for a multi-row
  box that is the row's centre, not the box's. Without
  `dominant-baseline="central"` the glyph body sits ~4px above where you meant
  it and descenders collide with the line below.
- Arrowheads: one shared `<marker>` with `fill="context-stroke"` (or
  `stroke="context-stroke"` on its path) so every head inherits its own line's
  color — no per-color marker duplicates, no mismatched heads.

## Route on the verb, not the noun

The same subject becomes a different diagram depending on what was asked.
Decide the family first:

- **Reference diagrams** — the user wants a map they can point at; precision
  beats feeling. Flowcharts for steps and decisions ("walk me through the
  process", "what happens when I submit"); structural diagrams for containment
  ("what is the architecture", "where does X live"). These are the diagrams you
  would find in documentation.
- **Intuition diagrams** — the user wants to feel how something works ("how
  does X actually work", "I don't get X"). The goal is the right mental model,
  drawn as a visual metaphor: a cross-section for a physical mechanism, a ball
  rolling down a loss surface, tokens lighting up between stacked layers,
  numbered envelopes passed between two endpoints. This is the default for an
  unqualified "how does X work", and it is the more ambitious route — do not
  retreat to a flowchart just because it feels safer.

Hard routing rules:

| Request shape                                    | Build                                            | Why                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "draw the schema" / "show the ERD"               | Mermaid `erDiagram` — not hand-placed SVG        | Hand-laid ERDs fail in the same places every time: entity boxes mis-sized for their field lists, relationship labels colliding, edges crossing at shallow angles. The layout engine solves exactly these. |
| A cyclic process (event loop, Krebs cycle, retry loop) | An HTML stepper the user clicks through     | Never a ring. Every spacing formula in this file is Cartesian — none applies to labels placed at angles, and curved arrows between ring nodes cross each other through the centre. |
| Both intuition and reference are needed          | Two visuals, intuition first, prose between      | Do not mix families on one canvas. Build the mental model first, then the precise map (see the delivery-honesty rule in SKILL.md).                          |

Keep each diagram to 4–5 nodes; a bigger graph is a signal to split into an
overview plus detail visuals rather than to shrink boxes below the width
formula.

## Budget and honesty still apply

The complexity budget, the "click to learn more" self-check, the accessibility
floor, and the promised-N-delivered-N rule from SKILL.md apply to diagrams
without exception. A diagram whose boxes each need a paragraph is a diagram
that should be split.
