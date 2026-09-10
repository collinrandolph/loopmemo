/**
 * Inline icons, all from **Lucide** (ISC). Path data is inlined rather than depended on, since
 * this repo carries no runtime dependencies.
 *
 * Lucide's 24-unit box, 2px stroke and round caps are already what the shared `.backing-icon,
 * .lr-help svg` rule declares, so they drop straight in. **Take any new icon from the same set**
 * — that is the whole reason they look like each other.
 *
 * `keyboard-music` rather than Lucide's `piano`: the latter is a grand piano in silhouette and
 * needs its outline to be read, which at 20px it does not get — side by side in the row it reads
 * as a bag. Compared at size rather than chosen from the icon sheet.
 */

/** Lucide `drum`. */
export const DRUM_ICON =
  '<path d="m2 2 8 8"/><path d="m22 2-8 8"/><ellipse cx="12" cy="9" rx="10" ry="5"/>' +
  '<path d="M7 13.4v7.9"/><path d="M12 14v8"/><path d="M17 13.4v7.9"/>' +
  '<path d="M2 9v8a10 5 0 0 0 20 0V9"/>';

/** Lucide `keyboard-music`. */
export const PIANO_ICON =
  '<rect width="20" height="16" x="2" y="4" rx="2"/>' +
  '<path d="M6 8h4"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M2 12h20"/>' +
  '<path d="M6 12v4"/><path d="M10 12v4"/><path d="M14 12v4"/><path d="M18 12v4"/>';

/**
 * Lucide `move-vertical` — the swipe-axis hint on a `swipeWheel`.
 *
 * The same shape as the `↕` it replaces, and it replaces it because **a text glyph cannot be
 * centred reliably.** `↕` paints 2.5px below the centre of its own line box (its ink runs 9px
 * above the baseline and 3px below, so its visual middle is not the baseline-derived middle) and
 * overflows a `line-height: 1` box by 2px. No amount of `align-items: center` fixes that, since
 * the box is centred correctly and the ink inside it is not — and any hardcoded nudge would be a
 * correction for one font, when this is whatever the platform's system font happens to be.
 *
 * An SVG's box *is* its art, so centring it centres what you see.
 */
export const SWIPE_Y_ICON =
  '<path d="M12 2v20"/><path d="m8 18 4 4 4-4"/><path d="m8 6 4-4 4 4"/>';

/** Lucide `settings` — the way into a project's settings from the Playback header. */
export const SETTINGS_ICON =
  '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>' +
  '<circle cx="12" cy="12" r="3"/>';

/** Lucide `circle-question-mark`, wrapped because it is used on its own rather than in a row. */
export const HELP_ICON =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/>' +
  '<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>';
