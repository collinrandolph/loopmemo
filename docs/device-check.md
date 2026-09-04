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

## Setup

**No apps to install, on either device.** Everything below uses Safari and Settings, both built in.
Nothing is downloaded from the internet and nothing leaves the local network.

Both devices must be on **the same Wi-Fi**. If the PC is on Ethernet and the iPad on Wi-Fi that is
still fine, as long as it is one network.

### Why any of this is needed

`getUserMedia` and `AudioWorklet` are **secure-context only**, and `http://192.168.x.x` is not a
secure context. Over plain HTTP the app loads, looks completely normal, and then refuses to arm —
which reads as a bug in the app rather than a property of the URL. So the local server has to speak
HTTPS, and a certificate it issues itself has to be trusted once by the iPad.

### On the PC — twice, then leave it running

```bash
bash Tools/make-cert.sh
```

Once, ever. Writes a certificate for this machine's LAN address, good for a year. Re-run it if the
PC's IP changes — the certificate names a specific address and WebKit checks it.

```bash
npm run ui
```

Leave this running for the whole session. It prints two URLs; you need both:

```
  on this network: https://192.168.0.104:5173     ← the app
On the iPhone or iPad, FIRST open:
  http://192.168.0.104:5174   (plain http — this is the certificate)
```

**If Windows Firewall prompts about Node, allow it on Private networks.** If no prompt appears and
the iPad cannot reach either URL, that is the first thing to check — the server is running fine and
the packets are being dropped before they arrive.

### On the iPad — five taps, in two different Settings screens

Open **`http://192.168.0.104:5174`** in Safari. Plain `http`, and the second port. That page exists
only to hand over the certificate, and it repeats these steps on screen.

1. Tap **Download the certificate**, and allow the download.
2. **Settings → General → VPN & Device Management** → tap the downloaded profile → **Install**.
3. **Settings → General → About → Certificate Trust Settings** → switch it on.

**Step 3 is a different screen from step 2, and skipping it is the usual failure.** It does not
appear at all until step 2 is done, and its absence looks identical to the certificate simply not
working. If Safari still refuses after all three, you are probably not on step 3.

Then open **`https://192.168.0.104:5173`** — the app.

Optionally **Share → Add to Home Screen**. Worth doing: iOS treats an installed web app differently
from a tab for storage, and §2 below is partly about exactly that.

### Why the certificate comes over plain HTTP

Because otherwise it is a loop — the certificate has to be trusted before the HTTPS server will
load, and the certificate is on the HTTPS server. The usual way out is mailing the file to
yourself, which drags a mail client and an account into a local-network test.

That helper serves the certificate and nothing else. A certificate is public by definition — it is
what every browser on the network is about to be shown — so there is nothing to give away. **The
private key is served by neither listener**, which needed saying in code: the document root is the
repo root, so the moment this server learned to speak HTTPS, `/Tools/certs/dev-key.pem` was a live
URL. It is now 403 on both ports.

### If the trust flow goes wrong anyway

Any HTTPS tunnel to `localhost:5173` — `cloudflared tunnel --url`, `npx localtunnel --port 5173` —
gives a publicly-trusted URL and skips all of it. That does need an external tool, it is slower,
and it puts the app on the public internet for the duration. It is the fallback, not the plan.

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

- [x] **Wired headphones with a microphone** (the common case). **Run 2026-09-04 on an iPhone:
      output stayed in the headphones.** The bug did not occur on the configuration most likely to
      trigger it, which is what keeps this route alive. iOS picked the headset microphone with no
      way to choose another; the Recording offset absorbed the route's latency, which is also the
      first confirmation that control works on hardware.
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
