# Backlog

Things noticed and deliberately not acted on yet. Each entry says what it is, why it matters, and
what it would touch — enough to pick up cold. **Nothing here is a commitment**; the spec is still
the authority on what the app is, and an idea living here has not been through §5.2's test of
whether it was already rejected for a reason.

Ordered by how much it costs to leave alone, not by size.

---

## 1 · Edit Layer's level control never got the +6 dB range — and it silently destroys the setting

**This is a defect, not an idea.** Logged here because it was noticed alongside the others, but it
loses user state today.

`ui/src/edit-layer.ts` builds its own range input instead of using `levelSlider`:

```ts
slider.max = '100';                                   // unity, not LEVEL_MAX
slider.value = String(Math.round(layer.level * 100));
```

Three separate consequences, in order of severity:

1. **A level above unity is silently reset.** `LEVEL_MAX` is 2, so Playback can put a layer at 1.5.
   Opening Edit Layer writes `slider.value = "150"` into an input whose max is `100`, and the
   browser clamps it to 100 without complaint. The displayed position is now wrong, and **the first
   touch of that slider commits the clamp** — `Number(slider.value) / 100` is 1.0, and the layer
   drops 3.5 dB. The user set a level on one screen and another screen quietly took it away.
2. **The +6 dB is unreachable from this screen.** §6.1 added the range specifically so a quiet take
   has a remedy, and Edit Layer is where you are looking at that take.
3. **The volume icon saturates at unity.** It passes `layer.level * 100` where every other mount
   passes `levelPercent(layer.level)`. CLAUDE.md's master-volume section already describes this
   exact failure — "the icon read identically at 1.0 and 2.0" — and it is still live here.

It is also a second implementation of a control that exists once in `controls.ts`, so it has no
unity tick and no double-tap-to-unity.

**Cause:** `b583528` ("Level runs past unity, to +6 dB") and `31ade6d` ("The volume icon spans the
whole level range") changed `controls.ts`, `playback.ts` and `backing-rows.ts`. Neither touched
`edit-layer.ts`, because its slider was hand-rolled and so was not where anyone looked.

**Fix:** replace the hand-rolled input with `levelSlider(() => layer.level, next => …)` and the
icon's argument with `levelPercent(layer.level)`. Small — the value being edited is already
`layer.level`, so the two screens are not fighting over different state, only presenting it
differently.

**Checked, so nobody has to check again:** there are three other hand-rolled `type="range"` inputs
outside `controls.ts`, and all three are correct. `playback.ts`'s master slider is 0..1 with unity
at the right-hand end and deliberately does **not** reuse `levelSlider`'s midpoint tick or its
double tap (§4.2 — monitoring only ever trims down). `settings.ts` has BPM and Rec offset, which are
not levels. **Edit Layer is the only one.**

---

## 2 · The waveform should scale with the layer's level

Today `Waveform` draws peaks from the recorded audio, and moving a level fader changes what you
hear without changing what you see. The illustration is the app's only picture of the audio, so a
layer pulled to 30% still looks as loud as one at unity, and the Playback lanes stop being
comparable to each other by eye.

Arguments for, which are the same argument twice:

- **§1.1's whole premise is that the picture tells you about the audio.** Colour already carries
  provenance; amplitude carrying loudness is the same contract.
- **It makes the +6 dB range legible.** Boosting a quiet take is currently a change you can only
  confirm by listening.

Things to settle before building it, none of them obvious:

- **Scale the drawn peaks, or scale the box?** Multiplying peak heights is truthful about
  amplitude, but at low levels the waveform collapses toward the centre line and stops being
  readable as *shape* — which is what it is mostly used for on the Edit Layer grid, where the
  question is "which pass is this" and not "how loud is it".
- **Where does it apply?** The Playback lane is a level meter's natural home. The Edit Layer tiles
  are a different job — comparing passes of the same layer at the same level — so scaling there may
  cost more than it gives. These may want different answers, which is a reason to be careful, not a
  reason to skip it.
- **Does it include mute?** A muted layer at level 1.0 is inaudible. Drawing it flat says something
  true and also throws away the only view of what is behind the mute. Per-bar mute (§3.7) already
  has a drawn treatment, and this should not contradict it.
- **Does it include master?** Almost certainly not — master is monitoring, not mix (§4.2), and the
  waveform is about the sketch rather than about the room.
- **Cost.** Peaks are computed per take, not per frame, so a level change is a redraw rather than a
  recomputation — but level changes fire on every pixel of a drag, so whatever this does has to be
  cheap enough for that. `setLayers` already distinguishes a level change from an arrangement
  change by identity, for exactly that reason.

**Nothing is decided.** The most conservative version worth considering is Playback lanes only,
peaks scaled by `level` and not by mute, leaving the Edit Layer grid alone.
