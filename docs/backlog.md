# Backlog

Things noticed and deliberately not acted on yet. Each entry says what it is, why it matters, and
what it would touch — enough to pick up cold. **Nothing here is a commitment**; the spec is still
the authority on what the app is, and an idea living here has not been through §5.2's test of
whether it was already rejected for a reason.

Ordered by how much it costs to leave alone, not by size.

**Done and removed:** Edit Layer's level control, which had a hand-rolled `max="100"` slider and so
silently clamped any layer set past unity on Playback. It was a defect rather than an idea and is
fixed — see the level section in `CLAUDE.md` for why a hand-rolled copy is what made it destructive.

---

## 1 · The waveform should scale with the layer's level

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

---

## 2 · A horizontal step can strand a slot on a pass that bar does not have

**Found 2026-09-16 by `tests/invariants.test.ts`**, which walks random sequences of the real edit
operations. It is recorded there as a `todo` test holding the exact reproduction, so it is
executable rather than prose.

```
bar 8 offers passes [1, 2, 3, 4, 5]     <- pass 3 is partial: it covers bars 1-8
bar 9 offers passes [1, 2, 4, 5]

slot holds P3 / bar 8                   legal, resolves
  one horizontal step forward ->
slot holds P3 / bar 9                   resolves to NOTHING
```

`stepBarAt` wraps `relativeBar` within the current pass — correct per §1.3, where neither axis may
step the other — and the available set is **per bar**. So the horizontal axis can walk off the end
of a partial pass.

**What it costs.** The tile draws blank and plays nothing. Worse, `compressionPlan` refuses the
whole project while any audible slot is unresolved, so Compress reports "a bar pointing at audio
that is no longer there" — a message about damage, for a state the user reached by swiping.

**It is recoverable**, which is why it is logged rather than treated as a stop: a vertical swipe
lands on P4, and stepping the bar back lands on P3 / bar 8. A blank tile, not a trap.

**The fix is a product decision, which is why it is here.** The obvious answer is for the
horizontal axis to skip bars the current pass does not have, the way the vertical axis already
skips gaps in the available set. That stays inside the pass, so §1.3 holds. But it makes one
horizontal swipe move more than one bar, and whether that reads as helpful or as the axis lying
about its own step is a question for someone who has used the screen. The alternatives are to clamp
at the end of the pass instead of wrapping, or to leave it and have the tile say something rather
than going blank.

**Check §5.2 before building any of them** — the arrangement axes have had alternatives rejected
for reasons this note does not restate.

---

## 3 · F14 — "Export previews the project rather than the export" — could not be confirmed

**Logged as not-a-defect rather than fixed**, because the audit itself flagged it as "verified by
reading rather than by driving, so confirm before fixing", and confirming it went the other way.

The claim was that the Preview transport on the Export screen plays the whole project while the
export writes a selection. It is true that `export.ts` never calls `setLayers`, so the preview
plays whatever the previous screen loaded. But **an `ExportSelection` does not select layers**:
it is `fullLoop`, `stems`, `stemsWithEffects` and `allPasses` — which *files* come out, not which
audio sounds. Every one of those is the same mixdown seen four ways.

The one setting on that screen which changes how a loop sounds is **Perfect loop**, and a live
preview is the case where it needs nothing: §2.8 and the tail section are explicit that the
delayed tail of the last bar running past the loop end is correct live, and only a fixed-length
render has to wrap it. So the preview and the file agree already.

**What would make it a real finding**: a selection that excludes audible material — per-layer
stems chosen individually, say — which the screen does not offer today. If that is ever added,
the preview has to consult it, and this entry is the note saying so.