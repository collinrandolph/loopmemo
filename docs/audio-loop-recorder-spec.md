# Audio Loop Recorder — Product & Implementation Specification

An iOS app for building multi-layer loop sketches. The user sets a tempo and bar count, picks a
drum pattern, and records up to seven layers over it while the loop runs continuously. Afterwards
they choose, bar by bar, which pass of the recording fills each slot of the arrangement.

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
| **loop** | The project's repeating structure itself. | — |
| **layer** | One of the seven recorded tracks. | "track" |
| **slot** | A bar's position in the *arrangement*, as opposed to where its audio came from. | — |
| **session** | One continuous recording onto a layer. A layer accumulates several. | — |
| **tile** | One bar's cell on the Edit Layer screen. | — |
| **lane** | One layer's full-loop strip on the Playback screen. | — |
| **backing tracks** | The drum track and chord bed collectively. | "reference tracks" |
| **drum pattern** | One bar of drum onsets — kick, snare, hats — repeated for the whole loop. | "drum loop" |
| **drum kit** | The synthesis parameters the pattern is played through. A separate axis from pattern. | — |
| **chord pattern** | The chord bed's rhythm: which beats the chord is played on, and how. The counterpart of a drum pattern, and named to say so. | "strum pattern" |
| **strike / chunk** | The two chord articulations. A strike rings; a chunk is short and damped. | — |

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
| All layers **and both backing tracks** derive timing from one shared sample-frame anchor | §2.4, §2.6 |

## 0.5 Suggested build order

1. Segment-scheduled playback (§2.4) with a fixed arrangement, no editing. Everything assumes it.
2. Recording with latency compensation (§2.3) and the three-state control (§3.5).
3. Playback screen as an overview (§4.2), static lanes.
4. Edit Layer grid, colour, and the motion model (§3.2, §3.3).
5. Gestures and transport (§3.7, §3.6) — the fiddliest part; the mockup is the reference.
6. Live editing: mid-bar splice (§2.5).
7. Project Library, compress, bounce (§4.1).
8. Chord bed (§4.4), settings (§4.6), user manual (§4.7).

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
| Drum track | Pattern + kit | Synthesised (§2.6). **Not locked** — changeable at any time. |
| Chord bed | Slots, pattern, tone, octave | Synthesised (§4.4). **Not locked** — changeable at any time. |
| Recording quality | Standard or High | Global setting, snapshotted per project (§2.7) |

**Only the first three lock.** BPM, bar count and beats per bar lock after the first recording
because every derived value — `framesPerBar`, bar boundaries, pass availability, the arrangement's
length — is computed from them, so changing one invalidates audio already on disk. **Backing tracks
feed nothing derived.** They are synthesised fresh on every loop and no recorded frame depends on
them, so the user keeps changing them for the life of the project: swap the kit after four layers,
drop the chords once the guitar carries the harmony, try a different groove against what is already
recorded. That is the whole reason they are backing rather than a fixed part of the session.

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
├── drumTrack                          // backing track (§2.6) — synthesised, no file
│   ├── patternId, kitId               // two independent axes
│   └── level, muted
├── chordBed                           // backing track (§2.6) — synthesised, no file
│   ├── chordPatternId                 // per project, not per slot
│   ├── tone, octave                   // octave: low | default | high
│   ├── level, muted
│   └── slots[4]                       // one chord per bar, tiled across the loop
│       ├── root (note + natural/flat/sharp)
│       └── quality (major | minor | dom7 | min7 | maj7)
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

**A backing track has no `enabled` flag, and neither one is optional.** Both always exist on the
project; a sketch that does not want the chords mutes them. Earlier drafts carried `enabled`
alongside `muted`, which were two spellings of one state — and only `muted` was ever reachable from
the interface, so `enabled` was a field the user could not set that nonetheless decided whether a
backing stem was written. Mute is the single control and the single fact (§2.6).

**There is no `scale` field, and quality is stored, not derived.** See §4.4.

**Neither backing track stores a file, a duration or an `originalBPM`.** They are synthesised, so
there is nothing to time-stretch and nothing to ship; `patternId` and `kitId` name recipes, not
assets.

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
| Backing-track voices | Oscillator, noise and filter nodes — **no sampler and no time-stretch unit** (§2.6) |
| Waveform peaks | `vDSP_maxmgv` on tap buffers |

`AVAudioUnitTimePitch` used to appear here, for stretching a sampled drum loop to the project
tempo. Synthesised backing removed the only thing that needed it (§2.6).

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
monitoring the drum track, chord bed and previous layers are all audible to the mic and will be
captured into the new layer, compounding with every layer. Headphones matter; see §4.7.

### The session category is a product decision, not a platform detail

*Added 2026-09-10 from a device finding. Not in the original spec — flagged as an addition.*

**The app declares itself a playback app, never an ambient one.** That is one sentence and it is
the whole decision; everything below is what it costs and how each platform spells it.

**Why it cannot be left at the default.** The ambient category is the one the iOS Ring/Silent
switch governs, and a loop sketchpad that goes silent because a switch on the side of the phone is
down is not behaving as a music app. Measured on an iPhone, 2026-09-10:

| | silent ON | silent OFF |
|---|---|---|
| headphones | sounds | sounds |
| phone speaker | **silent** | sounds |

Headphones are unaffected, which is what made this expensive to find: §2.2 makes headphones the
correct setup, so every device test used them and the app appeared to work in every category. See
`docs/device-check.md` §0.

**It is the same decision on every platform in `docs/platform-decision.md`**, which is why it is
here in the spec and not in a browser note:

| Platform | How it is spelled |
|---|---|
| Native / React Native | `AVAudioSession.setCategory(.playback)`, and `.playAndRecord` as §2.2 already has it |
| Browser | `navigator.audioSession.type = 'playback'` |

**The browser API needs feature detection and a device confirmation.** `navigator.audioSession`
is WebKit's, and the exact Safari version that introduced it — and the later one that added
`'play-and-record'` — must be checked on hardware rather than taken from this document. Where it is
absent the app is simply blind, and falls back on the note at the end of this section.

#### Two categories, not one

- **`playback` whenever the app is only playing.**
- **`play-and-record` while a take is running**, and back to `playback` at the stop.

**Holding `play-and-record` permanently is the obvious simplification and it is refused**, because
§2.3 says that category is where output routing stops being ours: output follows the input route,
and `overrideOutputAudioPort` only chooses speaker or receiver. `docs/platform-decision.md` §6 is
about exactly this risk — the reported iOS behaviour where beginning to record flips output to the
built-in speaker, which would put the backing and every previous layer into the microphone and
compound with each overdub. Sitting in that category while merely listening would extend the
window in which that can happen from "during a take" to "always", for no gain.

So the switch is tied to arming and stopping, which is where §3.5 already has a state change.

#### When it is set

**Inside the first gesture that starts sound, alongside the existing `resume()` — never at load.**
Two reasons, one practical and one honest: WebKit wants a user activation for audio work, and a
page that has made no sound yet claiming a playback session is a claim about an app that is not
running. The engine already has exactly one such moment.

#### What it costs, and why that is still right

- **Other audio is interrupted.** Opening a project stops someone's podcast. For an app whose only
  purpose is to make sound when you tap play, that is the expected behaviour and the alternative is
  worse — but it is a real change and it is why this is a product decision.
- **Audio continues when the app is backgrounded**, which is the same property that makes the
  switch stop applying. Whether a *take* should survive backgrounding is a separate question and is
  not answered here; §3.5's rule that stop and pause are the only two ways out of a take is about
  navigation inside the app.
- **The switch stops silencing it**, which is the point, and means a user who silenced their phone
  deliberately can still be surprised. A music app is the category of app where that is understood.

#### Detection is not possible, and should not be attempted

There is no API that reports the switch, and there is no side channel: the context reports
`running`, its clock advances, and nodes render normally. **The app cannot know it is inaudible.**
Anything that looks like a detection heuristic is a guess, and a wrong guess here shows a warning to
someone who can hear perfectly well.

Where `navigator.audioSession` is unavailable, the fallback is therefore **a one-time note, not a
detector**: the first time playback runs on a build that could not declare a category, a dismissible
line near the transport saying to check the side switch. It never reappears. It may be suppressed
when a headset is present — `enumerateDevices` can say so once microphone permission exists — but
that is a refinement and not the feature.

#### What has to be verified on a device before this is done

None of it can be checked from a development machine.

1. `playback` makes speaker output audible with the switch on silent.
2. Arming still records, and **the speaker flip of §2.3 / platform-decision §6 does not become
   worse** across all four output routes in `docs/device-check.md` §1.
3. Returning to `playback` at the stop restores whatever route was in use before the take.
4. The category survives backgrounding and returning, and a take is not left half-recorded by it.
5. What actually happens on a browser or OS version without the API — that the fallback note is
   what a user sees, rather than nothing.

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

### The offset is a control, not a measurement

**A single per-project *Recording offset*, adjustable at any time, is the mechanism.** Where a
platform reports its own latency it *seeds* that offset; it never overrides it. Loopback
calibration — play a click, record it, correlate — is a convenience that can improve the seed, not
a prerequisite for recording.

Three reasons the number cannot come from measurement alone:

- **A microphone cannot hear headphones**, and §2.2 makes headphones the correct setup. Calibrating
  through the speaker measures an output route the user is not going to record against, so the
  answer is wrong for the case that matters. Holding an earcup to the mic works and is fiddly
  enough to be done badly.
- Platform figures are typical, not exact, and a Bluetooth route's own reported latency drifts.
- Every serious recording tool ships a manual offset regardless, because automatic detection is
  unreliable often enough to need a way out.

**The offset is applied when recorded audio is scheduled for playback, never when it is captured.**
This is the decision the feature stands or falls on, and it has four consequences:

- **It is retroactive.** Moving it shifts everything already recorded, together. Baking it into the
  capture would fix only future takes and leave every earlier one permanently wrong.
- **It cannot change the pass count.** `recordedFrames` comes from the transport at capture and is
  untouched, so §1.4's "a bar exists once the recording reaches into it" gives the same answer at
  every offset. Shifting the capture instead would move a take's *end*, silently renumbering
  passes as the control moved.
- **It can be judged while the loop plays**, which is the only way anyone can set it. "What is your
  round-trip latency in milliseconds" is unanswerable; "nudge until your playing sits on the drums"
  is not.
- **It applies to recorded layers only.** The backing is generated on the shared anchor (§0.4) and
  is already on time; offsetting it too would move the reference the user is correcting against.

**Range 0–250 ms, and it does not go negative.** Negative compensation would mean the performance
reached the microphone before the cue was heard, which is not a thing that happens. A push/pull
"feel" control either side of zero is a different feature, belongs to a DAW, and is not this
(§5.2).

**It is stored per project and a new project inherits the last value used.** The offset is a
property of the audio route rather than of the music, so one number is right for every project on
the same hardware — but a project recorded against one offset has to keep it, or reopening it later
on other equipment silently shifts the takes. Inheriting the last value means it is set once in
practice and stays correct per project. It is *not* a second entry in §4.6: that would be two
editors for one piece of state, and the inherited value is a default rather than a setting.

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

## 2.6 Backing tracks

The drum track and the chord bed are the same kind of object: non-recorded backing the user plays
against. They share a row treatment (§3.8), a level and mute control, and one export rule.

**Both are synthesised live, and neither is a file.** Nothing is sampled, nothing is sourced, and
no audio asset ships with the app. Both are driven from the **same sample-frame anchor** as layer
playback (§0.4) — one clock, not two transports, which would drift against each other on every
replay.

**Neither is time-stretched, and neither can be.** Because both are generated at the correct
frequencies and triggered at computed offsets, changing BPM changes only *when* voices fire, never
how they sound. There is no playback ratio, no quality warning and no ratio limit anywhere in the
backing path. That immunity is the entire reason for synthesising rather than sampling.

### Drum track

**Pattern and kit are two independent axes.** Any kit plays any pattern — the same shape as tone
and pattern for the chord bed.

- **Pattern** — one bar of onsets, looped for the length of the project. Six of them, every onset
  on a straight beat or eighth. No swung or triplet-subdivided pattern is accepted: it would
  introduce a second timing grammar alongside the straight one everything else uses, for a
  genre-coverage gain that does not pay for it.
- **Kit** — four of them. A kit is a *parameter set* (frequencies, sweep and decay times, filter
  cutoffs) fed into the three recipes below, not a different recipe per kit. A kit has to occupy a
  genuinely different region of that parameter space to read as distinct; one that only nudges
  another's numbers is indistinguishable by ear and does not earn a slot.

Three voices, one recipe each:

| Voice | Recipe |
|---|---|
| Kick | Pitch-swept sine plus a very short click transient. The sweep alone reads as boomy, not as a hit. |
| Snare | Two detuned tonal oscillators (the shell) plus a highpassed noise burst (the buzz). |
| Hat | Filtered noise. **Closed and open are one recipe differing only in decay** — the same way strike and chunk are one chord voice with two envelopes, not a fourth sound. |

**The hat chokes itself.** A real hi-hat is one pair of cymbals, so any new hit, open or closed,
cuts off whatever is still ringing from the last. Kick and snare do not choke, and how voices that
outlive their own onset gap are handled is **not yet settled** — see §6.1.

### Chord bed

Four slots on a recurring **4-bar** progression, one chord per bar. Bar counts are always multiples
of 4 (§1.2), so the progression tiles evenly into every valid project length and no
partial-progression case exists.

```
chordSlot(arrangementSlot) = ((arrangementSlot − 1) mod 4) + 1
```

So chord 2 plays in slots 2, 6, 10, 14, 18, 22 — and **bar-preview mode follows the same rule**,
playing the one chord that owns the previewed slot rather than the first chord or none. What you
hear in preview is what you hear in the loop.

Per slot: a **root** (note plus natural / flat / sharp) and an explicit **quality** — major, minor,
dom7, min7 or maj7. See §4.4.

Per project, not per slot: **chord pattern**, **tone** (Rhodes, Pad, Wurly, Organ) and **octave**
(Low / Default / High) — in that order, because it is the drum row's order too. **Tone is to the
chord bed what kit is to the drums**: the voicing of a track whose rhythm the pattern already
fixed, so the two sit in the same place and work the same way.

**The chord pattern is one setting for the whole progression.** Seven of them, same one-bar
straight-eighth constraint as the drums. Each onset is a **strike** (full, lets the chord ring per
the tone's own envelope) or a **chunk** (short, damped, quieter). A per-slot pattern was considered and
rejected: it is the axis most likely to make a four-bar bed sound arranged rather than supportive,
and the bed exists to be played against, not composed. It is also a fourth per-slot decision on top
of root and quality, in a control whose entire justification is that it is quick.

### Backing settings are never locked

Unlike BPM and bar count (§1.2), a backing track can be changed at any point in a project's life,
including after every layer is recorded. Nothing derived depends on it and no recorded frame
references it. Changing one is exactly as consequential as muting one, which is to say: audible
immediately, and reversible by changing it back.

### Export rule

**Any track that is not muted is exported, backing tracks included.** To exclude one, mute it. The
export screen has no mute controls of its own — muting happens on the Playback screen, where the
user can hear the result. The rule is *what you hear is what you export*, and it applies identically
to a bounce mixdown.

**Mute is the only control, and it means both things.** A backing track the sketch does not want is
muted, and a muted backing track produces no file. This deliberately diverges from layers: a muted
*layer* is a performance the user made and is not using right now, so it still ships as a stem. A
muted *backing track* is a decision that the sketch does not have one.

### Unresolved: voices that ring past the loop point

A struck chord can outlive the bar it was struck in — a Pad rings for seconds, and a strike or an
open hat late in the last bar will still be sounding when the loop wraps. **Live this is correct and
needs nothing**: the loop is continuous, so the tail simply overlaps the next pass, which is what a
real instrument does.

**Bounce and export render a fixed length, and there it is a defect.** A rendered loop that stops
dead at the loop point has a seam the live version never had; the tail has to wrap to the start,
exactly as §2.8's delayed copy of the last bar already must. Two things make this sharper for
backing than for the Haas delay: the tails are **two orders of magnitude longer** (seconds against
milliseconds), and they are *musically* load-bearing rather than a width effect, so truncating one
is plainly audible.

`tailFrames` is the existing home for this obligation and currently accounts only for the pan
delay. **Not yet addressed** — flagged here so it is not discovered at render time. See §6.1.

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

- All layers are mixed into a **single audio file** with EQ, pan and level baked in. Whether unmuted backing tracks are part of that mixdown is **unresolved — see below**.
- That file becomes **layer 1** of the new project, as **Pass 1**, and layer 1 can record further passes like any other layer. Layer 1 starts **neutral** — level 1, Flat, Center, unmuted — because the processing is already in the audio.
- **The original project is untouched.**
- BPM, bar count and beats per bar are preset from the source. **What happens to the backing tracks is unresolved — see below.**
- **Audio quality carries too, and that is forced rather than chosen.** The mixdown is a sum of the source's layers and therefore sits at its sample rate; seeding at any other rate would need a resample at every splice, which is exactly what snapshotting quality at creation exists to prevent.
- **`isCompressed` is false.** The flag means a project's recorded passes were discarded; a new project never had any, so the Library label would be a lie.
- Layers 2–7 are empty and available.

Per layer, what survives is exactly what compress keeps, so `compressionPlan` does that work and
bounce is **compress applied to every layer at once, plus a mix**. The mixdown is exactly one loop,
which is what makes it Pass 1 — so it is filled through the ordinary recording lifecycle (§1.6) and
bounce needs no arrangement logic of its own.

#### The backing tracks: not in the mixdown, but their settings carry

**Settled.** The two questions were decided together, because they constrain each other:

| Question | Answer |
|---|---|
| Is the backing **in the mixdown**? | **No.** A bounce is a stem of the performance, not of the sketch — the layers only. |
| Do the **settings** carry to the new project? | **Yes, verbatim, mute flags included.** Pattern, kit, slots, tone, octave, chord pattern and level are copied from the source. |

Taken together these avoid both failures. Baking the audio *and* carrying the settings would play
the drums twice; baking without carrying would freeze the groove into layer 1, contradicting §1.2's
rule that backing never locks in the one place it would matter most. Excluding the audio and
carrying the settings means the new sketch opens on the same groove — live, still editable, one tap
from a different kit — and the mixdown is exactly the playing.

The settings carry **even when a track is muted**. That is the user's setting, and the new project
is the place to change it; dropping it would be the app deciding the mute was a mistake.

**This narrows §2.6's export rule rather than contradicting it.** *What you hear is what you
export* governs export, where a muted backing track writes no stem. A bounce is not an export: it
never contains the backing, so a backing mute has no bearing on it either way. `isAudibleInMixdown`
is therefore an **export** predicate, not a bounce one.

**Refused in two cases**: a slot pointing at audio that does not exist, since baking a hole into the
seed is not a repair even though the original survives; and a mixdown with nothing audible in it,
which would seed a project with a loop of silence. Every layer muted is now exactly that second
case — the backing cannot rescue it, because the backing is not in the mixdown.

**A Surround layer's delay tail must wrap.** Live, the delayed copy of the last bar runs past the
loop point and the delay line keeps going; a bounce renders a fixed length, so that tail has nowhere
to go and truncating it leaves a seam at the loop point the original never had. `BouncePlan.tailFrames`
reports how many frames must wrap round to the start, and is zero when no audible layer uses Surround.

**Quality conflict**: if the source project's quality differs from the current global setting, ask;
otherwise ask nothing.

| Choice | Effect |
|--------|--------|
| **Use project quality** (default) | New project matches the source. No resampling. |
| **Use current setting** | Mixdown resampled once; layers recorded next match natively. |

Both are legitimate. Keeping the source quality preserves the mixdown exactly and suits a bounce that
is the foundation of the new piece. Taking the current setting costs one resample of material that is
already a composite — and suits a bounce that is **something the user will mute or delete**, where
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
| High Cut | low-pass 7 kHz, Q 0.707 | Removes air and edge |
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
#### Perfect loop

**A loop is a loop**: whatever is still ringing at the end carries over the start, and live that
needs no arithmetic. A rendered file is a fixed length, so the same audio is cut instead — and on
repeat that is a seam the live loop never had.

Both behaviours are wanted and one file cannot be both, so `Project.perfectLoop` is a setting,
**on by default**, read by export *and* by bounce:

| | |
|---|---|
| **On** | Renders past the loop point and folds the overhang onto the head. No seam when the file repeats. |
| **Off** | Renders exactly one loop; the tail is cut. A clean start, which is what a one-shot going into an arrangement wants. |

**It does not change a file's length**, so the manifest and the size projection are identical
either way, and it is a no-op for files with no tail — dry stems (forced to centre pan and flat
EQ) and recorded passes, which are never rendered.

**It is one value with two views**: the primary control is on the project settings screen and a
second instance sits on Export, where the choice is usually made. Both read and write
`project.perfectLoop`. Settings holds it pending until Save like its other fields; Export applies
it at once, because that screen has no commit step.

**Off is a foot-gun on a bounce** and kept only for consistency: a bounce seeds a project that
loops forever and cannot be re-rendered with the other setting later, so a seam there is permanent.

`loopTailFrames` reports what has to wrap. Three sources, and they are not the same size —
measured at 44.1 kHz:

| | Overhang |
|---|---|
| A Surround layer's Haas delay | 35 ms |
| `syncopated-pop`'s open hat, Tight kit | 0 ms at 84 BPM, 100 at 120, **183 at 180**, 225 at 240 |
| Chords | 0 ms across the usable range; 25 ms at 240 BPM from the ring floor |

**Chords essentially never overhang**, which is not obvious: `chordRingSeconds` caps a ring to the
next onset *minus 50 ms* and every pattern in the library starts on beat 1, so the ring lands just
before the bar line. Off-beat Skank is the one that starts elsewhere and its onsets are all short
chunks. **Only one drum pattern overhangs at all** — the only one with an open hat, whose own
source comment says the accent is meant to ring past the loop point.

- **The fader runs past unity, to +6 dB**, and unity is its midpoint. A take arrives at whatever
  the system input gave it and the app has no API to set that (§2.3), so a fader stopping at 1
  leaves a quiet recording with no remedy at all — including recordings already made. Half the
  travel attenuates and half boosts, which is what makes unity markable: a tick sits dead centre,
  **below** the track rather than on it, since drawn on the track the thumb would hide it at
  exactly the value it exists to mark. **A double tap returns to unity.**
- **The arcs span the whole range, so unity is half fill.** Filling them completely at unity
  would leave the whole +6 dB above it moving nothing — the icon identical at 1.0 and at 2.0,
  which is the readout going blind exactly where the new range lives. Half fill also puts the
  icon's neutral where the fader's tick is, so the coarse readout and the fine one agree.

A staged version (four arcs filling one at a time) was tried and rejected: it required reading which
arcs were complete and then how far into the next — three judgments for one value.

### Record — `LR.RecordDot`

| State | Dot | Row |
|-------|-----|-----|
| Unarmed | Grey, translucent | No emphasis |
| **Waiting** | Red at 45%, faster pulse | No emphasis — it has not armed |
| Armed | Red, slow pulse | Background lifts, soft red inset border |
| Recording | Red **square**, no pulse | Stronger red border, warmer background |

- **Positioned at the far LEFT of a row, opposite the speaker.** They were neighbours, which put "start recording" a thumb-width from "mute". The consequences are asymmetric: a mis-hit on mute is one tap to undo, a mis-hit on record starts or stops a pass.
- **Arming is exclusive** — arming one layer clears any other.
- **Running out of room does not end the session.** A take that storage refuses is still in
  memory and still plays; what it has lost is durability, so recording carries on and the screen
  says which takes are not safe and what frees room. They are written as soon as there is space —
  a delete retries them — so the recovery needs no re-recording.

  **Full and unavailable are different states.** Unavailable is a private window or blocked site
  data: nothing will ever be written and the user cannot change it from here. Full is a working
  store with no room, where reads and *deletes* still work — so treating a quota error as
  unavailable would turn a recoverable state into a permanent one and disable the delete that
  fixes it.
- **A row cannot arm without an input.** The dot means "this will record", so it must not light up
  when there is nothing to record with. Arming is where the microphone is opened — a prompt raised
  at the downbeat instead is answered seconds into a running take — and if it is refused the row
  simply does not arm.

  **This is the only place the failure can be prevented.** Everything downstream is correct given a
  take, so a denied microphone that still armed produced a take of silence that the domain
  committed as a real pass: the badge advanced, the arrangement was built on it, and the pass count
  and the size projection both grew by audio that does not exist. Measured at 7 → 8 passes and
  24.7 → 28.2 MB for three seconds of nothing.

  **Waiting is a state, not a stall.** Only a cold start waits, because the microphone is held open
  across takes (§2.3) — every arm after the first is instant, so the waiting dot means a permission
  prompt is open and nothing else. Every record dot is inert while one is.

  **A refusal is worded per cause, never as an exception.** Denied, no device and an insecure
  origin need three different things from the user, and only the first is fixable without leaving
  the app. The stream can also go *between* arming and the downbeat — a device unplugged, a
  permission revoked in another tab — and the row backs out of recording for the same reason.
- **Hold while armed cancels** back to unarmed; Escape does the same on a keyboard. Hold does nothing while recording, where a tap already means stop.
- **While a pass is running every other record control is removed** (`visibility: hidden`, preserving row spacing so nothing shifts when it ends). A greyed control still invites a tap and then has to explain itself.
- **A pass in progress owns the whole screen, not only the input.** Stop and pause are the only two ways out of a take, and every control that would end one by other means — project settings, Edit Layer, Projects, Export, and seeking the transport — is disabled for its length. The test is not whether an action is related to recording but whether taking it destroys the performance: leaving the screen tears down the audio graph, and seeking moves the clock the take's length is measured against, so a forward seek claims passes that were never played and a backward one claims none at all. Losing a take to a mis-tap is not a recoverable mistake.

  These are **greyed rather than hidden**, which is the opposite treatment to the record dots above, and for the reason the rule above gives. A missing record dot is explained by the one beside it that is recording; a missing Export button has nothing next to it to say why, and a screen whose furniture disappears reads as broken rather than as busy.

### Transport — `LR.PlayButton`, `LR.ProgressBar`

A standard progress bar with optional bar ticks and click-to-seek, alongside the gradient sweep
rather than replacing it. The sweep shows *what* has played; the bar shows *how far through* at a
glance. **Seeking is refused while a take is running**, per the rule above.

**A tile with only one available pass hides its vertical hint.** The axis still works; it simply
has nowhere to go, and an affordance for a gesture that cannot change anything is a promise the
user has no way to cash. Scoped per **bar**, not per layer — a partial pass leaves early bars with
one more pass than late ones (§1.4), so neighbouring tiles legitimately differ. Both forms go: the
strip on a tall tile and the arrow folded into the label on a short one.

**Deliberately not extended to a muted tile**, whose swipe is also locked. That lock is one hold
away from being released and the help sheet says so; a second pass can only come from recording one.

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

**Escalation only works from silence, and the double tap has to work from playback too.** On a bar
that is already repeating, the first tap of the pair means *stop*, so there is nothing to escalate
— the instinctive double tap on the playing bar stopped and restarted the same bar, two taps to
arrive back where you were. Reported from use. **The stop is therefore undone rather than
deferred**: it happens immediately, and a tap on the same slot inside the window starts the loop
from there. Deferring is the alternative and it spends this section's own latency on the one action
that must feel immediate, while a stop that waits 300 ms to be sure keeps sounding as the user asks
it not to. The cost is that a stop followed inside 300 ms by a tap on the *same* slot plays the
loop rather than re-previewing that bar; the resumed loop also starts at the slot's downbeat, since
the phase rebase needs a transport that is still running.

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

One primitive serves layer rows, backing rows and project rows: a head that is always visible and a
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

**Row anatomy**: play button · thumbnail · name and metadata · size or position. **No chevron and no panel** — see the actions note below.

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

**Actions live on the project's own settings screen (§4.5), not here.** Export, bounce, compress and
delete were originally a per-row panel behind a chevron, which made a browsing list carry every
operation the app can perform on a project. They are operations *on a project*, so they sit under the
settings for the thing they act on. Open is not an action at all any more — **tapping the row opens
the project**, which settles §4.1's open question by removing the alternative rather than choosing
between the two.

**One consequence, accepted deliberately.** This section makes the Library the place storage is
"visible and user-managed", and compress and delete are storage actions that used to sit beside the
sizes. The Library still shows every number — per project and the device total — but reaching the
action is now one tap further, through the project. Sizes are what you browse by; discarding audio
is something you do to one sketch at a time.

**Destructive actions confirm in place and state the outcome.** Compress shows the real projection —
"214 MB → 26 MB" — because a projected saving is the entire reason to do it, and a generic prompt
hides the only fact that would inform the decision. Compress is disabled on already-compressed
projects, and its copy notes that recording a new pass clears the status. Compress and bounce both
refuse a project with a bar pointing at missing audio; from the settings screen the remedy is to
close and repair that bar, rather than the "open it" the Library used to offer.

## 4.2 Playback screen

Reference: `playback-screen-mockup.html`.

```
Header      project name · BPM · bars · time signature
            passes · size · settings gear
            play · progress bar · position · master volume icon + slider
Backing     drum track · chord bed
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

**Backing rows** use the same primitive: a Lucide `drum` or `keyboard-music` icon, the content
(drum pattern name; the four chords), a speaker, and a panel. The drum row shows no BPM — that's a
project setting shown in the header. Each row's remaining settings live in its panel: **pattern and
kit** for drums, **pattern, tone and octave** for chords, plus a level on both. Every one of
them stays editable for the life of the project (§1.2).

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

## 4.4 Chord bed

A generated chord bed that plays alongside the drum track, audible without recording anything, and
available while recording every layer.

| Control | Options | Scope |
|---------|---------|-------|
| Four chord slots | A recurring **4-bar** progression, one chord per bar | — |
| Chord root per slot | Note with natural / flat / sharp | Per slot |
| Chord quality per slot | Major, minor, dom7, min7, maj7 | Per slot |
| Chord pattern | Seven (§2.6) | Per project |
| Tone | Rhodes, Pad, Wurly, Organ | Per project |
| Octave | Low / Default / High | Per project |

**Quality is picked directly, and there is no scale.** Each slot carries its own quality; the user
chooses "D minor", not "D in the key of C". Two consequences follow and are intended: *outside the
scale* cannot exist without a scale, so there is no dashed or marked slot state, and **a slot can
never be wrong**, so nothing is defaulted or corrected on the user's behalf.

> **This reverses an earlier rule** that derived quality from a scale and explicitly forbade a
> quality picker — see §5.2. The reversal is deliberate and was made after building the interface
> both ways. Do not restore the scale.

Five qualities, not more. Diminished, augmented, suspended and extensions past the seventh were left
out on the same footing as swung chord patterns: the bed exists to give a sketch a harmonic floor,
and a vocabulary that needs scrolling is slower than the thing it is backing.

**Octave is one setting for the whole progression**, three positions, ±1 from the mid-register
default. It was built as ±2 and narrowed after listening — the outer two octaves were hard to listen
to and bought nothing. Three positions also read better as Low / Default / High than as signed
numbers.

**Bar counts are always multiples of 4**, so the progression tiles evenly into every valid project
length — no partial-progression case exists at any bar count. Which chord owns which slot, live and
in bar preview alike, is `((slot − 1) mod 4) + 1` (§2.6).

**Synthesised, not sampled** (§2.6), and triggered against the shared sample-frame anchor. Rhythm is
the **chord pattern's** job, not the tone's: an earlier draft had voicing follow the timbre — a pad
holding through the bar, a keyed tone re-articulating — which quietly welded two independent choices
together, so picking a sound also picked a groove. They are separate axes now. Any tone plays any
chord pattern, and both sit mid-register so the bed stays under vocals.

## 4.5 Project Setup and Export

**Setup**: name, BPM, bar count, a preview at that tempo, and the recording quality inherited from
the global setting. This is the **last point** at which quality can be chosen at all, and the last
point at which BPM and bar count can be changed *until the first recording locks them* (§1.2).

**The project actions live here**: export, bounce to a new project, compress and delete (§4.1).
They act on a project, so they sit with that project's settings rather than behind a chevron on a
browsing list. They appear only for a project that exists — there is nothing to export or delete
about one being created — and they act on the fields as currently edited, so a rename typed above
reaches the exported filenames.

**Setup and settings are one screen, not two.** The fields are identical and only their editability
differs, and that is derived rather than moded: a project being created is simply one with no
recordings, so `isConfigurationLocked` answers false and everything is open. Quality is the single
exception — it is choosable exactly once, and "does this project exist yet" is not a fact a project
can report about itself.

**Setup does not choose the backing tracks.** §4.5 originally put drum pattern and kit here; a new
project now starts on the default groove and every backing choice is made from its row on the
Playback screen (§4.2), where it can be heard against what is already recorded. One editor for one
piece of state, and the blank slate stays a blank slate rather than a form. The backing tracks are
not locked by anything, ever (§1.2), so nothing is lost by deferring the choice.

**The preview is of the tempo, not of the arrangement.** It is a play button on the tempo control
itself, looping **one bar** of drums — hearing what 96 against 132 actually feels like is the one
thing a BPM number cannot tell you. Bar count is deliberately not part of it: the drum pattern is
one bar and repeats identically, so a longer loop would sound the same while taking longer to come
round, and changing the length would disturb a preview it has nothing to do with.

**Recording offset lives here** (§2.3): one slider, 0–250 ms, adjustable for the life of the
project and never locked by a recording the way tempo is. A new project inherits the last value
used, so in practice it is set once.

**Its preview plays the loop, not a bar of drums.** The tempo preview above it exists to answer
"what does 96 feel like", which one bar can do. The offset can only be judged by hearing a recorded
layer land against the backing, so this row previews the arrangement and the slider applies live
while it runs — drag until the playing sits on the beat. A control that cannot be judged where it
is presented is worse than one that is hard to find. If it turns out not to be judgeable here, the
fallback is to move it to the Playback screen rather than to add a second copy.

**Export**: format (WAV / MP3), quality, preview, share. **No mute controls** — it exports the
project exactly as it currently sounds, and muting happens on the Playback screen where the result
is audible (§2.6).

## 4.6 Settings

Global, and — unless stated — they apply live.

| Setting | Options | Applies |
|---------|---------|---------|
| **Recording quality** | Standard (16-bit / 44.1k) · High (24-bit / 48k) | **New projects only.** Snapshotted at creation and immutable thereafter (§2.7). |
| **Count-in length** | Off · 1 · 2 · 3 · 4 bars | Live. Never recorded, so it needs no per-project snapshot (§5.1 #3). Widened from 2 bars during the build. |
| **Count-in sound** | Full loop · Drums only | Live. The count-in is the loop's own tail played into the wrap, so this chooses how much of it sounds. Added during the build; there is still no click (§5.1 #8). |
| **Export format** | WAV · MP3, with quality | Default for the export screen |
| **EQ / pan preset defaults** | Which preset a new layer starts on | Live |
| **Master level limiting** | On / off | Live |
| **Playback loop mode** | Repeat on / off | Live |

**There is no metronome setting** — the drum track replaces it (§5.1 #8). **There is no bar increment
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
| Everything else | Backing tracks — that they are synthesised, that pattern and kit are separate choices, that muting one is how you exclude it from an export, and that none of them ever lock; what compress discards and keeps; that bounce leaves the original untouched; that export matches what you hear |

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
| 7 | **A session is written to disk at the stop** — amended 2026-09-16; see below | Originally "written continuously, not at stop". The app has never done it, so the spec was asserting a safety property the code does not have. |
| 8 | **No metronome — the drum track replaces it** | Every project has a drum track for timing reference. A separate click would need its own row, level and export rule for nothing. |
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

### On #7, and why it was amended rather than built

*Amended 2026-09-16.* The original read: **"Sessions are written to disk continuously, not at
stop. The raw performance is the only asset that can't be recreated. Recovery needs no special
handling: under §1.4 a partial session is already a valid one."*

**The reasoning was good and the code never did it.** PCM chunks arrive from the worklet into a
JavaScript array and stay in memory; the only `takes.put` on the recording path is inside
`commitCapture`, after `stopCapture()` resolves. So a take exists nowhere but RAM for its whole
duration, and anything that ends the page — reload, tab close, an iOS swipe-back or
pull-to-refresh — takes it. There is a second cost: memory grows at roughly 10.6 MB/min at
44.1 kHz, and at the stop it briefly holds about twice that while the buffer is assembled. A
five-minute take peaks near 106 MB, which on a phone is the allocation the OS kills a tab over —
and killing the tab destroys the take the memory was holding. The failure is self-inflicted.

**It is amended rather than implemented because the spec must not assert a safety property the
app lacks.** A future reader believed it, which is the actual harm. Building it is a large change
in the riskiest part of the codebase — streaming writes under a provisional id, assembly and
`trimToDownbeat` moved to recovery-on-boot, quota failure arriving *during* a performance, and
main-thread contention with the scheduler's per-bar allocation.

**The mitigation that shipped with this amendment** is a `beforeunload` guarded by the same
`takeInProgress()` the shell already asks before every navigation. It is a warning, not durability.

**If this is revisited, the middle option is the interesting one**: flush once per completed pass
rather than continuously. It bounds the loss to one pass, costs one write per loop instead of a
stream, and §1.4 already makes the partial result valid. It does **not** conflict with "nothing is
written at the loop point" — that rule is about *session identity*, one continuous recording being
one session however many passes it spans, not about durability.

**Triggers to revisit**: a device session that loses a take, or takes routinely running past a
couple of minutes.

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
| **Sampled drum loops, time-stretched to the project tempo** | Specified in full — `originalBPM`, a `targetBPM / originalBPM` ratio, `AVAudioUnitTimePitch`, a 0.5–2.0× limit, a quality warning outside it, and Superpowered as the upgrade path. Replaced by synthesis after listening to both. Pitch-preserved stretching fails hardest on exactly this material — transient-heavy percussion — right across the app's 60–240 BPM range, and synthesis does not merely dodge that: it deletes the ratio, the limit, the warning, the upgrade path, and every sourcing and redistribution-licensing question along with them. Nothing ships as an asset now. |
| **A kit baked into each drum pattern** | Correct under sampling, where an independent kit picker meant auditioning every kit against every pattern as recorded audio. Synthesis makes a kit a parameter set, so the combinatorial cost is zero and the two became independent axes. |
| **Scale-derived chord quality** | The scale picked each slot's quality from its root, and a quality picker was explicitly forbidden as doubling the decisions. Built both ways; the explicit picker reads better and is what §4.4 now specifies. It also took three sub-rules with it — the out-of-scale slot marking, the major-triad default for non-diatonic roots, and the long-press per-slot override — none of which can mean anything once there is no scale to be outside of. |
| **Voicing implied by the chord tone** | A pad held through the bar, a keyed tone re-articulated. It welded rhythm to timbre, so choosing a sound also chose a groove. The chord pattern is now its own axis (§2.6). |
| **A per-slot chord pattern** | Considered when the rhythm axis was added, rejected: it is the axis most likely to make a four-bar bed sound arranged rather than supportive, and it is a fourth per-slot decision in a control whose justification is speed. |
| **`enabled` alongside `muted` on a backing track** | Two spellings of one state, and only `muted` was ever reachable — so `enabled` was a field the user could not set that still decided whether a backing stem was written. |
| **Preset chord progressions** | A library of I–V–vi–IV and similar, to remove the blank slate. The blank slate is four editable slots and a Randomize button, which is already fast; a preset list adds a vocabulary to learn in front of a control whose whole justification is speed. |
| **Auto-navigating to Edit Layer when a recording stops** | What follows a take is usually another take, not editing. Moving the screen out from under the user at the moment they might reach for the record dot again is the wrong guess, and the guess is unnecessary — the Edit Layer button is right there. |
| **An input level meter** | The live waveform *is* the meter. It draws from the same `inputPeak()` a meter would, at the same display gain as the committed take, across the whole pass rather than at one instant — so a second readout would be a quieter copy of something already on screen. This does not settle input *gain staging* (§6.1), only the display half of it. |
| **Tapping the lane to open Edit Layer** | The Edit Layer button in the layer's own panel is deliberately large, and it is the affordance. A second, invisible route to the same screen teaches nothing and makes the lane's other gestures ambiguous. |
| **Lane scrubbing** | The transport's progress bar already seeks, and it is the control that looks like it seeks. Putting a second seek on the lane would also make a horizontal drag mean "seek" on Playback and "change bar" on Edit Layer, on elements that look alike. |
| **Subdividing the layer's ramp slice on the Edit Layer grid** | Considered so colour would mean one thing on every screen. Measured on a 5-pass, 16-bar layer: the full ramp separates neighbouring passes by 80–139 RGB units; a layer's seventh separates them by 11–12. Layer 1's whole recording would run `rgb(255,138,91)` to `rgb(255,184,91)` — red pinned at 255, blue at ~90, only green moving — which at a 3px line width is not a jump anyone can see, and the jump is the feature (§1.1). The argument for it, constantly signalling which layer you are in, is already served by the layer's name in the header. The two screens are not inconsistent: Playback's colour is layer identity (§4.4), Edit Layer's is source position (§1.1). |
| **Showing the pass range on a tile** (`P2/4`) | Meant to make the vertical wrap predictable. The available set can be non-contiguous (§1.4), so with `{1,2,4,5}` a tile on pass 4 reads `P4/4` — which looks like the last of four and is the third, and the ambiguity is worst in exactly the case the readout would be most useful. Disambiguating costs a third number on a tile that already drops its hint strip at 50px. The hint now hides itself when there is only one pass, which is the part that was actually misleading. |
| **An input trim** | Considered for "working but very quiet". At playback it is `Layer.level` under a second name — the duplicate editor §1.5 warns about. At capture it is baked into the take, fixes only *future* recordings and cannot be judged after the fact, which is the same argument §2.3 uses to put the recording offset at scheduling rather than capture. The remedy was neither: extend the range of the fader that already exists (§3.5). |
| **Normalise-on-commit** | Scaling each take to a target peak. §2.3 already rejects `autoGainControl` because "a rider is a moving gain and ruins two takes of the same playing" — normalising per take is the same fault at coarser grain: two passes of one part come back at different levels and the balance the user set means nothing. |
| **A uniform voice choke on the backing** | One rule for all four voice types — a new onset ends the previous one over a 5 ms ramp, on the argument that a voice type is one physical mechanism (one pair of cymbals, one pair of hands, one drum and one beater). Built behind a live A/B and rejected on hearing it. Measured, it leaves 1.81× the energy of the cap on Fast 8th with a Rhodes, 1.59× on Steady Quarters and 0.98× on Sustain — the chords ring their full recipe length and are cut while still singing, rather than having faded first. The numbers were right and the sound was wrong; a chord bed is meant to support, and one that keeps ringing to the handover competes. The per-voice policies stand (§2.6). |
| **Layer reordering** | Seven layers, all on screen at once, summed in parallel — order carries no signal-chain meaning and nothing is off-screen to bring into view. It would also cost more than it looks: `Layer.index` is presently the position, the identity the engine and the edit paths key on, the display-name fallback, *and* the layer's slice of the colour ramp, and those are only safely one field because layers never move. Reordering forces them apart and forces a further choice between a layer changing colour when it moves and the Library's colour signature ceasing to correlate with anything. |

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
| **Row density** | Empty and armed layers occupy full-height rows; with two of seven recorded, much of the screen is placeholder. |

## 6.2 Not yet designed

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
| **1** | Session config, drum track playback, single-layer recording, pass detection |
| **2** | Seven layers, levels, mute, EQ and pan presets, project persistence |
| **3** | Edit Layer grid, gestures, transport, splicing, live editing |
| **4** | Project Library, compress, bounce, export, chord bed, manual |

---

# Appendix — audio file formats

| Format | Use |
|--------|-----|
| **PCM (CAF/WAV)** | Capture and all editable material. 5.0 MB/min mono at 16-bit/44.1k, 8.2 at 24-bit/48k. |
| **WAV** | Lossless export |
| **MP3 / AAC** | Sharing, and compressed material the user has declared finished |
| **ALAC** | Optional lossless compression of retained loops (~55% of PCM) |

Never capture to a lossy format — see §2.7.
