import type { BarRef } from '../../src/domain/bar-ref.ts';
import { type PassIndex, regionFor } from '../../src/domain/pass-index.ts';
import type { Layer } from '../../src/domain/project.ts';
import { TAKE_URL_SCHEME } from './takes.ts';

/**
 * Waveform peaks, computed from audio that actually exists.
 *
 * `RecordingSession.waveformPeaks` has been in the domain since the beginning and was always
 * empty, so every waveform on screen came from `sim.ts`'s `amp()` — a deterministic function of
 * the layer index and the bar number. That was fine while nothing had been recorded and actively
 * wrong the moment something had: the lanes drew a confident, detailed waveform bearing no
 * relation to the take, which is worse than drawing nothing. A display that invents its content
 * is not a placeholder, it is a lie with a plausible shape.
 *
 * **Peaks are absolute maxima over a fixed frame window, not RMS.** A waveform overview is read
 * for *where the playing is* — where a note starts, where a bar is empty — and RMS smooths
 * exactly the transients that answer it. It also means a single loud sample is visible, which is
 * what a clipping check wants.
 */

/**
 * Frames per peak. 512 gives ~86 peaks per second, so the 16 lines of an Edit Layer tile
 * aggregate about 13 peaks each at 96 BPM — enough that a line means something, few enough that
 * a 40-second take costs about 3,500 numbers rather than a copy of the audio.
 */
export const PEAK_FRAMES = 512;

/**
 * The curve from amplitude to drawn height. **Nothing here touches audio** — it shapes the
 * picture, not the signal, and the same peaks feed a mixdown at their true value.
 *
 * A take that is comfortably audible sits nowhere near full scale. Recording at a sensible level
 * leaves peaks around 0.2–0.4, which drawn literally is a few pixels in a box sized for 1.0, so
 * the lane read as flat and said nothing about where the playing was — the one thing an overview
 * is for.
 *
 * **A power curve rather than a gain, because a gain has to clip and this does not.** A linear
 * 2.5× reached full height at 0.4 and drew everything above it identically, so a healthy take
 * and one that was clipping looked the same, and the top 60% of the range carried no
 * information at all. `peak ** 0.5` is monotonic over the whole range: every amplitude maps to
 * its own height, loud is still distinguishable from louder, and the clamp below is a guard
 * against an overshoot rather than a working part of the curve.
 *
 * It also spends the pixels where the signal actually is. Against a literal drawing it roughly
 * triples a quiet passage and barely moves a loud one:
 *
 * | peak | literal | 2.5× | `√` |
 * |---|---|---|---|
 * | 0.02 | 0.02 | 0.05 | 0.14 |
 * | 0.10 | 0.10 | 0.25 | 0.32 |
 * | 0.30 | 0.30 | 0.75 | 0.55 |
 * | 0.60 | 0.60 | 1.00 | 0.77 |
 * | 1.00 | 1.00 | 1.00 | 1.00 |
 *
 * The cost is that it lifts the very bottom too: room tone at 0.005 draws at 0.07 rather than
 * 0.01, so near-silence is a thin line rather than nothing. That is the honest trade for seeing
 * a quiet take, and it is preferable to a noise gate here — a threshold would decide for the
 * user which of their playing counted as silence.
 *
 * None of this is a substitute for recording at a sensible level; see §6.1 on input gain
 * staging, which is the actual cause and still open.
 */
export const PEAK_DISPLAY_EXPONENT = 0.5;

/** Amplitude to drawn fraction of the box. */
export function drawnHeight(peak: number): number {
  if (!(peak > 0)) return 0;
  return Math.min(1, peak ** PEAK_DISPLAY_EXPONENT);
}

export function computePeaks(buffer: AudioBuffer, framesPerPeak = PEAK_FRAMES): number[] {
  const data = buffer.getChannelData(0);
  const out: number[] = [];
  for (let at = 0; at < data.length; at += framesPerPeak) {
    let peak = 0;
    const end = Math.min(at + framesPerPeak, data.length);
    for (let i = at; i < end; i++) {
      const v = data[i]! < 0 ? -data[i]! : data[i]!;
      if (v > peak) peak = v;
    }
    out.push(peak);
  }
  return out;
}

/**
 * One line's amplitude for a bar of a layer, resolved through the domain.
 *
 * **Indexed on the region, which is indexed on the source** — so a slot showing pass 4's bar 2
 * draws pass 4's bar 2, and swiping the slot redraws it with that pass's material. That is §1.1's
 * two indices at the level of a single line: position on screen comes from the slot, content
 * comes from the source, and collapsing them would draw every slot alike.
 *
 * `regionFor` is the only place a `BarRef` becomes a session and a frame range, and it stays the
 * only place — a waveform that worked out its own offsets would be the second derivation the
 * whole of `pass-index.ts` exists to prevent, and it is the derivation that once asked for frame
 * 5,292,000 of a 3,528,000-frame file.
 *
 * Undefined when that bar has no captured audio behind it, so the caller can choose: the demo
 * projects have sessions with no samples at all, and drawing them flat would make the Library
 * look broken rather than simulated.
 */
export function barAmplitude(
  layer: Layer,
  index: PassIndex,
  ref: BarRef,
  lineIndex: number,
  lineCount: number,
): number | undefined {
  const region = regionFor(index, ref);
  if (!region) return undefined;
  const session = layer.sessions[region.sessionIndex];
  if (!session) return undefined;

  // **A take that captured nothing must draw as nothing.** Falling through to the synthetic
  // generator here would reproduce the exact fault this replaced, in the one case where it
  // matters most: a session recorded with a refused microphone would come back covered in a
  // detailed waveform of audio that was never captured. The URL scheme is what separates the
  // two — `take:` was recorded by this build, so its peaks are the truth even when empty,
  // while a demo project's `sim://` session has no samples and never claimed to.
  const captured = session.audioFileURL.startsWith(TAKE_URL_SCHEME);
  if (session.waveformPeaks.length === 0) return captured ? 0 : undefined;
  return drawnHeight(
    peakAt(session.waveformPeaks, region.startFrame, region.frameCount, lineIndex, lineCount),
  );
}

export function peakAt(
  peaks: readonly number[],
  startFrame: number,
  frameCount: number,
  lineIndex: number,
  lineCount: number,
  framesPerPeak = PEAK_FRAMES,
): number {
  if (peaks.length === 0 || frameCount <= 0 || lineCount <= 0) return 0;

  const from = startFrame + (lineIndex / lineCount) * frameCount;
  const to = startFrame + ((lineIndex + 1) / lineCount) * frameCount;
  const first = Math.floor(from / framesPerPeak);
  // At least one peak per line even when a line is narrower than the peak window, which happens
  // on the Library thumbnail and would otherwise draw an empty strip.
  const last = Math.max(first, Math.ceil(to / framesPerPeak) - 1);

  let peak = 0;
  for (let i = first; i <= last && i < peaks.length; i++) {
    if (i >= 0 && peaks[i]! > peak) peak = peaks[i]!;
  }
  return peak;
}
