# On-device check — iPhone or iPad Pro, over Safari

**What this session is for.** `docs/platform-decision.md` §7 ranks four routes onto an iOS device.
Route 1 — the browser build you already have, free, no account, no signing, no expiry — is
attractive enough that it should be settled before anything is paid for. One flaw may kill it
outright (§6), and it is testable in an afternoon.

**The session either hands you a zero-cost route to the device or eliminates it for good.** Both
outcomes are worth having. The second is what justifies the $99.

Everything here is a browser test. It says nothing about `react-native-audio-api`, which is a
different engine with different gaps — see §4 of the platform doc for those.

---

## Before you start

```bash
bash Tools/make-cert.sh
```

Then `npm run ui`. It prints the LAN URL to open on the device.

**HTTPS is not optional and not about secrecy.** `getUserMedia` and `AudioWorklet` are
secure-context only, and `http://192.168.x.x` is not a secure context. Over plain HTTP the app
loads and then simply refuses to arm — which looks like a bug in the app rather than a property of
the URL, and has cost people a day.

### Trusting the certificate on iOS — two steps, in two different screens

Doing only the first is the usual failure, and it fails *silently* by looking like an ordinary
"this connection is not private" warning that no longer goes away.

1. Open the URL on the device. Safari refuses. **Download** the certificate when offered, or mail
   `Tools/certs/dev-cert.pem` to yourself and open it.
2. **Settings → General → VPN & Device Management → install the profile.**
3. **Settings → General → About → Certificate Trust Settings → enable full trust for it.**
   This screen is separate from step 2 and does not appear until step 2 is done.

Then reload. If Safari still refuses, check `openssl x509 -in Tools/certs/dev-cert.pem -noout -ext
subjectAltName` lists the IP you are actually browsing to — WebKit ignores the Common Name
entirely and matches only on SAN.

**The alternative, if the trust dance goes wrong:** any HTTPS tunnel to `localhost:5173`
(`cloudflared tunnel --url`, `npx localtunnel --port 5173`) gives a publicly-trusted URL and skips
all of the above. Slower, and it puts the app on the public internet for the duration.

---

## 1. The one that decides everything — output routing while recording

**This is the flaw that may rule the web route out.** On iOS Safari there is a known behaviour:
with a headset connected, granting microphone permission and starting to record **flips audio
output to the built-in speaker**.

For most recording apps that is an annoyance. Here it is fatal. §2.2 makes headphones the premise:
under speaker monitoring the drum track and every previous layer bleed into the new one, and it
**compounds with every layer**. An overdub app cannot have the OS force speaker output at the
moment of recording.

Test it in this order, because the answers differ and the difference matters:

- [ ] **Wired headphones with a microphone** (the common case). Play the loop, arm a layer, record.
      Does the backing stay in the headphones, or jump to the speaker?
- [ ] **Wired headphones without a microphone.** §2.2's ideal configuration anyway. The bug may be
      specific to a headset that offers an input route.
- [ ] **Bluetooth headphones.** Expect the worst here — recording typically forces the HFP profile,
      which is 8–16 kHz mono and will sound obviously degraded.
- [ ] **USB-C interface or headphones** (iPad Pro). The most likely route to work, and the one a
      person actually recording would use.

**If it flips on every route, route 1 is dead** and the remaining question is only whether the same
happens in a native shell — where the app can set the audio session category and Safari cannot.
Record which routes you tried; "it didn't work" without the list cannot be acted on.

## 2. Does a take survive?

Persistence is IndexedDB, and iOS is the platform most likely to take it away.

- [ ] Record a take. Reload the page. Is it still there?
- [ ] Add the app to the Home Screen and repeat. Storage rules differ between a tab and an
      installed web app, and this app wants the installed behaviour.
- [ ] Leave it a few days and come back. Safari caps script-writable storage for sites you have not
      interacted with recently — this is the one item that cannot be answered in a single session,
      so start the clock on day one.
- [ ] Fill it up. `ui/src/verify-quota.ts` covers the code path; what is unknown is what iOS
      reports and when. The banner should say *full*, not *unavailable* — the difference is whether
      deleting a project is offered as the fix.

## 3. Does the engine hold in real time?

Everything below has been verified on this machine through `OfflineAudioContext`, which has no
output device, no underruns and no jitter. **That is the half a device answers.**

- [ ] **Playback of a multi-layer arrangement.** Any dropout, crackle or stutter. Fourteen
      concurrent source nodes is the number to reach — seven layers plus backing voices.
- [ ] **Mid-bar splice.** Swipe a tile while the loop plays. The new source should enter within the
      same bar, without a click. `cancelAndHoldAtTime` is what makes the hand-off continuous;
      if WebKit's implementation differs, this is where it shows.
- [ ] **The recording offset.** Play the loop, record a take, then drag Rec Offset while it plays
      until your playing sits on the beat. The control is judged by ear on purpose (§2.3) — this is
      the first chance anyone has had to judge it.
- [ ] **Lock the screen mid-loop, then come back.** Suspension and resumption of the
      `AudioContext`, and whether the transport agrees with the audio afterwards.
- [ ] **Take a phone call, or trigger any interruption.** Does the app recover or wedge?

## 4. Does it read and work under a finger?

Everything visual has been judged in a desktop browser at a phone-sized viewport, which is not the
same as a phone.

- [ ] **The Edit Layer colour ramp.** Tiles pulled from another pass must read as an obvious
      colour jump — that is §1.1's whole feature, and it is the thing a small bright screen in a
      room with light in it could ruin.
- [ ] **The transport colour feather.** Verified numerically across 32,768 played-set states and
      never looked at. Does the trailing edge read as soft against a crisp height edge?
- [ ] **Both swipe axes on a tile.** Vertical must step the pass, not scroll the page. If the page
      scrolls, `touch-action` is not surviving.
- [ ] **Tap-and-hold to mute a bar**, without it being mistaken for a swipe.
- [ ] **The four colourways** in real light. Contrast was measured — every screen clears 3:1 in all
      four — but measured is not seen, and a phone outdoors is the hard case.

## 5. What the browser cannot tell you, so do not try

- **MP3 export.** Not available in any browser; the format is struck through in this build on
      purpose. A native platform has it.
- **The two `react-native-audio-api` gaps** — the missing `DynamicsCompressorNode` and whether an
      oscillator can be connected into an `AudioParam`. Those belong to route 2 and need an Expo
      dev build, not Safari. Web Audio has both, so a browser test proves nothing about them.

---

## Recording the result

Put what you find into `docs/platform-decision.md` §8 and mark the items it answers, the way §8 #1
and #2 were struck through when they stopped being open. The value of that file is that it is
evidence rather than memory; a session whose result lives only in a chat log has to be run again.
