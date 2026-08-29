# Platform decision — research and recommendations

**Status: deliberately OPEN.** Researched 2026-08-29. The decision is being deferred as far
into the build as possible; this document exists so it can be made later on evidence rather
than re-researched from scratch.

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

The existing Swift in `Sources/LoopRecorderCore/` was written to this shape. Its logic was
verified by mirroring it into JavaScript and executing it (`Tools/*.js`), which is itself
evidence the layer is portable — it has already been expressed in two languages without the
design changing.

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
| Drum loop time-stretch (§2.6) | `playbackRate` + `pitchCorrection` | ⚠️ see below |
| Latency compensation (§2.3) | — | ❌ see §5 |

`start(when, offset, duration)` is the important one. It is effectively `scheduleSegment`,
which means §2.4's whole architecture — segment-scheduled playback, never a rendered file —
survives the port intact.

**Time-stretch, probably solved.** `pitchCorrection` is a creation option; when enabled
`getLatency()` returns ~0.06 s and `playbackRate` clamps to ±4. Sixty milliseconds of
algorithmic delay and a rate clamp is the signature of a phase vocoder, i.e. genuine
pitch-preserving stretch. §2.6 only needs 0.5–2.0×, comfortably inside. The docs do not state
the algorithm, so **confirm by ear on a device**. `getLatency()` exists precisely so playback
can be scheduled earlier to compensate, and the docs recommend doing so.

**Setup:** an Expo config plugin handles microphone permission and background audio. It ships
native code, so it needs an Expo **development build**, not Expo Go. This matters for §6 —
Expo Go would have been the one no-account route onto an iPhone, and this library closes it.

**Maturity risk:** v0.13.3 as of 2026-08-29, published the previous day. Very actively
developed by a serious team, but pre-1.0. Pin the version; expect API churn.

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

1. **Sample-accurate joins.** Two `AudioBufferSourceNode`s scheduled back to back against
   `currentTime` — do they join without a gap or a click? If not, §2.4 does not survive and
   everything downstream changes.
2. **Loopback calibration accuracy.** Can round-trip latency be measured reliably enough, and
   is it stable across a session?
3. **`pitchCorrection` is really a time-stretch**, not a resampler — confirm by ear that
   `playbackRate` 0.75 does not drop the pitch of a drum loop.
4. **Mid-bar splice** entering at an arbitrary offset, sample-accurately (§2.5).
5. **Simultaneous playback and recording** without the output route collapsing (the failure
   mode §6 describes for Safari — confirm native RN does not share it).
6. **Fourteen concurrent source nodes** without dropouts.

## Sources

Retrieved 2026-08-29.

- [EAS Build introduction](https://docs.expo.dev/build/introduction/) · [setup](https://docs.expo.dev/build/setup/) · [iOS build process](https://docs.expo.dev/build-reference/ios-builds/) · [local builds](https://docs.expo.dev/build-reference/local-builds/)
- [react-native-audio-api: AudioBufferSourceNode](https://docs.swmansion.com/react-native-audio-api/docs/sources/audio-buffer-source-node) · [AudioBufferBaseSourceNode](https://docs.swmansion.com/react-native-audio-api/docs/sources/audio-buffer-base-source-node) · [AudioRecorder](https://docs.swmansion.com/react-native-audio-api/docs/inputs/audio-recorder/) · [BaseAudioContext](https://docs.swmansion.com/react-native-audio-api/docs/core/base-audio-context) · [Expo plugin](https://docs.swmansion.com/react-native-audio-api/docs/other/audio-api-plugin/)
- [Dev builds without the Apple Developer Program](https://yvainee.com/blog/create-development-builds-without-an-Apple-Developer-Program)
- [AltStore on Windows](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows)
- [PWA iOS limitations and Safari support](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)
- [iOS Safari forces speaker output with getUserMedia](https://medium.com/@python-javascript-php-html-css/ios-safari-forces-audio-output-to-speakers-when-using-getusermedia-2615196be6fe)
