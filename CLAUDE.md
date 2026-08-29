# Audio Loop Recorder — CLAUDE.md

iOS app for building multi-layer loop sketches. Set a tempo and bar count, pick a drum loop,
record up to seven layers while the loop runs, then choose bar by bar which pass of the
recording fills each slot of the arrangement.

**It is a sketchpad for improvising, not a DAW.** Almost every design decision follows from that.

## The spec is the authority, not this file

`audio-loop-recorder-spec.md` (~1200 lines) is authoritative, along with `lr-kit.css`,
`lr-kit.js` and three HTML mockups. Currently at `C:\Users\colli\Downloads\extracted\` —
**move them into this repo.** This file is a day-to-day reference; when the two disagree,
the spec wins.

The mockups are behaviour references, not production code. Read them for exact constants and
for interactions prose describes poorly. Do not port the DOM structure.

`lr-kit.js` contains a working reference implementation of the timing rules — `LR.timing`
holds `framesPerBar`, `passesForBar` and `passCount`. The spec calls `passesForBar` "the
executable form" of §1.4. **It runs under Node, and it is the cheapest way to check a
timing change**, on any machine, without a Swift toolchain. Use it.

## Build status

| | |
|---|---|
| `LoopRecorderCore` | Written. **Never compiled** — no Swift toolchain on the dev machine. |
| `LoopRecorderCoreTests` | Written. Never run. |
| `LoopRecorderAudio` | A documented stub. Not implemented. |

Nothing in this package has been built. Verify in Xcode before believing any of it.

The core logic *has* been validated, though not as Swift: `PassIndex`'s pass numbering,
availability and region lookup were mirrored in JavaScript and executed against the spec's
own worked example (§1.4) plus the `lr-kit.js` reference, and all checks passed. The
algorithm is sound; the Swift transcription of it is unverified.

## Layout

```
Sources/LoopRecorderCore/     pure Foundation — builds and tests anywhere
  BarRef.swift                bar identity, axis stepping
  Timing.swift                frame arithmetic, tolerance
  RecordingSession.swift      session model, SourceRegion
  PassIndex.swift             pass numbering, availability, region lookup
  SchedulePlan.swift          what plays when; splice entry points
  Layer.swift  Project.swift  AudioQuality.swift
Sources/LoopRecorderAudio/    AVFoundation — Apple only, needs a device to verify
Tests/LoopRecorderCoreTests/
```

**The split is the point.** Anything decidable without audio hardware goes in Core, where a
test can reach it. `LoopRecorderAudio` executes decisions Core has already made, so the part
that can only be verified by ear stays small.

```bash
swift test --filter LoopRecorderCoreTests
```

## The three ideas everything rests on (spec §0.3)

**1. Two indices, and the app shows both at once (§1.1).**

| Index | Means | Shown as |
|---|---|---|
| **slot** | where the bar sits in the arrangement | its position in the grid; playback progress |
| **source** | where its audio came from | its colour, and its `P# / #` label |

Smooth colour flow means the bars are still in recorded order; a colour jump means that bar
was pulled from elsewhere. That is the whole Edit Layer screen. Playback progress indexes on
the **slot**; colour indexes on the **source**. Collapsing them destroys the feature.

**2. Playback is segment scheduling, never a rendered file (§2.4).** The arrangement is a
sequence of `BarRef`s that schedule regions of the continuous recording back to back. This is
what lets an edit apply to *playing* audio, which is core functionality, not polish.

**3. `BarRef { pass, relativeBar }`, both 1-based (§1.3).** The two swipe axes map directly
onto the pair — vertical steps `pass`, horizontal steps `relativeBar`. That is the whole
reason it is a pair rather than a flat index, so **neither axis may step the other**.
`steppingBar` wraps within its pass; `PassIndex.steppingPass` wraps through the passes that
exist for that bar.

## Traps that have already been walked into

Every one of these was written, shipped into the repo, and had to be removed.

**Pass numbers are global; frame offsets are session-local.** A layer accumulates one session
per recording, and **sessions are never concatenated** (§1.4) — frame 0 of a session's file is
the downbeat of *that session's* first pass. Deriving a frame offset from the absolute bar
number across the whole layer asked for frame 5,292,000 of a 3,528,000-frame file: forty
seconds past the end, reading silent garbage rather than crashing. The conversion happens in
exactly one place, `PassIndex.region(for:)`, and is tested.

**The tolerance is a duration, not a frame count.** §1.4 forgives "a few milliseconds" on a
session's final bar so stop latency does not lose a completed pass. A hardcoded 2000 frames
looks reasonable and is 45 ms — enough to admit a bar that is most of a beat short, which the
scheduler then reads past EOF. `Timing.toleranceSeconds` is 4 ms, and `region(for:)` clamps
`frameCount` to what is actually on disk, so a forgiven bar plays a hair short instead.

**One derivation per quantity.** An earlier `Layer` counted passes one way for its total
(against a hardcoded `16 * 4410`, which is not `framesPerBar` for any tempo) and another way
for availability. `PassIndex` walks session order once; everything else asks it.

**Sum passes across layers, don't max them.** §2.7's table — 5 layers, 12 passes, 66 MB —
only holds if it is the total. Pass count drives size, not layer count, which is why the
Library shows it.

**Use Double for `loopSeconds`.** `barCount * beatsPerBar * 60 / bpm` in integers truncates
9.6 s to 9 — a 6% error in every size projection at that tempo.

**Availability is derived from audio, never stored (§1.4).** A counter cannot express a
partial pass, where early bars have one more pass than late ones. It also means a compressed,
bounced or imported layer needs no special handling, and the pass axis re-enables by itself
after recording onto a compressed project.

**The available set can be non-contiguous.** A tile legitimately reads `P4` with no `P3`
behind it. The gap is real and the number preserves provenance.

## Where the audio work is still ahead

`Sources/LoopRecorderAudio/PlaybackEngine.swift` carries the detail. The short version:
one shared sample-frame anchor for all layers; two alternating player nodes per layer; an
unconditional 5–10 ms equal-power crossfade on every join; beat-sized segments so the
committed horizon stays short; nothing on the render thread; and **latency compensation,
which is mandatory (§2.3) and was the thing most quietly missing** — it was computed and
then discarded.

Also note `installTap(onBus:)` twice on the same bus throws. Metering and capture share one.

## Build order (§0.5)

1. Segment-scheduled playback with a fixed arrangement, no editing.
2. Recording with latency compensation and the three-state record control.
3. Playback screen as an overview, static lanes.
4. Edit Layer grid, colour, motion model.
5. Gestures and transport — the fiddliest part; the mockup is the reference.
6. Live editing: mid-bar splice.
7. Project Library, compress, bounce.
8. Chord reference, settings, manual.

## Tone and scope

- Never let the app be the judge of how a sketch is going. No scoring, no streaks.
- Do not add features the spec does not have without flagging the addition.
- Part 5.2 of the spec lists rejected alternatives with reasons. Read it before "improving"
  something that looks arbitrary — several were built once and removed.
- The renaming warning in §0.1 is real: the glossary's right-hand column contains retired
  words, and a blind find-and-replace across the spec has destroyed it once already.
