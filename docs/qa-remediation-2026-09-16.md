# QA remediation, 2026-09-16 — what landed overnight

Branch **`qa/unblocked-remediation`**, sixteen commits off `54342b2`. Every commit is one item with
its evidence in the message, so anything here is a single `git revert` away.

`npm run check` green throughout: **379 tests, 378 passing, 0 failing, 1 todo** — the todo is a real
defect, deliberately left failing, described below. All nine browser instruments pass.

The scope was "all unblocked items": everything in the remediation plan that did not need one of the
decisions it flagged as yours.

---

## What is done

### Phase 1 — things that destroy or fabricate user data (all five)

| Ref | What | Evidence |
|---|---|---|
| `G1` | The tempo lock was CSS-only and bypassable | Keyboard-driving the locked slider held 96 BPM; bars and quality held both value *and* highlight |
| `F0` | Previews played another project's recordings | `newModeStillHoldsDonorAudio: ["donor-take-1"]` before, `[]` after |
| `F2` | A dead microphone armed and recorded silence | `readyState === 'live'` rather than object existence |
| `G7` | A reload mid-take destroyed the performance | `beforeunload` on the same predicate `navigate` asks |
| new | The dev server served `.git/` | `/.git/config` 403, `/ui/index.html` still 200 |

### Phase 2 — the net

- **2.1 the scheduling hook.** `engine.onSchedule` reports every onset it commits — drum voice,
  chord frequency, or a layer segment carrying the **session id**, which is what says *whose*
  recording it is. The audit harness had been monkeypatching `OscillatorNode.prototype.start` from
  outside, which sees voices it did not cause and had two measurements retracted.
- **2.2 composition tests** (`tests/composition.test.ts`) — record → bounce → overdub, record →
  compress → record again, bounce of a bounce. The category with no coverage at all, and the one
  that produced the worst findings.
- **2.3 `verify-lifecycle.ts`** — a screen mounted against a stand-in engine that records what it is
  told and *holds* it, preloaded the way the shell leaves it after a navigation. Covers F0, F1, F4,
  F8, F9.
- **2.4 `tests/invariants.test.ts`** — seeded random sequences of the real edit operations, asserting
  the same properties after every step.
- **`verify-ramps.ts`** — measures the worst sample-to-sample step a live control puts in the signal.

### Phase 3 — the rest of the audit, minus G2

`F1` count-in window outliving its take · `F4` mute not rescheduling · `F5` layer mute cutting the
signal dead · `F7` compress never reaching the engine · `F8`/`F9` destroy not terminal and the
microphone never released · `F10` layer segments never swept · `F11` live peak carrying between
takes · `F12` a mid-bar seek playing no layers · `F13` two capture races · `G3` backing faders
stepping · `G5` the sample rate never checked · `G6` the storage banner only Playback could see.

### Phase 6b — documentation that described a world that no longer exists

CLAUDE.md contradicting itself about EQ; four sections pointing at an emptied §6.1; two stale "not
yet addressed" notes; §6.2 claiming the manual is structure only. Plus §5.1 #7 amended, which was
your decision B.

---

## The three things I did *not* do as asked, and why

**1. `G4` — ramping the EQ coefficients. Built, measured, reverted.** The audit asked for `setEq` to
use the `ramp()` its own file defines. It made the transition **worse**: the worst sample step on a
preset change went from 1.00× the untouched render to **1.59×**. A biquad is not a gain — `type`
cannot be interpolated, so it switches instantly either way, and ramping `frequency` then sweeps the
corner of an already-switched filter across the signal. The assignment stays, with the measurement
written above it.

**2. `F14` — "Export previews the project rather than the export". Could not be confirmed.** The
audit flagged it as read rather than driven. An `ExportSelection` chooses which *files* come out, not
which audio sounds, and the one setting that changes how a loop sounds — Perfect loop — is the case a
live preview needs nothing for. Logged in `docs/backlog.md` with what would make it real.

**3. The seven over-exported helpers — four of seven.** `PEAK_FRAMES`,
`PEAK_DISPLAY_EXPONENT` and `HAAS_DIVISION_BEATS` stay exported: they are constants that *name a
decision* rather than helpers that do work, which is what a test or a doc has reason to reference.

---

## Found while working, not on the audit's list

**A horizontal step can strand a slot on a pass that bar does not have.** Found by the invariants
suite on its first run, seed 1337. One step off P3 / bar 8 lands on P3 / bar 9, and bar 9 does not
have pass 3 — §1.4's worked example has a partial pass covering bars 1–8 only. The tile draws blank
and Compress refuses the whole project with a message about damage, for a state reached by swiping.

It is **recoverable** — a vertical swipe lands on P4 — so it is a blank tile rather than a trap, and
it is left as the **one failing `todo`** holding the exact reproduction. Fixing it changes what one
horizontal swipe does, which is a question for someone who has used the screen. `docs/backlog.md` #2
has the options.

---

## Three instruments were wrong before they were right

Worth recording, because each one would have shipped a false result.

1. **`verify-ramps` measured nothing.** It made its change before `await startRendering()` — but an
   `OfflineAudioContext` does not advance until then, so the mutation landed at time zero and the
   layer was disconnected before a single sample existed. It reported a worst step of **0** for a
   layer mute and called it a pass. Caught by running it against the *unfixed* code and getting a
   better number than the fixed code gave. `ctx.suspend(t)` is the right tool.
2. **The count-in probe passed for the wrong reason.** It looked for chord onsets in a default
   project — and `defaultBacking()` starts with chords **muted**, so there were none either way.
3. **`verify-lifecycle`'s first draft named the wrong mechanism.** It reported F0 as "the screen
   pushes nothing", which was true and not the failure: the engine is stateful and survives the
   navigation still loaded with the project you came from.

Every fix in this branch was checked **both ways** — against the unfixed code as well as the fixed —
because a test that passes before the fix proves nothing about it. That is the repo's own rule, from
`verify-take-ids.ts`.

---

## Decisions, taken the same day

| # | Decision | Outcome |
|---|---|---|
| 1 | The bounce latency model (`F15`) | **Held** for backlog #4 — a bounce as a backing track, which removes the problem rather than flagging around it. Not built. |
| 3 | A headless browser in `npm run check` | **A page instead**: `/ui/verify.html` runs every instrument. Its first run caught a race in `verify-capture` itself. |
| 4 | The 16px floor vs the layer name (`G2`) | **Fewer characters**: one 16px rule for every text field, `contenteditable` included. |
| 5 | Migration policy | **Default on load, compiler-enforced**: `src/domain/migrate.ts`. |
| 6 | §2.2's audio session category | **Built behind a Session setting, off by default**, for a device pass comparing both. |
| 7 | Waveform scaling | **Playback lanes only**, by level. §6.1 row density is still open — it needs the mockups. |
| — | The stranded slot (backlog #2) | **A partial pass is as long as the recording got**: the horizontal axis wraps through the bars a pass has. The `todo` is now passing tests. |
| — | Merging this branch | **Not yet** — kept on `qa/unblocked-remediation`. |

**One piece of new evidence for #3.** Running all nine instruments back to back in one page gave a
spurious failure — several hold live `AudioContext`s and they contend. Spaced 400 ms apart, all nine
pass. If they are ever automated, they need to run in isolation or share one context; that is a real
cost of automating them, and it was not visible while they were run by hand one at a time.

---

## Next on the device

`docs/device-check.md` §1 is still the one that "decides everything". Two things in this branch
change what to look for:

- **`F9` was leaking a live `MediaStream` per arm-after-navigation.** A live capture track holds the
  iOS audio session in a record category — a routing variable nobody was controlling for during the
  Ring/Silent investigation, and one that sits directly on top of §1's output-routing question.
- **`F10`'s unbounded segment list** made the long-session case worth a deliberate soak. Measured at
  8 sources created and **0 released** over six bars before the fix.
