# Backlog

Things noticed and deliberately not acted on yet. Each entry says what it is, why it matters, and
what it would touch — enough to pick up cold. **Nothing here is a commitment**; the spec is still
the authority on what the app is, and an idea living here has not been through §5.2's test of
whether it was already rejected for a reason.

Ordered by how much it costs to leave alone, not by size.

---

## Deferred to v2

### Bounce — built, switched off (2026-09-16)

**Why.** Its remaining decisions change what a bounce is, and they are v2 decisions: `F15` (a bounced
project records over its mixdown ~110 ms late) and #4 below (a bounce as a backing track instead of
layer 1). Shipping the current shape would mean migrating every bounced project if #4 wins.

**What is hidden — the one control to restore.** "Bounce to new project" in the actions row on
**project settings**, between Export and Compress. It is behind `BOUNCE_ENABLED` in
`ui/src/features.ts`; set it true and the button, its confirm panel and the whole path return as
they were.

**What was deliberately left in.** All of it, still compiled and checked: `askBounce` / `runBounce`
in `ui/src/settings.ts`, `onBounce` in `ui/src/app.ts`, `src/domain/bounce.ts`,
`tests/bounce.test.ts` and the bounce compositions in `tests/composition.test.ts`,
`ui/src/verify-bounce.ts` in `/ui/verify.html`. Bounced projects already saved keep working, and the
demo shelf still has one (`Sunday Loop (Bounce)`).

**Before turning it back on:**

1. Decide #4. If the bounce becomes a backing track, `bounceSeed` changes shape and `F15` goes away
   by construction; if it stays on layer 1, `F15` needs the per-session rendered flag instead.
2. Whichever shape wins, a migration for projects bounced in v1 — through `src/domain/migrate.ts`,
   which will refuse to typecheck a new field until its default exists.
3. Re-read spec §2.7 *Bounce* and the CLAUDE.md bounce section, both of which describe the v1 shape.
4. Help copy: no current sheet mentions bounce, so v2 needs to add it rather than un-hide it.

**Done and removed:** Edit Layer's level control, which had a hand-rolled `max="100"` slider and so
silently clamped any layer set past unity on Playback. It was a defect rather than an idea and is
fixed — see the level section in `CLAUDE.md` for why a hand-rolled copy is what made it destructive.
And #2, a horizontal step stranding a slot on a bar its partial pass never reached: settled
2026-09-16 as "a partial pass is as long as the recording got" — see `steppingBarIn` and §3.7.
And #1, waveforms scaling with level: built 2026-09-16 as the conservative version — Playback lanes
only, by level and not by mute or master. See `levelScaledHeight` and the spec's waveform section.

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
