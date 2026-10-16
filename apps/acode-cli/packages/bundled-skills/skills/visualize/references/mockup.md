# Mockups — UI replicas that behave like ACode

## Read the design vocabulary first

`references/design-tokens.md` is generated from this repository's `DESIGN.md`:
the type scale, spacing rhythm, radius ladder, and control-size baselines the
real ACode UI follows. A mockup that respects those proportions reads as
ACode; a mockup with marketing-scale padding reads as a landing page. Mind the
boundary: the fragment sandbox does **not** contain the app's `--color-*`
variables or `text-ui-*` utilities — use the generated file as a numeric and
ratio source, and paint with the theme variables the host injects (SKILL.md
contract §2).

The design language in one paragraph: dense and operational; calm surfaces;
text hierarchy before borders and colors; a 4px spacing rhythm; restrained
radius (the first rounded container is the largest, nested containers step
down); shadows only on floating overlays; semantic colors only for semantic
states.

## The card sizes itself to your content — plan around it

The host measures your fragment's in-flow height and grows the card to fit.
Three consequences kill naive mockups:

- **`position: fixed` contributes no in-flow height.** An overlay built with
  `fixed` collapses the card. Build modal and overlay mockups as a normal-flow
  faux viewport: a wrapper `<div>` with an explicit `min-height` (say 420px),
  the dim background on the wrapper, and the dialog centered inside with flex.
  The wrapper is the "screen"; it behaves like one because it has real height.
- **`100vh` means the iframe's current height**, which is derived from your
  content — a circular dependency that resolves to a collapsed card. Use
  explicit px heights or in-flow sizing.
- **There is no fullscreen surface.** Never build fullscreen/expand controls
  on `requestFullscreen` — inside the sandbox the API is unavailable and the
  button is dead on arrival. If the user asks for "expandable", build an
  expanded-layout toggle: a synchronous class flip on in-flow content with
  explicit px sizes (taller canvas, roomier rows), updating the button's own
  label in the same handler, symmetric enter and exit. Mutate the existing
  elements — never rebuild the control's DOM with `innerHTML`, which silently
  drops its listeners and leaves a dead button.

## Sandbox reality — dead APIs, disclosed up front

The card iframe runs `sandbox="allow-scripts"` only, plus an injected CSP:

- **No same-origin storage**: `localStorage`, `sessionStorage`,
  `document.cookie`, and IndexedDB access all throw. Widget state goes through
  `window.acodeViz.getWidgetState/setWidgetState` (see interactive.md).
- **No network**: `connect-src 'none'` — `fetch`, XHR, and WebSocket fail
  silently. Inline all data (≤1 MiB total; aggregate, bin, or downsample
  first).
- **No forms, popups, or top navigation**: `form-action 'none'` means a `<form>`
  submit goes nowhere; `window.open` and `target="_blank"` are dead. A mockup
  form's submit button runs a JS handler that validates and updates the
  mockup — never a real navigation.
- **Links do not reach the user's browser**: popups and top navigation are
  blocked, and a plain in-frame navigation would replace your card's content.
  Treat links in mockups as visual elements; if a click must do something,
  wire a JS handler with `preventDefault()`.

## Fidelity checklist

- Real copy, not lorem: the labels the actual feature would use, at realistic
  lengths. ACode is internationalized — do not build a layout only short
  English survives; leave room for ~30% longer strings.
- Controls in a mockup validate before they advance: a required empty field
  shows a small inline error next to the control and blocks the next step; the
  error clears as soon as the user edits the field.
- The one-sentence sr-only summary at the top of the fragment (SKILL.md
  accessibility floor).
- Both themes: every color from the injected variables. Mental check — if the
  background flipped to near-black, would every label still read?
- Density over decoration: a mockup of an operational surface should look
  like the real thing — compact rows, quiet surfaces, hierarchy through text
  weight and color, not through borders on everything.
