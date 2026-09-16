import type { BarRef } from '../../src/domain/bar-ref.ts';
import { type PassIndex, regionFor } from '../../src/domain/pass-index.ts';
import type { Layer } from '../../src/domain/project.ts';
import { TAKE_URL_SCHEME } from './takes.ts';

/**
 * Waveform peaks, computed from audio that actually exists. Everything a real take draws comes
 * from here; `demo.ts`'s `amp()` covers only projects that never had samples.
 *
 * **Absolute maxima over a fixed frame window, not RMS.** An overview is read for *where the
 * playing is* — where a note starts, where a bar is empty — and RMS smooths exactly the
 * transients that answer that. It also keeps a single loud sample visible.
 */

/**
 * Frames per peak. 512 is ~86 per second, so an Edit Layer tile's 16 lines aggregate about 13
 * each at 96 BPM, and a 40-second take costs ~3,500 numbers rather than a copy of the audio.
 */
export const PEAK_FRAMES = 512;

/**
 * The curve from amplitude to drawn height. **Nothing here touches audio** — it shapes the
 * picture, and the same peaks feed a mixdown at their true value.
 *
 * A comfortably audible take peaks around 0.2–0.4, which drawn literally is a few pixels in a box
 * sized for 1.0, so the lane reads as flat. **A power curve rather than a gain, because a gain
 * has to clip**: a linear 2.5× draws everything above 0.4 identically, so a healthy take and a
 * clipping one look the same. `peak ** 0.5` is monotonic over the whole range, and the clamp
 * below guards an overshoot rather than doing work.
 *
 * The cost is that it lifts the bottom too — room tone at 0.005 draws at 0.07 — which is the
 * honest trade for seeing a quiet take, and better than a gate deciding what counts as silence.
 * None of it substitutes for recording at a sensible level (§6.1, still open).
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
 * **Indexed on the region, which is indexed on the source** — a slot showing pass 4's bar 2 draws
 * pass 4's bar 2, which is §1.1's two indices at the level of one line. It goes through
 * `regionFor` because that is the only place a `BarRef` becomes a session and a frame range.
 *
 * Undefined when the bar has no captured audio, so the caller can choose: the demo projects have
 * sessions with no samples, and drawing them flat would make the Library look broken.
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

  // **A take that captured nothing must draw as nothing**, or a session recorded with a refused
  // microphone comes back covered in a waveform of audio that never existed. The URL scheme
  // separates them: `take:` peaks are the truth even when empty, `sim://` has no samples.
  const captured = session.audioFileURL.startsWith(TAKE_URL_SCHEME);
  if (session.waveformPeaks.length === 0) return captured ? 0 : undefined;
  return drawnHeight(
    peakAt(session.waveformPeaks, region.startFrame, region.frameCount, lineIndex, lineCount),
  );
}

function peakAt(
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
