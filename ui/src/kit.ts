/**
 * Typed handle on `docs/kit/lr-kit.js`, which is a classic script exposing `window.LR`.
 *
 * The kit owns **presentation** — the colour ramp, the motion model, line sizing, and the
 * components. Its `timing` and `Transport` are deliberately *not* re-exported here: those are
 * the pieces `src/domain` replaces, and importing both would put two implementations of the
 * same rules on one screen, which is the drift the spec warns about (§1.5).
 */

export type Rgb = [number, number, number];

export type WaveNode = HTMLDivElement & {
  build(count: number, spec: (i: number, t: number) => { height: number; rgb: Rgb }): HTMLElement[];
  lines(): HTMLElement[];
  paint(line: HTMLElement, passed: number, scale: number | null, spent: Rgb, floorPx?: number): void;
};

export type VolumeNode = HTMLButtonElement & { update(): void };

type Kit = {
  clamp01(v: number): number;
  ramp: {
    rgb(t: number): Rgb;
    css(t: number): string;
    slice(i: number, n: number): [number, number];
    toSpent(rgb: Rgb, t: number, spent: Rgb): string;
    tokenRGB(name: string): Rgb;
  };
  motion: {
    COLOR_FEATHER: number;
    TAU: Record<string, number>;
    approach(value: number, target: number, tau: number, dt: number): number;
    playScale(passed: number): number;
    swipeScale(activation: number): number;
    snapEven(px: number, min: number): number;
  };
  sizing: {
    fitToWidth(containerPx: number, targetLines: number, minCount?: number): { width: number; count: number };
    fitToCount(containerPx: number, lineCount: number, minWidth?: number): { width: number; count: number };
    apply(width: number): void;
  };
  el(tag: string, cls?: string, html?: string): HTMLElement;
  fmtTime(sec: number): string;
  Waveform(opts: { variant?: string }): WaveNode;
  VolumeControl(opts: {
    level(): number;
    muted(): boolean;
    onToggle(): void;
    large?: boolean;
  }): VolumeNode;
};

export const LR = (window as unknown as { LR: Kit }).LR;
export const { el, ramp, motion, sizing, clamp01 } = LR;
