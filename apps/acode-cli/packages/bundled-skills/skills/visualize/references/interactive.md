# Interactive widgets — controls, state, motion

## State that survives a re-render

The host can re-render a card (theme change, conversation restore, scrolling
recycling). `window.acodeViz.getWidgetState(key)` and
`setWidgetState(key, value)` are an in-memory key-value shim that lives as long
as the card: persist slider positions, toggle states, the current stepper
index, and filter selections through it, and restore from it during init so a
re-render never resets the user's view. Values must be JSON-serializable. This
shim is not storage — the sandbox has no same-origin storage at all (see
mockup.md), so nothing survives the card itself.

## Control budget

Every control must visibly change the graphic in the same frame it is
operated. A slider that only edits a caption is prose dressed as a control —
put that sentence in the response text instead. Prefer two or three meaningful
controls (rate, threshold, stage) over a panel of toggles. All computation is
local JS: `connect-src 'none'` means there is no server to ask, ever — inline
the data and derive from it.

Filtering, sorting, toggling, and recalculating belong in JS inside the
widget. What the widget cannot do — interpret, recommend, continue the
conversation — belongs in your response text, not in a dead button.

## Scripts and load order

- A library `<script src>` (the vendored Mermaid/Chart.js paths or an
  allowlisted CDN — SKILL.md contract §1) must appear **before** any inline
  script that uses its global. Code above its source tag runs against
  `undefined` and throws.
- Select your own root by its unique `id` with `document.getElementById` —
  never `document.currentScript` (SKILL.md contract §1).
- Draw into visible, in-flow containers. The host injects a height reporter
  that re-measures your content, so an async layout change is picked up — but
  a chart rendered inside a zero-height or hidden container measures zero and
  stays blank.
- Do not fight the height reporter: no nested scroll areas, no fixed-height
  shells with internal overflow. The card grows to your content; let it.

## Motion

- Animate meaning, not decoration. A looping animation says "this is running";
  a one-shot transition says "this changed". Infinite ambient motion inside a
  conversation is noise competing with the text.
- Honor reduced motion **inside the fragment** with your own
  `@media (prefers-reduced-motion: reduce)` block that kills or freezes every
  animation. Be aware of the boundary: the host app's in-app reduce-motion
  preference lives on the host document's root (`data-acode-reduce-motion`)
  and does **not** cross into the sandboxed iframe — the OS-level media query
  is the only reduce signal your fragment can see, so gate on it.
- Keep state-change transitions ≤300ms; long, springy, or playful motion does
  not belong next to an operational chat.

## Steppers and multi-stage widgets

For a cyclic or staged process the stepper is the default form (diagram.md —
never a ring). Rules:

- The stage list stays visible at all times (a row of numbered chips or a
  sidebar list); the current stage is emphasized by weight, background, or a
  marker — not by color alone.
- Advancing mutates classes and text on the existing DOM and writes
  `setWidgetState('stage', i)`; never an `innerHTML` rebuild of the widget
  (it drops listeners and resets focus).
- Stage chips are real `<button>` elements, so Tab and keyboard activation
  work without extra code; icon-only buttons carry `aria-label`.
- Validate any input before the stage advances (SKILL.md floor; mockup.md has
  the inline-error pattern).
