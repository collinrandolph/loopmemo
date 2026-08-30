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

**The tolerance is a duration, not a frame count.** §1.4 forgives "a few milliseconds" on a
session's final bar so stop latency does not lose a completed pass. A hardcoded 2000 frames
looks reasonable and is 45 ms — enough to admit a bar that is most of a beat short, which the
scheduler then reads past EOF. `TOLERANCE_SECONDS` is 4 ms, and `regionFor` clamps
`frameCount` to what is actually on disk, so a forgiven bar plays a hair short instead.

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
