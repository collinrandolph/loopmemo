# Backing tracks prototype

**Standalone. Not part of the app.** Nothing here is imported by `src/`, `ui/`, or `tests/`, and
nothing in here imports from them either. It's a scratch space for working out drum-pattern and
chord-strum behavior before any of it is decided as production shape.

Scope, for now: **drums and chords only.** Whether this ever shares machinery with layer
playback (`schedule-plan.ts`) is an open question to revisit at integration time, not something
this prototype assumes either way.

## Files

- `patterns.js` — the finalized pattern data: 6 drum patterns, 4 drum kits, 7 chord strum
  patterns, plus the 4 chord tones and the octave range. Plain global-scope script (no ES module,
  no build step, no bundler) so it loads the same way whether opened directly via `file://` or
  served.
- `audio.js` — the synthesis engine and scheduler. Four chord tone recipes, three drum voices fed
  by the selected kit's parameters, and one shared time anchor driving both tracks so they cannot
  drift against each other.
- `index.html` — the selection UI, with audio: pick a kit, a drum pattern, a chord, a tone, an
  octave and a strum pattern, then play. Draws each pattern's beat grid so the shape of the groove
  is visible alongside the sound.

## Running it

Open `index.html` directly in a browser (it's fully self-contained, no server required), or —
since `Tools/serve.js` already serves the whole repo root — run it from the repo root and browse
to this folder:

```bash
node Tools/serve.js
```

then open `http://localhost:5173/prototype/backing-tracks/index.html`.
