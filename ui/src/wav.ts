/**
 * WAV, written by hand.
 *
 * **The browser cannot encode MP3 and this repo carries no runtime dependencies**, so the web
 * build's only real option is linear PCM — see `docs/audio-loop-recorder-spec.md` §2.7 and the
 * note in `export-files.ts`. WAV happens to be the format that needs no library at all: a 44-byte
 * header and the samples.
 *
 * **Bit depth follows the project's quality, not the format.** §2.7 makes Standard 16-bit and
 * High 24-bit, and an export that quietly widened Standard to 24 would inflate the file by half
 * while adding nothing — the extra bits would be zero-padding of a 16-bit capture.
 */

export type BitDepth = 16 | 24;

/**
 * Interleave and quantise. Float −1..1 to a signed integer of `depth` bits.
 *
 * **Clamped before rounding, and rounded rather than truncated.** A sample at exactly 1.0 scales
 * to 32768, which does not fit a signed 16-bit word and wraps to full-scale *negative* — one
 * sample of maximum-amplitude noise, audible as a tick, from material that was merely loud.
 * Truncation instead of rounding would add a half-LSB DC offset across the whole file.
 */
function quantise(buffer: AudioBuffer, depth: BitDepth): DataView<ArrayBuffer> {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = depth / 8;
  const view = new DataView(new ArrayBuffer(frames * channels * bytes));
  const peak = 2 ** (depth - 1);
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));

  let at = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const clamped = Math.max(-1, Math.min(1, data[c]![i]!));
      const value = Math.round(clamped * (peak - 1));
      if (depth === 16) {
        view.setInt16(at, value, true);
      } else {
        // 24-bit has no DataView accessor; three little-endian bytes, two's complement.
        const u = value < 0 ? value + 0x1000000 : value;
        view.setUint8(at, u & 0xff);
        view.setUint8(at + 1, (u >> 8) & 0xff);
        view.setUint8(at + 2, (u >> 16) & 0xff);
      }
      at += bytes;
    }
  }
  return view;
}

function ascii(view: DataView<ArrayBuffer>, at: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
}

/** A canonical 44-byte RIFF/WAVE header followed by the samples. */
export function encodeWav(buffer: AudioBuffer, depth: BitDepth = 16): Blob {
  const samples = quantise(buffer, depth);
  const channels = buffer.numberOfChannels;
  const blockAlign = channels * (depth / 8);
  const header = new DataView(new ArrayBuffer(44));

  ascii(header, 0, 'RIFF');
  header.setUint32(4, 36 + samples.byteLength, true);
  ascii(header, 8, 'WAVE');
  ascii(header, 12, 'fmt ');
  header.setUint32(16, 16, true); // PCM fmt chunk length
  header.setUint16(20, 1, true); // format 1 = linear PCM
  header.setUint16(22, channels, true);
  header.setUint32(24, buffer.sampleRate, true);
  header.setUint32(28, buffer.sampleRate * blockAlign, true); // byte rate
  header.setUint16(32, blockAlign, true);
  header.setUint16(34, depth, true);
  ascii(header, 36, 'data');
  header.setUint32(40, samples.byteLength, true);

  return new Blob([header, samples], { type: 'audio/wav' });
}
