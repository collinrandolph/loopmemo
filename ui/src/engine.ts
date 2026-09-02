/**
 * The seam between a screen and whatever is making sound.
 *
 * A screen asks for a frame position and gets one; `audio.ts` implements this with a real audio
 * clock behind it. If a screen ever needs something here that a real engine could not give, the
 * platform-bound surface has grown past what the platform deferral assumed.
 */
export type Engine = {
  /** The rate frames are counted at — the project's, never the device's. */
  readonly sampleRate: number;
  frame(): number;
  running(): boolean;
  start(atFrame: number): void;
  stop(): void;
};
