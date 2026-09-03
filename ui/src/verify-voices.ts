import { createProject, projectTiming } from '../../src/domain/project.ts';
import { loopFrames } from '../../src/domain/timing.ts';
import { renderOffline } from './render.ts';
import { takeStore } from './takes.ts';

/**
 * The §6.1 backing-voice A/B, measured rather than argued (**temporary — delete with the loser**).
 *
 * Three things worth knowing before judging by ear:
 *
 * 1. **The policies actually differ.** If `cap` and `choke` render the same, the toggle is not
 *    wired and any preference you form is imaginary.
 * 2. **By how much, per chord pattern.** The claim is that a capped chord is pre-shortened, so it
 *    has already faded where a choked one is still singing — that should show as more energy.
 * 3. **Choke does not click.** A choke is a 5 ms ramp on a dedicated output gain, so the worst
 *    sample-to-sample step should not grow. A click is a step.
 *
 * Run from the console:
 *
 *     const m = await import('/ui/dist/ui/src/verify-voices.js');
 *     await m.verifyVoices();
 */
type Hook = { lrVoices?: string | undefined };

async function underPolicy(policy: string, chordPatternId: string, tone: string) {
  const before = (globalThis as Hook).lrVoices;
  (globalThis as Hook).lrVoices = policy;
  try {
    const base = createProject({ id: 'v', name: 'V', bpm: 120, barCount: 4, quality: 'standard' });
    const project = {
      ...base,
      backing: {
        drums: { ...base.backing.drums, muted: true },
        chords: {
          ...base.backing.chords,
          muted: false,
          level: 1,
          chordPatternId,
          tone: tone as typeof base.backing.chords.tone,
        },
      },
    };
    const t = projectTiming(project);
    const frames = loopFrames(t);
    const rendered = await renderOffline(project, project.backing, takeStore(), frames);

    const d = rendered.getChannelData(0);
    let sum = 0;
    let peak = 0;
    let worstStep = 0;
    for (let i = 0; i < d.length; i++) {
      sum += d[i]! * d[i]!;
      if (Math.abs(d[i]!) > peak) peak = Math.abs(d[i]!);
      if (i > 0) worstStep = Math.max(worstStep, Math.abs(d[i]! - d[i - 1]!));
    }
    return {
      rms: Number(Math.sqrt(sum / d.length).toFixed(5)),
      peak: Number(peak.toFixed(5)),
      worstStep: Number(worstStep.toFixed(5)),
    };
  } finally {
    (globalThis as Hook).lrVoices = before;
  }
}

export async function verifyVoices() {
  const cases: { pattern: string; tone: string }[] = [
    { pattern: 'steady-quarters', tone: 'rhodes' },
    { pattern: 'fast-8th-note', tone: 'rhodes' },
    { pattern: 'sparse-half-note', tone: 'pad' },
    { pattern: 'sustain', tone: 'pad' },
  ];

  const rows = [];
  for (const c of cases) {
    const cap = await underPolicy('cap', c.pattern, c.tone);
    const choke = await underPolicy('choke', c.pattern, c.tone);
    rows.push({
      pattern: c.pattern,
      tone: c.tone,
      capRms: cap.rms,
      chokeRms: choke.rms,
      // >1 means choke leaves more energy in the loop, i.e. the chords are still ringing where
      // the cap had already faded them.
      ringsLonger: Number((choke.rms / Math.max(cap.rms, 1e-9)).toFixed(2)),
      capWorstStep: cap.worstStep,
      chokeWorstStep: choke.worstStep,
    });
  }

  const differ = rows.every((r) => r.capRms !== r.chokeRms);
  // A choke is a 5 ms ramp, so it must not make the waveform any more discontinuous than the cap.
  const noNewClicks = rows.every((r) => r.chokeWorstStep <= r.capWorstStep * 1.5 + 0.01);

  return { rows, policiesDiffer: differ, chokeAddsNoSteps: noNewClicks, pass: differ && noNewClicks };
}
