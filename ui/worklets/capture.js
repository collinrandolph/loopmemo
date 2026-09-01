/**
 * PCM capture, on the audio thread.
 *
 * Plain JS and outside `ui/src` on purpose: an `AudioWorkletProcessor` is loaded by URL into a
 * separate global scope, not imported, so it is never part of the module graph `tsc` builds.
 *
 * **`currentFrame` is why this is a worklet rather than a `ScriptProcessorNode`.** The worklet
 * global scope exposes the context's own sample-frame counter, so every chunk can be stamped
 * with the exact frame its first sample belongs to. Reading `ctx.currentTime` on the main thread
 * instead means asking a different clock, after an unknown delay, and rounding the answer — and
 * §2.4's whole position on clocks is that the engine's frame count is the authority.
 *
 * `ScriptProcessorNode` would also run this on the main thread, where a layout or a garbage
 * collection is a dropout.
 */

/** 32 render quanta. Fewer, larger messages rather than one per 128 frames. */
const CHUNK = 4096;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.chunk = new Float32Array(CHUNK);
    this.filled = 0;
    /** Frame of the first sample currently held in `chunk`. */
    this.chunkFrame = 0;
    this.port.onmessage = ({ data }) => {
      if (data === 'start') {
        this.on = true;
        this.filled = 0;
      } else if (data === 'stop') {
        this.on = false;
        this.flush();
        this.port.postMessage({ done: true });
      }
    };
  }

  flush() {
    if (this.filled === 0) return;
    // Sliced, not sent whole: the receiver keeps it, and this buffer is about to be reused.
    this.port.postMessage({ frame: this.chunkFrame, samples: this.chunk.slice(0, this.filled) });
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!this.on || !channel) return true;

    for (let i = 0; i < channel.length; i++) {
      if (this.filled === 0) this.chunkFrame = currentFrame + i;
      this.chunk[this.filled++] = channel[i];
      if (this.filled === CHUNK) this.flush();
    }
    return true;
  }
}

registerProcessor('lr-capture', CaptureProcessor);
