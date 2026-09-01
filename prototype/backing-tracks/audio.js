// Chord + drum synthesis engine for the backing-tracks prototype. Plain script, no build step —
// same as patterns.js.
//
// The drum voices here are synthesized (kick/snare/hat, one recipe each). This started as an
// experiment against a settled one-shot-sample design; after listening it won, and synthesis is
// now the decided approach — spec §2.6, which no longer describes sampling at all. The recipes
// below are therefore a reference to port, not a proof of concept to evaluate.
//
// Four chord tone recipes (Rhodes, Pad, Wurly, Organ), one root+quality+octave -> frequency
// resolver, and one shared scheduler that walks both the drum pattern's per-voice onsets and
// the chord pattern's strike/chunk onsets off a single time anchor, so the two tracks play in
// sync rather than as two independently-clicked, inevitably-drifting transports.

let audioCtx = null;
let masterInput = null; // every voice connects here, never straight to ctx.destination
let isPlaying = false;
let scheduledVoices = []; // { nodes: AudioNode[], disconnectAt: epoch-ms }
let cleanupTimer = null;
let refillTimer = null;
let playStartTime = 0; // audioCtx time
let nextBarToSchedule = 0;
let currentParams = null;

// Keep at most this many bars' worth of voices scheduled ahead at once, topped up on an
// interval — avoids both a giant up-front scheduling batch and any audible gap.
const BARS_AHEAD = 8;
const TOPUP_INTERVAL_MS = 1000;

function ensureContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (!masterInput) {
    // A chord is 3-4 simultaneous notes, and some tones use 2-3 oscillators per note, so a
    // dense pattern can easily have 8-12+ raw oscillators sounding at once, plus overlapping
    // tails from the previous onset. Summed directly into ctx.destination that clips — hard
    // digital clipping, which is exactly a harsh, arrhythmic, high-frequency-heavy screech,
    // because distortion doesn't respect envelopes or timing. Every voice must go through
    // this compressor, never straight to the destination.
    const compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 12;
    compressor.ratio.value = 14;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    const headroom = audioCtx.createGain();
    headroom.gain.value = 0.5;
    compressor.connect(headroom);
    headroom.connect(audioCtx.destination);
    masterInput = compressor;
  }
  return audioCtx;
}

// ---- pitch resolution -------------------------------------------------------
// Root sits at MIDI 60 (C4) before the octave wheel is applied — the spec's assumed
// mid-register default, and exactly octave 0 on the wheel. Standard 12-tone equal temperament.
const LETTER_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACCIDENTAL_OFFSET = { natural: 0, flat: -1, sharp: 1 };
const QUALITY_INTERVALS = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  dom7: [0, 4, 7, 10],
  min7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
};

function chordFrequencies(root, quality, octaveShift) {
  const semitoneFromC = LETTER_SEMITONE[root.letter] + ACCIDENTAL_OFFSET[root.accidental];
  const baseMidi = 60 + semitoneFromC + octaveShift * 12;
  return QUALITY_INTERVALS[quality].map(
    (interval) => 440 * Math.pow(2, (baseMidi + interval - 69) / 12),
  );
}

// ---- voice bookkeeping -------------------------------------------------------
// Cleanup has to be anchored to the voice's actual scheduled end (startTime + duration, in
// audioCtx time), not to Date.now() at the moment it was scheduled — the scheduler works up to
// BARS_AHEAD bars ahead of real playback, so "now" at scheduling time can be many seconds
// before the voice actually starts. Anchoring to wall-clock "now" instead disconnected voices
// before they ever played. Date.now() and ctx.currentTime both advance at the same real-time
// rate, so the gap between "when this voice ends" and "ctx.currentTime right now" converts
// directly to a wall-clock delay from this instant.
function trackVoice(ctx, nodes, startTime, durationSeconds) {
  const msUntilDone = (startTime - ctx.currentTime) * 1000 + durationSeconds * 1000 + 200;
  scheduledVoices.push({ nodes, disconnectAt: Date.now() + Math.max(0, msUntilDone) });
}

function sweepFinishedVoices() {
  const now = Date.now();
  scheduledVoices = scheduledVoices.filter((v) => {
    if (v.disconnectAt > now) return true;
    for (const n of v.nodes) {
      try { n.disconnect(); } catch (e) { /* already disconnected */ }
    }
    return false;
  });
}

function stopAllVoices() {
  for (const v of scheduledVoices) {
    for (const n of v.nodes) {
      try { if (n.stop) n.stop(); } catch (e) { /* not started yet, or already stopped */ }
      try { n.disconnect(); } catch (e) { /* already disconnected */ }
    }
  }
  scheduledVoices = [];
}

// ---- tone recipes -------------------------------------------------------------
// Each returns { nodes, duration }. Articulation is an envelope choice, not a different sound:
// "chunk" forces a short, quieter, damped release regardless of what the tone would normally do.

function playRhodes(ctx, dest, freq, startTime, articulation, maxRingSeconds) {
  const isChunk = articulation === 'chunk';
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const bark = ctx.createOscillator(); // the tine's bright attack transient
  bark.type = 'sine';
  bark.frequency.value = freq * 2;
  const barkGain = ctx.createGain();
  const mainGain = ctx.createGain();
  // Tremolo has to be multiplicative (a gain stage in series, oscillating around 1), not added
  // straight into mainGain.gain — an additive ±0.06 wobble is a fixed absolute amount no matter
  // how quiet the envelope has decayed to, so it dwarfs the signal right as it's fading out and
  // reads as a stutter instead of a smooth tremolo. In series, it scales down with the note.
  const tremoloGain = ctx.createGain();
  tremoloGain.gain.value = 1;
  const tremolo = ctx.createOscillator();
  tremolo.type = 'sine';
  tremolo.frequency.value = 4.5;
  const tremoloDepth = ctx.createGain();
  tremoloDepth.gain.value = 0.06;

  osc.connect(mainGain);
  bark.connect(barkGain);
  barkGain.connect(mainGain);
  tremolo.connect(tremoloDepth);
  tremoloDepth.connect(tremoloGain.gain);
  mainGain.connect(tremoloGain);
  tremoloGain.connect(dest);

  const peak = isChunk ? 0.22 : 0.3;
  // Clamped to the gap until this pattern's next onset (see computeOnsetGaps) so a dense
  // pattern can never leave several onsets' worth of this note overlapping the next ones.
  const duration = Math.min(isChunk ? 0.12 : 1.5, maxRingSeconds);

  // Breakpoints are fractions of `duration`, not fixed offsets — a fixed 0.35s/0.8s breakpoint
  // would land *after* a duration clamped shorter than that, which is an invalid (non-monotonic)
  // automation sequence. Scaling with duration keeps every case valid by construction.
  mainGain.gain.setValueAtTime(0.0001, startTime);
  mainGain.gain.linearRampToValueAtTime(peak, startTime + Math.min(isChunk ? 0.004 : 0.008, duration * 0.2));
  if (isChunk) {
    mainGain.gain.setValueAtTime(peak, startTime + duration * 0.3);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  } else {
    mainGain.gain.exponentialRampToValueAtTime(peak * 0.45, startTime + duration * 0.3);
    mainGain.gain.setValueAtTime(peak * 0.45, startTime + duration * 0.65);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  }
  barkGain.gain.setValueAtTime(peak * 0.5, startTime);
  barkGain.gain.exponentialRampToValueAtTime(0.0001, startTime + Math.min(isChunk ? 0.05 : 0.18, duration));

  const stopAt = startTime + duration + 0.05;
  osc.start(startTime); osc.stop(stopAt);
  bark.start(startTime); bark.stop(stopAt);
  tremolo.start(startTime); tremolo.stop(stopAt);

  return { nodes: [osc, bark, barkGain, mainGain, tremolo, tremoloDepth, tremoloGain], duration };
}

function playPad(ctx, dest, freq, startTime, articulation, maxRingSeconds) {
  const isChunk = articulation === 'chunk';
  const mainGain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = isChunk ? 900 : 1800;
  filter.Q.value = 0.7;

  const oscs = [-6, 0, 6].map((cents) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    o.detune.value = cents;
    o.connect(filter);
    return o;
  });
  filter.connect(mainGain);
  mainGain.connect(dest);

  const peak = isChunk ? 0.16 : 0.22;
  const duration = Math.min(isChunk ? 0.15 : 2.2, maxRingSeconds);

  // Fractions of duration, same reasoning as Rhodes — a fixed 0.5s/1.1s breakpoint can't
  // outlive a duration clamped shorter than that.
  mainGain.gain.setValueAtTime(0.0001, startTime);
  if (isChunk) {
    mainGain.gain.linearRampToValueAtTime(peak, startTime + Math.min(0.01, duration * 0.2));
    mainGain.gain.setValueAtTime(peak, startTime + duration * 0.3);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  } else {
    // Slow attack and release are the whole identity here — the swell IS the tone.
    mainGain.gain.linearRampToValueAtTime(peak, startTime + duration * 0.25);
    mainGain.gain.setValueAtTime(peak, startTime + duration * 0.55);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  }

  const stopAt = startTime + duration + 0.05;
  for (const o of oscs) { o.start(startTime); o.stop(stopAt); }

  return { nodes: [...oscs, filter, mainGain], duration };
}

function playOrgan(ctx, dest, freq, startTime, articulation, maxRingSeconds) {
  const isChunk = articulation === 'chunk';
  const harmonics = [1, 2, 3, 4];
  const drawbarGains = [1, 0.5, 0.28, 0.16];
  const mainGain = ctx.createGain();
  mainGain.connect(dest);

  const oscs = harmonics.map((h, i) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq * h;
    const g = ctx.createGain();
    g.gain.value = drawbarGains[i];
    o.connect(g);
    g.connect(mainGain);
    return o;
  });

  const peak = isChunk ? 0.14 : 0.18;
  const duration = Math.min(isChunk ? 0.1 : 1.0, maxRingSeconds);

  // Near-instant attack, flat sustain while "held", quick release — an organ doesn't decay
  // while a key is down, which is most of what makes it read as an organ. The sustain-hold
  // point is a fraction of duration so the "quick release" stays quick (and valid) at any
  // clamped duration, not just the nominal 1.0s/0.1s.
  mainGain.gain.setValueAtTime(0.0001, startTime);
  mainGain.gain.linearRampToValueAtTime(peak, startTime + Math.min(0.004, duration * 0.15));
  mainGain.gain.setValueAtTime(peak, startTime + duration * (isChunk ? 0.75 : 0.9));
  mainGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  const stopAt = startTime + duration + 0.05;
  for (const o of oscs) { o.start(startTime); o.stop(stopAt); }

  return { nodes: [...oscs, mainGain], duration };
}

// A gentle, bounded soft-clip curve for the Wurly's reed "growl" — a real Wurlitzer reed
// distorts slightly when struck, which is a good deal of what makes it read as a Wurly rather
// than a Rhodes. tanh saturates smoothly and can never blow up regardless of how many voices
// sum into it or how long playback runs — no shared state between calls, no feedback, so none
// of the accumulation risk the Karplus-Strong loop had. Normalized so full-scale input maps to
// full-scale output (no free gain from the curve itself).
const WURLY_CURVE = (() => {
  const n = 1024;
  const k = 2.2; // drive amount — enough for character, not enough to sound like fuzz
  const curve = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
})();

function playWurly(ctx, dest, freq, startTime, articulation, maxRingSeconds) {
  const isChunk = articulation === 'chunk';
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freq;

  const shaper = ctx.createWaveShaper();
  shaper.curve = WURLY_CURVE;
  shaper.oversample = '2x';

  // A brighter, faster-decaying transient than the Rhodes' bark — punchier, at the third
  // partial rather than the octave, closer to a reed's actual attack.
  const bark = ctx.createOscillator();
  bark.type = 'sine';
  bark.frequency.value = freq * 3;
  const barkGain = ctx.createGain();

  const mainGain = ctx.createGain();
  // Multiplicative tremolo, same reasoning as Rhodes: in series so it scales down with the
  // note's own decay, instead of an additive wobble whose fixed depth dwarfs the signal once
  // the envelope has faded quiet — that mismatch is what read as a stutter.
  const tremoloGain = ctx.createGain();
  tremoloGain.gain.value = 1;
  const tremolo = ctx.createOscillator();
  tremolo.type = 'sine';
  tremolo.frequency.value = 5.5;
  const tremoloDepth = ctx.createGain();
  tremoloDepth.gain.value = 0.07;

  osc.connect(shaper);
  shaper.connect(mainGain);
  bark.connect(barkGain);
  barkGain.connect(mainGain);
  tremolo.connect(tremoloDepth);
  tremoloDepth.connect(tremoloGain.gain);
  mainGain.connect(tremoloGain);
  tremoloGain.connect(dest);

  const peak = isChunk ? 0.2 : 0.26;
  // Shorter and punchier than the Rhodes (1.5s) — a Wurly doesn't bloom and sustain the same
  // way, it's a quicker, more percussive decay.
  const duration = Math.min(isChunk ? 0.12 : 1.1, maxRingSeconds);

  mainGain.gain.setValueAtTime(0.0001, startTime);
  mainGain.gain.linearRampToValueAtTime(peak, startTime + Math.min(isChunk ? 0.003 : 0.005, duration * 0.15));
  if (isChunk) {
    mainGain.gain.setValueAtTime(peak, startTime + duration * 0.25);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  } else {
    mainGain.gain.exponentialRampToValueAtTime(peak * 0.35, startTime + duration * 0.2);
    mainGain.gain.setValueAtTime(peak * 0.35, startTime + duration * 0.5);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  }
  barkGain.gain.setValueAtTime(peak * 0.65, startTime);
  barkGain.gain.exponentialRampToValueAtTime(0.0001, startTime + Math.min(isChunk ? 0.03 : 0.1, duration));

  const stopAt = startTime + duration + 0.05;
  osc.start(startTime); osc.stop(stopAt);
  bark.start(startTime); bark.stop(stopAt);
  tremolo.start(startTime); tremolo.stop(stopAt);

  return { nodes: [osc, shaper, bark, barkGain, mainGain, tremolo, tremoloDepth, tremoloGain], duration };
}

const TONE_PLAYERS = { Rhodes: playRhodes, Pad: playPad, Wurly: playWurly, Organ: playOrgan };

function triggerChord(ctx, dest, tone, frequencies, startTime, articulation, maxRingSeconds) {
  const player = TONE_PLAYERS[tone];
  for (const freq of frequencies) {
    const { nodes, duration } = player(ctx, dest, freq, startTime, articulation, maxRingSeconds);
    trackVoice(ctx, nodes, startTime, duration);
  }
}

// ---- drum voices --------------------------------------------------------------
// One recipe each for kick, snare and hat, with the kit supplying the parameters. Deliberately
// minimal — the character comes from the kit's numbers, not from more voices.

function createNoiseBuffer(ctx, seconds) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function playKick(ctx, dest, startTime, kick) {
  // The standard synthesized-kick trick: a sine that sweeps fast from a bright starting pitch
  // down to the sub thud, plus a very short click at the very front for attack — a pure sweep
  // with no click reads as boomy/weak, not as a hit. `kick` is the current kit's parameters.
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  const mainGain = ctx.createGain();
  osc.connect(mainGain);
  mainGain.connect(dest);

  const click = ctx.createOscillator();
  click.type = 'square';
  click.frequency.value = kick.clickFreq;
  const clickGain = ctx.createGain();
  click.connect(clickGain);
  clickGain.connect(dest);

  const duration = kick.duration;
  osc.frequency.setValueAtTime(kick.startFreq, startTime);
  osc.frequency.exponentialRampToValueAtTime(kick.endFreq, startTime + kick.sweepTime);

  mainGain.gain.setValueAtTime(0.0001, startTime);
  mainGain.gain.linearRampToValueAtTime(0.9, startTime + 0.002);
  mainGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  clickGain.gain.setValueAtTime(kick.clickGain, startTime);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.012);

  const stopAt = startTime + duration + 0.05;
  osc.start(startTime); osc.stop(stopAt);
  click.start(startTime); click.stop(startTime + 0.02);

  return { nodes: [osc, mainGain, click, clickGain], duration };
}

function playSnare(ctx, dest, startTime, snare) {
  // Body (two short detuned tonal oscillators, the "shell") plus a highpassed noise burst (the
  // "buzz") — the standard two-part synthesized-snare recipe. `snare` is the kit's parameters.
  const bodyGain = ctx.createGain();
  const osc1 = ctx.createOscillator(); osc1.type = 'triangle'; osc1.frequency.value = snare.body1;
  const osc2 = ctx.createOscillator(); osc2.type = 'triangle'; osc2.frequency.value = snare.body2;
  osc1.connect(bodyGain);
  osc2.connect(bodyGain);

  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.2);
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'highpass';
  noiseFilter.frequency.value = snare.noiseHp;
  const noiseGain = ctx.createGain();
  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);

  const mainGain = ctx.createGain();
  bodyGain.connect(mainGain);
  noiseGain.connect(mainGain);
  mainGain.connect(dest);

  const duration = snare.duration;
  bodyGain.gain.setValueAtTime(0.5, startTime);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, startTime + snare.bodyDecay);
  noiseGain.gain.setValueAtTime(0.7, startTime);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  mainGain.gain.value = 0.6;

  const stopAt = startTime + duration + 0.05;
  osc1.start(startTime); osc1.stop(stopAt);
  osc2.start(startTime); osc2.stop(stopAt);
  noise.start(startTime); noise.stop(stopAt);

  return { nodes: [osc1, osc2, bodyGain, noise, noiseFilter, noiseGain, mainGain], duration };
}

// Closed and open hat share one recipe, differing only in decay — the same "one tone" the way
// strike/chunk are one chord voice with a different envelope, not a fourth drum sound.
//
// Choke: a real hi-hat is one pair of cymbals, so any new hit — open or closed — cuts off
// whatever was still ringing from the last one. `lastHatNoise` tracks the most recently
// *scheduled* hat voice; because scheduling always proceeds in ascending time order (bars in
// order, onsets sorted within a bar), "most recently scheduled" and "immediately preceding in
// playback" are the same thing, so this stays correct even though scheduling runs up to
// BARS_AHEAD bars ahead of real playback. Stopping the noise source (rather than trying to
// retroactively rewrite a gain envelope) is enough here because a filtered noise burst carries
// no resonant memory the way the earlier Karplus-Strong loop did — there's nothing left to ring
// on once the source stops feeding it.
let lastHatNoise = null;

function playHat(ctx, dest, startTime, open, hat) {
  const duration = open ? hat.openDuration : hat.closedDuration;
  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, duration + 0.05);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = hat.hp;
  const bp = ctx.createBiquadFilter(); // a little metallic character on top of the noise
  bp.type = 'bandpass';
  bp.frequency.value = hat.bp;
  bp.Q.value = 0.8;
  const gain = ctx.createGain();

  noise.connect(hp);
  hp.connect(bp);
  bp.connect(gain);
  gain.connect(dest);

  gain.gain.setValueAtTime(open ? 0.32 : 0.38, startTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  if (lastHatNoise && lastHatNoise.stopAt > startTime) {
    try { lastHatNoise.source.stop(startTime); } catch (e) { /* already stopped */ }
  }

  const stopAt = startTime + duration + 0.02;
  noise.start(startTime);
  noise.stop(stopAt);
  lastHatNoise = { source: noise, stopAt };

  return { nodes: [noise, hp, bp, gain], duration };
}

const DRUM_VOICE_PLAYERS = {
  kick: (ctx, dest, startTime, kit) => playKick(ctx, dest, startTime, kit.kick),
  snare: (ctx, dest, startTime, kit) => playSnare(ctx, dest, startTime, kit.snare),
  hat: (ctx, dest, startTime, kit) => playHat(ctx, dest, startTime, false, kit.hat),
  hatOpen: (ctx, dest, startTime, kit) => playHat(ctx, dest, startTime, true, kit.hat),
};

function triggerDrumVoice(ctx, dest, voice, startTime, kit) {
  const player = DRUM_VOICE_PLAYERS[voice];
  if (!player) return;
  const { nodes, duration } = player(ctx, dest, startTime, kit);
  trackVoice(ctx, nodes, startTime, duration);
}

// ---- scheduler ---------------------------------------------------------------
// For each onset, how long can this voice ring before the *next* onset in the same pattern
// (wrapping past the bar boundary back to the first onset)? Capping every voice's duration to
// this gap makes cross-onset overlap structurally impossible — no combination of pattern
// density, tempo, or how long playback has been running can ever stack more than one onset's
// worth of ring-out, which is what was producing the cumulative, worsening screech.
function onsetGapsSeconds(pattern, secondsPerBeat) {
  const onsets = [
    ...pattern.strikes.map((beat) => ({ beat, articulation: 'strike' })),
    ...pattern.chunks.map((beat) => ({ beat, articulation: 'chunk' })),
  ].sort((a, b) => a.beat - b.beat);
  if (onsets.length === 0) return [];
  return onsets.map((onset, i) => {
    const next = onsets[(i + 1) % onsets.length];
    const gapBeats = i === onsets.length - 1
      ? (5 - onset.beat) + (next.beat - 1) // wraps past the bar boundary (beat 5 == next bar's beat 1)
      : next.beat - onset.beat;
    // Small safety margin so the release finishes just before the next onset, not exactly at
    // it, plus a floor so even the densest legal pattern still has an audible release.
    return { ...onset, maxRingSeconds: Math.max(0.15, gapBeats * secondsPerBeat - 0.05) };
  });
}

// One shared bar loop drives both tracks off the same `playStartTime` anchor, so drums and
// chords stay in sync with each other — two independently-started transports would drift
// against each other on every replay, since each would anchor to whenever its own Play was
// clicked. `params` is `{ bpm, chord: {...}, drum: {...}, chordMuted, drumMuted }`; a muted
// track is skipped at scheduling time rather than scheduled-then-silenced, which is cheaper
// and simpler than adding a mute gain stage to every voice.
function scheduleBar(ctx, dest, bar, params) {
  const { bpm, chord, drum, chordMuted, drumMuted } = params;
  const secondsPerBeat = 60 / bpm;
  const barSeconds = 4 * secondsPerBeat;

  if (!chordMuted) {
    const frequencies = chordFrequencies(chord.root, chord.quality, chord.octave);
    for (const { beat, articulation, maxRingSeconds } of onsetGapsSeconds(chord.pattern, secondsPerBeat)) {
      const time = playStartTime + bar * barSeconds + (beat - 1) * secondsPerBeat;
      triggerChord(ctx, dest, chord.tone, frequencies, time, articulation, maxRingSeconds);
    }
  }

  if (!drumMuted) {
    const hits = [];
    for (const voice of ['kick', 'snare', 'hat', 'hatOpen']) {
      const beats = drum.pattern.voices[voice];
      if (!beats) continue;
      for (const beat of beats) hits.push({ voice, beat });
    }
    hits.sort((a, b) => a.beat - b.beat); // chronological order — required for hat choke
    for (const { voice, beat } of hits) {
      const time = playStartTime + bar * barSeconds + (beat - 1) * secondsPerBeat;
      triggerDrumVoice(ctx, dest, voice, time, drum.kit);
    }
  }
}

function topUp() {
  if (!isPlaying || !currentParams) return;
  const ctx = ensureContext();
  const barSeconds = (60 / currentParams.bpm) * 4;
  const elapsedBars = Math.max(0, Math.floor((ctx.currentTime - playStartTime) / barSeconds));
  const target = elapsedBars + BARS_AHEAD;
  while (nextBarToSchedule < target) {
    scheduleBar(ctx, masterInput, nextBarToSchedule, currentParams);
    nextBarToSchedule++;
  }
}

function start(params) {
  const ctx = ensureContext();
  stopAllVoices();
  lastHatNoise = null; // fresh choke state for the new run
  currentParams = params;
  playStartTime = ctx.currentTime + 0.08;
  nextBarToSchedule = 0;
  isPlaying = true;
  topUp();
  if (refillTimer) clearInterval(refillTimer);
  refillTimer = setInterval(topUp, TOPUP_INTERVAL_MS);
  if (!cleanupTimer) cleanupTimer = setInterval(sweepFinishedVoices, 2000);
}

function stop() {
  isPlaying = false;
  currentParams = null;
  if (refillTimer) { clearInterval(refillTimer); refillTimer = null; }
  stopAllVoices();
}

// Simplest correct response to a control changing mid-play: restart fresh with the new
// params, right away. A seamless bar-boundary-aware live update would also have to handle a
// BPM change re-anchoring every future bar time, which isn't worth the complexity here —
// instant restart is also the better UX for exploring tones and patterns by ear.
function updateParams(params) {
  if (!isPlaying) return;
  start(params);
}

window.BackingEngine = {
  start,
  stop,
  updateParams,
  chordFrequencies,
  get isPlaying() { return isPlaying; },
};
