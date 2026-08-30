import { PAN_ICON_ARCS, type PanPreset } from '../../src/domain/effects.ts';
import type { EqPresetId } from '../../src/domain/eq.ts';

/**
 * The picker icons (§2.8). Presentation only — the arc counts come from `PanPreset.icon`, and
 * these curves are drawn for contrast between presets rather than from the filter response.
 */

const EQ_CURVES: Record<EqPresetId, string> = {
  flat: 'M 5 24 L 43 24',
  lowCut: 'M 5 37 C 13 37 13 24 21 24 L 43 24',
  highCut: 'M 5 24 L 27 24 C 35 24 35 37 43 37',
  presence: 'M 5 24 L 10 24 C 17 24 17 11 24 11 C 31 11 31 24 38 24 L 43 24',
  scoop: 'M 5 24 L 10 24 C 17 24 17 37 24 37 C 31 37 31 24 38 24 L 43 24',
  distant: 'M 5 37 L 9 37 C 14 37 14 24 19 24 L 29 24 C 34 24 34 37 39 37 L 43 37',
};

export function eqIconSvg(id: EqPresetId, size = 22): string {
  return (
    `<svg viewBox="0 0 48 48" width="${size}" height="${size}" style="display:block">` +
    `<path d="${EQ_CURVES[id]}" fill="none" stroke="currentColor" stroke-width="2.6"` +
    ` stroke-linecap="round" stroke-linejoin="round"/></svg>`
  );
}

const RADII = [10, 14.5, 19];
const HALF_DEGREES = 52;

function arc(r: number, side: 'L' | 'R'): string {
  const rad = (HALF_DEGREES * Math.PI) / 180;
  const dx = r * Math.cos(rad);
  const dy = r * Math.sin(rad);
  const x = (side === 'R' ? 24 + dx : 24 - dx).toFixed(2);
  return `M ${x} ${(24 - dy).toFixed(2)} A ${r} ${r} 0 0 ${side === 'R' ? 1 : 0} ${x} ${(24 + dy).toFixed(2)}`;
}

export function panIconSvg(preset: PanPreset, size = 22): string {
  let body = '';
  for (const [side, lit] of [['L', preset.icon.left], ['R', preset.icon.right]] as const) {
    for (let i = 0; i < PAN_ICON_ARCS; i++) {
      const on = i < lit;
      body +=
        `<path d="${arc(RADII[i]!, side)}" fill="none" stroke="currentColor"` +
        ` stroke-width="2.2" stroke-linecap="round" opacity="${on ? 1 : 0.28}"/>`;
    }
  }
  return (
    `<svg viewBox="0 0 48 48" width="${size}" height="${size}" style="display:block">` +
    `${body}<circle cx="24" cy="24" r="4" fill="currentColor"/></svg>`
  );
}
