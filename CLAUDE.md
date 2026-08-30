# Audio Loop Recorder — CLAUDE.md

A mobile app for building multi-layer loop sketches. Set a tempo and bar count, pick a drum
loop, record up to seven layers while the loop runs, then choose bar by bar which pass of the
recording fills each slot of the arrangement.

The spec is written for iOS. **The target platform is currently an open decision** — see
`docs/platform-decision.md` and the section below.

**It is a sketchpad for improvising, not a DAW.** Almost every design decision follows from that.

## The spec is the authority, not this file

`docs/audio-loop-recorder-spec.md` (~1200 lines) is authoritative, along with `docs/kit/`
and `docs/mockups/`. This file is a day-to-day reference; when the two disagree, the spec
wins.

The mockups are behaviour references, not production code. Read them for exact constants and
for interactions prose describes poorly. Do not port the DOM structure.

`docs/kit/lr-kit.js` holds a working reference implementation of the timing rules —
`LR.timing` has `framesPerBar`, `passesForBar` and `passCount`, and the spec calls
`passesForBar` "the executable form" of §1.4. **It runs under Node, and it is the cheapest
way to check a timing change**, with no Swift toolchain involved:

```bash
node Tools/verify-timing.js && node Tools/verify-region.js
```

## The target platform is deliberately UNDECIDED

Development is on Windows and **a Mac is not a realistic option**. That rules out Xcode, the
iOS Simulator, and any local compilation of AVFoundation — permanently.

The research behind this, and the ranked options, are in **`docs/platform-decision.md`**.
Read it before proposing a platform, and do not re-derive it. The short version: Expo + EAS
Build compiles iOS in the cloud from Windows, `expo-audio` cannot express this app but
`react-native-audio-api` can, and Android costs nothing to build for. The decision is being
held open on purpose.

**Holding it open costs something on every commit, and that cost is the rule:**

> Anything decidable without audio hardware goes in a platform-neutral layer. The
> platform-bound surface stays small enough to rewrite in a day.

Bar identity, frame arithmetic, pass availability, region lookup, the schedule plan,
arrangement editing, compress and bounce are all pure. What genuinely binds to a platform is
narrow: open a file, schedule a buffer at a time, read input, measure latency. **If that
surface starts growing, the deferral is failing** — stop and decide rather than drifting.

### Why the domain layer is TypeScript

Not a platform bet — the opposite. TypeScript runs identically in Node, React Native and a
browser, so it fits three of the four routes in `docs/platform-decision.md`; Swift fits only
the one that needs the Mac that does not exist. And it **runs and tests on this machine
today**, which Swift never could.

An earlier Swift version of this same layer is at commit `349d15b` if a native path ever
opens. It was deleted rather than kept alongside: two implementations of one domain is
precisely the drift the spec warns about (§1.5), and one of them could not be compiled or
tested by anything.

**There is no audio code in this repo, deliberately.** A first attempt produced ~400 lines of
AVFoundation that could not compile and was deleted whole. Do not write audio code until a
platform is chosen and there is something that can build it.

## Layout

```
src/domain/            the whole domain layer — no platform APIs, no dependencies
  bar-ref.ts           bar identity; horizontal axis stepping
  timing.ts            frame arithmetic; the end-of-session tolerance
  pass-index.ts        pass numbering, availability, region lookup, vertical stepping
  schedule-plan.ts     what plays when; mid-bar splice entry points
  arrangement.ts       the edit operations; compression plan
  transport.ts         playback position, the played set, the release edge
  project.ts           Project, Layer, quality, size projection
tests/                 node:test, one file per module
Tools/                 toolchain-free cross-checks against docs/kit/lr-kit.js
docs/                  the spec, the design kit, the mockups, the platform research
```

```bash
npm run check      # typecheck + tests + the lr-kit.js cross-check
npm test           # just the tests
```

**No build step and no runtime dependencies.** Node 22.6+ runs the TypeScript directly by
stripping types, so `tsconfig.json` sets `erasableSyntaxOnly` — enums, namespaces and
parameter properties are rejected at typecheck rather than at runtime. `typescript` is the
only devDependency, for `tsc --noEmit`.

**Run `npm run check`, not the individual scripts.** It has already caught one regression the
others hid: adding `"type": "module"` silently broke the CommonJS harness in `Tools/` while
`npm test` stayed green.

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
exactly one place — `regionFor` in `pass-index.ts` — and it is tested.

**The tolerance is a duration, not a frame count, and it guards the NEAR edge of a bar.**
A hardcoded 2000 frames looks reasonable and is 45 ms — and it means different slack at
44.1 kHz than at 48 kHz, when the thing being absorbed is a physical delay in milliseconds.
`TOLERANCE_SECONDS` is 4 ms. Since a bar now exists once the recording reaches into it
(§1.4), a bar landing short needs no forgiveness; what needs absorbing is the *overrun* —
stopping is never instant, so a pass played to exactly the loop point captures a few ms past
it, and that crumb would otherwise become a phantom bar and a phantom pass.

**`passCount` and `barExists` are one derivation, not two.** They used to be computed
independently and disagreed on every recording that overran the loop point: two complete
passes plus 20 ms reported three passes to the size projection while offering two to the
swipe axis, so the Library over-stated the project by 50%. Both now go through `passExists`.
`tests/recording.test.ts` sweeps lengths asserting they agree.

**A partial bar is kept; a partial pass is not — and that asymmetry is deliberate.** An
overrun bar is one tap-and-hold from silence and local to its slot. An overrun *pass*
renumbers every pass after it, permanently, and a single pass cannot be deleted (§5.1 #2), so
the only escape is clearing the layer. It is near-worthless even when intended: a traversal
that has not completed bar 1 contributes a fragment to one bar position and nothing to any
other. **Gate it in bars, not milliseconds** — a stop overrun is roughly constant in absolute
time, so it is ~10% of a bar at 60 BPM and ~40% at 240 BPM, and no percentage threshold works
at both ends of the range. "One complete bar" needs no tuning. This is also the only surviving
use of the tolerance at the *far* edge of a bar; a completeness test is the one kind that
needs it.

**One derivation per quantity.** An earlier `Layer` counted passes one way for its total
(against a hardcoded `16 * 4410`, which is not `framesPerBar` for any tempo) and another way
for availability. `PassIndex` walks session order once; everything else asks it.

**Sum passes across layers, don't max them.** §2.7's table — 5 layers, 12 passes, 66 MB —
only holds if it is the total. Pass count drives size, not layer count, which is why the
Library shows it.

**Keep `loopSeconds` floating point.** `barCount * beatsPerBar * 60 / bpm` under integer
division truncates 9.6 s to 9 — a 6% error in every size projection at that tempo. JavaScript
will not do this to you by accident, but a port to a typed language will.

**Availability is derived from audio, never stored (§1.4).** A counter cannot express a
partial pass, where early bars have one more pass than late ones. It also means a compressed,
bounced or imported layer needs no special handling, and the pass axis re-enables by itself
after recording onto a compressed project.

**The available set can be non-contiguous.** A tile legitimately reads `P4` with no `P3`
behind it. The gap is real and the number preserves provenance.

## Recording lifecycle, and a deliberate reversal of §5.1 #5

`recordSession` in `project.ts` is the only way a layer gains audio. Nothing else writes
`barSources` — before this existed, nothing did at all, and every function in the domain
operated on an arrangement that could not come into being.

**A bar exists once the recording reaches into it, not once it is whole.** This reverses
§5.1 #5 ("kept but not exposed"), whose stated reason was that padding "creates silent bars
that look selectable". Nothing is padded — `regionFor` clamps to the file, so a half-recorded
bar plays half and stops — and a bar the recording never reached is still excluded. So the
failure that rule guarded against cannot occur, and a partial pass yields usable bars instead
of discarding the user's last seconds of playing. **The kit still implements the old rule**;
`Tools/verify-timing.js` asserts it does, so the divergence cannot vanish unnoticed.

**The arrangement is built on the first session and never rebuilt.** A later pass is an
option the vertical axis gains, not a decision about where it goes — auto-selecting the
newest pass would discard hunting the user had already done.

**Slots a partial first pass never reached point at `P1/1` and start muted.** Both halves
matter. Pointing at real audio keeps the slot swipeable — left dangling, the tile draws blank
and the vertical axis has no available set to wrap through, so the user cannot select their
way out. Starting muted stops the placeholder lying about being a performance. Together they
hand the decision back through gestures that already exist, and the swipe lock composes
rather than conflicts: unmuting is the step where the user decides the slot should sound.
**Nothing ever reaches back to unmute them** — by then they are ordinary muted slots and our
guesses would be indistinguishable from the user's choices.

**A session that never completed a bar is not recorded.** It holds no passes, and on an empty
layer would initialise an arrangement of nothing but muted placeholders. The pass gate applies
to the first pass like any other.

**The pass badge previews the gate rather than restating it.** `recordingBadge` increments the
number at the loop point and marks it provisional until `passExists` says the traversal has
earned its bar — the same predicate that decides survival at the stop, so the two cannot
drift. It takes the engine's frame count, not a software clock, for the same reason transport
does (§2.4): a free-running counter would commit the badge at a different instant than the
stop actually does. The provisional number is never reassigned — stop early and the discarded
traversal hands that number straight to the next take, which is tested.

**A retained bar occupies `framesPerBar` no matter how much audio is behind it.**
`RetainedBar.frameCount` is the width of the slot; `region.frameCount` is how much there is to
copy, and for a partial bar it is less. They were the same number until partial bars became
selectable, and collapsing them again is silent and destructive — compress writes bars back to
back, so a narrow one pulls every later bar early and leaves the compressed loop shorter than
`barCount × framesPerBar`, in the only surviving copy.

**The layer being recorded onto is silent for the take**, and it is derived (`isLayerAudible`),
never written into `layer.muted`. Writing through would make our state indistinguishable from
the user's, so stopping could not restore theirs — the same trap as everywhere else here.

## Per-bar mute

Tap and hold on a tile (§3.7). **Scope is the slot, not the source** — and since swiping is
locked while a bar is muted, no gesture can ever move a mute onto different audio, so the two
readings are not even distinguishable in use.

**Stored as sparse slot indices** (`Layer.mutedSlots`), not a boolean per slot. A parallel
array would have to stay exactly `barCount` long forever, and two arrays sharing a length
invariant is how they drift apart. Sparse has no invariant to break, and every slot muted at
once — a legitimate state — costs 32 numbers at worst. It is deliberately not folded into
`BarRef` either: a BarRef says where audio came from and is used to look up regions; muting
is a decision about a slot.

§1.5's warning about a parallel per-bar map does not apply. That was about a *selection* map
restating what `barSources` already encoded. `barSources` says where a slot's audio comes
from; `mutedSlots` says whether it sounds. Different questions, no duplication.

**Layer mute is never written through into `mutedSlots`.** Either mute silences a slot, and
they compose at read time through `isSilentAt`. Writing the layer mute through would destroy
the record of which bars the user muted deliberately, so unmuting the layer could not restore
them — the same derived-versus-written trap as anywhere else. There is no per-bar override
that plays through a muted layer, because that would be solo, and §5.1 #9 rules solo out.

**`canSwipeSlot` is domain code, not a check in the gesture handler**, so the gesture and any
other route to the same edit cannot drift about when it is allowed. `stepPassAt` and
`stepBarAt` both consult it and take `MutedSlots` as a required argument — defaulting it would
mean forgetting it silently permits the thing the gate exists to prevent.

**Compress and bounce both bake it in.** They are deliberately destructive to reclaim space,
so a muted slot is written as real silence rather than kept as a flag over audio nobody can
hear. Three consequences, all tested:

- **A rest is still a bar.** The silence occupies its slot and the arrangement stays
  `barCount` long; muting bar 3 does not shorten the loop or renumber what follows.
- **The flags clear afterwards.** The silence is in the audio now; keeping them would silence
  it twice, and unmuting later would reveal silence rather than the take that was there.
- **A muted slot needs no source.** It is about to be silence either way, so missing audio
  behind it is not the error it would be for an audible slot.

**Transport knows nothing about mute.** The mockup computes `passed` from the transport and
applies mute on top, so the progress sweep stays readable through a silent bar — "other layers
sound through its slot". Height collapses to the dot floor via real height, never `scaleY`
(§3.3's border-radius trap). Keep that composition; do not feed mute into the played set.

## Transport, and two deliberate divergences from the kit

§3.6 lists six rules. **Four of them are one rule**: index on position within the *cycle*
(`origin → end → wrap → back to origin`) rather than on raw slot, and gating, wrap-release,
hold-while-wrapped and release-at-the-origin all fall out of `cyclePosition(slot) < phase`.
The fifth falls out of bar mode being a cycle of length 1. The sixth — selection clears on
stop — is UI state and lives in the caller.

Verified against the kit across 32,768 played-set states and 144,000 rendered line-frames.

**`wrapped` does two jobs, and only one is redundant.** As *state* it is exactly
`head < origin`, so the comparison above replaces it. As an *edge detector* it is not
redundant: it fires the cycle event, which sets the mockup's per-tile `resetA` — and
`passed = max(passedAt, resetA)` decaying over `TAU.reset` is the 180 ms release. Drop the
flag naively and `isPlayed` stays perfectly correct while the release degrades to a
one-frame snap, which **no played-set test can see**. `completedCycleBetween` is that edge
without the flag. `tests/transport-animation.test.ts` guards it.

**Divergence 1 — transport owns no clock.** The kit integrates its own `tick(dt)`. Here the
engine's frame position is authoritative (§2.4), because a software clock free-runs against
the audible playhead — 1% on a 40-second loop is 400 ms. It also made the cycle edge fire a
frame early under float accumulation, offsetting the whole release. Exact frame counts and
integer division remove the class.

**Divergence 2 — the colour feather stays continuous across the wrap.** The kit satisfies
"hold lines from the origin onward as played" with `return COLOR_FEATHER`, a constant. That
holds them, but it also snaps the *trailing* feather: at the instant the playhead leaves the
last slot, that slot's final line is one line behind and should read ~40% spent and still
fading — the kit jumps it to 100% in a frame. §3.4 asks for "a soft colour edge trailing a
crisp height edge", so we return the true distance, which holds the line just as played and
lets the feather finish. Height is unaffected either way (its window is one line, so both
clamp). There is a test asserting the kit still snaps — if it stops, re-check whether this
divergence is still wanted.

**The snap is NOT what stops the gradient bleeding onto the previous bar.** That was checked,
because it is the obvious reason to keep a constant and it would make the divergence unsafe.
Two independent fixes: the *gate* stops the bleed (rule 1 — "the colour feather reaches
backwards across the bar boundary and tints the tail of the previous bar, which never
played"), and the *constant* holds played lines (rule 3). The kit has both; we reproduce the
gate structurally through cycle position and replace only the constant. Measured: zero bleed
events in the kit across five origins and sixty-five phases of single-bar playback, and zero
in ours. `tests/transport-bleed.test.ts` keeps it that way — it is the most visible failure
in the whole transport, so it has its own file.

**This has not been seen on screen.** It is verified numerically against the reference, which
is not the same as looking right. Confirm in the UI when there is one.

## Where the audio work is still ahead

Not written, and deliberately not started — see the platform section. What it will owe,
whichever platform wins:

- **One shared sample-frame anchor** for all layers. Relative timing drifts them apart (§0.4).
- **Two alternating players per layer**, so segment N+1 can overlap the tail of N.
- **An unconditional 5–10 ms equal-power crossfade on every join**, including a splice into
  the same source. Bar boundaries in a live recording almost never land on silence (§2.4).
- **Beat-sized segments**, so the committed horizon stays short and a splice is never far
  behind the gesture.
- **Nothing on the render thread** — no allocation, no locks, no file I/O.
- **Latency compensation**, mandatory per §2.3 and the thing most quietly missing from the
  first attempt: it was computed and then discarded. On a platform without a latency API the
  answer is loopback calibration — see `docs/platform-decision.md` §5.

`segments()` and `splice()` in `schedule-plan.ts` already decide *what* plays and *when*. The
audio layer's job is to execute that, and little else.

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
