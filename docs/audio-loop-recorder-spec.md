# Audio Loop Recorder — Product & Implementation Specification

An iOS app for building multi-layer loop sketches. The user sets a tempo and bar count, picks a
drum loop, and records up to seven layers over it while the loop runs continuously. Afterwards they
choose, bar by bar, which pass of the recording fills each slot of the arrangement.

**It is a sketchpad for improvising, not a DAW.** Almost every design decision follows from that.

---

## How to read this document

| Part | Contents |
|------|----------|
| **0. Orientation** | Glossary, artifacts, invariants, build order. Read this first. |
| **1. Core concepts** | The two ideas the whole app rests on, plus the data model |
| **2. Audio architecture** | Session config, routing, scheduling, live editing, storage |
| **3. Component library** | The shared UI kit — one section per component |
| **4. Screens** | How the components are assembled, screen by screen |
| **5. Decisions** | What was settled and why, including rejected alternatives |
| **6. Open items** | Not yet designed, deferred, and the roadmap |

Parts 3 and 4 are deliberately split. A component is specified **once**, in Part 3; a screen section
says which components it uses and what is specific to it. Where a screen and a component seem to
disagree, the component wins.

---

# Part 0 — Orientation

## 0.1 Glossary

Settled deliberately. Earlier drafts used other words; these are the current ones.

| Use | Means | Instead of |
|-----|-------|-----------|
| **bar** | One bar of music. The unit of the grid, the swipe axis, and the splice. | "measure" |
| **pass** | One traversal of the loop during a continuous recording. The vertical swipe axis. | "take", "iteration", "loop" |
| **loop** | The project's repeating structure itself, and the drum loop. | — |
| **layer** | One of the seven recorded tracks. | "track" |
| **slot** | A bar's position in the *arrangement*, as opposed to where its audio came from. | — |
| **session** | One continuous recording onto a layer. A layer accumulates several. | — |
| **tile** | One bar's cell on the Edit Layer screen. | — |
| **lane** | One layer's full-loop strip on the Playback screen. | — |
| **reference tracks** | The drum loop and chord bed collectively. | — |

**Why "pass" rather than "take".** *Take* implies converging on one right version of the same
performance. This app leaves the loop running so the player can improvise, and each traversal may
differ wildly from the last — which is precisely why the colour gradient carries information.
*Pass* is neutral about intent and accurate to a continuous recording.

**Label style**: spelled out where it appears once (`Pass 3` on a Playback row), abbreviated where it
repeats across a grid (`P2` on Edit Layer tiles, with the `↕ pass` hint below teaching it).

**Code names**: `BarRef { pass, relativeBar }`, `barSources[]`, `RecordingSession`, `barRef()`,
`barBoundaries`, `passesForBar()`.

> **Renaming warning**: the right-hand column above deliberately contains retired words. A blind
> find-and-replace across this document will destroy it — that has already happened once.

## 0.2 Artifacts

| File | What it is |
|------|------------|
| `audio-loop-recorder-spec.md` | This document. Authoritative. |
| `lr-kit.css` | Shared design tokens and component styles |
| `lr-kit.js` | Shared logic and components (see Part 3) |
| `edit-layer-mockup.html` | Working reference for §4.3 |
| `playback-screen-mockup.html` | Working reference for §4.2 |
| `project-library-mockup.html` | Working reference for §4.1 |
| `build.py` | Inlines the kit into each mockup so they run standalone |

The mockups are **behaviour references, not production code**. Read them for exact constants and for
interactions that prose describes poorly. Do not port the DOM structure.

The delivered mockups have the kit inlined so they run standalone; `lr-kit.css` / `lr-kit.js` are the
readable source.

## 0.3 Read these first

Three ideas everything else depends on:

1. **§1.1** — colour encodes position in the recording; playback progress indexes on the edited timeline. Decoupling those two is what makes reordering visible. Do not collapse them.
2. **§2.4** — playback is segment scheduling against the continuous recording, never a rendered file. This is what allows edits to apply to playing audio, which is a core feature.
3. **§1.3** — bars are identified by `{pass, relativeBar}`, derived from the absolute bar number. The two swipe axes map directly onto that pair.

## 0.4 Invariants

Breaking any of these produces bugs that look cosmetic but aren't.

| Invariant | Where |
|-----------|-------|
| One `isPlayed(slot)` — render and release must agree | §3.6 |
| One render pass writes one transform and one colour per line | §3.3 |
| Gradient stop count derives from line count, never the reverse | §3.2 |
| Whole-pixel, even-numbered geometry | §3.3 |
| `scaleY` cannot reach the dot floor — mute animates real height | §3.3 |
| Pass availability derives from recorded audio, per session | §1.4 |
| The available pass set for a bar can be non-contiguous | §1.4 |
| Unselected passes cannot be auto-deleted while a project is uncompressed | §2.7 |
| All layers derive timing from one shared sample-frame anchor | §2.4 |

## 0.5 Suggested build order

1. Segment-scheduled playback (§2.4) with a fixed arrangement, no editing. Everything assumes it.
2. Recording with latency compensation (§2.3) and the three-state control (§3.5).
3. Playback screen as an overview (§4.2), static lanes.
4. Edit Layer grid, colour, and the motion model (§3.2, §3.3).
5. Gestures and transport (§3.7, §3.6) — the fiddliest part; the mockup is the reference.
6. Live editing: mid-bar splice (§2.5).
7. Project Library, compress, bounce (§4.1).
8. Chord reference (§4.4), settings (§4.6), user manual (§4.7).

---

# Part 1 — Core concepts

## 1.1 The two indices

Every bar on screen has **two positions**, and the app shows both at once:

| Index | Means | Shown as |
|-------|-------|----------|
| **slot** | where the bar sits in the arrangement | its position in the grid; playback progress |
| **source** | where its audio came from in the recording | its colour, and its `P# / #` label |

Smooth colour flow across tiles means the bars are still in recorded order. A colour jump means that
bar was pulled from elsewhere. **This is the central idea of the Edit Layer screen** — it turns the
waveform from decoration into information.

Playback progress indexes on the **slot**. Colour indexes on the **source**. Collapsing the two
destroys the feature.

## 1.2 Session configuration

| Setting | Range | Notes |
|---------|-------|-------|
| BPM | 60–240 | Tap tempo supported. Locked after the first recording. |
| Bar count | 4, 8, 12, 16, 20, 24, 28, 32 | Multiples of 4 only. Locked after the first recording. |
| Time signature | 4/4 | v1 only — but see §5.1 |
| Layers | Exactly 7 | |
| Drum loop | From a library | Time-stretched to the project BPM (§2.6) |
| Chord bed | Optional | Generated, not sampled (§4.4) |
| Recording quality | Standard or High | Global setting, snapshotted per project (§2.7) |

```
loopSeconds = barCount × beatsPerBar × 60 / bpm
```

## 1.3 Bar identity

A slot stores a `BarRef { pass, relativeBar }`, both 1-based — **not** an absolute bar number. Both
are derived from the absolute bar number, so nothing extra is captured at record time.

```swift
struct BarRef {
    var pass: Int          // which traversal of the loop
    var relativeBar: Int   // position within that pass
}

func barRef(barNumber: Int, barCount: Int) -> BarRef {
    BarRef(pass: ((barNumber - 1) / barCount) + 1,
           relativeBar: ((barNumber - 1) % barCount) + 1)
}

func absoluteBar(_ ref: BarRef, barCount: Int) -> Int {
    (ref.pass - 1) * barCount + ref.relativeBar
}
```

Verified: absolute bar 17 in a 16-bar loop → `P2 / 1`; bar 33 → `P3 / 1`.

The two swipe axes map directly onto this pair: vertical steps `pass`, horizontal steps
`relativeBar`. That is the whole reason the pair exists rather than a flat index.

## 1.4 Pass availability is derived from audio

**Where the audio came from must not matter.** A pass exists if the audio for that bar exists. There
is no pass counter to maintain, no flag to clear, and no difference in handling between a freshly
recorded layer, a compressed layer, a bounced layer, or an imported one.

### The unit of derivation is the session, not the layer

A layer accumulates one **session** per time the user records onto it. Each session is a continuous
recording aligned to the loop grid at its own start (recording always begins at the top of the loop).

**Sessions must not be concatenated into one timeline.** If a user records 2½ passes, stops, and
later records 2 more, the layer holds 4.5 loop-lengths of audio — and deriving from that total puts
every boundary after the partial pass at the wrong offset. The correct reading is **5 passes**: the
partial one is pass 3, and the new session starts at pass 4.

```
framesPerBar = round(sampleRate × 60 × beatsPerBar / bpm)     // beatsPerBar = 4 in v1
loopFrames   = framesPerBar × barCount

session[i].firstPass = 1 + Σ passCount(session[0..i-1])       // numbering follows session order

// does pass p contain any of relative bar r?
//   locate the owning session, convert p to a session-local index, then:
barExists(p, r) = ((localPass - 1) × loopFrames + (r - 1) × framesPerBar) + tolerance
                  < session.frames

// a traversal becomes a pass once it holds one COMPLETE bar
passExists(p)        = (p - 1) × loopFrames + framesPerBar <= session.frames + tolerance
passCount(session)   = count of p ≥ 1 where passExists(p)     // one derivation, not two
```

**A partial bar is kept; a partial *pass* is not.** The two gates differ on purpose, because
the mistakes cost different amounts. An overrun bar is one tap-and-hold from silence and is local
to its slot. An overrun **pass** renumbers every pass after it, permanently — a single pass cannot
be deleted (§5.1 #2), so the only escape is clearing the whole layer, and it inflates the size
projection the Library exists to show. It is also worth almost nothing when intended: a traversal
that has not completed bar 1 contributes a fragment to one bar position and nothing to any other.
Discarding it costs at most one bar of a take that can be played again.

Gate it **in bars, not in milliseconds.** A stop overrun is a reaction-time quantity — roughly
constant in absolute terms and therefore a wildly different *fraction* of a bar across the BPM
range (about 10% at 60 BPM and 40% at 240 BPM for the same physical action), so no percentage
threshold works at both ends. "One complete bar" needs no tuning and is expressed in the app's own
units. This is also the one place the tolerance sits at the **far** edge of a bar: a completeness
test is the only kind that needs it, so that stop latency cannot lose a pass played to the end.

**A bar exists once the recording reaches into it**, not once it is whole. Stopping halfway through
bar 10 keeps bar 10 as an ordinary, selectable bar that runs out of audio partway; the region is
clamped to what is on disk, so nothing is padded and no silence is written. The alternative discards
the user's last seconds of playing for not landing on a boundary. See §5.1 #5, which this reverses,
and §1.6 for what it means for a first pass.

`LR.timing.passesForBar()` in the kit still implements the earlier rule, which required a whole bar.
The two agree wherever a session ends on a bar boundary — every case in the table below — and
`Tools/verify-timing.js` pins the difference so it cannot vanish unnoticed.

### Availability is per bar position, and can be non-contiguous

96 BPM, 16 bars; session 1 is 2 passes + 8 bars, session 2 is 2 passes:

| Session | Contains | Pass numbers |
|---------|----------|--------------|
| 1 | 2 full + 8 bars | 1, 2, 3 (3 is partial) |
| 2 | 2 full | 4, 5 |

| Bar position | Available passes |
|--------------|-----------------|
| 1–8 | 1, 2, 3, 4, 5 |
| 9–16 | 1, 2, **—**, 4, 5 |

Bars 9–16 have no pass 3, because that session stopped before reaching them. Two consequences:

- The vertical swipe **wraps through the available set for the bar being swiped**, skipping absent passes rather than assuming a contiguous range.
- A tile can legitimately read `P4` with no `P3` behind it. That is correct — the gap is real, and the number preserves provenance.

### Two implementation rules

**Compute in sample frames, never seconds**, and derive each boundary from the absolute formula
rather than accumulating bar durations — otherwise rounding error walks the boundaries out of
alignment over a long recording.

**Allow a small tolerance** (a few milliseconds) for stop latency — at the **near** edge of a bar,
not the far one. A bar that lands a hair short is admitted for free now that reaching into a bar is
enough, so nothing needs forgiving there. What needs absorbing is the opposite case: stopping is
never instant, so a pass played to exactly the loop point captures a few milliseconds past it, and
that crumb would otherwise become a whole phantom bar — and through `passCount`, a whole phantom
pass inflating the size projection.

## 1.5 Data model

```
Project
├── metadata
│   ├── id, name
│   ├── bpm (60–240)                  // locked after first recording
│   ├── barCount (4…32, step 4)       // locked after first recording
│   ├── beatsPerBar (4 in v1)         // named, not a literal — see §5.1
│   ├── createdDate, lastModified     // Library sorts on lastModified
│   ├── audioQuality (standard | high)// snapshotted at creation, immutable
│   ├── isCompressed (Bool)           // a label and a storage fact only;
│   │                                 // cleared by recording. Never gate UI on it.
│   └── bouncedFromProjectId (UUID?)  // lineage
├── drumLoop                           // reference track
│   └── id, name, audioFileURL, duration, originalBPM, channels
├── chordProgression                   // reference track, optional
│   ├── enabled, scale, tone, level
│   └── slots[4]                       // one chord per bar, repeats every 4 bars
│       └── root (note + natural/flat/sharp)
│           // quality derived from the scale; major triad if non-diatonic
├── layers[7] → Layer
└── exportSettings (format, quality)
```

```
Layer
├── id, name (≤12 chars), level (0–1), muted
├── sessions[] → RecordingSession       // one per recording; never concatenated
│   └── audioFileURL, recordedFrames, recordedAt, waveformPeaks[]
└── barSources[]                        // one BarRef per slot; the arrangement
```

**There is no separate per-bar selection map.** An earlier draft had one alongside `barSources`; two
structures describing the same thing is exactly how they drift apart.

**Pass numbers are never stored.** They are derived from session order and duration (§1.4), which
keeps them stable as sessions are added.

## 1.6 Recording lifecycle

An empty layer has **no arrangement at all** — `barSources` is empty, which is the absence of an
arrangement rather than a degenerate one. There is nothing to arrange until audio exists, which is
also why §4.2 hides Edit bars until then.

**The arrangement is built on the first session, and never rebuilt.** Every later session leaves
`barSources` and `mutedSlots` exactly as they are. A new pass is an *option the vertical axis gains*,
not a decision about where it goes; auto-selecting the newest pass would silently discard hunting
the user had already done, which is the activity the app exists for.

**A first pass that stopped part way leaves slots with nothing behind them.** Those slots point at
`P1/1` and **start muted**. Both halves are load-bearing:

- **Pointing at real audio** keeps the slot swipeable. Left pointing at a bar that does not exist,
  the tile draws blank and the vertical axis has no available set to wrap through — the user cannot
  select their way out of the hole. Bar 1 is guaranteed to exist the moment any of the pass does.
- **Starting muted** stops the placeholder from lying. An unmuted slot quietly playing bar 1 in slot
  13 would be the app inventing an arrangement the user never performed.

Together they hand the decision back: unmute, then swipe, using only gestures that already exist.
The swipe lock (§3.7) composes rather than conflicts — unmuting is simply the first step, and it is
the step where the user decides the slot should sound. The app never resolves the gap on their
behalf, **including later**: recording a complete second pass does not reach back and unmute these.
By then they are ordinary muted slots, and our guesses would be indistinguishable from their choices.

When the first pass is complete this is exactly recorded order with nothing muted.

**A session holding no usable audio is not recorded.** It would add a file, contribute no passes,
and on an empty layer would trigger initialisation with nothing behind it — an arrangement of
nothing but muted placeholders.

**The layer being recorded onto is silent for the take.** §3.9 already says "all *other* layers
play"; this states why. The user is presumably playing a replacement for what is there, and would
otherwise be performing against the very audio they are trying to replace. It is **derived, never
written into `layer.muted`** — writing it through would make our state indistinguishable from the
user's, so stopping the recording could not restore theirs. Same composition rule as layer mute and
per-bar mute (§3.7).

---

# Part 2 — Audio architecture

## 2.1 Framework stack

| Concern | API |
|---------|-----|
| Graph, taps, scheduling | `AVAudioEngine`, `AVAudioPlayerNode` |
| Session config and routing | `AVAudioSession` |
| Effects | `AVAudioUnitEQ`, panning via `AVAudioMixerNode` |
| Drum loop time-stretch | `AVAudioUnitTimePitch` |
| Waveform peaks | `vDSP_maxmgv` on tap buffers |

## 2.2 Simultaneous playback and recording

```swift
let session = AVAudioSession.sharedInstance()
try session.setCategory(.playAndRecord,
                        mode: .measurement,          // no AGC, no voice processing
                        options: [.duckOthers, .defaultToSpeaker])
try session.setActive(true)
```

`.measurement` matters: voice isolation and noise suppression duck sustained notes and strip room
tone. They are actively harmful for music. Note that Bluetooth microphones may apply their own
processing regardless of mode.

The microphone is never routed to the output, so there is no feedback path — but with speaker
monitoring the drum loop, chord bed and previous layers are all audible to the mic and will be
captured into the new layer, compounding with every layer. Headphones matter; see §4.7.

## 2.3 Input, output and latency

### Input selection — well supported

```swift
let inputs = session.availableInputs        // built-in, wired, USB, Bluetooth
try session.setPreferredInput(chosenPort)
```

Built-in mics narrow further via `setPreferredDataSource` (front/back/bottom) and, on supported
hardware, a polar pattern. **iOS 26+**: `AVInputPickerInteraction` (AVKit) presents the system input
menu in-app with live level metering — the right control here.

### Output selection — constrained on Bluetooth only

Under `.playAndRecord`, output largely follows the input route; `overrideOutputAudioPort` only forces
speaker vs receiver.

**The constraint is a Bluetooth profile limitation, not an API gap.** A Bluetooth headset is either
in A2DP (high-quality, output only) or HFP (bidirectional, mono, low sample rate). There is no
profile where the headset provides high-quality output while a *different* device provides input, so
requesting the built-in mic drops the headset from the record path — and in practice iOS often
collapses the whole route to the phone speaker. **Treat "Bluetooth output + built-in mic input" as
unavailable.** No combination of session options works around it.

**Wired output does not have this problem**, because output and input are independent paths:

- **Wired headphones, no mic**: input stays on the built-in mic automatically. Nothing to configure.
- **Wired headset with inline mic**: iOS defaults input to the headset mic, but `setPreferredInput(builtInMic)` overrides it and output stays on the headphones. Worth exposing — a phone mic usually beats an inline earbud mic for an instrument or room sound.

### Bluetooth microphone quality

- **Legacy (`.allowBluetoothHFP`)**: forces the whole route to mono HFP, degrading *playback* at the same time. Unacceptable for music monitoring.
- **iOS 26+ (`.bluetoothHighQualityRecording`)**: high sample rate AirPods capture with a content-creator tuning, falling back to HFP when unavailable. This is what makes recording with AirPods viable.

### Latency compensation — mandatory

The user hears the backing late, plays in time with what they hear, and their pass lands late. Across
seven layers the error compounds.

```
totalLatency = session.outputLatency + session.inputLatency + session.ioBufferDuration
```

Shift each recorded session **earlier** by `totalLatency` before deriving bar boundaries. Query the
values **after** the session is active and the route has settled — they are route-dependent.

| Route | Typical latency |
|-------|----------------|
| Wired / built-in | 20–50 ms |
| Bluetooth | 150–200 ms |

### Route changes

Subscribe to `AVAudioSession.routeChangeNotification`. A route change alters latency, which
invalidates compensation for anything currently recording: **stop and warn** rather than silently
producing a misaligned pass. Re-read latency on every change. Handle `interruptionNotification` for
calls.

### Recommended configurations

| Scenario | Configuration | Notes |
|----------|---------------|-------|
| **Ideal** | Wired headphones out, built-in mic in | Fully supported, lowest latency, no bleed |
| Wired headset with inline mic | Same, input overridden to built-in | Phone mic usually better |
| USB interface | Interface in, wired headphones out | Best quality |
| AirPods, iOS 26+ | AirPods for both, `.bluetoothHighQualityRecording` | Viable; latency compensated |
| AirPods, pre-iOS 26 | AirPods for playback only | Warn: the AirPods mic drops the route to mono |
| No headphones | Speaker monitoring | Warn: backing bleeds into every layer |

Expose device selection where the user can reach it while recording, and show the active route
plainly. Guidance on *choosing* belongs in the manual (§4.7), not in pre-recording prompts.

## 2.4 Segment-scheduled playback

**The arrangement is never rendered to a file for playback.** Playback is the act of scheduling
regions of the continuous recording, back to back, in arranged order. This is what allows edits to
take effect on playing audio without interrupting it (§2.5).

**Per layer**
- Two `AVAudioPlayerNode` instances, alternating, so segment N+1 can overlap the tail of N. Fourteen nodes across seven layers is negligible.
- Segments queued with `scheduleSegment(_:startingFrame:frameCount:at:)` against the memory-mapped session file.
- Schedule in **beat-sized** segments rather than whole bars, keeping the committed horizon short so a splice is never far behind the gesture.

**Splicing**
- 5–10 ms equal-power crossfade on every join, **unconditionally** — including splices into the same source. Bar boundaries in a live recording almost never land on silence, so butt-joining clicks. A no-op fade costs nothing; branching costs a special case.
- On a mid-bar splice, reschedule from the current playhead rather than the next boundary.

**Timing**
- All layers derive bar starts from **one shared sample-frame anchor** and schedule with explicit `AVAudioTime`. Relative timing drifts layers apart.
- Scheduling work and file I/O never run on the audio render thread.

**Region lookup**

```
sourceBar  = (ref.pass - 1) * barCount + ref.relativeBar
startFrame = barBoundaries[sourceBar]
frameCount = barBoundaries[sourceBar + 1] - startFrame
```

## 2.5 Live editing during playback — core functionality

**Swipes take effect on playing audio without pausing it.** The primary use case is *hunting* —
comparing passes at the exact moment of the phrase being evaluated — not performing.

Two cases, and only two:

1. **Swipe a bar that isn't currently playing** — the slot's `BarRef` changes and the new audio is heard when the playhead arrives.
2. **Swipe the bar that IS playing** — splice immediately at the current position. Capture the exact sample offset within the bar at the moment the gesture commits, and enter the new source bar at that same offset. Two beats into bar 5 becomes two beats into the alternate pass of bar 5.

Mid-bar splice is what makes hunting viable. Boundary-committing would force the user to wait out
the rest of every bar before hearing a comparison — exactly the friction that makes pass selection
tedious.

**No pending indicator.** An earlier design deferred commits to the loop boundary and marked edited
tiles as pending. Immediate commit plus mid-bar splice removes the window where visual and audible
state can disagree, so there is nothing to indicate. **Do not reintroduce it.**

**Tail guard**: a swipe within ~15 ms of the end of a bar would splice into a region shorter than the
crossfade. Skip the splice and let the natural boundary transition handle it — the next bar is
already scheduled correctly.

**Known limitation**: if two passes drift rhythmically, a mid-bar splice can land mid-syllable.
Accepted for the hunting workflow. If it proves disruptive, the fallback is to splice immediately in
the first half of a bar and defer in the second — but do not build that until real recordings
demonstrate the need.

## 2.6 Reference tracks

The drum loop and the chord bed are the same kind of object: non-recorded backing the user plays
against. They share a row treatment, an enable/level/mute control, and one export rule.

### Drum loop

Each loop stores an immutable `originalBPM`; playback rate is `targetBPM / originalBPM`, applied with
`AVAudioUnitTimePitch` (range 0.5–2.0×). Warn on quality when the ratio exceeds 2.0 or falls below
0.5. Superpowered SDK is the upgrade path if wider ratios are needed.

### Chord bed

Generated, not sampled — see §4.4 for the interface. Because the chords are synthesised at the
correct frequencies, **there is no time-stretch problem**: changing BPM changes only when chords
trigger, never how they sound. The chord bed is immune to the ratio limits above.

### Export rule

**Any enabled track is exported, reference tracks included.** To exclude one, mute it. The export
screen has no mute controls of its own — muting happens on the Playback screen, where the user can
hear the result. The rule is *what you hear is what you export*, and it applies identically to a
bounce mixdown.

## 2.7 Storage, quality and compression

### Recording quality

| Setting | Format | Per minute, one layer |
|---------|--------|----------------------|
| **Standard** (default) | 16-bit / 44.1 kHz mono PCM | 5.0 MB |
| **High** | 24-bit / 48 kHz mono PCM | 8.2 MB |

**Global setting, snapshotted into each project at creation, immutable thereafter.** A project's
layers must share a sample rate; if the setting applied live, flipping it mid-project would leave
layers at 44.1k and 48k in one arrangement, forcing a resample at every splice.

**Capture stays PCM in both modes.** Not a quality-for-its-own-sake choice:

- **Layers compound loss.** Seven lossy layers get mixed, then bounced into a new project as a starting layer, which can itself be bounced.
- **Mid-bar splice wants PCM.** Sample-accurate entry at an arbitrary offset is a frame index in PCM; in AAC it means decoding a packet to find the sample, adding latency exactly where the feature can't afford it.
- Lossy encoding belongs at **compression and export**, where the user has declared the material finished.

Standard is the default because a phone mic's noise floor sits well above where 16 bits runs out.
High is for input through a USB interface.

### Size arithmetic

```
loopSeconds  = barCount × beatsPerBar × 60 / bpm
uncompressed = totalPasses × loopSeconds × bytesPerSecond
compressed   = layerCount × loopSeconds × bytesPerSecond      // one loop per layer
```

At 24-bit/48k mono:

| Project | Loop | Layers | Passes | Uncompressed | Compressed |
|---------|------|--------|--------|--------------|-----------|
| 16 bars @ 96 BPM | 40 s | 5 | 12 | 66 MB | 27 MB |
| 8 bars @ 128 BPM | 15 s | 3 | 6 | 12 MB | 6 MB |
| 32 bars @ 84 BPM | 91 s | 7 | 7 | 88 MB | 88 MB |
| 12 bars @ 72 BPM | 40 s | 2 | 7 | 38 MB | 11 MB |

Worst case — 7 layers × 32 bars @ 60 BPM (a 128-second loop) × 8 passes = 56 passes:

| Format | Uncompressed | Compressed |
|--------|--------------|-----------|
| 16-bit / 44.1k | 603 MB | 75 MB |
| 24-bit / 48k | **984 MB** | 123 MB |

Design consequences:

- **Pass count drives size, not layer count.** A 5-layer project with 12 passes costs more than a 7-layer project with 7. This is why the Library shows the pass count beside the layer count — it is the number that explains the size.
- **Slow, long loops are the expensive case.**
- **Compression saves nothing on a project with one pass per layer.** Show the projection before confirming; sometimes the honest answer is "this won't help."
- A gigabyte is reachable but requires deliberately extreme settings. Typical sketches land in the tens of megabytes.
- Waveform caches (~6 KB per session) and metadata are rounding errors.

### Retention

Live editing requires the full continuous recording to stay available while a project is
uncompressed. **Unselected passes cannot be auto-deleted** — auto-cleanup and live splicing are
mutually exclusive.

Storage is therefore **visible and user-managed, never coerced**: the Library shows each project's
size, and Compress is the user's tool. No forced commit, no maximum-passes threshold, no background
deletion. The app is for quick sketches; storage shouldn't be a hassle in either direction.

### Compress

Discards every recorded pass, keeping each layer's final edited loop.

- The retained loop is **standardised to Pass 1** for each layer, and bars are **renumbered to the arranged order**. The original numbering referenced audio that no longer exists.
- **Compressed projects remain recordable.** Recording a new pass clears the compressed status — passes exist again, so the flag would be a lie.
- The pass axis re-enables automatically, because availability is derived from audio (§1.4), not from the flag.
- The project can be compressed again later.

### Bounce

Creates a **new project** seeded with a combined, compressed copy of the original.

- All layers are mixed into a **single audio file** with EQ, pan and level baked in. Enabled reference tracks are included; the mixdown contains exactly what was audible.
- That file becomes **layer 1** of the new project, as **Pass 1**, and layer 1 can record further passes like any other layer.
- **The original project is untouched.**
- BPM, bar count and chord settings are preset from the source.
- Layers 2–7 are empty and available.

**Quality conflict**: if the source project's quality differs from the current global setting, ask;
otherwise ask nothing.

| Choice | Effect |
|--------|--------|
| **Use project quality** (default) | New project matches the source. No resampling. |
| **Use current setting** | Mixdown resampled once; layers recorded next match natively. |

Both are legitimate. Keeping the source quality preserves the mixdown exactly and suits a bounce that
is the foundation of the new piece. Taking the current setting costs one resample of material that is
already a composite — and suits a bounce that is **a reference the user will mute or delete**, where
matching the working rate of everything recorded next matters more.

**Why bounce makes a new project**: nothing is destroyed, no partially-editable layer state has to
exist inside a project, and the seven-layer ceiling stops being a wall — it becomes a stage.

## 2.8 Effects

Applied per layer, in real time, persisted with the project.

**EQ presets** — six, named for what they do rather than for a source, since any layer can hold
anything. Chosen by icon like the pan presets, each drawn as its curve.

| Preset | Bands | Does |
|--------|-------|------|
| Flat | — | No EQ |
| Low Cut | high-pass 100 Hz, Q 0.707 | Removes rumble and body |
| High Cut | low-pass 8 kHz, Q 0.707 | Removes air and edge |
| Presence | peak 4 kHz, +3.5 dB, Q 1 | Pushes forward |
| Scoop | peak 500 Hz, −4 dB, Q 1 | Makes room for other layers |
| Distant | high-pass 300 Hz + low-pass 3.4 kHz, Q 0.707 | Sends it to the back |

**Only three filter kinds and no shelves**, which maps 1:1 onto `AVAudioUnitEQFilterType` and Web
Audio's `BiquadFilterNode` — the platform-bound part of EQ is setting four numbers on a stock filter.

**Q is 0.707 (Butterworth) on the filters, not 1.** Mixing sources often suggest Q = 1 on a
high-pass, which puts a small resonant peak at the corner: a colour worth choosing on a known source,
not a default for whatever the user happened to play. A steeper 24 dB/octave slope would be two
cascaded biquads, not a change of Q.

**Frequencies are craft convention and every source quotes a range** — these sit mid-range and are a
starting point for listening. The exception is Distant: 300 Hz to 3.4 kHz is **ITU-T G.101**, the
literal bandwidth of a narrowband voice channel.

**Presence is the only preset that boosts.** The other four can only make a layer quieter, so it is
the single place a preset change can push a seven-layer sum toward clipping.

`responseDb` in `src/domain/eq.ts` computes the actual curve, and `tests/eq.test.ts` asserts each
preset does what its name and icon promise — corner frequencies at −3 dB, bells at their stated
gain, and the right shape with no ripple. The numbers above are therefore checkable rather than
quoted. The retired set was source-based — Warm Vocals, Bass Thump, Crisp Drums, Airy Strings,
Gritty Guitar, Lead Synth — and `docs/mockups/playback-screen-mockup.html` still lists those names.

**Pan presets**: Center (0°), Slight L (−15°), Slight R (+15°), Wide L (−45°), Wide R (+45°), and
**Surround** — a Haas effect where the duplicate is delayed, panned opposite and sits below the dry.

**The angle is the equal-power angle**, so ±45° is a *hard* pan and Slight is a third of the way
across. Sources are mono (§2.7), so panning is positioning rather than balancing and the law must be
equal-power (`L = cos θ`, `R = sin θ`); linear panning dips about 3 dB through the centre, heard as
a layer going quiet in the middle of the sweep.

**The Surround delay is `7500 / BPM` ms clamped to 35 ms.** That formula is exactly **one eighth of
a beat** — a 32nd note at 4/4, since `60000/BPM ÷ 8 = 7500/BPM` — so it is a note division rather
than a magic constant, and is computed in frames like everything else. But **the Haas effect only
fuses below roughly 35–40 ms**; past that the ear hears a second attack instead of a wider image.
Unclamped the delay is 62.5 ms at 120 BPM and 125 ms at 60 BPM, both plainly echoes, and it only
stays inside the window above about 214 BPM. The clamp costs the tempo sync at most tempos and keeps
the preset doing what its name says at all of them. **The 32nd-note slap it discards is a good
effect in its own right and belongs to the v2 delay (§6.2)**, which is why `DelaySpec` is shaped for
a general delay — Surround is one configuration of it, with a single repeat and no feedback.

Surround's fixed choices: **dry left, delayed right** (fixed, or every Surround layer leans the same
way), and the copy at **−1.5 dB**. That level is a considered split between unity and −3 dB and is
**flagged for confirmation by ear** — Surround is the only preset whose two paths both carry signal,
so it lands about 2.3 dB hotter in total power than any other, and switching to it reads partly as a
level change. There is a test recording that consequence so a change to the number is deliberate.

**Build the delay path on every layer and silence it with gain** rather than adding it when Surround
is chosen. Every preset therefore reports the same delay time, and switching presets is a gain ramp:
rebuilding the node graph clicks, and so does moving the delay time of a running line. Preset changes
are a live gesture. The delay time then only ever moves when the tempo does, and tempo locks after
the first recording (§4.5).

**The delayed copy of the last bar runs past the loop end.** Live that needs nothing — the line keeps
running across the boundary the way any delay does. **Bounce and export render a fixed-length file**,
so there the tail must wrap into the start of the loop, or the rendered version has a discontinuity
the live one never had.

### Pan preset icons

Presets are chosen by icon rather than by name. The icon is `((o))`: a filled circle with three arcs
each side, drawn in full with unlit arcs as dim ghosts. Arcs lit per preset:

| Center | Slight L | Slight R | Wide L | Wide R | Surround |
|---|---|---|---|---|---|
| 2 / 2 | 2 / 1 | 1 / 2 | 3 / 0 | 0 / 3 | 3 / 3 |

These are static labels standing in for names, not readouts — they are not derived from the pan
gains, and they indicate nothing about the delay. Both sides always use the same radii.

Layout, sizing and states follow `docs/kit/` and `docs/mockups/`.

Native `AVAudioUnitEQ` plus mixer panning is sufficient for v1; Superpowered or JUCE only if the
effects rack in §6.2 is built.

**Level changes interpolate over 10–50 ms** to avoid clicks.

---

# Part 3 — Component library

Everything here lives in `lr-kit.css` / `lr-kit.js` and is used by more than one screen. Specify a
component once, here; screens reference it.

## 3.1 Design tokens

The whole app is drawn from **one violet family** — no pure neutrals. Values were chosen by holding
luminance constant and changing only hue, so value relationships are unchanged from the earlier
neutral set.

```css
--lr-grad-start #5A5FCE   --lr-grad-end #64408E    /* screen background, 135° */
--lr-page       #E8E4F2                            /* behind the app frame */

--lr-tile       #382561   /* default surface           */
--lr-tile-hover #402B6E
--lr-tile-sel   #1B1733   /* SELECTED — see below      */
--lr-tile-muted #43306E   --lr-tile-muted-sel #2C2549
--lr-tile-armed #2E2050   --lr-tile-rec       #4A2350
--lr-tile-empty #33265A

--lr-ink        #E6DCFF   /* primary text on dark      */
--lr-ink-dim    #B4A5E4   --lr-ink-faint #9384C4
--lr-ink-pass   #9384C4   /* the smaller P# portion    */
--lr-ink-on-light #35275E /* text on light buttons     */
--lr-hint       #9C8CD0   --lr-hint-sel  #B9A9EC
--lr-rec        #FF6B6B

--lr-spent      173,152,214   /* played lines fade toward this, on violet */
--lr-spent-sel  140,133,175   /* ...on the dark selected surface          */

--lr-line-w 3px  --lr-line-gap 3px   /* set at runtime; always equal */
--lr-radius 8px  --lr-seam 2px
```

**Default surfaces carry the violet fill; selection drops to the dark tile.** This inversion is
deliberate: selection *recedes into a well* rather than lighting up, which reads cleaner against a
violet background and measurably improves the selected surface's contrast against the background at
both ends of the gradient:

| Selected surface | vs gradient light end | vs gradient dark end |
|------------------|----------------------|---------------------|
| Dark `#1B1733` (chosen) | **3.26:1** | **2.19:1** |
| Violet `#382561` (rejected) | 2.47:1 | 1.66:1 |

The brighter treatment was starting to disappear at the dark end of the gradient.

Selected and default text values differ because the surface beneath them differs. Matching absolute
colour would make perceived weight inconsistent.

Contrast check: white text 5.30:1 / 7.88:1 against the gradient ends; spent lilac 5.13:1 against the
default tile; spent grey 5.00:1 against the selected fill.

## 3.2 Gradient — `LR.ramp`

Eleven anchors, interpolated to however many stops are needed:

```
[255,138, 91] coral        [ 79,209,197] teal
[255,178, 89] amber        [ 86,194,255] sky blue
[255,217,102] gold         [122,168,255] cornflower
[214,230,110] chartreuse   [169,140,255] periwinkle
[124,224,142] spring green [229,140,224] orchid
                           [255,143,176] rose
```

**The stop count is derived from the line count** (`recordedBars × linesPerBar`), never the reverse.
A fixed-size palette was tried and rejected: song length must never be limited by how many colours
are defined.

**The greens and blues are load-bearing.** An earlier orange→purple ramp spent most of its length in
near-identical warm tones, which made the colour discontinuities hard to see. The whole point is that
adjacent lines are distinguishable.

| Method | Use |
|--------|-----|
| `rgb(t)` / `css(t)` | colour at position `t` (0–1) |
| `slice(i, n)` | the sub-range belonging to layer `i` of `n` |
| `toSpent(rgb, t, target)` | blend toward a spent target |
| `tokenRGB(name)` | read a spent triple out of a CSS custom property |

**Two colour meanings, one ramp.** On the Edit Layer screen, position in the ramp means *position in
the recording*. On the Playback screen, each layer owns `slice(i, 7)` so position means *which
layer*. Deliberate, and the screens are never seen at once — but see §6.1.

## 3.3 Waveform — `LR.Waveform`

One line renderer, three densities.

| Variant | Used by | Line count |
|---------|---------|-----------|
| *(default)* | Edit Layer tiles | 16 per bar, fixed |
| `lane` | Playback rows | ~40, follows the container |
| `thumb` | Library rows | 16, sized in % |

### Geometry rules

| Rule | Why |
|------|-----|
| Line width **equals** the gap, always | |
| Both floored to a **whole pixel** | Fractional widths put some lines on device-pixel boundaries and not others, so identical lines render at visibly different weights |
| Heights rounded to **even** whole pixels | Centre alignment puts the midpoint on the container centreline; an odd height lands the edges on half-pixels and antialiases the capsule caps into hairlines |
| Container height fixed and **even** | A fractional container height does the same thing to every line at once |
| Lines are capsules (`border-radius: 999px`) | `50%` produces ovals |
| Minimum rendered height = one line width | Below that a capsule cannot draw its caps and degrades into a smudged nub |

Two sizing strategies, both in `LR.sizing`:

```js
fitToCount(containerPx, lineCount)    // fixed count, width follows   (tiles)
fitToWidth(containerPx, targetLines)  // width and count both follow  (lanes)
```

`fitToWidth` picks the whole-pixel width closest to the target, then fits as many lines as that
width allows — filling 99–100% at any viewport.

**Fewer, thicker lines are load-bearing on lanes.** At 2 px the cap radius is 1 px, and scaling to a
fractional height smears the cap into a visible hairline above and below the line. At ~9 px the
radius is 4.5 px and the same error is invisible. Thickness solved an artifact that pixel-snapping
only masked.

**Waveform shape is keyed to normalised position (0–1), not line index**, so a lane redrawn at a
different count keeps its silhouette. Otherwise resizing appears to change the recording.

### The `scaleY` trap

**`scaleY` cannot be used to reach the dot floor.** CSS resolves an over-large `border-radius` by
scaling every corner by **one shared factor** (here `width / 2`), not per axis. Squashing the box
vertically therefore leaves a wide horizontal cap over a near-zero vertical one — visually square.
Any collapse to the floor must animate **real height**.

### Rendering

`paint(line, passed, scale, spent, floorPx)` writes exactly one transform and one colour per line.
`passed` is the distance beyond the playhead, or negative for lines not yet reached.

## 3.4 Motion model — `LR.motion`

**All height motion on every screen runs through one render pass.** Each source produces an
activation; activations map to scale factors; factors compose multiplicatively.

```
playScale  = 1 - (1 - 0.8) × easeIn(clamp01(playhead - lineIndex))
swipeScale = 0.6 + 0.4 × swipeActivation
scale      = max(playScale × swipeScale, lineWidth / baseHeight)
```

| Source | Rest depth | Window | Notes |
|--------|-----------|--------|-------|
| **Playback** | 80% | one line's duration | Full height → 80% as the playhead passes, then holds |
| **Swipe** | 60% | eased | Contracts to 60% of *current* height, springs back on release |
| **Mute** | dot floor | ~110 ms | Real height, not transform. Colour still animates. |

**Playback easing is ease-in (`t³`)** — the line holds, then snaps at the moment of crossing,
reinforcing the beat rather than anticipating it. The direction was flipped late in design: full→80%
reads better than low→full, because played lines end up both shorter and duller, a coherent "spent"
state.

**The two rest depths differ on purpose.** 80% for playback (constant background motion, must stay
subtle — 60% was tried and judged too distracting); 60% for swipe (a deliberate act, reads stronger).
Composing multiplicatively means a swipe always takes the wave to 60% of whatever height it has, so
the gesture feels consistent regardless of playback state.

**Mute colour still animates.** The bar is silent on this layer but still occupies its slot, and
other layers sound through it, so the progress sweep must stay readable.

**Colour fill** uses the same playhead with a wider feather (2.5 lines) than the height window
(1 line), producing a soft colour edge trailing a crisp height edge.

All easing is frame-rate independent:

```js
value = LR.motion.approach(value, target, tau, dt)   // v += (target-v)(1-e^(-dt/tau))
```

| τ | Value |
|---|-------|
| swipe contract | 70 ms |
| swipe release | 120 ms |
| loop reset | 180 ms |
| mute | 110 ms |

Clamp `dt` to 50 ms per frame so returning from a backgrounded app doesn't jump the playhead.

**Use transforms for per-frame motion**; real height only for the mute collapse. With 256+ lines
animating per frame, height changes trigger layout while `scaleY` composites.

## 3.5 Controls

### Volume — `LR.VolumeControl`

**Level and mute in one speaker icon.** Three arcs, all filling together with the level, each growing
from its **centre outward** (normalise `pathLength` to 1, draw a dash of length `f` starting at
`0.5 - f/2`).

- **No track behind the arcs** — the icon shows the level itself rather than the level against a ceiling, and a silent layer looks genuinely silent rather than dimly outlined.
- **Muted**: arcs hidden, body dimmed, a slash wipes in over ~180 ms using the same dash technique.
- The icon **absorbs its own clicks** so muting never also expands the row.
- **No numeric readout in the row.** The arcs are the readout; precision belongs on the expanded slider.

A staged version (four arcs filling one at a time) was tried and rejected: it required reading which
arcs were complete and then how far into the next — three judgments for one value.

### Record — `LR.RecordDot`

| State | Dot | Row |
|-------|-----|-----|
| Unarmed | Grey, translucent | No emphasis |
| Armed | Red, slow pulse | Background lifts, soft red inset border |
| Recording | Red **square**, no pulse | Stronger red border, warmer background |

- **Positioned at the far LEFT of a row, opposite the speaker.** They were neighbours, which put "start recording" a thumb-width from "mute". The consequences are asymmetric: a mis-hit on mute is one tap to undo, a mis-hit on record starts or stops a pass.
- **Arming is exclusive** — arming one layer clears any other.
- **Hold while armed cancels** back to unarmed; Escape does the same on a keyboard. Hold does nothing while recording, where a tap already means stop.
- **While a pass is running every other record control is removed** (`visibility: hidden`, preserving row spacing so nothing shifts when it ends). A greyed control still invites a tap and then has to explain itself.

### Transport — `LR.PlayButton`, `LR.ProgressBar`

A standard progress bar with optional bar ticks and click-to-seek, alongside the gradient sweep
rather than replacing it. The sweep shows *what* has played; the bar shows *how far through* at a
glance.

## 3.6 Transport logic — `LR.Transport`

Progress indexes on the **edited** timeline. Modes: `idle`, `bar` (repeat one slot), `loop` (play the
arrangement from an origin).

**The played set must be computed in ONE place.** Every bug in this area came from a render pass and
a release path disagreeing. `isPlayed(slot)` and `passedAt(lineIndex)` are that place.

Rules, each of which was arrived at by fixing a visible defect:

| Rule | Symptom when broken |
|------|--------------------|
| Gate activation to the transport's **origin** | The colour feather reaches backwards across the bar boundary and tints the tail of the previous bar, which never played |
| **Release the gate at the wrap** past the end of the arrangement | Bars before the origin never light on the return leg |
| While wrapped, **hold lines from the origin onward as played** | After the wrap the playhead drops to 0, so everything from the origin on recomputes as unplayed and pops back in one frame |
| A cycle is origin → end → start → **back to origin**; release at the origin crossing | Releasing at the arrangement end fires mid-cycle whenever playback began somewhere other than slot 0 — a jarring flash |
| The release floor is **per slot**, never global | Finishing a one-bar playback flashes every other bar, including ones that never played |
| On pause, rewind **and** release only the genuinely played slots | Bars before the origin flash on stop; or played bars stay stuck spent |
| **Selection clears on pause**, and nothing is selected on load | Selection points at nothing |

## 3.7 Gestures

Established on the Edit Layer tiles; the same idioms apply anywhere they recur.

| Gesture | Effect |
|---------|--------|
| Swipe up / down | Steps `pass` |
| Swipe left / right | Steps `relativeBar` — **swiping LEFT steps forward** |
| Single tap | Repeats that bar, looping until stopped; tapping again stops |
| Double tap | Plays the arrangement from that bar |
| Tap the origin during loop playback | Pauses |
| Tap and hold | Mutes / unmutes that **bar** |

**The horizontal axis is inverted relative to travel**: the next bar is pulled in from the right, the
way a filmstrip moves under the finger. Arrow keys match (Left = forward), which reads oddly on a
keyboard but keeps one mental model.

**Mute scope is the bar, not the layer.** Every other gesture on a tile acts on that tile, and the
Edit Layer screen edits a single layer — muting the layer there would silence what you're editing.
Layer mute lives on the Playback screen.

**Swiping is locked while a bar is muted.** A muted tile shows no contraction and no redraw, so a
swipe would change the pass with zero feedback — silent state mutation the user discovers much later.

### Conflict resolution

Single tap and double tap normally conflict: a single tap can't fire until the double-tap window
expires, which puts audible latency on the most common action. **Resolved by escalation, not
waiting** — the first tap starts the bar immediately, and a second tap inside 300 ms simply lets
playback continue past the bar end into the full loop. Both are "play", so nothing is undone.

| Pair | Resolution |
|------|------------|
| tap / double tap | Escalation, as above |
| tap / hold | Hold fires at 500 ms and suppresses the pending tap |
| hold / swipe | >8 px of travel cancels the pending hold; a hold requires stillness |
| swipe / tap | A press that never crosses ~22 pt falls through to tap |

Also required:
- Axis locks to the dominant direction past ~22 pt, so a diagonal never changes both values
- Origin resets after each step, so one drag scrubs multiple bars without lifting
- `pointercancel` **must** reset state, or a tile sticks when an iOS edge swipe steals the gesture
- Clear double-tap tracking on every pause, or the next tap reads as a double and resumes
- Arrow keys drive the same axes — a swipe-only interface is unusable with VoiceOver

## 3.8 Row and panel — `.lr-row`

One primitive serves layer rows, reference rows and project rows: a head that is always visible and a
panel that expands on tap.

- The head holds the row's controls; **each control absorbs its own clicks** so acting on one never also toggles the panel.
- Panels hold settings rather than content — level, presets, destructive actions.
- Rows are separated by a 2 px seam. **The background belongs to the row, not the container**; with it on the container the seams are invisible.

## 3.9 Labels and badges

**Pass badge** — shows the pass about to be captured: `Pass 1` for an empty layer, `passes + 1`
otherwise. From the moment a layer is **armed** it takes the name's place and holds it through the
recording: the label helps you find a layer later, but once you've committed to recording onto it
the only thing that matters is which pass is being captured.

**It has two states while recording, because a pass now has to be earned** (§1.4). The number
**increments the instant a traversal begins**, and reads **provisional** until that traversal has
completed a bar and become a real pass. Waiting for the bar to increment would freeze the badge
through the loop point, which reads as broken; showing the number at once and marking it unearned
is honest about both facts at the same time.

The provisional number never lies about what it will be. Stop before the bar completes and the
traversal is discarded, and that same number is what the next take claims — it is either committed
or handed straight back, never reassigned to something else.

Treat this as a **quiet state change, not an alert**: the two states differ the way a placeholder
name differs from a real one, and nothing animates on arrival. It is peripheral information for a
user who is playing, and the app is not scoring the take (§0.4). Commitment is `passExists` — the
same predicate that decides survival at the stop, so the badge is a live preview of the gate rather
than a second rule that could drift from it.

**Fixed-width label column.** The name and the badge swap **inside one box**, so a lane starts at the
same x in every state. As siblings, arming a layer widened that row and pushed its lane out of
alignment with the others.

**Editable names**: tap to rename, Enter commits, Escape reverts.

- **Capped at 12 characters, enforced while typing** — a field that grows mid-edit shoves the lane sideways on every keystroke. Paste truncates to the remaining room; `max-width` with ellipsis backstops wide glyphs.
- Empty layers show a **placeholder**, not a real name, so an unnamed layer doesn't require clearing text first.
- The name absorbs its own pointer events so editing doesn't expand the row.
- Force plain-text paste, or copied markup lands in the row.

**Tags**: `HQ` (green), `Compressed` (neutral), `Bounced` (blue).

---

# Part 4 — Screens

## 4.1 Project Library — app entry point

Lists all projects, **most recently modified first**. Reference: `project-library-mockup.html`.

**Row anatomy**: play button · thumbnail · name and metadata · size or position · chevron · panel.

| Element | Detail |
|---------|--------|
| **Thumbnail** | One `thumb` waveform per recorded layer, each in that layer's `LR.ramp.slice`. A project is recognisable by its colour signature and stripe count before the name is read. |
| **Metadata** | BPM · bars · layers · **passes** · last modified. The pass count is shown because it, not the layer count, explains the size (§2.7). |
| **Size** | Per project; the header shows the device total. |
| **Tags** | HQ, Compressed, Bounced |

**Inline playback.** Each row plays without opening the project. Playback is **exclusive** — starting
one stops another, matching the arming rule. The **thumbnail is the progress display**: played lines
recede, the same convention as the other screens, so no separate progress bar sits over the artwork.
The size readout swaps to a position readout while playing, so the row doesn't change width.

> Preview should play a **cached rendered mix**, not the full scheduling engine. The Library may show
> dozens of projects; standing up seven player nodes per row to audition a sketch is wasteful.

**Actions** (in the panel): Open · Export · Bounce · Compress · Delete.

**Destructive actions confirm in place and state the outcome.** Compress shows the real projection —
"214 MB → 26 MB" — because a projected saving is the entire reason to do it, and a generic prompt
hides the only fact that would inform the decision. Compress is disabled on already-compressed
projects, and its copy notes that recording a new pass clears the status.

**Open questions**: tapping the row currently expands the actions; in the build the row body should
open the project and the chevron should stay the secondary action.

## 4.2 Playback screen

Reference: `playback-screen-mockup.html`.

```
Header      project name · BPM · bars · time signature
            play · progress bar · position · master volume icon + slider
Reference   drum loop · chord bed
Layers      seven rows
Footer      gesture legend · Export
```

**Layer row**, left to right:

| Element | Component | Notes |
|---------|-----------|-------|
| Record dot | §3.5 | Far left |
| Label column | §3.9 | Fixed 116 px: index, editable name, pass badge |
| Lane | §3.3 `lane` | Fills remaining width |
| Speaker | §3.5 | Level + mute |

Tapping the row expands: level, and — once the layer holds a pass — EQ presets, pan presets,
**Edit bars**, and **Clear layer**.

**Clear layer** removes all of that layer's sessions and resets its `barSources`, returning the row
to the empty state. It is the only way to discard a single layer's audio (§5.1 #2), it is
destructive, and it confirms in place like Delete and Compress. It is self-contained: no other layer
references this one's passes.

**Empty layers**: EQ, pan and Edit bars are **hidden** until the layer holds a pass; they have
nothing to act on. Gate on `passCount > 0` so they appear the moment a pass completes. Level stays
visible — it sets the monitoring level for the layer about to be recorded. The panel reads
*"Record a pass to start editing."* While an empty layer's panel is open the record dot warms and
emits a slow expanding ring, ending when the panel closes and yielding to the armed and recording
states.

**Recording**: the playhead resets to the top of the loop (a pass starting mid-loop would have bar
boundaries that don't align with everything else, breaking the whole bar-swapping model), the lane
draws the incoming waveform in real time, and the pass badge increments at each loop point,
provisional until that pass has earned its first bar (§3.9). All other layers play at their current
level, mute, EQ and pan — the layer being recorded onto is silent for the take (§1.6).

**Live waveform**, real implementation:

```swift
inputNode.installTap(onBus: 0, bufferSize: 1024, format: fmt) { buffer, _ in
    var peak: Float = 0
    vDSP_maxmgv(buffer.floatChannelData![0], 1, &peak, vDSP_Length(buffer.frameLength))
    ringBuffer.write(peak)          // lock-free handoff
}
```

At 44.1 kHz with a 1024-frame buffer that's a value every ~23 ms — finer than needed, so bucket
several per drawn line. **No allocation, no locks, no UIKit in the tap callback.** Drain on a
`CADisplayLink`. `AVAudioRecorder` metering gives only a current level, not a history; use the tap.

**Reference rows** use the same primitive: a Lucide `drum` or `keyboard-music` icon, the content
(drum part name; the four chords), a speaker, and a panel. The drum row shows no BPM — that's a
project setting shown in the header. The chord row's scale and tone live in its panel.

## 4.3 Edit Layer screen

Reference: `edit-layer-mockup.html`. Reached from **Edit bars** in a layer's panel.

A grid of bar tiles, four per row, `rows = barCount ÷ 4`. Each tile shows one bar of recorded audio
as 16 lines.

| Element | Component |
|---------|-----------|
| Header | Layer name, project meta, speaker + level slider (§3.5) |
| Tile waveform | §3.3, default variant |
| Tile label | `P2` left in smaller dimmer type, relative bar right at 16 px |
| Swipe hint | `↕ pass` / `↔ bar`, **always visible** |
| Gestures | §3.7 |
| Transport | §3.6 — no transport buttons; play and stop are taps on tiles |

**Layout**: 5 px horizontal padding on every tile; 2 px seams in both directions; waveform max height
40% of the 120 px tile; bar row height fixed at 72 px (even).

**Corners are squared except the outer left and right ends of each row.** Rounding all four corners
of every tile produced a visible **Hermann grid illusion** at the seam intersections — the rounded
corners widened each crossing into a pool where the grey smudges formed. Squaring the interiors
eliminates it, and each row reads as one continuous bar with rounded caps.

**Swipe hints are always visible, never hover-revealed.** Touch devices have no hover, so a
hover-gated affordance never appears on the platform the gesture is designed for.

**One pass available** — a layer one pass in, a compressed layer, a bounced layer — is a single
defined state, derived from audio (§1.4), not a flag:

- The vertical (pass) axis is **disabled**
- The `P#` portion of the label is **hidden**; the tile shows only the bar number
- The horizontal axis stays fully active, so bars can still be rearranged against the single loop

For layers with more than one pass but still few, consider showing the range (`P2/4`) so the wrap is
predictable.

## 4.4 Chord progression reference

A generated chord bed that plays alongside the drum loop, enabled without recording anything, and
available while recording every layer.

| Control | Options |
|---------|---------|
| Scale | Major, minor, and less common scales (dorian, mixolydian, phrygian, lydian, harmonic minor…) |
| Four chord slots | A recurring **4-bar** progression, one chord per bar |
| Chord root per slot | Note with natural / flat / sharp |
| Tone | Several timbres |

**Scale plus root is enough.** The scale determines each chord's **quality** from its root: pick D in
C major and you get D minor; pick D in D major and you get D major. The user never chooses "minor" or
"diminished" — they pick a scale and four roots, and the harmony is correct by construction.

**Do not add a chord-quality picker to the primary interface.** It would double the decisions and
undo the entire benefit. Out-of-scale roots are allowed (borrowed chords are useful): default them to
a major triad and mark them as outside the scale. A per-slot override, if ever wanted, belongs behind
a long-press.

**Bar counts are always multiples of 4**, so a 4-bar progression tiles evenly into every valid
project length — no partial-progression case exists at any bar count.

**Synthesised, not sampled** (§2.6). Trigger one chord per bar against the shared sample-frame
anchor. Voicing follows the tone — a pad holds through the bar, a keyed tone re-articulates — and
sits mid-register so it stays under vocals.

## 4.5 Project Setup and Export

**Setup**: name, BPM, bar count, drum loop selection with preview at the project tempo, and the
recording quality inherited from the global setting. This is the **last point** at which BPM, bar
count and quality can be changed for the project.

**Export**: format (WAV / MP3), quality, preview, share. **No mute controls** — it exports the
project exactly as it currently sounds, and muting happens on the Playback screen where the result
is audible (§2.6).

## 4.6 Settings

Global, and — unless stated — they apply live.

| Setting | Options | Applies |
|---------|---------|---------|
| **Recording quality** | Standard (16-bit / 44.1k) · High (24-bit / 48k) | **New projects only.** Snapshotted at creation and immutable thereafter (§2.7). |
| **Count-in** | Off · 1 bar · 2 bars | Live. Never recorded, so it needs no per-project snapshot (§5.1 #3). |
| **Export format** | WAV · MP3, with quality | Default for the export screen |
| **EQ / pan preset defaults** | Which preset a new layer starts on | Live |
| **Master level limiting** | On / off | Live |
| **Playback loop mode** | Repeat on / off | Live |

**There is no metronome setting** — the drum loop replaces it (§5.1 #8). **There is no bar increment
mode** — the two-axis swipe replaced it (§5.2).

Recording quality is the only setting with snapshot semantics, and the reason is worth stating in the
UI: a project's layers must share a sample rate, so a live setting would let a user end up with
layers at 44.1k and 48k in one arrangement.

## 4.7 User manual

The app needs one, and the Edit Layer screen is the reason: its core interactions are **powerful but
undiscoverable**. Nothing about a grid of coloured waveforms announces that vertical swipes change
passes, that horizontal swipes change bars, or that a colour jump means a bar came from somewhere
else. A user who doesn't know these things sees a pretty visualisation instead of an instrument.

**Access**: a help affordance on the Edit Layer screen, an entry in the Project Library, and
deep-linkable sections so a control can point at its own explanation. The in-tile swipe hint stays as
a reminder; the manual carries the reasoning.

**Topics**

| Section | Covers |
|---------|--------|
| Editing | What `P2 / 5` means; the two axes; **reading the gradient** — the highest-value entry, because the swipe is discoverable by accident and the colour encoding is not; live editing and mid-bar splice; why the pass axis disappears after compressing |
| Recording setup | The ideal wired setup; why Bluetooth output with the phone mic is impossible (A2DP vs HFP — explained as a constraint, so it reads as physics rather than a bug); why Bluetooth monitoring feels detached; what bleeds when using the speaker |
| Everything else | Reference tracks; how scale plus four roots produces the chords; what compress discards and keeps; that bounce leaves the original untouched; that export matches what you hear |

**Tone**: short, plain, answering questions users will actually have ("why did that bar change
colour?", "why does it sound late?"). Each entry readable in isolation, since users arrive by deep
link rather than reading front to back.

---

# Part 5 — Decisions

Settled deliberately. Recorded with reasoning, because several look arbitrary without it and a
future session would otherwise "clean them up" and quietly undo the iteration.

## 5.1 Settled

| # | Decision | Reasoning |
|---|----------|-----------|
| 1 | **4/4 only in v1**, but `beatsPerBar` stays a named constant | `framesPerBar = round(sampleRate × 60 × beatsPerBar / bpm)` — never hardcode 240. Bar counts being multiples of 4 is a UI constraint, not a timeline one. |
| 2 | **A layer can be cleared; an individual pass cannot be deleted** | `barSources` references pass numbers; deleting one pass renumbers the rest and breaks every reference past it. Clearing a layer is self-contained. Compress is the only other way to discard audio, and it renumbers everything at once. |
| 3 | **Count-in exists and is not recorded**; length is a global setting | The session's first frame is the downbeat of Pass 1, or every boundary is offset by a bar. It never touches the audio, so it needs no per-project snapshot. |
| 4 | **BPM and bar count lock after the first recording** | Every derived value depends on them. |
| 5 | **A partial bar at the end of a session is kept AND exposed** — reversed; see §1.4 | Still **don't pad**: the rule's real point was that padding creates silent bars that look selectable. `regionFor` clamps to the file, so the bar plays short instead. A bar the recording never reached is still excluded, and a slot with nothing behind it starts muted (§1.6) rather than blank. |
| 6 | **Exactly 7 layers** | Not "7+". The row stack has no defined behaviour otherwise. |
| 7 | **Sessions are written to disk continuously**, not at stop | The raw performance is the only asset that can't be recreated. Recovery needs no special handling: under §1.4 a partial session is already a valid one. |
| 8 | **No metronome — the drum loop replaces it** | Every project has a drum loop for timing reference. A separate click would need its own row, level and export rule for nothing. |
| 9 | **No solo** | It earns its place in a DAW with dozens of tracks; with seven layers muting suffices. It also collided with the export rule — if solo mutes everything else, soloing silently changes what exports. |
| 10 | **No undo stack** | Every reversible action reverts through its own control (below). An undo stack would be a large amount of state for actions that already carry their own inverse. |
| 11 | **Storage is user-managed, never coerced** | No forced commit, no maximum-passes threshold, no background deletion. See §2.7. |

**Reversibility without undo**:

| Action | Reverts by |
|--------|-----------|
| Swipe (pass or bar) | Swiping back |
| Mute | Unmuting |
| Rename | Renaming again |
| Delete, Compress, Clear layer | A confirmation before the fact |

## 5.2 Rejected alternatives

Do not reintroduce these. Each was built or specified, then removed for the stated reason.

| Rejected | Why |
|----------|-----|
| **Increment-mode toggle** (loop vs bar) | Deprecated by the two-axis swipe. It was also a hidden mode — the same click did different things depending on state set earlier and invisible at the moment of action. |
| **Pending / deferred-commit indicator** | Immediate commit plus mid-bar splice removed the window where visual and audible state can disagree. Nothing left to indicate. |
| **Coloured axis-flash on swipe** | Read as unwanted flashing; redundant against the contraction, label change and redraw; and an abrupt on/off event in an otherwise continuous motion design. |
| **Inset ring on the sounding bar** | An inset shadow reads as the tile's background shrinking. |
| **Transport buttons on the Edit Layer screen** | Play and stop are taps on the bars themselves. |
| **Axis arrows beside the numbers** | Tried, reverted; the swipe hint at the bottom of the tile is clearer. |
| **Hover-revealed swipe hints** | Touch has no hover, so the affordance never appears where it's needed. |
| **Fading played lines to white** | Too loud, and white also reads as "empty layer", so a mid-playback layer could be mistaken for an unrecorded one. |
| **Rounding all four corners of every tile** | Produced a Hermann grid illusion at the seam intersections. |
| **Hiding sub-threshold lines** | The gaps implied silence that isn't in the recording. Floor them to dots instead. |
| **Fixed-size gradient palette** | Caps song length at the number of colours defined. |
| **Orange→purple sunset ramp** | Spent most of its length in near-identical warm tones, hiding the discontinuities the ramp exists to show. |
| **Four arcs filling one at a time** on the volume icon | Three judgments to read one value. |
| **A per-bar selection map** alongside `barSources` | Two structures describing the same thing drift apart. |
| **Auto-deleting unselected passes** | Mutually exclusive with live editing. |
| **Concatenating sessions into one timeline** | A partial pass puts every later boundary at the wrong offset. |
| **Deriving pass availability from a stored counter** | Can't express a partial pass, where early bars have one more pass than late ones. |
| **A global release floor** | Finishing a one-bar playback flashes bars that never played. |

## 5.3 Suppress by default

```css
-webkit-tap-highlight-color: transparent;   /* the default blue flash */
-webkit-touch-callout: none;                /* long-press callout during a hold */
user-select: none;
touch-action: none;                         /* on gesture surfaces */
```

---

# Part 6 — Open items

## 6.1 Undecided, safe to settle during the build

| Item | Notes |
|------|-------|
| **Microphone permission and first-run** | The first record tap triggers the system prompt; a denial needs a defined state. The only §5.1-class item still open. |
| **Lane scrubbing** | The lane is the obvious place to seek, but that would make a horizontal drag mean "seek" here and "change bar" on the Edit Layer screen — same gesture, different meaning, on similar-looking elements. Distinct contexts, so probably fine; decide deliberately. |
| **Handoff to the Edit Layer screen** | "Edit bars" is a panel button; the lane is the more natural target and is currently inert. |
| **Auto-navigation** to Edit Layer when a recording stops | |
| **Row density** | Empty and armed layers occupy full-height rows; with two of seven recorded, much of the screen is placeholder. |
| **Edit Layer gradient scope** | Full ramp, or the layer's `slice(i, 7)` subdivided across the recording. The slice would make colour mean the same thing on both screens and constantly signal which layer you're in — but a seventh of the ramp has less hue separation, so subtle reorderings get harder to spot. Try both against real recordings. |
| **Preset chord progressions** | A small library (I–V–vi–IV and similar) removes the blank-slate problem. |
| **Layer reordering** | |
| **Storage full mid-recording** | How gracefully the session ends. |
| **Showing the pass range** (`P2/4`) | Makes the wrap predictable. |

## 6.2 Not yet designed

- Drum loop library and selection UI
- Export sharing details beyond format and destination
- The manual's actual copy (§4.7 is structure only)
- Onboarding

## 6.3 Later

- Effects rack (reverb, compression, per-layer EQ curves)
- Graphic and dynamic EQ, multi-band compression, spectral analyser
- Stereo width and mid-side processing
- ML preset suggestion from recorded content
- Stem export
- iCloud sync

## 6.4 Roadmap

| Phase | Scope |
|-------|-------|
| **1** | Session config, drum loop playback, single-layer recording, pass detection |
| **2** | Seven layers, levels, mute, EQ and pan presets, project persistence |
| **3** | Edit Layer grid, gestures, transport, splicing, live editing |
| **4** | Project Library, compress, bounce, export, chord reference, manual |

---

# Appendix — audio file formats

| Format | Use |
|--------|-----|
| **PCM (CAF/WAV)** | Capture and all editable material. 5.0 MB/min mono at 16-bit/44.1k, 8.2 at 24-bit/48k. |
| **WAV** | Lossless export |
| **MP3 / AAC** | Sharing, and compressed material the user has declared finished |
| **ALAC** | Optional lossless compression of retained loops (~55% of PCM) |

Never capture to a lossy format — see §2.7.
