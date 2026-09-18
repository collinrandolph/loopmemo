/**
 * Colourways, generated rather than hand-written.
 *
 * Ported from the "Loop Recorder Directions" mockup, which settled the structure: one set of
 * relationships, four base hues, and **four numbers per variation** — a dark family `[hue, sat]`
 * for the header and cards, a light family for the body, an accent hue, and a chosen record hex.
 * Everything else is derived at fixed lightnesses, so adding a fifth is four numbers and not a
 * palette.
 *
 * The relationships, most to least prominent, are the mockup's "prominence ladder":
 * dark low-chroma header (L≈17–25) → card one step up (L≈30) → recessed / muted / armed derived
 * from it → light near-neutral body and play button (L≈81) → dusty mid button and track (L≈72) →
 * cream ink on dark, dark base-hue ink on light → a near-grey accent (L≈65) → one saturated
 * record hue.
 *
 * **The waveform ramp is deliberately not here.** It is a wide non-repeating spectrum encoding
 * recording position (§1.1), shared by every colourway, and earlier rounds of the mockup muted it
 * "to match the palette" and buried the feature. `docs/kit/restyling.md` says the same. Do not
 * bring it into the palette.
 */

export type ThemeId = 'wine' | 'moss' | 'cobalt' | 'indigo';

type Variation = {
  readonly id: ThemeId;
  readonly name: string;
  /** Dark family: the header, the cards, and everything recessed from them. */
  readonly dh: number;
  readonly ds: number;
  /** Light family: the app body and the play button. */
  readonly lh: number;
  readonly ls: number;
  /** Accent hue, held to very low chroma so it reads as a tint rather than a colour. */
  readonly ah: number;
  readonly rec: string;
  /** Overrides the derived body colour where a variation wants a different warmth. */
  readonly bg?: string;
  readonly note: string;
};

export const THEMES: readonly Variation[] = [
  {
    id: 'wine',
    name: 'Wine',
    dh: 330, ds: 20, lh: 16, ls: 16, ah: 20, rec: '#DE424C',
    note: 'A warm red-violet. Header plum, cards oxblood, body a warm putty, accent a soft taupe.',
  },
  {
    id: 'moss',
    name: 'Moss',
    dh: 106, ds: 18, lh: 84, ls: 16, ah: 98, rec: '#E4544A', bg: '#E5E3CF',
    // The body is deliberately warmer and yellower than the others' neutral greige, so the green
    // reads sun-warmed rather than clinical.
    note: 'A warm olive-green. Header deep moss, cards grass, body a pale cream.',
  },
  {
    id: 'cobalt',
    name: 'Cobalt',
    dh: 220, ds: 25, lh: 218, ls: 14, ah: 222, rec: '#F2574B',
    note: 'A true blue — no green, no violet. The record vermilion is the base’s complement.',
  },
  {
    id: 'indigo',
    name: 'Indigo',
    dh: 250, ds: 24, lh: 248, ls: 14, ah: 250, rec: '#EA5570',
    note: 'A blue-violet, the nearest neighbour to the app’s violet heritage, held to one accent.',
  },
];

export const DEFAULT_THEME: ThemeId = 'wine';

/** HSL to hex, so a variation is four numbers rather than a list of colours. */
function hslHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lum = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lum, 1 - lum);
  const f = (n: number) => lum - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) =>
    Math.round(255 * x)
      .toString(16)
      .padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return `#${x
    .map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * The `--lr-*` tokens for one variation.
 *
 * **`--lr-spent` and `--lr-spent-sel` are bare `r,g,b` triples, not hex.** `LR.ramp.tokenRGB`
 * parses them with `split(',').map(Number)`, so hex makes every played waveform line
 * `rgb(NaN,NaN,NaN)` and nothing throws. `docs/kit/restyling.md` leads with this.
 *
 * `--lr-grad-start` / `--lr-grad-end` now describe the **header**, not the whole screen — the
 * body underneath is light. `--lr-line-w` and `--lr-line-gap` are absent on purpose: `LR.sizing`
 * writes those at runtime and a theme must not fight it.
 */
function tokens(v: Variation): Record<string, string> {
  const card = hslHex(v.dh, v.ds - 3, 30);
  const sel = hslHex(v.dh, v.ds + 4, 22);
  const body = v.bg ?? hslHex(v.lh, Math.min(v.ls, 8), 81);
  const button = hslHex(v.lh, v.ls + 12, 72);
  const ink = hslHex(v.lh, Math.min(v.ls + 26, 40), 93);
  const ink2 = hslHex(v.lh, v.ls + 10, 76);
  // L62 rather than the mockup's 55: this is the recessive ink on a card, and it carries the size
  // readout and both swipe hints at 9–11px. 55 measures 2.5–2.7:1 against the card in all four
  // colourways; 62 is the lowest step that clears 3:1 in every one, Moss included, and it is still
  // two clear steps below `--lr-ink-dim`.
  const ink3 = hslHex(v.dh, 12, 62);
  const accent = hslHex(v.ah, 15, 65);
  // The body's own ink, named here because the flat rows derive three tokens from it (2026-09-18).
  const labelInk = hslHex(v.dh, 15, 34);

  return {
    // Outside the screen, and the screen's own body.
    '--lr-page': mix(body, '#ffffff', 0.35),
    '--lr-body': body,
    // The header gradient. Two stops of the dark family.
    '--lr-grad-start': hslHex(v.dh, v.ds, 17),
    '--lr-grad-end': hslHex(v.dh, v.ds - 2, 25),

    // Card surfaces, and the states recessed from them.
    '--lr-tile': card,
    '--lr-tile-hover': hslHex(v.dh, v.ds - 3, 34),
    '--lr-tile-sel': sel,
    '--lr-tile-muted': hslHex(v.dh, 8, 30),
    '--lr-tile-muted-sel': mix(hslHex(v.dh, 8, 30), sel, 0.55),
    '--lr-tile-armed': mix(card, v.rec, 0.34),
    '--lr-tile-empty': hslHex(v.dh, v.ds - 8, 28),
    '--lr-tile-rec': mix(card, v.rec, 0.46),

    // Ink on the dark surfaces.
    '--lr-ink': ink,
    '--lr-ink-dim': ink2,
    '--lr-ink-faint': ink3,
    '--lr-ink-pass': accent,
    '--lr-hint': ink3,
    '--lr-hint-sel': ink2,

    // Ink and lines on the light body.
    '--lr-ink-on-light': hslHex(v.dh, v.ds, 18),
    '--lr-label-ink': labelInk,
    '--lr-label-strong': sel,
    '--lr-label-line': `hsla(${v.dh}, ${v.ds}%, 25%, 0.22)`,
    /**
     * The light-body surfaces the flat rows introduced (design study v27, 2026-09-18). Backing
     * tracks, Layers and the Projects list lost their card fill, so every state that used to be a
     * step off `--lr-tile` is now a step off the *body*, and mixing the old card-toned values onto
     * it would read as a darker card rather than a state.
     *
     * **Armed and recording are two washes, not one** (§3.5): armed has captured nothing yet, so it
     * is a hint; recording is the same row gone live and sits deeper. Both are mixes of the body
     * rather than of the card, so dark-on-light ink stays legible over them — measured, not assumed.
     */
    '--lr-armed-soft': mix(body, v.rec, 0.16),
    '--lr-rec-wash': mix(body, v.rec, 0.36),
    /** The panel a row opens: one shade behind the body, enough to read as a step and no more. */
    '--lr-panel-surface': mix(body, '#000000', 0.03),
    /** The record control's resting target and the dot inside it, both on the body. */
    '--lr-rec-idle-bg': mix(body, labelInk, 0.12),
    '--lr-rec-idle': hslHex(v.dh, 13, 48),

    // The things you act on.
    '--lr-accent': accent,
    '--lr-accent-hi': hslHex(v.ah, 15, 71),
    '--lr-btn-bg': button,
    '--lr-btn-ink': hslHex(v.dh, v.ds, 18),
    '--lr-play-bg': body,
    '--lr-play-ink': hslHex(v.dh, v.ds, 20),
    '--lr-track': button,

    // The one hot mark. `--lr-rec` is chosen to sit on a dark card; on the light body it measures
    // ~2.2:1, so the light side gets a darkened version rather than borrowing it.
    '--lr-rec': v.rec,
    '--lr-rec-ink': mix(v.rec, '#000000', 0.42),
    // A bare triple so CSS can pick its own alpha — `rgba(var(--lr-rec-rgb), .45)`. Four surfaces
    // wanted a translucent record colour and each had hardcoded the pre-theme violet-era red, so
    // the pending dot and the two failure notes stayed the same hue in all four colourways.
    // Not parsed by JavaScript, unlike `--lr-spent`; it just has to be a valid `rgba()` argument.
    '--lr-rec-rgb': rgb(v.rec).join(', '),
    '--lr-rec-glow': `rgba(${rgb(v.rec).join(',')}, 0.30)`,

    // Parsed as numbers by JS. Bare triples only.
    '--lr-spent': rgb(ink2).join(','),
    '--lr-spent-sel': rgb(mix(ink2, sel, 0.42)).join(','),
    /**
     * **A third spent target, because a third surface appeared.** `--lr-spent` is tuned to the dark
     * tile and `--lr-spent-sel` to the selected one; the Playback lanes and the Library thumbnails
     * now draw on the light body, where a played line receding toward a pale card ink disappears.
     * It recedes into the row's own text colour instead. Bare triple — `ramp.tokenRGB` parses it.
     */
    '--lr-spent-lane': rgb(labelInk).join(','),
  };
}

/** A swatch for the picker: hue-forward, because the real accent is nearly grey. */
export function swatch(v: Variation): string {
  return hslHex(v.dh, Math.min(v.ds + 24, 46), 46);
}

export function theme(id: ThemeId): Variation {
  return THEMES.find((v) => v.id === id) ?? THEMES[0]!;
}

/** Write a colourway onto the document. The only thing that changes an app-wide colour. */
export function applyTheme(id: ThemeId): void {
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(tokens(theme(id)))) {
    style.setProperty(name, value);
  }
  document.documentElement.dataset['theme'] = id;
}
