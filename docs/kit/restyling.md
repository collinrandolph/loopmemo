# Restyling this app without breaking it

Read this before changing `docs/kit/lr-kit.css`, `ui/app.css` or the tokens in `:root`.

Most of the styling here is ordinary and safe to replace. What follows is the part that is not:
colour that carries information, values JavaScript parses, styles JavaScript overwrites, and CSS
rules that gate *behaviour* rather than appearance. Every one of these fails silently — the app
still renders, it just stops meaning what it meant.

---

## 1. Colour that is information, not decoration

### The 11-anchor ramp is the Edit Layer screen's whole feature

`LR.ramp.ANCHORS` is a warm→cool gradient, and §1.1 hangs on it: a bar's colour indexes on its
**source**, so smooth colour flow across tiles means the bars are still in recorded order and a
**colour jump means that bar was pulled from another pass**. That is the feature. §4.7 calls
reading the gradient the manual's highest-value entry.

Constraints, in order of how badly breaking them hurts:

- **It must be monotonic in hue and traverse a wide arc.** The kit's own note says an
  orange-to-purple ramp *hid the joins* — adjacent anchors were too close to tell apart, so a
  jump stopped reading as a jump. Warm through green and blue to violet is load-bearing.
- **Adjacent anchors must be distinguishable at a 3px line width.** That is the size these are
  actually seen at.
- **Each layer owns `ramp.slice(i, 7)`** — one seventh of the ramp — so a project is recognisable
  by its colour signature in the Library before the name is read. Seven bands have to stay
  separable from each other *and* have enough internal spread to show a jump within one layer.
  Compressing the ramp trades one against the other.

### The four export kind dots are hardcoded hex, not tokens

`.export-kind.is-loop` `#7CE08E` · `.is-stem` `#7AA8FF` · `.is-stem-fx` `#C69BFF` · `.is-pass`
`var(--lr-ink-faint)`. They are the only thing distinguishing four file kinds in the manifest.
Restyle them to one colour and the list stops being readable.

### `--lr-rec` is the only non-violet in the palette, on purpose

Red is "this is live". It carries the armed pulse, the recording square, the row tint
(`--lr-tile-armed`, `--lr-tile-rec`), the pass badge background, and the empty-row record hint.
A palette without a colour that is clearly *not* the rest of the palette loses the one state the
user must never mistake.

---

## 2. Two tokens are parsed as numbers by JavaScript

```css
--lr-spent:     173,152,214;   /* NOT #AD98D6 */
--lr-spent-sel: 140,133,175;
```

`LR.ramp.tokenRGB` does `getPropertyValue(name).split(',').map(Number)`. Write these as hex or as
`rgb(...)` and every waveform line gets `rgb(NaN,NaN,NaN)` the moment the playhead passes it.
Nothing throws.

**There are two because the spent target depends on the surface underneath.** `--lr-spent` sits on
the default violet tile; `--lr-spent-sel` sits on the darker selected tile (`--lr-tile-sel`).
Setting them equal makes played lines on a selected tile read wrong. If you change the tile
colours, these two have to move with them.

A spent line must stay *visible against its tile* while being clearly less prominent than an
unplayed one. It is not "faded to background" — it is a second, quieter colour.

---

## 3. Styles JavaScript overwrites every frame

CSS rules on these properties are dead. Do not add them; do not expect them to win.

| Element | Property | Written by |
|---|---|---|
| `.lr-wave__line` | `color` **and** `transform` | `Waveform.paint`, every animation frame |
| `.lr-wave__line` | `height` | `Waveform.build` |
| `.lr-panel` | `max-height` | `syncCollapse` |
| `.backing .lr-row` | `opacity` (1 or 0.62) | `backing-rows.ts`, from `isAudibleInMixdown` |
| `:root` | `--lr-line-w`, `--lr-line-gap` | `LR.sizing.apply`, at runtime |
| `.lr-screen` | `--tile-h`, `--tile-wave-h`, `--layer-label-w` | `syncTileHeight`, `syncLabelWidth` |
| `.export-error`, `.input-note` | `display` | their screens |

**`.lr-wave__line` uses `background: currentColor`.** The line's fill comes from its `color`
property, which JS sets from the ramp. Give the line a `background` in CSS and every waveform in
the app turns that one colour.

Declaring `--lr-line-w` in `:root` only sets the first frame; `sizing.apply` overwrites it on
`documentElement`. **`--lr-line-w` and `--lr-line-gap` must stay equal** — the sizing model assumes
it.

---

## 4. CSS rules that gate behaviour

Deleting or restyling these changes what the app *does*.

- **`.tile { touch-action: none }`** — this is what stops the browser eating a vertical drag before
  it can step the pass axis (§3.7). Remove it and the vertical swipe stops working on touch.
- **`.tile { min-width: 0 }`** — a grid item defaults to `min-width: auto`, and the tile's content
  is a waveform whose line width is derived *from the tile's width*. That is a feedback loop: one
  measurement taken while the row is briefly too wide locks it wide permanently.
- **`.lr-row.is-armed .lr-wave__line:not(.is-live)`, same for `.is-recording` → `display: none`** —
  this is what hides a layer's committed lane for the length of a take, so the live waveform draws
  alone. Lose it and the two draw on top of each other.
- **`.lr-rows.is-capturing .lr-row:not(.is-recording) .lr-rec { visibility: hidden; pointer-events:
  none }`** — "a pass in progress owns the input" (§3.5). `visibility`, not `display`, deliberately:
  the space is kept so nothing shifts when the pass ends.
- **`.lr-panel-row.is-inert { opacity: .4; pointer-events: none }`** — part of the tempo/bar-count
  lock (§1.2). The JS guard exists too, but this is what makes it unreachable.
- **`.lr-panel { overflow: hidden }`** — required for the measured `max-height` collapse.
- **`.lr-row:not(.has-audio) [data-needs-audio] { display: none }`** — changes the panel's content
  height, which `syncCollapse` measures. Fine to keep, but any rule that changes panel height must
  not animate, or the measurement catches it mid-flight.
- **`.is-measuring` and `.is-measuring-badge`** — applied for one synchronous measurement in
  `syncLabelWidth`, then removed in the same frame. They must make the label auto-width and swap
  the name for the badge. Restyle them and the label column is sized from the wrong box.
- **`disabled` states on `.lr-btn`, `.header-gear` and `.app-nav button`** — the recording lock
  (§3.5). Three separate selectors, all at .35 opacity. A new sheet that styles only `.lr-btn`
  leaves the gear and the tab bar looking available while they are not.

---

## 5. States that are more numerous than they look

An LLM given "make it darker" will usually collapse these. Each pair below is a distinction the
user has to be able to make at a glance.

**Tile (Edit Layer)** — five surfaces plus hover:

| Class | Token | Note |
|---|---|---|
| default | `--lr-tile` | |
| `:hover` | `--lr-tile-hover` | |
| `.is-selected` | `--lr-tile-sel` | **Recedes, does not brighten** — selection is a well, not a highlight. Has its own spent colour. |
| `.is-muted` | `--lr-tile-muted` | |
| `.is-muted.is-selected` | `--lr-tile-muted-sel` | The fourth combination is a real state and needs its own value. |

Ink over a selected tile needs its own contrast: `--lr-hint` vs `--lr-hint-sel` exist for exactly
this, and `.tile.is-selected .tile-label` brightens to `--lr-ink`.

**Layer row (Playback)** — `is-empty` · `is-armed` · `is-recording` · `is-muted` · `is-open` ·
`has-audio`, and they combine. Armed and recording differ in **colour and shape**: the dot goes
circle → square (`border-radius: 4px`, `transform: scale(.78)`) and the pulse stops. Keep both
signals; colour alone is not enough for the one control that must never be misread.

**Record dot has a fourth state**: empty + open gets a pulsing expanding ring
(`lr-rec-hint`) to say "record here", explicitly suppressed once armed or recording.

**`.lr-pass-badge.is-provisional`** — opacity .45, meaning "this pass has not been earned yet"
(§1.4). Not decoration; it is a preview of whether the take will survive the stop.

**Chips** — `.is-active` is *selection*, moved by `bindChips` delegating on the enclosing
`.lr-chips`. `.is-unavailable` is MP3, and must read as **"not here"** rather than "never":
greyed and present, not removed. No chip may call `stopPropagation`, or the highlight stops
following the selection.

**Backing rows** carry no `has-audio` and never will. Any rule scoped by it must be scoped to
`.lr-rows` as well, or it silently applies to the drum and chord rows too.

---

## 6. Geometry that looks cosmetic and is not

- **Line heights are snapped to even numbers** so a capsule's centreline lands on a whole pixel
  (§3.3). `motion.snapEven` does it; a stylesheet that introduces an odd `--lr-line-w` fights it.
- **Height collapses use real height, never `scaleY`** — a scaled capsule's `border-radius: 999px`
  deforms into an ellipse. This is why a muted tile's lines shrink to a dot floor by height.
  `paint` writes a `scaleY` for the *played* recession only, where the range is small.
- **Interiors of a bar row are square on purpose**: only the first and last tile in a row get a
  radius. Rounding every corner produced a Hermann-grid shimmer at the seams.
- **`--lr-seam: 2px`** is the gap that makes four tiles read as four bars rather than one strip.

---

## 7. A quick check after restyling

Nothing here is covered by tests — `ui/` has none, by design. Drive the browser:

1. Open Edit Layer on a recorded layer. Tiles 3 and 4 of the demo project are pulled from pass 4:
   **the colour jump must be obvious.**
2. Play a bar. Played lines must recede in height *and* shift to the spent colour — if they turn
   black or vanish, `--lr-spent` is no longer a bare rgb triple.
3. Select a tile and play it. The spent colour on the dark selected surface must still be legible.
4. Arm a layer, then record. The old lane must disappear, every other record dot must vanish while
   keeping its space, and the nav tabs, gear, Export, Projects and Edit Layer must all dim.
5. Drag vertically on a tile. If the page scrolls instead of stepping the pass, `touch-action` is
   gone.
6. Open a layer panel and a backing panel. Both must animate the full distance, not jump.
