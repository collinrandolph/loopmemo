# Backlog

Things noticed and deliberately not acted on yet. Each entry says what it is, why it matters, and
what it would touch — enough to pick up cold. **Nothing here is a commitment**; the spec is still
the authority on what the app is, and an idea living here has not been through §5.2's test of
whether it was already rejected for a reason.

Ordered by how much it costs to leave alone, not by size.

**Done and removed:** Edit Layer's level control, which had a hand-rolled `max="100"` slider and so
silently clamped any layer set past unity on Playback. It was a defect rather than an idea and is
fixed — see the level section in `CLAUDE.md` for why a hand-rolled copy is what made it destructive.
And #2, a horizontal step stranding a slot on a bar its partial pass never reached: settled
2026-09-16 as "a partial pass is as long as the recording got" — see `steppingBarIn` and §3.7.

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
---

## 4 · A bounce as a backing track rather than layer 1

**Proposed 2026-09-16, to explore rather than build.** Raised against `F15` — a bounced project
records over its mixdown about 110 ms late — as a structural alternative to the two fixes on the
table (a rendered-or-captured flag per `RecordingSession`, or carrying the source's offset to the
seed).

**The idea.** The mixdown becomes a third row in the backing section instead of Pass 1 of layer 1,
with the source's recording offset already baked in. Backing tracks are not layers, so the new
project's Rec offset slider never touches it.

**Why it is attractive**

- **`F15` goes away by construction, not by a flag.** The offset lives in `regionFor`, which only
  layers go through; backing is scheduled on the shared anchor and is on time already. That is the
  same argument the audio layer section makes for not offsetting drums and chords, so the mixdown
  would join the category it already behaves like. No per-session bit for every future reader to
  remember.
- **All seven layers are free.** The ceiling becomes a real stage rather than six layers and a
  foundation.
- **It matches how a bounce is used.** A backing row already has level and mute, and "a groove you
  record over and mute when you are done with it" is exactly §2.7's second use case.
- **No stretching, so §5.2's rejection does not bite.** Sampled backing was rejected over
  time-stretching to the project tempo. A bounce seed takes the source's BPM, bar count and quality,
  so its ratio is always 1 — *provided the tempo stays locked* (below).

**What it breaks or reopens — check each before building**

- **"Neither backing track is a file"** (§2.6, spec line ~327) stops being true. The row is audio in
  the take store, so `hasAudioFor`, the refused-take `flush()`, delete and storage size all have to
  see it — and the backing rows code that assumes synthesis (`backingMixSources`, the kit/tone
  panels, the pickers) gets a kind with none of those axes.
- **The tempo lock is derived from recorded layers.** `isConfigurationLocked` is
  `projectHasRecordings`, so a seed with its audio in the backing and no layers would open *unlocked*
  — change the BPM and the mixdown is wrong against every bar line. The lock would have to count
  backing audio.
- **Bounce of a bounce.** §2.7 settles that backing is *not* in a mixdown. Applied to this row, a
  second-generation bounce silently drops the first generation's audio. So the rule has to split:
  synthesised backing excluded, bounced backing included — which is the kind of per-kind exception
  this codebase keeps having to undo, and needs a reason stronger than convenience.
- **Offset baking has a direction.** "Baked in" should mean the mixdown is rendered with the source
  offset applied (which it already is — `renderOffline` reads through `regionFor`), and the seed
  then never applies its own. Worth writing down, because the obvious alternative — render raw and
  offset later — reintroduces `F15`.
- **What it loses as a layer.** No pass hunting, per-bar mute, compress, or EQ/pan presets on the
  mixdown. Mostly moot — it is one pass with processing already in it — but per-bar mute on a
  bounced foundation is a plausible thing to want.
- **Export.** Does it write a stem? It is audio the user can hear, so §2.6's *what you hear is what
  you export* says yes, alongside drums and chords.
- **Count-in "Drums only"** — does the bounce row sound during a count-in? Probably not, by the
  name; that is one more per-kind rule.
- **Existing bounced projects** hold their mixdown on layer 1. Either they stay as they are (two
  shapes of bounced project, forever) or a migration moves it — which is the migration-policy
  decision again, and moving audio between a layer and the backing is a bigger migration than a
  default.
- **More than one?** A project could reasonably want two bounces as backing. One slot or a list is
  a layout question for the mockups, not for code.
- **Spec sections this would reverse:** §2.7 *Bounce* ("That file becomes layer 1… as Pass 1",
  "Layers 2–7 are empty"), §2.6's "not a file", §4.1 help copy about backing tracks.

**Honest comparison with the flag.** The flag is small and leaves every spec section standing; its
cost is one more thing `regionFor` consults. This idea is larger and reopens three settled sections,
but it removes a category of mistake instead of guarding against it, and it changes what a bounce
*is* in a way that may be the better product. That trade is the decision; neither is a patch.
