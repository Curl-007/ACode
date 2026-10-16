# Charts — data visuals and color discipline

## Color is assigned last

Most bad charts pick colors first and then hunt for data to justify them. Run
the procedure in order:

1. **Pick the form** from the tables below. Sometimes the right form is not a
   chart at all.
2. **Assign color by its job** — categorical, sequential, diverging, or status.
   Never cycle hues across series, never a rainbow.
3. **Apply the mark specs** — thin marks, recessive axes, gaps between touching
   marks.
4. **Legend**: required for ≥2 series; prefer direct end-labels for ≤4 series;
   a single series needs no legend (the title names it).
5. **Hover**: crosshair + tooltip on line/area charts; a per-mark tooltip on
   bars and dots.
6. **Render, then look at it** — label collisions, overflow at the right edge,
   legibility in both host themes.

## Choosing the form

| The data is…                              | Use                                        | Not                      |
| ----------------------------------------- | ------------------------------------------ | ------------------------ |
| One current value (+ maybe a trend)       | Stat tile: value + delta + sparkline       | A bar chart with one bar |
| A handful of headline numbers             | A row of stat tiles                        | A grouped bar chart      |
| One ratio against a limit                 | A meter on a single ramp                   | A two-slice pie          |
| More than ~7 classes that all matter      | A table (optionally plus a chart)          | More colors              |

When a chart is right, the data's job picks the type:

| Job                                      | Form                                        | Color job                 |
| ---------------------------------------- | ------------------------------------------- | ------------------------- |
| Compare magnitudes                       | Bar/column; heatmap for a grid              | Sequential (one hue)      |
| Trend over time                          | Line; area for a single series              | Sequential or one hue     |
| Tell distinct series apart               | Grouped/stacked bar, multi-line             | Categorical               |
| One series is the point, rest is context | Emphasis: highlight one, gray the rest      | One hue + gray            |
| Above/below a baseline, delta to target  | Diverging bar or line against the baseline  | Diverging                 |
| Part-to-whole                            | Stacked bar (horizontal for long names)     | Categorical               |
| Before → after per item                  | Dumbbell                                    | One hue, two shades       |

Sequential is the safe default. Categorical has a cost: it can bury the one
series that matters. If the story is "this one went up", that is emphasis (one
hue + gray), not categorical. Never solve "too many series" with more hues —
past 8, fold the tail into "Other" or switch to small multiples.

## Non-negotiables

- **One y-axis.** A dual-axis chart is two charts stacked on top of each
  other; split it into two visuals or index both series to a common baseline.
- **Color follows the entity, never its rank.** Filtering or sorting must not
  repaint a series into a different hue.
- **Sequential = one hue. Diverging = two hues with a neutral gray midpoint.**
  The midpoint of a diverging scale is never a hue.

## Reserved color semantics

On ACode surfaces blue, green, amber/yellow, and red already carry UI-state
meaning — info, success, warning, error — and the host injects `--blue`,
`--green`, `--yellow`/`--orange`, `--red` for exactly that role. A chart
series painted in those hues reads as a status verdict ("red = broken") even
when it is just "series 3". For categorical series prefer the non-reserved
injected hues (e.g. `--purple`) and neutral ramps, or make the legend state
explicitly that hue is identity, not status. Status colors are for actual
status series (healthy/degraded/failed), always paired with a text label or
icon — never color alone.

Text sitting on a colored fill (badges, highlighted points, heat cells) takes
the darkest shade of that same color family — never plain black or a generic
gray, which drift against the fill in one theme or the other.

## Theme variables and canvas

Paint every mark from the variables the host injects (SKILL.md contract §2) so
the chart survives both themes; hardcoded hex is invisible or glaring in one
of them. `<canvas>` cannot resolve CSS variables: read each one once at init
with
`getComputedStyle(document.documentElement).getPropertyValue('--blue')`
and pass the resolved string into the chart configuration. Keep the chrome
recessive: `--border` for hairline gridlines, `--muted-foreground` for tick
labels, text in the foreground tokens. Text wears text colors, never the
series hue — identity is carried by a small colored swatch beside the label.

Mark specs:

- Bars ≤24px thick, 4px radius on the data end, square at the baseline.
- Lines 2px, round joins and caps; end-dots ≥8px filled with the series color
  and ringed 2px in the surface color.
- Area fills at ~10% opacity of the series hue.
- Gridlines 1px and one step off the surface; no vertical gridlines on a time
  axis.
- A 2px surface-colored gap between touching marks (stacked segments,
  adjacent bars) instead of strokes around marks.
- Big single numbers (stat tiles) use tabular numerals so digits do not jitter
  as values change.

## Canvas accessibility

Every `<canvas>` gets `role="img"`, a descriptive `aria-label` saying what the
chart shows, and fallback text between the tags carrying the actual values
(`Quarterly revenue: Q1 12, Q2 19, Q3 8, Q4 15.` is the shape). Without these
the chart does not exist for a screen reader.

And never rely on color alone to separate series: pair each hue with a second
channel — dash pattern for lines, marker shape for scatter, hatch or pattern
fill for bars and pie slices — and show both the color and the cue in the
legend. Chart.js exposes `borderDash` and `pointStyle` per dataset; SVG patterns
slot into `<defs>` and stay subtle (thin hatching, sparse dots).
