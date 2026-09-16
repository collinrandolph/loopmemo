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

**`--lr-rec-rgb` is a third bare triple and is *not* one of these.** Nothing in JavaScript reads
it; it exists so CSS can choose its own alpha — `rgba(var(--lr-rec-rgb), .45)` — for the four
surfaces that want a translucent record colour: the pending dot, the input note, the export error
and the armed row's inset rule. Those had each hardcoded the pre-theme red, so they stayed one hue
across all four colourways while everything around them changed. Breaking this one is visible
rather than silent: an invalid `rgba()` simply does not paint.

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
- **`disabled` states on `.lr-btn` and `.header-gear`** — the recording lock (§3.5). Two separate
  selectors, both at .35 opacity. A new sheet that styles only `.lr-btn` leaves the gear looking
  available while it is not.

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

**The record dot has three states, not four.** There was a fourth — empty + open got a pulsing
expanding ring (`lr-rec-hint`) meaning "record here" — and it is **removed**, from the kit and from
all three mockups. Two reasons, and the second is the one to remember:

- It was the record colour and it pulsed, which is exactly how `.is-armed` reads. A user reported
  an open empty layer looking armed or already recording when it was neither.
- Its selector was four classes, so it outranked `.is-armed` and `.is-pending` at three. On an
  empty open row — *the normal way to arm a layer* — the real states could not paint themselves:
  the armed dot stayed at the hint's paler red and did not pulse, and the pending dot never showed
  its own animation at all. About 25 lines in `ui/app.css` and an `is-arming` class existed purely
  to win that specificity fight, and were deleted with it.

The lesson generalises: **a hint keyed to a container state will outrank the element states it
sits on top of.** If you add one, give it a selector no more specific than the states it must
yield to, or it will quietly win.

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

## 8. Two surfaces, and tokens named for their role rather than their surface

The app is a **light body with a dark header and dark cards**. Every ink token therefore belongs to
exactly one of those surfaces, and reusing one across the divide fails silently in whichever
direction you got wrong — the text is still painted, still selectable, still the right size.

| Surface | Ink | Recessive ink | Strong ink |
|---|---|---|---|
| dark header / card | `--lr-ink` | `--lr-ink-dim`, `--lr-ink-faint` | — |
| light body | `--lr-label-ink` | `--lr-label-ink` | `--lr-label-strong` |

Four of these were shipped at once and all four were invisible or near it:

- `.lr-title` took `--lr-label-strong`. It lives in the dark header — **1.3:1**.
- `.setting-figure` took `--lr-ink`. It is the value a settings row is *set to*, on the body —
  **1.3:1**, so "96 BPM" and "Off" were the least readable text on the screen reporting them.
- `.export-title` / `.export-detail` were pulled into the body block by name. They are inside
  `.export-item`, a dark card — the option titles measured **1.00:1**, i.e. exactly invisible.
- `.lr-btn--danger` uses `--lr-rec`, which is chosen to sit on a dark card. Delete is on the body —
  **2.2:1**. `--lr-rec-ink` is the darkened version for that side.

**A class name does not tell you its surface.** `.export-note` and `.export-title` differ by one
word and sit on opposite ones. Ask the DOM, not the name.

### The audit

Paste into the console on each screen. It walks every leaf element with text, finds the nearest
ancestor that actually paints a background, and reports anything under 3:1. Gradient-backed
ancestors are skipped rather than guessed at, so the header reports nothing — check it by eye.

```js
const bg = el => { for (let e = el; e; e = e.parentElement) {
  const cs = getComputedStyle(e);
  if (cs.backgroundImage !== 'none') return 'GRADIENT';
  const m = cs.backgroundColor.match(/[\d.]+/g);
  if (m && (m.length < 4 || +m[3] > 0.5)) return m.slice(0, 3).map(Number);
} return [255, 255, 255]; };
const lum = c => { const f = c.map(v => (v /= 255) <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return .2126 * f[0] + .7152 * f[1] + .0722 * f[2]; };
for (const e of document.querySelectorAll('.lr-screen *')) {
  if (e.children.length || !e.textContent.trim()) continue;
  const cs = getComputedStyle(e);
  if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < .05) continue;
  const b = bg(e); if (b === 'GRADIENT') continue;
  const ink = e.tagName === 'svg' && cs.stroke !== 'none' ? cs.stroke : cs.color;
  const fg = ink.match(/[\d.]+/g).slice(0, 3).map(Number);
  const [a, z] = [lum(fg), lum(b)].sort((x, y) => y - x);
  const r = (a + .05) / (z + .05);
  if (r < 3) console.warn(e.className || e.tagName, JSON.stringify(e.textContent.trim().slice(0, 20)), r.toFixed(2));
}
```

**An icon's ink is `stroke`, not `color`** — the line above exists because the first version of
this checked only `color` and reported every screen clean while the footer's question mark was
cream on the light body, invisible. It shares a rule with the backing-track icons, which are on
dark cards and correctly keep the cream. Same two-surface trap as §8's table, in a property the
audit was not looking at.

Run it on all seven screens **in every colourway** — the four bodies differ in lightness, so a
token can clear the bar in Wine and fail in Moss. That is how `--lr-ink-faint` was set: L55 measured
2.5–2.7:1 against the card in all four, and L62 is the lowest step that clears 3:1 in every one.

## 9. Colourways

`ui/src/theme.ts` generates all four from **four numbers each** — a dark `[hue, sat]`, a light
`[hue, sat]`, an accent hue and a record hex — and writes `--lr-*` onto `document.documentElement`.
A fifth is four numbers, not a palette.

- **The picker applies the theme without re-rendering.** The tokens are on the root element, so
  every open screen restyles in place; rebuilding would stop a running preview to change a colour.
- **The ramp is not in here** (see §1). All four colourways share it.
- **A token defined anywhere below `:root` outranks the theme** for everything inside it.
  `--lr-accent` was hardcoded on `.lr-screen`, so the New Project button stayed violet in all four
  colourways and no theme could reach it. One definition per token.

## 10. Translucent white is fine; opaque white is not

`rgba(255,255,255,.1)` over a card is a **veil** — it lightens the card's own hue, so it moves with
the colourway for free. Most of the whites in `app.css` are that, and they are correct.

**Opaque and near-opaque white is a colour**, and it does not move. `rgba(255,255,255,.92)` on a
selected chip stayed pure white in Moss and Cobalt while the New Project button an inch away took
the theme's warm cream. The rule: **above about .5 alpha, use a token.** `--lr-play-bg` /
`--lr-play-ink` is the pair for anything that reads as "the light neutral", which is rung 1 of the
prominence ladder and what the selected state borrows.

**Measure a colour claim against a token, not against your eye.** A chip at 92% white and one at
`--lr-play-bg` look near-identical in Wine, which is where this residue survived four rounds of
restyling — it only separates in the other three colourways.

### And check for dead declarations while you are there

Three rules were still carrying pre-theme whites that had not painted since the colourways landed,
because a later rule of equal specificity replaced them: `.lr-settings`'s colour, `.lr-play--sm`'s
background and ink, and the whole of the since-removed tab bar's `.is-active`. **Confirm with a computed style
before deleting** — specificity reasoning is easy to get backwards, and the measurement is one line.

**A transition will lie to a measurement.** Several of these carry `transition: stroke .12s` or
`background .15s`, so a sweep that reads computed styles 250 ms after a click catches intermediate
values and reports failures that settle on their own. Wait it out, or the audit invents work.
