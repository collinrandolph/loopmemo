import { createProject, projectTiming } from '../../src/domain/project.ts';
import { audioEngine } from './audio.ts';
import { setAudioSessionEnabled } from './audio-session.ts';
import { takeStore } from './takes.ts';

/**
 * Does the engine declare the audio session category §2.2 asks for, at the edges it names?
 *
 * **What this can and cannot say.** Only WebKit has `navigator.audioSession`, and whether iOS then
 * keeps the speaker playing with the switch on silent is a device question — §2.2 lists five of
 * them and none can be answered here. What *can* be checked on this machine is the part that is
 * ours: the sequence of categories the engine requests as a take is armed, run and stopped, and
 * that nothing is requested at all while the setting is off. A stand-in `audioSession` records
 * every assignment; the engine runs the real path with `getUserMedia` stubbed to an oscillator,
 * the same way `verifyCaptureFrames` does.
 *
 *     const m = await import('/ui/dist/ui/src/verify-audio-session.js');
 *     await m.verifyAudioSession();
 */
export async function verifyAudioSession() {
  const nav = navigator as Navigator & { audioSession?: unknown };
  const had = Object.getOwnPropertyDescriptor(nav, 'audioSession');
  const log: string[] = [];
  let type = 'auto';
  Object.defineProperty(nav, 'audioSession', {
    configurable: true,
    value: {
      get type() {
        return type;
      },
      set type(next: string) {
        type = next;
        log.push(next);
      },
    },
  });

  const rate = 44100;
  const project = createProject({ id: 'as', name: 'AS', bpm: 240, barCount: 4, quality: 'standard' });
  const t = projectTiming(project);

  const source = new AudioContext({ sampleRate: rate });
  const dest = source.createMediaStreamDestination();
  const osc = source.createOscillator();
  osc.connect(dest);
  osc.start();
  const media = navigator.mediaDevices;
  const realGetUserMedia = media.getUserMedia.bind(media);
  media.getUserMedia = async () => dest.stream;

  async function scenario(enabled: boolean) {
    setAudioSessionEnabled(enabled);
    log.length = 0;
    type = 'auto';
    const engine = audioEngine(rate);
    const marks: Record<string, string> = {};
    try {
      engine.setBacking(project.backing, t);
      engine.setLayers(project, takeStore());
      marks['afterMount'] = type;
      engine.start(0);
      marks['afterPlay'] = type;
      engine.stop();
      await engine.openInput();
      marks['afterArm'] = type;
      engine.start(0);
      marks['afterTakeStartsTransport'] = type;
      await engine.startCapture();
      marks['duringTake'] = type;
      await new Promise((r) => setTimeout(r, 300));
      await engine.stopCapture();
      marks['afterStop'] = type;
      engine.start(0);
      marks['afterPlayWithInputOpen'] = type;
    } finally {
      engine.destroy();
    }
    marks['afterDestroy'] = type;
    return { marks, requests: [...log] };
  }

  let on: Awaited<ReturnType<typeof scenario>>;
  let off: Awaited<ReturnType<typeof scenario>>;
  try {
    on = await scenario(true);
    off = await scenario(false);
  } finally {
    setAudioSessionEnabled(false);
    media.getUserMedia = realGetUserMedia;
    osc.stop();
    void source.close();
    if (had) Object.defineProperty(nav, 'audioSession', had);
    else delete (nav as { audioSession?: unknown }).audioSession;
  }

  const m = on.marks;
  const claims = {
    // Mounting a screen is not a gesture; §2.2 says never at load.
    nothingAtMount: m['afterMount'] === 'auto',
    playbackOnPlay: m['afterPlay'] === 'playback',
    recordCategoryOnArm: m['afterArm'] === 'play-and-record',
    // The transport starts a moment before the capture; flipping back to playback in between could
    // end the live input track.
    noFlipBetweenTransportAndCapture: m['afterTakeStartsTransport'] === 'play-and-record',
    recordCategoryDuringTake: m['duringTake'] === 'play-and-record',
    playbackAfterStop: m['afterStop'] === 'playback',
    playbackStaysWithInputOpen: m['afterPlayWithInputOpen'] === 'playback',
    playbackWhenInputReleased: m['afterDestroy'] === 'playback',
    // The comparison is only fair if "Default" asks for nothing at all.
    offRequestsNothing: off.requests.length === 0,
  };
  return { on, off, claims, pass: Object.values(claims).every(Boolean) };
}
