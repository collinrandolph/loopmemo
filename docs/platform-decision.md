# Platform decision — research and recommendations

**Status: DECIDED 2026-09-16 for the first iPhone build — see §9.** The research below is kept as
the record of why, and §7's ranking predates the route that was chosen.

Researched 2026-08-29, revisited 2026-08-31. The decision was deferred as far into the build as
possible; this document exists so it could be made on evidence rather than re-researched.

**The 08-31 pass changed three things and the reader should know which.** Drum synthesis
replaced sampled loops, which deletes the time-stretch requirement (§4) and one of the six
device checks (§8) — and adds a different set, because synthesis needs oscillators, a shaper
and a compressor that sampling did not. The domain layer is now TypeScript rather than Swift.
And `ui/src/audio.ts` is a working Web Audio implementation of the backing tracks, which turns
"the port should be straightforward" into something with code behind it (§4a).

Nothing here overrides `audio-loop-recorder-spec.md`. The spec describes *what the app does*
and is platform-neutral in everything that matters. This document is only about *where it
runs and how it gets built*.

---

## 1. The constraint

Development is on Windows. **A Mac is not a realistic option**, now or later.

That rules out, permanently and regardless of effort:

- Xcode, and therefore local iOS builds, the iOS Simulator, and free "Personal Team" signing
- Any local compilation of AVFoundation code

It does **not** rule out shipping an iOS app. See §3.

## 2. What keeps this decision deferrable

This is the actionable part, and it costs something on every commit.

**Keep everything decidable without audio hardware in a platform-neutral layer**, and keep the
platform-specific layer thin enough to rewrite in a day. Concretely, none of the following
care about the answer, and none of them should be allowed to start caring:

| Stays neutral | Why it can |
|---|---|
| `BarRef`, bar identity, the two axes | integer arithmetic |
| `Timing` — frames per bar, loop frames, tolerance | integer arithmetic |
| `PassIndex` — pass numbering, availability, region lookup | derived from frame counts alone |
| `SchedulePlan` — what plays when, splice entry points | produces plain data |
| Arrangement editing, compress, bounce, size projection | pure transformations |
| Every rule in spec Parts 1, 5 and most of 3 | design, not implementation |

What is genuinely platform-bound is small: opening an audio file, scheduling a buffer at a
time, reading input, and measuring latency. That is the seam. **If the platform-bound surface
starts growing, the deferral is failing** — that is the signal to stop and decide.

This layer has now been expressed in two languages without the design changing, which is the
evidence that it is portable. It was Swift in `Sources/LoopRecorderCore/`; it is TypeScript in
`src/domain/`, and the Swift was deleted at `349d15b` rather than kept alongside, because two
implementations of one domain is precisely the drift the spec warns about in §1.5. `Tools/*.js`
still cross-checks the timing rules against `docs/kit/lr-kit.js`, so a third expression of the
same arithmetic is executed on every `npm run check`.

**The language change shrank the seam rather than moving it.** Swift fits only the route that
needs the Mac that does not exist. TypeScript runs unchanged in Node, in a browser and in React
Native, so for three of the four routes in §7 the domain is not ported at all — it is imported.
"Thin enough to rewrite in a day" now applies only to the audio layer itself.

## 3. Verified: Expo + EAS Build removes the Mac requirement

iOS builds run on macOS runners in Expo's cloud; builds can be created from any OS. Only
*local* builds (`--local`) require macOS or Linux, and those are not needed.

So the shape of a viable stack is **React Native + Expo, built via EAS from Windows.**

## 4. Verified: `expo-audio` cannot build this app; `react-native-audio-api` can

`expo-audio` and the deprecated `expo-av` are media playback libraries — play, pause, seek,
volume. This app needs an audio *engine*: "play frames 3,528,000–3,638,250 of that file,
exactly 2.5 s from now, crossfaded into what is already sounding, against a clock seven
layers share." `expo-audio` has no vocabulary for that, and never exposes PCM.

**`react-native-audio-api`** (Software Mansion — Reanimated, Gesture Handler) is a Web Audio
API implementation for React Native, native C++ underneath. It maps onto the spec closely:

| Spec requirement | API | Verified |
|---|---|---|
| Segment scheduling (§2.4) | `AudioBufferSourceNode.start(when, offset, duration)` | ✅ three args, documented |
| One shared anchor (§0.4, §2.4) | `AudioContext.currentTime` | ✅ |
| Equal-power crossfade (§2.4) | `GainNode` ramps | ✅ |
| EQ presets (§2.8) | `BiquadFilterNode` | ✅ |
| Pan presets (§2.8) | `StereoPannerNode` | ✅ |
| PCM capture (§4.2) | `AudioRecorder.onAudioReady` — float PCM, configurable `sampleRate`, `bufferLength`, `channelCount` | ✅ |
| Capture to CAF/WAV (§2.7) | `AudioRecorder.enableFileOutput()` — WAV, **CAF**, M4A, FLAC | ✅ |
| Haas delay on Pan presets (§2.8) | `DelayNode` | ✅ documented |
| Backing voices — pitched (§2.6) | `OscillatorNode`, sine/square/triangle/sawtooth, `detune` | ✅ documented |
| Backing voices — noise (§2.6) | `createBuffer` + `getChannelData`, `BufferSource` | ✅ documented |
| Wurly reed saturation (§2.6) | `WaveShaperNode`, `oversample` | ✅ documented |
| Tremolo on Rhodes and Wurly (§2.6) | oscillator connected **into a `GainNode.gain`** | ⚠️ see below |
| The backing bus (§2.6) | `DynamicsCompressorNode` | ❌ see below |
| Export to WAV (§2.7) | written by hand — a 44-byte header and PCM | ✅ |
| Export to MP3 (§2.7) | — | ❌ **not in a browser** — see below |
| Latency compensation (§2.3) | — | ❌ see §5 |

`start(when, offset, duration)` is the important one. It is effectively `scheduleSegment`,
which means §2.4's whole architecture — segment-scheduled playback, never a rendered file —
survives the port intact.

**Time-stretch is no longer a requirement at all.** It was the one ⚠️ in this table — a phase
vocoder to fit a sampled drum loop to the project tempo, needing confirmation by ear that
`playbackRate` 0.75 did not drop the pitch. Synthesis deleted the requirement rather than
answering it (§5.2), and with it the ratio, the 0.5–2.0× limit, the quality warning and the
sample-licensing question. That is the single largest reduction in platform risk since this
document was written.

**What synthesis added instead.** Two gaps, one of them real.

`DynamicsCompressorNode` is **absent** — not in `BaseAudioContext`'s factory list and not among
the documented effect nodes. It is not a nicety here: `ui/src/audio.ts` routes every voice
through one because a dense chord pattern easily has a dozen oscillators sounding at once, and
summed straight to the destination that clips, which is an arrhythmic screech rather than a
quiet distortion. Two mitigations, both cheap. A `tanh` soft-clip `WaveShaperNode` is already
proven in this codebase — it is what gives the Wurly its reed growl — and bounded soft clipping
on the bus is arguably better behaved than a compressor for this material. Failing that,
`createWorkletProcessingNode` exists, so a compressor can be written rather than found.

Audio-rate modulation — connecting an oscillator's output **into an `AudioParam`** — is
**undocumented**, neither confirmed nor denied. The tremolo depends on it: a gain stage in
series oscillating around 1, which is the multiplicative form, and the additive alternative
reads as a stutter rather than tremolo because a fixed depth dwarfs the signal exactly as the
note decays. If the connection is unsupported, `setValueCurveAtTime` can approximate it on a
schedule. **Check this on a device**; it is a two-line test.

**Setup:** an Expo config plugin handles microphone permission and background audio. It ships
native code, so it needs an Expo **development build**, not Expo Go. This matters for §6 —
Expo Go would have been the one no-account route onto an iPhone, and this library closes it.

**Maturity risk:** v0.13.3 as of 2026-08-29, published the previous day. Very actively
developed by a serious team, but pre-1.0. Pin the version; expect API churn.

**MP3 export is the one place the browser build cannot follow the spec.** Measured rather than
assumed: `AudioEncoder.isConfigSupported` reports `mp3` unsupported in Chrome while offering AAC
(`mp4a.40.2`) and Opus, and this repo carries no runtime dependencies, so a LAME-class encoder is
not available either. §2.7's format list is unchanged — a native platform has MP3, and
`react-native-audio-api`'s recorder writes M4A among others — and `ui/` refuses the format in the
build that cannot honour it, showing it struck through rather than removing it. **The one thing
never to do is write a WAV with an `.mp3` name.**

Two capabilities the browser has that are worth recording, because both removed a dependency:
`CompressionStream('deflate-raw')` is exactly the codec ZIP wants, so a multi-file export needs
no archive library, and `showSaveFilePicker` gives a real Save dialog with a fallback to an
`<a download>` click.

## 4a. The port is no longer hypothetical

`ui/src/audio.ts` synthesises both backing tracks in the browser, against the real
`src/domain` schedule, and it is Web Audio. `react-native-audio-api` is Web Audio. So the
question "will this port" has stopped being an argument about API tables and become a diff.

Everything it uses is documented as present except the two gaps above:
`createGain`, `createOscillator`, `createBiquadFilter`, `createBufferSource`, `createBuffer`,
`createWaveShaper`, `setValueAtTime`, `linearRampToValueAtTime`, `exponentialRampToValueAtTime`,
`currentTime` and `sampleRate`.

**This cuts both ways, and that is the point of raising it.** It is the strongest evidence yet
that the React Native route works — and it is also the first platform-bound code in the repo
that is not obviously disposable. §2 says the signal to stop deferring is the platform-bound
surface growing. It has grown, in the one direction that was sanctioned (`ui/` was always
browser-specific), and the growth is now valuable enough that the choice of platform decides
whether it is an asset or a throwaway. Deferring used to be free. It is not any more.

## 5. The one real gap: no I/O latency API

`AudioContext` exposes `currentTime` and `sampleRate` but **not `baseLatency` or
`outputLatency`**. `AudioRecorder` reports nothing. `getLatency()` covers only the
pitch-correction algorithm's own delay, not the input/output round trip.

§2.3 calls latency compensation mandatory, and it is — the user hears the backing late, plays
in time with what they hear, and the pass lands late, compounding across seven layers.

**The answer is loopback calibration, and it is arguably better than what the spec specifies.**
Play a click, record it, correlate to find the offset. That measures the *actual* round trip —
buffers, drivers, Bluetooth, the speaker-to-mic acoustic path — rather than an estimate of it.
Run it once per route, store the result, re-run on route change (which §2.3 already requires
detecting). Input buffering is directly controllable via `AudioRecorder`'s `bufferLength`.

§2.3's formula `outputLatency + inputLatency + ioBufferDuration` was always AVFoundation-
specific. **The requirement survives; only the mechanism changes.** Treat the spec's formula
as one implementation of "measure the latency", not as the definition.

## 6. The Apple Developer account ($99/yr)

**There is no practical free route onto an iPhone from Windows.**

- Free "Personal Team" provisioning is real, but it is an **Xcode** feature — needs a Mac.
- EAS documents simulator builds as the no-membership path; the simulator is macOS-only.
- EAS device builds assume real signing credentials, which need the paid program's portal access.
- **Expo Go** needs no account at all — but `react-native-audio-api` ships native code and is
  not in Expo Go. That door is closed by the library choice.
- **Sideloadly / AltStore** sign an IPA on Windows with a free Apple ID, but producing an
  unsigned device IPA from EAS is not a supported flow, and free-ID sideloading means
  **7-day expiry, weekly re-signing, 3 apps maximum**.

### Tested on an iPhone, 2026-09-04: the routing bug did not occur

**With wired headphones that have a microphone**, playing the loop and recording kept output in
the headphones. The failure described below did not happen, on the exact configuration most likely
to trigger it.

That is the single result this document was most waiting on, and it keeps route 1 alive. Read it
narrowly: one handset, one iOS version, one headset, wired. The other routes in
`docs/device-check.md` §1 — no-mic headphones, Bluetooth, USB-C — are still unrun, and Bluetooth
is the one still expected to misbehave, since recording typically forces the HFP profile.

Also observed: **iOS chooses the headset microphone with no way to pick another**, and the app
offers no input picker either (none is in the spec). Not a blocker — §2.3's *Recording offset*
absorbs the route's latency, and it was reported as sufficient in use, which is the first
confirmation that the control works on hardware at all.

Two defects surfaced, both fixed and neither about audio routing: double-tap zoom made a
gesture-driven interface unnavigable, and take ids collided across projects. See §8 #7.

### The PWA route has a flaw specific to this app

Worth recording because "free, no account, no signing, no expiry" is genuinely attractive and
the reason it fails is non-obvious.

`getUserMedia` and Web Audio do work in iOS Safari (`AudioContext` must be created or resumed
inside a user gesture — fine, the app has a play button). But there is a known iOS Safari
behaviour: **with headphones that have a microphone connected, granting mic permission and
starting to record flips audio output to the built-in speaker.**

For most recording apps that is an annoyance. Here it is fatal. §2.2 and §4.7 are explicit
that headphones are the point — under speaker monitoring the drum loop and every previous
layer bleed into the new one, **compounding with every layer**. An app whose entire premise is
stacking overdubs cannot have the OS force speaker output at the moment of recording.

It may be avoidable with headphones that have no mic (the spec's ideal configuration anyway),
but it is a fragile foundation. **Test on a real device before betting anything on the web.**

**`docs/device-check.md` is that test**, and running it costs nothing. `Tools/make-cert.sh` plus
`npm run ui` serves the existing build over HTTPS on the local network — required rather than
tidy, since `getUserMedia` and `AudioWorklet` are secure-context only and a LAN IP is not one.
The checklist covers the routing bug across four output routes, iOS storage eviction, the
real-time half of §8, and the visual judgements that have only ever been made on a desktop.

**What makes this worth doing now rather than when this document was written:** `ui/` was a probe
then and is a whole app now — library, recording, editing, compress, bounce, export, persistence.
The session tests the product rather than a toy, and it settles route 1 either way.

### Android costs nothing, and that is the deferral

EAS builds an Android APK with **no developer account**; install it directly, no expiry, no
re-signing. Google Play is $25 one-time and only if publishing.

`react-native-audio-api` is cross-platform. So the entire app — audio engine, sample-accurate
scheduling, latency calibration, gestures, the Edit Layer grid — can be built and validated on
Android from Windows, with Apple's $99 paid only when it specifically needs to be on an iPhone.

The catch is needing a physical Android device. The emulator runs on Windows but its audio
latency is bad enough to be useless for judging the thing that actually matters here. A cheap
used Android costs less than one year of Apple's fee.

## 7. Options, ranked

| | Route | Cost | Trade |
|---|---|---|---|
| 1 | **Android device first, iOS later** | ~$0 + a used handset | Defers $99 behind real progress; everything transfers |
| 2 | **Pay the $99 now** | $99/yr | Cleanest. TestFlight removes the 7-day problem entirely |
| 3 | **Free Apple ID + Sideloadly** | $0 | Weekly re-signing, 3-app cap, unsupported build path |
| 4 | **PWA** | $0 | Instant and free, but §6's routing bug may rule it out outright |

## 8. Still unverified — needs a physical device

In rough priority order. The first two decide whether the architecture holds at all.

1. ~~**Sample-accurate joins.**~~ **Answered 2026-08-31, on this machine, with no device.**
   `OfflineAudioContext` renders the same graph faster than real time into a buffer that can be
   read sample by sample, so this became a measurement rather than a listening test.
   `ui/src/verify-joins.ts` is the harness; run it from the browser console.

   Rendering `segments()` through `AudioBufferSourceNode.start(when, offset, duration)` against
   one anchor reproduces the source **bit-identically** — worst absolute difference 0, not
   "small", both for an arrangement in recorded order and for one that jumps between passes and
   bars. A muted slot renders as exactly one bar of silence with the bars after it unmoved.
   §2.4 survives, and so does §1.1's whole premise that a slot can carry any source.

   The 7 ms equal-power crossfade cuts the worst single-sample step at a join by **393×**, from
   2.0 to 0.005 on a full-scale ramp. It also surfaced a real defect that only a measurement
   would have caught: **an outgoing segment has no tail to fade when its bar is the last in its
   recording**, so the first implementation cut it dead at the boundary. The fix is to move that
   join's crossfade *before* the boundary and start the incoming segment early on its pre-roll,
   which preserves timing because the offset moves with the start. Where neither exists — a
   recording's last bar into a recording's first — there is no material to fade against at all;
   level through that join measures 0.74 against 1.0 elsewhere, a short dip rather than a click,
   and that is a limit of the material rather than of the API.

   What this does not answer is the real-time half: an offline render has no output device, no
   underruns and no jitter. That still needs hardware, and it is a much smaller question than
   whether the design works.
2. **Loopback calibration accuracy.** ~~Can round-trip latency be measured reliably enough, and
   is it stable across a session?~~ **Demoted 2026-09-01: no longer blocking.** §2.3 now makes the
   compensation a per-project *Recording offset* the user sets by ear, which a platform figure or a
   calibration may seed but never overrides. The deciding argument is that a microphone cannot hear
   headphones, and §2.2 makes headphones the correct setup — so a loopback measures an output route
   nobody records against, and the "correct" number would be wrong for the real case. Calibration
   becomes a convenience worth having on a device, not a thing the app waits for.

   The capture path itself is exact and that part stands: an `AudioWorkletProcessor` stamping
   chunks from the worklet scope's own `currentFrame` returns 72,000 frames of noise
   bit-identically, with nothing missing and the anchor landing on the frame the main thread
   expected (`ui/src/verify-capture.ts`).

   **Compensation, however, was never wired up**, and this document said it was. `Capture.startFrame`
   is computed in `recorder.ts` and read by nothing but its own sign test, so `latencyFrames` has no
   audible effect at any value — the same "computed and then discarded" failure recorded in §5 as
   the first attempt's, repeated. It is being replaced rather than finished: the offset moves to
   playback scheduling and becomes a control, so `latencyFrames` leaves the capture path entirely
   and there is one place it can be applied instead of two.
3. ~~**Simultaneous playback and recording** without the output route collapsing.~~ **Answered
   2026-09-04 on an iPhone, for wired headphones with a microphone: output stayed in the
   headphones.** See §6. Still open for the other three routes, Bluetooth especially. Nothing here
   speaks for native React Native, which is a different engine and a different audio session.
4. **Mid-bar splice** entering at an arbitrary offset, sample-accurately (§2.5).
5. **Fourteen concurrent source nodes** without dropouts.
6. **The two synthesis gaps in §4** — a bus limiter without `DynamicsCompressorNode`, and
   whether an oscillator can be connected into an `AudioParam`.

7. **What the first device session actually found**, recorded because both were invisible on a
   desktop and neither was on this list:

   - **Double-tap zoom.** iOS Safari zooms to a block on double-tap, and this interface is made of
     swipe targets — a zoomed viewport made it unnavigable. Four separate mechanisms were needed:
     `touch-action: manipulation` (the only one iOS honours, since `user-scalable=no` has been
     ignored since iOS 10), the viewport meta for every other browser, a 16px floor on text inputs
     because iOS zooms on focus below that and does not zoom back, and a `gesturestart` guard for
     pinch. Any one alone leaves a way in.
   - **Take ids collided across projects**, which was data loss rather than a display fault — see
     `newTakeId`. A desktop session never hit it because it takes two recorded projects to see.

   The lesson for the next device session is that the untested surface was *platform interaction*,
   not audio. The audio architecture was measured to death and held; what broke was everything
   around it that a desktop browser answers differently.

The `pitchCorrection` check that used to sit at #3 is gone. Synthesis removed the requirement,
so there is nothing left to confirm by ear.

## 9. Decided 2026-09-16: v1 is a Home Screen web app; a native shell is built and parked

**v1 ships as the browser build on GitHub Pages, added to the Home Screen** — §7's route 4, the PWA
(`docs/hosting.md`). The same day, a native shell was built first and then parked; both halves of
that are recorded below, because the shell is the path v2 takes if the web app runs out.

**Why the web app won for v1.** Sideloading with a personal Apple ID means a free provisioning
profile, which expires every 7 days, and avoiding that costs the $99 program. The concern that
motivated a native app was locking down gestures, and **a Home Screen web app removes nearly all of
the ones that come from Safari** — the address bar and its tab swipe, pull-to-reload, the page
resizing as the bar collapses — leaving only the system's bottom-edge swipe, which a native app can
merely defer. The remaining page-level gestures (the long-press callout, overscroll bounce) are CSS
and apply in every mode. §6's routing flaw, the reason route 4 was ranked last, was tested on this
iPhone on 2026-09-04 and did not occur. And it is the exact build that has been tested, with no
signing, no expiry and no install step per update.

**What it gives up**, each recorded in `docs/hosting.md`: background audio, a system-level audio
session (the Session setting depends on `navigator.audioSession`), deferring the bottom-edge
gesture, and an app whose storage cannot be confused with a Safari tab's.

### The native shell, parked

**Capacitor wrapping `ui/` unchanged**, built unsigned on a GitHub-hosted Mac
(`.github/workflows/ios.yml`, now manual-only) and signed on Windows with Sideloadly. Install steps:
`docs/sideload.md`. **Never built** — the workflow has not run.

**Why this was the native route, when §7 ranked React Native first.** §4a already said the browser build had
stopped being disposable. By now it is the whole product — every screen, recording, editing,
persistence, export — and it is the build that has been tested on this iPhone. React Native would
keep the domain and rewrite every screen, and still leave §4's two library gaps. A shell ships what
exists. It can also answer the Ring/Silent switch better than Safari: a native host owns the audio
session, so the playback category need not depend on `navigator.audioSession`.

**What it does not settle.** §6's routing result was measured in Safari; WKWebView inside an app is a
different host and needs the same test (`docs/sideload.md` §4). §8's real-time questions are
unchanged, being the same Web Audio engine. And the React Native route is not closed: `src/domain`
is still pure, and `ui/src/audio.ts` is still the reference a port would translate.

**Signing.** Unsigned in CI, so no Apple credentials live in the repo and the same `.ipa` works with
a free Apple ID (7-day expiry — weekly re-sign, or SideStore's on-device refresh) or a paid account
(one year). A free Apple ID cannot sign anything that lasts longer than 7 days; that is Apple's limit.

**What §2's rule becomes.** Keep the platform-bound surface small, now with a named platform: `ios/`
stays a shell. Anything the app needs from iOS that the web layer cannot reach — the audio session
is the likely first — is a small Capacitor plugin, and `ui/` must keep running in a plain browser,
because that is where it is driven and measured.

## Sources

Retrieved 2026-08-29.

- [EAS Build introduction](https://docs.expo.dev/build/introduction/) · [setup](https://docs.expo.dev/build/setup/) · [iOS build process](https://docs.expo.dev/build-reference/ios-builds/) · [local builds](https://docs.expo.dev/build-reference/local-builds/)
- [react-native-audio-api: AudioBufferSourceNode](https://docs.swmansion.com/react-native-audio-api/docs/sources/audio-buffer-source-node) · [AudioBufferBaseSourceNode](https://docs.swmansion.com/react-native-audio-api/docs/sources/audio-buffer-base-source-node) · [AudioRecorder](https://docs.swmansion.com/react-native-audio-api/docs/inputs/audio-recorder/) · [BaseAudioContext](https://docs.swmansion.com/react-native-audio-api/docs/core/base-audio-context) · [Expo plugin](https://docs.swmansion.com/react-native-audio-api/docs/other/audio-api-plugin/)
- [Dev builds without the Apple Developer Program](https://yvainee.com/blog/create-development-builds-without-an-Apple-Developer-Program)
- [AltStore on Windows](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows)
- [PWA iOS limitations and Safari support](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)
- [iOS Safari forces speaker output with getUserMedia](https://medium.com/@python-javascript-php-html-css/ios-safari-forces-audio-output-to-speakers-when-using-getusermedia-2615196be6fe)
