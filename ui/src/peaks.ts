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
 * **0.35, lowered from 0.5 on 2026-09-16** after use on an iPhone: takes that sounded at a good
 * level drew relatively flat, because a phone microphone with `autoGainControl` off peaks nearer
 * 0.05–0.2 than the 0.2–0.4 this was first tuned for. In a 34px Playback lane:
 *
 *     peak      0.005  0.02  0.05  0.1   0.2   0.4   0.7   1
 *     ^ 0.5     2px    5px   8px   11px  15px  22px  28px  34px
 *     ^ 0.35    5px    9px   12px  15px  19px  25px  30px  34px
 *
 * The cost is the one this curve always had, a little more of it: room tone at 0.005 now draws
 * 5px rather than 2. 0.3 would lift a normal take slightly more and start drawing near-silence as
 * signal. This one number shapes every waveform in the app — lanes, tiles, the live line and the
 * level scaling below — so it is the knob to turn if they still read flat.
 */
export const PEAK_DISPLAY_EXPONENT = 0.35;

/** Amplitude to drawn fraction of the box. */
export function drawnHeight(peak: number): number {
  if (!(peak > 0)) return 0;
  return Math.min(1, peak ** PEAK_DISPLAY_EXPONENT);
}

/**
 * A drawn height with the layer's level applied — Playback lanes **and** Edit Layer tiles.
 *
 * **The level scales the amplitude, and the curve then applies as usual**, so a lane shows what the
 * mix will do with the take: `drawnHeight(peak × level)`, which for a power curve is exactly
 * `drawnHeight(peak) × level ** PEAK_DISPLAY_EXPONENT`. Written in the second form because the demo
 * projects' synthetic `amp()` is already a drawn fraction with no peak behind it, and one formula
 * has to serve both. +6 dB therefore draws 2^0.35 ≈ 1.27× taller, not twice, and clips at the box.
 *
 * **Not mute.** A muted layer keeps its picture — flattening it would throw away the only view of
 * what is behind the mute, and per-bar mute already has its own drawn treatment. **Not master**,
 * which is monitoring (§4.2).
 *
 * **Edit Layer was first left out** (2026-09-16, the same day) on the argument that its tiles
 * compare passes of one layer at one level and are read for shape, which a quiet layer would lose.
 * Using the app reversed it: a fader that changes one screen's picture and not the other's reads as
 * two different layers, and every tile on the grid shares the level, so the comparison between
 * passes is unaffected.
 */
export function levelScaledHeight(drawn: number, level: number): number {
  return Math.min(1, drawn * Math.max(0, level) ** PEAK_DISPLAY_EXPONENT);
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
