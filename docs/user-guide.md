# Audio Loop Recorder — In-App User Guide

Copy for the question-mark (`?`) sheet on each screen. One section per screen. Brief and
scannable — what each control does and how to use it.

**`ILLUSTRATION` blocks are notes to an LLM tasked with producing the visual assets.** They
name the screen, the element to capture or render, the state(s) to show, and what to label.
They are not user-facing copy. Assets can be real screenshots of the running UI
(`npm run ui`), cropped and annotated, or clean re-renders of a single component. Prefer the
smallest crop that still reads — one row, one tile, one control — over a whole screen.

**Words used everywhere:** **layer** = one recorded track (seven per project) · **pass** =
one lap of the loop in a single recording · **slot** = a bar's position in the song ·
**source** = which pass and bar the audio came from · **backing** = the drums and chords you
play along to.

---

## Screen 1 — Projects

Your list of sketches, newest first. The app opens here.

- **Tap a row** — open the project.
- **Play button** — hear it without opening. One plays at a time. The thumbnail dims as it plays.
- **Row shows** — colour thumbnail (one stripe per layer), then the name, then `last modified · file size`, `BPM · bars` and `layers · passes` on their own lines. The playing position appears at the right of the row while it previews. No tags.
- **New project** — button in the header.
- **Export, Bounce, Compress, Delete** — open the project, then tap the settings gear.

> **ILLUSTRATION — one project row, annotated.** Crop to a single row from the list. Label:
> play button, colour thumbnail (call out "one stripe per recorded layer"), the
> `BPM · bars · layers · passes` metadata line, the size readout, and any tag chip.
>
> **ILLUSTRATION — the same row playing vs idle (two states, side by side).** Idle: full
> thumbnail + size shown. Playing: thumbnail lines partly dimmed (progress), size readout
> replaced by a running time. Caption the swap.

---

## Screen 2 — New Project / Project Settings

- **Name** — type to edit.
- **Tempo** — drag the slider (60–240 BPM). The **play button** next to it loops one bar of drums to preview the tempo.
- **Bars** — pick a chip, 4 to 32 (multiples of 4).
- **Recording quality** — Standard (16-bit/44.1 kHz) or High (24-bit/48 kHz). Set once, at creation; can't change later.
- **Rec offset** — corrects for headphone/mic delay so a take lands on the beat. See *Playback → Recording → Adjusting latency*. Never locks.
- **Tempo and bar count lock after the first recording.** Set them first.
- **Backing tracks aren't here** — set them from the Playback screen, any time.

### Actions (existing projects only)

- **Export** — opens the Export screen.
- **Bounce to new project** — mixes all layers into layer 1 of a new sketch, effects baked in. Original untouched. The new project is named after the old one with **(Bounce)** on the end; rename it whenever you like.
- **Compress** — discards recorded passes, keeps each layer's edited loop. Shows the space saved. Still recordable after.
- **Delete** — removes the project. Confirms first.

> **ILLUSTRATION — the tempo row.** Crop to the Tempo row: slider, the BPM number, and the
> preview play button. Label the play button "loops one bar of drums".
>
> **ILLUSTRATION — the quality control.** The Standard / High chips with the format-and-cost
> line beneath (e.g. "24-bit / 48 kHz"). Show it disabled/dimmed on an existing project, with
> a note that it is chosen only at creation.
>
> **ILLUSTRATION — a destructive confirmation, in place.** The Compress confirm state showing
> a real projection ("214 MB → 26 MB") with its Compress / Cancel buttons. This is the
> pattern all four actions use.

---

## Screen 3 — Playback

The hub for a project: set up backing, record layers, mix, and open the editor.

- **Transport (top)** — play/pause, tap the progress bar to seek, position readout, master volume + slider.

### Backing rows — drums and chords

- Tap a row to open it. Mute (speaker) to leave it out of exports.
- **Drums** — pick a **pattern** and a **kit** (independent).
- **Chords** — tap a slot to set its **note / sign / type**; **pattern**, **tone** and **octave** apply to all four. **Randomize chords** refills the four slots.

### Layer rows

Left to right: record dot · name / pass badge · waveform · speaker (level + mute).

- **Tap a row** to expand: volume, **EQ**, **pan**, and **Edit Layer**. EQ / pan / Edit appear once the layer has a pass.
- **Rename** — tap the name (12 characters).

> **ILLUSTRATION — one layer row, annotated.** record dot · label column (name / pass badge)
> · waveform lane · speaker.
>
> **ILLUSTRATION — an expanded layer panel, two states.** With a pass: volume, EQ presets,
> pan presets, Edit Layer button. Empty layer: volume only, plus the "Record a pass to start
> editing" note.
>
> **ILLUSTRATION — the speaker/volume icon.** Level arcs partly filled vs muted (arcs hidden,
> slash across). Small crop.
>
> **ILLUSTRATION — the chord row expanded.** The four chord slots, one slot open showing its
> Note / Sign / Type wheels, and the Pattern / Tone / Octave controls plus Randomize chords.

### Recording

**Use headphones.** On the speaker, the drums, chords and every layer you've already recorded
bleed into the mic and pile onto each new take.

#### Arming a track

- **Tap the record dot** to arm the layer. It turns red and pulses. Arming one layer disarms
  any other.
- **Hold** the dot while armed to cancel without recording.

> **ILLUSTRATION — the record dot, three states in a row.** Unarmed (grey, translucent),
> armed (red, pulsing), recording (red square). Label "tap to advance, hold while armed to
> cancel".

#### Count-in

Bars of the loop that play before the take starts, so you can come in on the beat instead of
from silence.

- **Length** — Off, or 1 to 4 bars. On the project settings screen (the **gear**), below Rec offset.
- **Sound** — **Full loop** plays the ending you're joining, drums, chords and every layer.
  **Drums only** keeps the beat clear when the arrangement is busy.
- **It's never recorded.** The count-in is the *end* of the loop played into the wrap, so your take
  still begins on the downbeat and bar 1 is bar 1. Stop during the count-in and nothing is kept.
- **Both settings apply to every project**, and save the moment you tap them — Cancel doesn't
  undo them.
- **While it runs**, the layer's lane shows one dot per beat, filling up to the downbeat. The dot
  at the start of each bar is larger.

> **ILLUSTRATION — a row counting in.** The record dot as a red square, the pass badge in place of
> the name, and the lane showing eight beat dots with five lit.

#### Recording a pass

- **Tap the armed dot again** to start. Recording always begins at the top of the loop.
- Every other layer plays at its current level, mute, EQ and pan. **The layer you're
  recording onto stays silent** — you're playing over the rest, not against the take you're
  replacing.
- **Tap once more** to stop.

##### Pass indicator

- From the moment you arm, a **pass badge** takes the layer name's place and counts the pass
  being captured.
- It reads **provisional** (dimmed) until that pass completes one full bar. Stop before then
  and nothing is kept — the number carries over to your next take instead.

> **ILLUSTRATION — the pass badge, two states.** Provisional (dim, "Pass 6", a sparse waveform
> just started) vs earned (full brightness, "Pass 6", a fuller waveform).

#### Adjusting latency

Headphones and a microphone both add a small delay, so a take can land audibly late even
when you played it on the beat. **Rec offset** corrects for that — it's on the project's
settings screen, not here: tap the **gear** next to the project name, then find **Rec
offset** near the bottom.

- **Drag the slider** (0–250 ms) while the loop plays and listen for your playing to land on
  the beat. The **play button** beside it loops the arrangement so you can judge by ear.
- Reads **Off** at 0 ms.
- It's a playback correction, not a recording change — it can be adjusted at any time, even
  long after a layer is recorded, and never locks.

> **ILLUSTRATION — the Rec offset row (Project settings).** Label, slider, ms readout, play
> button, and the note beneath it: "How far earlier your recording plays than it arrived…".

---

## Screen 4 — Edit Layer

Choose which pass fills each bar of the song. Open it from **Edit Layer** in a layer's panel.

**Every tile has two identities:**

- **Slot** — its place in the song (grid position, playback sweep).
- **Source** — where its audio came from (its **colour** and `P# / #` label).

Smooth colour across tiles = bars still in recorded order. A colour jump / out-of-order number
= that bar came from elsewhere.

### Gestures

| Gesture | Effect |
|---|---|
| Swipe up / down | Change the **pass** |
| Swipe left / right | Change the **bar** (swipe left = forward) |
| Tap | Repeat this bar; tap again to stop |
| Double tap | Play the song from here |
| Tap and hold | Mute / unmute this bar |

- Arrow keys do the same.
- Swipe the bar that's playing and it switches mid-bar, right away.
- Swiping is locked while a bar is muted — unmute first.

### Looks wrong but isn't

- **Vertical swipe does nothing** — the layer has only one pass (new, compressed, or bounced). Rearranging bars still works.
- **`P4` with no `P3`** — that pass didn't reach this bar. The swipe skips the gap.
- **Last bar cuts out** — recording stopped partway through it. It's kept as-is.

### Layer… drawer

- **Compress layer** — keeps the edited loop, discards unused passes.
- **Clear layer** — empties the layer.

Both confirm first.

> **ILLUSTRATION — the key one: colour flow vs colour jump.** A grid where bars 1–4 flow
> smoothly along the gradient and bar 5 is a hard colour break with an out-of-sequence
> `P# / #` label. Annotate: "smooth = still in recorded order", "jump = pulled from
> elsewhere". This is the single most important image in the guide.
>
> **ILLUSTRATION — one tile, annotated.** The 16 waveform lines, the small dim `P2` label,
> the large bar number, and the `↕ pass  ↔ bar` hint underneath.
>
> **ILLUSTRATION — the swipe axes.** A tile with four arrows: up/down labelled "pass",
> left/right labelled "bar", and a note that swiping left steps forward.
>
> **ILLUSTRATION — two special-case tiles.** (a) one-pass layer: no `P#`, vertical swipe
> shown as disabled. (b) muted bar: collapsed to the dot floor, "swipe locked" note.
>
> **ILLUSTRATION — the Layer… drawer open.** Compress layer and Clear layer buttons, plus one
> confirm sentence stated in passes and megabytes.

---

## Screen 5 — Export

Makes files of the project exactly as it sounds now (levels, effects, backing, mutes applied).

### What to export

Tick any combination. Each row shows its file count and size.

- **Full loop** — the finished mix.
- **Stems** — one file per layer and backing track, no effects.
- **Stems + effects** — same, with each layer's level, EQ and pan. Panned layers are stereo.
- **All recorded passes** — every take, unedited.

### Format

- **WAV** — at the project's recording quality.
- **MP3** — choose a bitrate.

### Other

- No mute controls here — mute on the Playback screen.
- **Preview** plays the selection. **Share** writes the files.

> **ILLUSTRATION — the "what to export" list.** All four rows, each with its file-count and
> size badge, one or two rows ticked so the selected vs unselected states both show.
>
> **ILLUSTRATION — the format row, two states.** WAV selected (quality line, no bitrate) vs
> MP3 selected (bitrate chips visible).
>
> **ILLUSTRATION — the file manifest.** The generated list: per-file name, stereo/mono tag,
> size — showing a panned stem as stereo and a centred one as mono.
