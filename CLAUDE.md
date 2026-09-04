# Audio Loop Recorder — CLAUDE.md

A mobile app for building multi-layer loop sketches. Set a tempo and bar count, pick a drum
pattern, record up to seven layers while the loop runs, then choose bar by bar which pass of the
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

**There is no audio code in `src/`, deliberately.** A first attempt produced ~400 lines of
AVFoundation that could not compile and was deleted whole. Do not write audio code there until a
platform is chosen and there is something that can build it.

**`ui/src/audio.ts` makes the browser build audible, and that is allowed.** The deferral protects
`src/domain` — pure, no platform APIs, so it survives whichever platform wins. `ui/` was always
browser-specific and always disposable, and `engine.ts`'s `Engine` is *the seam a real engine
replaces*, so a sounding engine implementing that type is the substitution working rather than a
second path beside it. It plays `backingSchedule()` and the recorded layers.
**Frames become seconds in exactly one function.**

**`prototype/backing-tracks/` is where the synthesis decisions were made by ear**, and `audio.ts`
is the port of it. Standalone, plain scripts, no build step; nothing imports it either way. Keep
it as the reference it is — but the recipes now exist twice, so a change to one is a decision
about the other.

## Layout

```
src/domain/            the whole domain layer — no platform APIs, no dependencies
  bar-ref.ts           bar identity; horizontal axis stepping
  timing.ts            frame arithmetic; the end-of-session tolerance
  pass-index.ts        pass numbering, availability, region lookup, vertical stepping
  schedule-plan.ts     what plays when; mid-bar splice entry points
  backing.ts           the drum track and chord bed: libraries, chord math, the tiling rule
  backing-schedule.ts  backing onsets in frames; the bar-preview entry point
  arrangement.ts       the edit operations; compression plan
  transport.ts         playback position, the played set, the release edge
  effects.ts           pan law, presets, the Haas delay
  eq.ts                EQ presets, and the biquad response that checks them
  project.ts           Project, Layer, quality, size projection
  bounce.ts            the mixdown plan and the project it seeds
  export.ts            what files come out, and what each one contains
tests/                 node:test, one file per module
Tools/                 toolchain-free cross-checks against docs/kit/lr-kit.js
docs/                  the spec, the design kit, the mockups, the platform research
```

```bash
npm run check      # typecheck (src+tests, then ui) + tests + the lr-kit.js cross-check
npm test           # just the tests
npm run ui         # build the browser bundle and serve it on :5173
```

## Needs a human — do not report these as verified

Everything else in this repo is checked by `npm run check` or by driving the browser. These
cannot be, because the environment the agent works in has no microphone, no ears and no screen it
can judge. Each is verified *in parts*; none is verified end to end.

- ~~**Arming with a microphone that is actually granted.**~~ Done on an iPhone, 2026-09-04,
  including the deny-then-re-grant path.
- ~~**Recording end to end on real hardware.**~~ Done on an iPhone, 2026-09-04: takes recorded and
  played back, and the recording offset was judged by ear and reported sufficient. Two defects
  came out of that session and are fixed — see the take-id and zoom sections below.
- **Transport's colour feather.** Verified numerically against the kit across 32,768 played-set
  states and 144,000 line-frames, which is not the same as looking right.
- **`SURROUND_WET_DB = -1.5`.** Surround is the only preset whose two paths both carry signal, so
  it is ~2.3 dB hotter; a test records the consequence so changing the number is deliberate, but
  the number itself is a guess until someone hears it.

## The UI pass

`ui/` is a browser app over the **real domain** — `tsc -p tsconfig.build.json` emits the same
`src/` sources as ES modules (`rewriteRelativeImportExtensions` turns the `.ts` specifiers into
`.js`), so nothing in `src/` changes for the browser's benefit and there is still no bundler
and no runtime dependency. `Tools/serve.js` is a 40-line static server.

It exists because several decisions were verified numerically and never seen — transport most
of all. It is **not** a place to design interface: `docs/kit/` and `docs/mockups/` are the
reference for layout, sizing and states, and `ui/app.css` copies the Edit Layer grid from the
mockup rather than reinventing it. The kit supplies presentation (`ramp`, `motion`, `sizing`,
`Waveform`, `VolumeControl`); its own `timing` and `Transport` are deliberately **not** used,
because those are what `src/domain` replaces.

**Recording on the Playback screen goes through the domain, and the mockup's version does
not.** The mockup increments a pass counter at each loop point; here the badge is
`recordingBadge` (provisional until the traversal earns a bar) and the take is committed by
`recordSession` at the stop, which may decline it. **Nothing is written at the loop point** —
one continuous recording is one session however many passes it spans (§1.4). Stop inside the
first bar and no pass appears, which is visible in the UI.

**Every pointer gesture goes through `ui/src/gesture.ts`. Do not write a second one.**
`pointermove` fires on plain hover, and capture is only a routing hint: it survives a `pointerup`
the page never receives — released outside the window, focus lost, the browser taking the gesture
over. Hover then re-enters a tile holding orphaned capture, a `hasPointerCapture` guard passes,
and the move is measured against an ancient `x0`/`y0`, so slots step with nothing pressed.
**The mockup guards this way, so copying it reintroduces the bug** — and it was then written a
second time, in the chord wheel, which is why there is now one copy of the answer. `trackDrag`
owns the `down` flag, the `e.buttons === 0` bail that catches the missed release itself, and
`lostpointercapture` / `pointercancel`; callers get `dx`/`dy`, `rebase()` to repeat within one
drag, and `consume()` to say the release was not a tap.

**A screen owns its screen; everything reusable is beside it.** `playback.ts`, `edit-layer.ts`,
`library.ts`, `export.ts` and `settings.ts` are the screens. Shared: `gesture.ts` (the press guard
above), `controls.ts` (`swipeWheel`, `bindChips`), `screen.ts` (`renderLoop`, `formatBytes`,
`confirmPanel`, `annotationRow` — each of these had been written out per screen and drifted),
`icons.ts` (inline Lucide paths — take new ones from that set), `backing-rows.ts` (the two backing
rows, which edit `project.backing` and report upward like a layer row), `theme.ts` (the four
colourways, generated — see `docs/kit/restyling.md` §9), `store.ts` (IndexedDB — see below) and
`help.ts`.
**There are no tests over `ui/`** — only `src/domain` is covered, so a change here is verified by
driving the browser.

**`bindChips` delegates on the `.lr-chips` group, so no chip may call `stopPropagation`.** The EQ
and Pan pickers did, and the consequence was quiet: the preset changed and the highlight stayed
put, so the panel named one preset while a different one looked selected. It was guarding nothing
either — the only click listener above a chip is on the row *head*, and the chips live in the
panel, which is the head's sibling. If a chip ever does need to stop an event, move the active
class with it rather than leaving two mechanisms.

**Every `swipeWheel` is a value with the `↕` pushed right; the layouts differ only in whether the
caption is drawn.** `row` puts it outside as a `.lr-panel-label`, so a panel of wheels reads as
labelled rows alongside Volume, EQ and Pan. `inline` — the chord editor's three-abreast Note /
Sign / Type — draws none: C / ♮ / Maj under a chord button say what they are, and a `↕ NOTE` under
each spent a line naming what the value already said. The caption still goes on as `aria-label`
either way. A labelled row is only a column if every label is one width — `.lr-panel-label`'s
`min-width` has to clear the longest caption at every breakpoint, and at ≤640 it did not.

**To line something up under the control column, give it an empty `.lr-panel-label` and make it a
row.** Never compute the indent: the column is `min-width` + the row `gap`, and *both* change at
640px, so a `padding-left` that looks right on a phone is 40px out on a desktop. This has been got
wrong twice. `settings.ts`'s `annotate()` is the helper; `playback.ts`'s empty-layer note is the
same trick. A stale `gap` override on one row is enough to break the column on its own — that is
what put the Preview row 4px off everything else.

**The hint is an icon because a text glyph cannot be vertically centred.** `↕` paints 2.5px below
the middle of its own line box and overflows a `line-height: 1` box by 2px — `align-items: center`
centres the box correctly and the ink inside it is still low, and any nudge that fixes it is a
correction for one font when this is whatever the platform's system font happens to be. An SVG's
box is its art. **Measure a centring claim rather than eyeballing it**: the box being centred and
the mark being centred are different facts, and only the second one is visible.

**The project actions live on `settings.ts`, not `library.ts`.** Export, bounce, compress and
delete were a per-row panel behind a chevron; a Projects row is now a list entry you tap to open,
with no panel and no second action. Each action operates on `commit()` rather than `opts.project`,
so pending edits are included — a rename has to reach the exported filenames.

**Setup and project settings are one screen (`settings.ts`), and the locks are derived.**
`isConfigurationLocked` already says whether tempo and bar count have set, and a project being
created is just one with no recordings — so it answers false and everything is open. One genuine
mode bit remains, recording quality, because "does this project exist yet" is not something a
`Project` can report about itself. **It deliberately has no backing pickers**: the Playback rows
own those, and a second editor for one piece of state is the drift this codebase keeps undoing.

**`ui/src/demo.ts` is the only invented data left**, and that is the test. It is the fixture
shelf plus `amp`, the synthetic peaks that stand in for the demo projects' missing audio; a real
take draws its own through `peaks.ts`. `engine.ts` holds the seam itself — if a screen ever needs
something from an engine that a real one could not give, the platform-bound surface has grown
past what the deferral assumed, and that is worth stopping for.

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

**Stop and pause are the only two ways out of a take, and everything else is disabled while one
runs** (§3.5). Pause used to end the transport and leave the row recording, so the commit was
never reached — fixed by delegating to `setRec`. Navigation was the same hole by a different
door: `render()` calls `destroy()` and then closes the `AudioContext`, which takes the capture
worklet with it, so a tab, the Projects button, Export, the gear or Edit Layer deleted the
performance outright. **Seeking is the same loss from a control that looks harmless** — the
length committed is `frameNow() - recordingFrom`, so moving the clock under a running take
reports a traversal nobody played: forward it claims passes with no audio behind them, back it
claims none and the domain declines the whole thing.

Three things about the shape, each of which the obvious version gets wrong:

- **One enforcement point.** `app.ts`'s `navigate` is the only way the route changes and the only
  place a change is refused; the tab bar used to set `route` and call `render()` itself, which is
  exactly how the next route added would skip the guard.
- **`disabled`, not `pointer-events: none`.** A focused button still fires on Enter, and a rule
  that only holds for the mouse is not a rule. `playback.ts` keeps an `exits` list every such
  control pushes into, so a new way off the screen is one line from being covered.
- **The predicate is asked, never cached.** `takeInProgress()` is what refuses; `onBusyChange`
  only dims the shell's tab bar, which the screen cannot reach. Deriving enforcement from the
  notification instead would make it depend on the notification having arrived.

**A row refuses to arm without an input, and that is the only place the failure is preventable**
(§3.5). Everything downstream is correct *given a take*, so a denied microphone that still armed
committed a take of silence as a real pass — badge advanced, arrangement built on it, pass count
and size projection both up by audio that does not exist. Measured at 7 → 8 passes and 24.7 →
28.2 MB for three seconds of nothing, and persistence would have made it permanent.

**Only a cold start waits.** `hasInput()` is what keeps every later arm instant, so the pending dot
means a prompt is open and nothing else — without it, each arm would flicker through a waiting
state it does not need. `classify()` sorts the failure into denied / missing / insecure so the
screen can word three different remedies; printing an exception name is not a defined state.

**Armed is deliberately not locked.** It holds no audio, and `onPointerDownAnywhere` already
abandons it the moment attention moves elsewhere — locking there would be a mode with nothing to
protect. The greying also reverses the kit's treatment of the *record dots*, which vanish
outright, and §3.5 says why: a missing dot is explained by the one recording beside it, a missing
Export button by nothing at all.

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

**This has not been seen on screen** — see "Needs a human" above.

## The audio layer, and what it still owes

`segments()` and `splice()` in `schedule-plan.ts` decide *what* plays and *when*. The audio
layer executes that and little else, which is why it is small: `layer-audio.ts` is about sixty
lines, `recorder.ts` and `effects-chain.ts` not much more.

**Built and measured** (all in the browser, on this machine — see `docs/platform-decision.md`
§8, which listed most of this as needing a device):

- **One shared sample-frame anchor.** Every layer and both backing tracks derive from it (§0.4).
- **Segment scheduling.** Rendering `segments()` offline reproduces the source *bit-identically*
  — worst difference 0 — in recorded order and reordered across passes. `verify-joins.ts`.
- **An unconditional 7 ms equal-power crossfade**, which cuts the worst join step by 393×.
- **PCM capture** on the audio thread, stamped with the worklet scope's own `currentFrame`.
  72,000 frames of noise back bit-identically. `verify-capture.ts`.
- **PCM capture verified end to end**, including that the take committed is the one that arrived.
- **EQ, pan and the Haas delay**, built once per layer and changed only by ramping gains.

**Two alternating players per layer is an AVFoundation problem, not a requirement.** A player
there is a long-lived queued object. An `AudioBufferSourceNode` is one-shot, so each segment
gets its own and overlap is free. It returns on a platform without that property.

- **Mid-bar splice**, through `spliceCurrentBar`, so a swipe is heard on the bar it was made on.
- **The recording offset**, applied at scheduling — see below.

Still owed:

- **Beat-sized segments**, so the committed horizon stays short and a splice is never far
  behind the gesture. Currently one bar at a time.
- **Nothing on the render thread** — no allocation, no locks, no file I/O. The worklet holds
  to this; the scheduler runs on the main thread and allocates per bar, which a browser
  tolerates and a phone may not.

**The recording offset is applied at scheduling, never at capture — and that is the whole design**
(§2.3). It is a user control rather than a measurement, because a microphone cannot hear
headphones and §2.2 makes headphones the correct setup, so a loopback calibration measures an
output route nobody records against.

Applying it at capture looks equivalent and is not, in three ways. It would fix only *future*
takes, leaving every earlier one permanently wrong. It would move a take's *end*, so §1.4's "a bar
exists once the recording reaches into it" would give a different answer at different offsets and
the control would silently renumber passes. And it could not be judged, because judging it means
dragging while the loop plays and hearing the take land — which only works if the change is
retroactive.

**It offsets `regionFor`'s read position, not the transport and not the backing.** Reading a
recorded region from `startFrame + offset` pulls the audio *earlier* in time, which is the
direction that corrects a late arrival. It belongs in `pass-index.ts` because that is already the
single place a `BarRef` becomes a session and a frame range, and a second place frame offsets are
computed is the one thing that file exists to prevent. The backing is generated on the shared
anchor and is already on time; offsetting it too would move the reference being corrected against.
**Seconds in the domain, frames at the boundary** — latency is a physical duration, so the same
argument as `TOLERANCE_SECONDS` and `HAAS_MAX_SECONDS` applies.

**The effects graph is fixed-shape on purpose.** `effects.ts` is explicit that every pan preset
reports the same `delayFrames` and the five without a delay silence it with gain, so a preset
change is a gain ramp rather than a reconnection — both a rebuild and a change of delay time
click, and preset changes are a live gesture. The EQ extends the same rule as far as the API
allows: a fixed chain of `EQ_SLOTS` biquads, with a preset that uses fewer parking the spare
ones as peaking at 0 dB, which is exactly unity. Only coefficients move; the chain never
changes length. A `type` change is still needed, because a high-pass cannot be flattened by its
gain the way a peaking filter can.

**Pan is two gains into a `ChannelMergerNode`, not a `StereoPannerNode`.** The law is the
domain's — equal power, and ±45° is a hard pan rather than 45° of a half-field — and a panner
would impose its own. Surround also needs its delayed copy panned *opposite* the dry signal,
which one panner cannot express.

## Bounce is compress on every layer, plus a mix

**`compressionPlan` does the per-layer work**, so bounce adds only the mix and the seed. The
mixdown is exactly one loop, which makes it Pass 1 — so layer 1 is filled through
`recordSession` and bounce needs no arrangement logic of its own.

**Quality carries from the source, and it is forced.** §2.7's bounce list omits it, but the
mixdown is a sum of the source's layers and sits at its sample rate; seeding at another rate
needs a resample at every splice, which is what snapshotting quality exists to prevent.

**Layer 1 starts neutral and `isCompressed` is false.** The processing is already in the audio,
and the flag means recorded passes were discarded — a new project never had any.

**`tailFrames` turns a prose obligation into a number.** A Surround layer's delayed copy of the
last bar runs past the loop point; a bounce renders a fixed length, so it must wrap to the start
or the seed has a seam the original never had.

**`isAudibleInMixdown` is shared with export on purpose**: two readings of "was this audible"
would let the bounce and the export disagree about the same project. It is structurally typed for
the same reason, so a layer and a backing track can both be asked.

**The backing is not in a bounce; its settings carry instead** (§2.7, settled). Baking the audio
*and* carrying the settings plays the drums twice; baking without carrying freezes a groove §1.2 says
never locks. Excluding the audio and copying `project.backing` verbatim — mute flags included —
means the new sketch opens on the same groove, live and still editable. `bouncePlan` therefore takes
no backing argument at all, and `isAudibleInMixdown` is an **export** predicate, not a bounce one.

**Export and bounce render through `render.ts`, never their own path.** `renderOffline` is the one
place a project becomes a buffer, because a second path is a second set of decisions about
crossfades, splices and pan law. `MixSource` in `bouncePlan` is the domain's account of what goes
in, not a recipe the browser follows — a platform without an engine to render through needs it.

**`wrapTail` folds the overhang onto the head.** A Surround layer's delayed last bar has nowhere to
go in a fixed-length render, so the render runs `frames + tailFrames` and adds the overhang back at
the start. **Export and bounce both do this, and both gate it on `Project.perfectLoop`** — off
renders exactly one loop and lets the tail be cut, which is what a one-shot going into an
arrangement wants. Truncating is now a choice rather than the only behaviour.

**Bounce passes no backing to `loopTailFrames` and export does.** That looks like a discrepancy and
is the same rule: the tail is what is still sounding in *this* render, and a bounce has no backing
audio in it at all (§2.7), so there is no drum tail to make room for.

**Both destructive-ish actions refuse audio that is not in this session.** `hasAudioFor` is shared:
compress would bake a gap into the only copy, bounce would seed a project with a silent layer 1.

## Compress writes audio, and the caller is the one that has to

**`compressionPlan` decides which bars survive; it does not write them.** `compressedProject`'s
own doc says the caller supplies the written files — that is the platform-bound half — and both
compress actions handed the domain a `simSession` instead. A compressed layer then pointed at a
file nobody had written: it played nothing, and `barAmplitude` fell through to `amp()`, so the
lane drew a confident waveform of audio that did not exist. **Reported as exactly that pair.**

`ui/src/compress.ts` is the missing half. **A straight sample copy, not a render** — compress keeps
the *edited loop* and level, EQ and pan stay on the layer, so there is nothing to bake and going
through the engine could only introduce differences.

**Advance by `RetainedBar.frameCount`, never by what was copied.** For a partial bar the region is
shorter than the slot, and advancing by the audio pulls every later bar early and leaves the loop
shorter than `barCount × framesPerBar` — in the only surviving copy.

**A layer whose audio is not in this session is refused, not compressed to silence.** Takes live in
memory only, so a reload loses them, and that is exactly when the buffers go missing. The project
action refuses whole rather than partly, matching §2.7. `verify-compress.ts` checks the render
against a ramp whose value is its own frame number, so a bar written from the wrong place is a
wrong number rather than a subtle difference: 617,400 frames, worst error 0.

**Bounce had the identical defect and no longer does.** It was left visible while §2.7's open
question stood — whether the backing is in a mixdown, and whether its settings carry — and that is
now settled (layers only, settings carry regardless of mute). `runBounce` renders through
`renderOffline`, wraps the tail, files the buffer with `takes.put`, and hands `bounceSeed` a
`RecordingSession` describing audio that exists. **`simSession` is now only `demo.ts`'s**, which is
the one place invented data belongs.

## Perfect loop, and the tail it wraps

**`loopTailFrames` is the one derivation of what is still sounding at the loop point**, shared by
bounce and export so they cannot disagree. It reports the project's worst case rather than a
per-file figure: over-wrapping adds silence and nothing else, where three per-kind figures would be
three things to keep in agreement.

**The tail is much smaller than it looks, and almost all of it is one drum pattern.** Chords
essentially never overhang — `chordRingSeconds` caps to the next onset minus 50 ms and every
pattern starts on beat 1, so the ring lands *before* the bar line. `syncopated-pop` is the only
pattern with an open hat and the only real backing tail: 183 ms at 180 BPM with the Tight kit. A
Surround layer adds 35 ms. Do not re-derive this from strike decays — that mistake was made once
and gave a figure four times too large, because chunk onsets ring `chunkSeconds`, not
`strikeSeconds`.

**`Project.perfectLoop` is one value with two views** — project settings and Export. That is not
the second editor §1.5 warns about, because there is one stored value; but the Export mount keeps
a **local mirror**, since `opts.project` is the snapshot that screen was built with and never sees
the write coming back.

**A quota error is `full`, never `unavailable`, and the difference is the whole recovery.** A full
store still reads and deletes — deleting is how it is emptied — so disabling it would remove the
fix. Only `unavailable` stops everything. Refused takes are kept in memory in `refused` and
rewritten by `flush()` when a delete frees room, so nothing has to be re-recorded.

**The storage banner is driven by a subscription, not the render loop.** The store announces its
own transitions, so polling was both wasteful and dependent on a loop that a hidden tab pauses —
which is also why it could not be tested. `onStatusChange` returns an unsubscribe, and the screen
calls it on teardown or the listener list grows with every navigation.

**`store.ts`'s `migrate` is where a new `Project` field gets its default on load.** A field added
today reads `undefined` on every project saved before today, and for a boolean that silently means
*off* — so a default of true inverts itself for existing work without it.

## Getting files out of the browser

**Ask where the file goes BEFORE rendering it, not after.** `showSaveFilePicker` needs transient
user activation and Chrome's expires about five seconds after the click. The export rendered every
file first and only then asked to save, so anything slower than that window threw
`SecurityError: Must be handling a user gesture to show a file picker` — measured at nine files
with `navigator.userActivation.isActive` false at the call, and one full loop of a long project is
enough on its own. `chooseDestination` reserves the destination while the click is still fresh and
the blob is written into it afterwards, which also means a cancel costs nothing because nothing has
been rendered yet.

**The other half was `catch { return false }`**, which turned that into silence: the button counted
through the renders, reset itself, and no file arrived. **`AbortError` is the only error that is not
an error** — it is the user closing the dialog. Everything else falls through to `<a download>`,
which needs no activation and works everywhere; it just cannot offer a folder or report a cancel.
Reported as "it looked like it was preparing the files and never downloaded anything", for every
option, which is exactly what a swallowed exception looks like from outside.

**The plan decides the container, not the outcome.** `renderOne` returns undefined for a file with
nothing behind it — a pass whose take is not in this session's store — so the rendered count can be
lower than the planned one. The name is chosen before any of that is known, so several *planned*
files stay an archive even when fewer arrive; letting the outcome decide would write a lone `.wav`
into a file the user has already named `.zip`.

**A short export stays on the screen.** `onShare` means "you are finished here" and it tears the
screen down — which took the shortfall message with it before it could be read. The file is still
written; the difference is only whether the screen leaves.

## Backing tracks

Two synthesised tracks, `project.backing.drums` and `.chords` (§2.6). **Neither is a file** — no
`audioFileURL`, no `originalBPM`, no playback ratio, and nothing ships as an asset. That whole
apparatus existed to stretch a sampled loop to the project tempo, and synthesis deleted the
problem rather than solving it; it is in §5.2 so it does not get rebuilt.

**Two axes per track, and keeping them independent is the point.** Drums are pattern × kit,
chords are chord pattern × tone — deliberately the same word on both rows, because they are the
same idea, and the two panels are laid out control for control to say so. A kit is a parameter set
fed to the same three recipes, so any
kit plays any pattern — the earlier design baked a kit into each pattern to avoid auditioning
sampled combinations, and that reason is gone. Do not offer a combined list; it re-couples them.

**Envelope times are seconds; pitches are Hz; onsets are frames.** Not an inconsistency. A kick's
decay is physical and identical at 60 and 240 BPM, so a frame count would silently differ between
44.1 and 48 kHz — the same argument as `TOLERANCE_SECONDS`. A pitch is not a duration at all.
Only *when* a voice fires is musical, and that is frames, converted at the platform boundary.
`kitVoiceFrames` and `toneFrames` do the conversion.

**`beatFrameOffset` divides `framesPerBar`, not its own frames-per-beat.** `framesPerBar` is
already rounded, so an independently-rounded beat length puts the eighth-note grid on a different
footing than the bar grid it sits inside and the two disagree by a frame at some tempos.

**Backing shares layer playback's timing, not its scheduling type.** `segments()` schedules
regions of a recorded file, keyed by `BarRef`; a backing voice is generated on demand and has no
file, no region and no `BarRef`. One shared anchor (§0.4), two builders. Do not merge them.

**`chordSlotFor(slot) = ((slot − 1) mod 4) + 1`, and bar preview uses the same rule** — chord 2
owns slots 2, 6, 10, 14, 18, 22. Previewing a bar plays the chord that owns it, not the first
chord and not none.

**The `AudioContext` must be created at the project's sample rate, never the device's.**
`new AudioContext()` takes the hardware default — 48 kHz here — while `Timing` computes every
frame count at the project's quality, 44.1 kHz. The engine then holds *two* rates: `frameToTime`
converts with the domain's, so the backing stays correct, and `scheduleSegments` converts with
`ctx.sampleRate`, so the recorded layers run 8.8% fast against the drums. A bar measured 2.297 s
instead of 2.5. **It is invisible until a layer has audio to play**, which is the argument for
closing the record-to-playback loop early rather than building recording and playback separately
and meeting in the middle.

**Layer segments are not in `voices`, so every teardown path has to handle them separately —
and two of the three forgot.** Backing voices are registered by `track()`; layer segments are
held per layer in `LayerVoice.scheduled`, because a splice has to be able to find and retire
them. `rescheduleFuture` pruned only the first list, leaving every queued bar of the old plan
running while `topUp` scheduled the new one beside it. `killAll` did the same, so `stop()` left
up to `AHEAD_SECONDS` of layer audio playing and the next `start()` laid a fresh plan on top —
tapping a playing slot and tapping again gave three copies at once. Both now walk both lists:
`cancel` for a segment that has not started, `retire` for one that has.

**A bar already under way is never re-scheduled from its downbeat.** `start` treats a past time
as "now", so handing it the bar's own start frame restarts that bar from the beginning on top of
the copy already playing. `scheduleBar` filters those out and `spliceCurrentBar` handles the
in-progress bar instead — entering the new source at the offset the playhead has reached
(§2.5), one crossfade ahead of the playhead so nothing is scheduled in the past, with the
outgoing segment retired over exactly that window. `splice()` declines the two cases that are
not worth it — no audio, or a playhead inside the tail guard — and both fall through to the
natural boundary, which is a bar away at most.

**`retire` uses `cancelAndHoldAtTime`, not `cancelScheduledValues`.** The outgoing voice may be
part-way through its own fade, and holding the value it has reached is what makes the hand-off
continuous; cancelling outright snaps it back to whatever was last set explicitly, which is a
click at the exact moment the splice exists to avoid one.

**The engine holds a snapshot, so every screen that edits must push it — this has been got
wrong four times.** `setLayers` copies each `Layer` into a `LayerVoice`, and nothing re-reads
project state on its own. The backing rows forgot it and a kit swap was silent; the EQ and pan
chips forgot it and a preset change did nothing; the Edit Layer axes forgot it and a swipe
redrew the tile while playback kept scheduling the old arrangement — the drawing and the audio
disagreeing about one edit, which is the split §1.1 exists to prevent. Both screens now have a
`syncLayers()` and every mutation calls it.

**The Library was the fourth, and the worst, because it was a whole screen of it.** Its row
preview called `engine.start(0)` and nothing else, so every row played whatever the engine was
last loaded with — which on that screen is the *open* project, never the row tapped. Seven
sketches previewing as one. The other three were an edit that did not reach the audio; this was
audio that belonged to a different project.

**It is also the one screen that plays a project other than the open one**, which is why it takes
an `engineFor(project)` callback rather than the shell's engine: the shell reloads the engine and
reuses the context while the rate matches, and builds a new one when it does not. A context cannot
change its sample rate after construction, and `Timing` computes every frame count at the
*project's* quality, so previewing a 48 kHz project on a 44.1 kHz context is the two-rates bug
above with the list as its trigger. Stop before reloading: `setBacking` re-anchors a running engine
on a tempo change, which starts the new project a beat before `start(0)` says so.

**`setLayers` reschedules only when the *arrangement* moved, and tells them apart by identity.**
An edit has to be heard now — §2.4 calls applying an edit to playing audio core functionality
rather than polish — but a level, EQ or pan change needs no rescheduling at all, because those
live on the chain the scheduled buffers already run through. Layers are immutable values, so an
edit produces a new `barSources` array while a slider drag leaves the same reference. That
distinction is load-bearing: a slider emits an event per pixel, and rescheduling on each one
would tear down and rebuild the horizon dozens of times a second.

**Which bar the backing generates comes from the transport, through `slotAt`.** The backing is
*generated*, so unlike `segments()` it needs to be told which bar to make — and the engine counted
its own bars off its own frame origin instead of asking. Two derivations of one quantity, and they
disagreed exactly where it shows: bar preview held one slot on screen while the chord bed walked
the whole progression underneath it, and a loop started from slot 6 played the progression from
chord 1. `slotAt` is the inverse of `cyclePosition`, so the chord you hear and the bar the sweep is
over are one answer. **Their two grids also have to be one grid** — a preview re-anchors the engine
and the transport both to frame 0, because a transport whose `startFrame` is not a frame the engine
calls a downbeat puts the sweep and the drums on different bar lines.

**A change to *which* bar plays next reschedules; a change to what the tracks sound like does
not.** Scheduling runs `AHEAD_SECONDS` in front, so a jump heard a second and a bit after the
sweep moved reads as the backing being on a different loop — that is the same bug again. Voices
already sounding are left alone (cutting a chord mid-decay is a click), and the bar in progress is
re-scheduled rather than skipped, so `scheduleBar` has to drop onsets already in the past.

**The three voice types overlap differently, and that is the decision** (§2.6). Chords cap their
envelope to the gap before the next onset; the hat chokes its predecessor, because a real hi-hat is
one pair of cymbals; kick and snare overlap, because their decays outlive the gap only above
~200 BPM on dense patterns and only in the inaudible tail. A uniform choke was built behind a live
A/B and **rejected by ear** (§5.2) — it measured 1.6–1.8× the energy on dense chord patterns, which
is exactly the chords ringing to the handover instead of getting out of the way.

**The hat's choke ramps its own output gain over `CHOKE_SECONDS` rather than stopping the source
dead**, which is the one thing kept from that A/B. Ramping a dedicated gain that sits at 1 until it
is needed avoids interrupting a voice's envelope automation mid-ramp.

**A muted track schedules nothing**, rather than scheduling voices that are then silenced. It
also means a caller reading the schedule cannot disagree with the mixdown about what was audible.

**`backingMixSources` is the seam bounce and export share.** Both ask only *was this audible* and
*what is it called*, so the two tracks flatten to one uniform list once. The screen used to hand
export a hardcoded pair, which meant a backing track muted on Playback still wrote a stem.

**Kit and tone descriptions exist for whoever is tuning them and are not UI copy.** The name is
the control.

**Anything a handler reads must go through the live `backing`, never a captured snapshot.** The
rows took the track object once at build time, so `!track.muted` was computed against a value
that never changed — mute worked and unmute was a no-op that re-sent `muted: true`. Accessors,
not values.

## EQ presets are checked, not quoted

**`responseDb` exists so the presets are falsifiable on this machine.** The frequencies come
from mixing sources that all quote wide ranges; a table of numbers nobody can evaluate is an
assertion. Computing the biquad response turns "Scoop cuts the low mids" into something a test
passes or fails, and `tests/eq.test.ts` checks each preset against **what its icon promises** —
one hump, one dip, monotone rise, monotone fall — not just against its own parameters.

That check earned its keep three times over. Every wrong number in the first pass was **my
estimate, not the filter**: the analogue approximation `|H|² = 1/(1+(f/fc)⁴)` is right in the
passband and wrong near Nyquist, where a digital biquad's response is frequency-warped and
falls away faster. High Cut is 28.8 dB down at 18 kHz, not the 14 the analogue prototype
predicts. **Do not hand-estimate a digital filter's stopband — run `responseDb`.**

**Web Audio's `Q` is in DECIBELS for `lowpass` and `highpass`, and linear for `peaking`.** The
spec converts the first two with `10^(Q/20)` before use, so handing a `BiquadFilterNode` the
domain's Butterworth 0.7071 asks for an effective Q of 1.085 — a resonant bump, which is the
exact colour `BUTTERWORTH_Q` exists to avoid. `effects-chain.ts`'s `webAudioQ` converts.

Reported as "EQ is either not working or too subtle to hear", and it was neither: it worked and
had been quietly softened, by 3.7 dB at the corner. **Neither side could have found it alone** —
`responseDb` was right, `tests/eq.test.ts` passed, and the graph faithfully built the wrong
filter. It took asking the browser's own `getFrequencyResponse` what it thought those filters
did and diffing that against the domain. `ui/src/verify-eq.ts` is that comparison, now run end
to end through rendered audio; it reports a worst error of 0 dB across five presets and nine
frequencies, and it is the guard against this coming back.

**Measure a sine's amplitude with RMS, not peak.** The first version of that check used
peak-of-samples, which is biased low whenever there are few samples per cycle: at 12 kHz there
are 3.7, so the nearest sample can sit 49° off the crest and read 3.7 dB down. It reported a
disagreement the same size as the real one and would have sent the next reader after the wrong
thing.

**Q is 0.707, not 1.** Sources suggest Q = 1 on a high-pass, which puts a resonant peak at the
corner — a colour for a known source, not a default for arbitrary material. 24 dB/octave would
be two cascaded biquads, not a Q change.

## Level runs past unity, and that is the whole answer to "very quiet"

**A take arrives at whatever the system input gave it, and no browser or iOS API can set that.**
`autoGainControl` is off on purpose (§2.3), so the app's only lever is what it does with the
signal afterwards — and `Layer.level` was attenuation-only, which meant a quiet recording had no
remedy anywhere, including recordings already made. `LEVEL_MAX` is 2, i.e. +6 dB.

**A trim and a normalise were both rejected, and both for reasons already in the codebase**
(§5.2). A trim at playback is `Layer.level` under a second name; at capture it is baked in and
unjudgeable, which is the argument §2.3 uses to put the recording offset at scheduling. Normalising
per take is `autoGainControl`'s fault at coarser grain — two passes of one part come back at
different levels.

**Unity is the midpoint, which is what makes it markable.** The tick sits *below* the track: drawn
on it, the thumb hides it at exactly the value it exists to mark. Double tap returns to unity.
`levelSlider` in `controls.ts` is the one copy — layer rows and backing rows share it.

**The volume icon spans the same range, so unity is half fill** (`levelPercent`). `VolumeControl`
divides by 100 and clamps, so passing `level * 100` saturated it at unity and every decibel of the
+6 dB above moved nothing — the icon read identically at 1.0 and 2.0. Dividing by `LEVEL_MAX` also
puts the icon's neutral where the fader's tick is. **The master control's `* 100` is the same
normalisation** — it is `level / max * 100` with a max of 1, not an exception to the rule.

## Master is monitoring, not mix

**How loud you hear the loop, not what goes in the file** (§4.2). It is the last gain before the
destination, and `setMaster` **refuses to act on an engine that was handed a context** — which is
every rendering engine, since `renderOffline` builds its own on an `OfflineAudioContext`. So the
guarantee is structural rather than a convention about who calls what: a future caller that reuses
the live engine for a render still writes the file at unity.

Getting this wrong is silent and permanent. Listen quietly at night, export, and every file is
15 dB down with nothing on screen having said so — in audio that has already been sent. That is why
`verify-master.ts` renders through an engine explicitly told to go to zero and muted, and asserts
the output is **bit-identical** to the ordinary render: worst sample difference 0. Claim 1 would
pass on an engine that happily applied it, because nothing calls `setMaster` on a render today;
driving it through one that has been told is the point.

**Mix decisions live on `Layer.level`**, which runs to +6 dB precisely so a quiet take has a remedy.
Master is 0..1 — monitoring only ever trims down, and the compressor is immediately upstream, so
there is no headroom above unity to spend. Unity is therefore the default *and* the right-hand end,
which is why `levelSlider`'s midpoint unity tick and double-tap are not reused here.

**It lives on the shell, not on the screen and not on a `Project`.** The Playback screen is rebuilt
on every navigation, so a listening level held there would reset on a trip to Edit Layer. It is not
project state either: it belongs to the room you are listening in, does not travel with a bounce,
and every engine `app.ts` builds is told it — including the Library's per-row preview engines.

**The level persists and the mute does not.** A trim is a preference; a mute is momentary — you
mute to take a call — and restoring one on launch is an app that opens silent and looks broken.
A stored value outside 0..1 is ignored rather than clamped: it means something else wrote the key.

**Ramp, never assign.** The slider emits an event per pixel and setting a gain outright is a click,
so `applyMaster` uses `setTargetAtTime` over 10 ms — the same rule as every other live gain here.
The database is not written per pixel either; that write is debounced.

## Pan and the Haas delay

**There is no EQ in `effects.ts` on purpose.** §2.8's preset table is a placeholder — frequencies
and directions with no gain, Q or filter type, and the set itself unsettled. Implementing it
would turn invented numbers into apparent decisions. It needs a research pass first.

**`7500 / BPM` ms is one eighth of a beat** (`60000/BPM ÷ 8`), so it is a note division, not a
magic constant — `noteDelayFrames` takes beats and shares its arithmetic with `framesPerBar`
(`noteDelayFrames(t, t.beatsPerBar) === framesPerBar(t)`, tested).

**Clamped to 35 ms, because Haas only fuses below ~35–40 ms.** Unclamped it is 62.5 ms at
120 BPM and 125 ms at 60 BPM — audible echoes, not width — and only stays in the window above
~214 BPM. **Floor the clamp, never round**: `round(44100 × 0.035)` is 1544 frames, which is
35.01 ms, i.e. past the limit the clamp exists to enforce.

**±45° is a hard pan** — the angle is the equal-power angle, not 45° of a 90° half-field. The
law must be equal-power; sources are mono, so linear panning would dip ~3 dB through centre.

**Every preset reports the same `delayFrames`, and the five plain ones silence the path with
gain.** The audio layer builds the delay once per layer and only ramps `wet`. Rebuilding the
graph clicks, and so does moving a running delay line's time — and preset changes are a live
gesture.

**Surround is ~2.3 dB hotter than the other presets**, being the only one whose two paths both
carry signal. `SURROUND_WET_DB = -1.5` is flagged for confirmation by ear; a test records the
consequence so changing the number is deliberate rather than incidental.

**The picker icons are a static table on `PanPreset`, and deriving them was a mistake made
once already.** They are labels standing in for names — deriving them from `panGains` produced
a rule that needed an exception for Surround and bought nothing anyone can act on.

**Before changing any stylesheet or token, read `docs/kit/restyling.md`.** Colour is load-bearing
here — two tokens are parsed as numbers by JS, the ramp is §1.1's whole feature, and several CSS
rules gate behaviour rather than appearance. All of it fails silently.

**Do not design UI here.** `docs/kit/` and `docs/mockups/` are the reference for layout,
sizing, states and styling, and they are better than anything derivable from the spec text.
Interface work cannot be judged before there is a build to look at, so proposing panel
layouts, control placement or new components ahead of one is wasted effort.

**The delayed tail of the last bar runs past the loop end.** Live that is correct and needs
nothing. **Bounce and export render fixed-length files**, so there it wraps to the start or the
rendered loop has a seam the live one never had — see "Perfect loop, and the tail it wraps".

## Build order (§0.5)

1. Segment-scheduled playback with a fixed arrangement, no editing.
2. Recording with latency compensation and the three-state record control.
3. Playback screen as an overview, static lanes.
4. Edit Layer grid, colour, motion model.
5. Gestures and transport — the fiddliest part; the mockup is the reference.
6. Live editing: mid-bar splice.
7. Project Library, compress, bounce.
8. Chord bed, settings, manual.

## Tone and scope

- Never let the app be the judge of how a sketch is going. No scoring, no streaks.
- Do not add features the spec does not have without flagging the addition.
- Part 5.2 of the spec lists rejected alternatives with reasons. Read it before "improving"
  something that looks arbitrary — several were built once and removed.
- The renaming warning in §0.1 is real: the glossary's right-hand column contains retired
  words, and a blind find-and-replace across the spec has destroyed it once already.

## Take ids are unique by construction, never derived from position

`newTakeId` in `takes.ts` mints every one. **`layer.id` is `layer-0`..`layer-6` in every project**,
so `${layer.id}-take-${sessions.length + 1}` produced `layer-0-take-1` for the first take on the
first layer of *every* project — and recording a second project overwrote the first project's
audio, in the in-memory map and in IndexedDB.

**It was silent, and it looked like a playback bug.** Waveform peaks live on the project's own
`RecordingSession`, so the lanes still drew correctly; only the sound was someone else's. Reported
from an iPhone as "the waveforms of the first track still look correct but the audio is
mismatched" — the audio was not mismatched, it was gone.

`takes.ts` already said identity is not position, because `sessions` is appended to and replaced
wholesale by a compress. The ids contradicted the doc above them. Three of the four mint sites were
affected: recording, `edit-layer.ts`'s per-layer compress (`${layer.id}-c`, which collided across
projects *and* on every repeat), and `settings.ts`'s project compress (`${p.id}-c${i}`, on repeat).
`verify-take-ids.ts` reproduces the old collision before proving the new scheme does not, because a
uniqueness test that never saw the bug proves nothing about it.

## Zoom is suppressed four ways, and it takes all four

Reported from an iPhone: double-tapping any section zooms, and an interface made of swipe targets
is unnavigable zoomed.

- **`touch-action: manipulation` on `html, body`** is the only one iOS honours — it has ignored
  `user-scalable=no` since iOS 10. Touch-action is not inherited, but the browser intersects the
  values from the touched element up through its ancestors, so this covers every descendant and
  the tiles' `touch-action: none` still wins, `none` being the stricter value.
- **The viewport meta** (`maximum-scale=1, user-scalable=no`) for every browser that is not iOS.
- **A 16px floor on text inputs.** iOS zooms the viewport when a field smaller than that takes
  focus and does not zoom back out. `.setting-name` was 15px.
- **`preventDefault` on Safari's `gesture*` events** in `app.ts`, for pinch, which CSS cannot
  reach. `passive: false` is required — a passive listener may not call `preventDefault`, and the
  default for touch-adjacent events is passive, so omitting it looks right and does nothing.

Whole-app rules, not per-element: the report was "throughout the app", and a list of elements is a
list to keep in sync with the markup. **This costs pinch-zoom as an accessibility affordance** —
a fixed-height gesture layout breaks when zoomed rather than helping, but it is a trade.

## `LR_HTTP=1` forces the dev server to plain HTTP

`Tools/serve.js` speaks HTTPS whenever `Tools/certs/` holds a pair, which a phone needs
(`getUserMedia` and `AudioWorklet` are secure-context only and a LAN IP is not one). Tools that
drive the page for verification refuse a self-signed certificate, and `localhost` is a secure
context over HTTP anyway — so the flag exists rather than deleting and re-issuing certificates
around every check.
