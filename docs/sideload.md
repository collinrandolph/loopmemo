# Getting Loop Recorder onto an iPhone

The app is the browser build in `ui/`, wrapped in a Capacitor iOS shell (`ios/`). There is no Mac, so
a GitHub-hosted Mac builds it and **produces an unsigned `.ipa`**; signing and installing happen on
Windows. Decided 2026-09-16 — see `docs/platform-decision.md` §9.

## 1. Get the build

Every push to `main` runs `.github/workflows/ios.yml`: `npm run check`, assemble `app/www`, sync it
into the Xcode project, build without signing, package `LoopRecorder.ipa`.

GitHub → **Actions** → the latest *iOS unsigned build* → **Artifacts** → `LoopRecorder-ipa`. It
downloads as a zip with the `.ipa` inside, and is kept 30 days. **Run workflow** on the same page
builds without a push.

## 2. Sign and install from Windows — Sideloadly

1. Install [Sideloadly](https://sideloadly.io), plus iTunes and iCloud **from Apple's website**, not
   the Microsoft Store — Sideloadly needs the non-Store drivers.
2. Plug the iPhone in by cable and trust the computer.
3. Drag `LoopRecorder.ipa` into Sideloadly, enter the Apple ID, **Start**.
4. On the iPhone: Settings → General → VPN & Device Management → trust the developer profile.
5. iOS 16 and later: Settings → Privacy & Security → **Developer Mode** on. The phone restarts.

## 3. How long it lasts

| Apple ID | Expires | Limit |
|---|---|---|
| **Free** | **7 days**, then the app will not open until re-signed | 3 sideloaded apps at once |
| **Paid developer account** ($99/yr) | 1 year | none that matter here |

**A free Apple ID cannot produce an app that does not expire.** The 7 days is Apple's limit on free
provisioning, not a limit of any tool. What avoids noticing it:

- **Re-sign weekly** by running step 2 again with the same `.ipa`. **App data survives** re-signing
  over an existing install with the same bundle id (`com.collinrandolph.looprecorder`). Deleting the
  app first deletes every project and take.
- **SideStore** refreshes the 7-day signature on the phone itself, in the background, after a
  one-time setup on the PC. Still a free Apple ID and still the 3-app limit, but no weekly cable.
- **A paid account** is the only route to a signature that outlasts a week.

## 4. What to check first on the device

Everything in `docs/device-check.md` applies, since the app is the same code. Three things are
specific to running inside the app shell rather than Safari, and they come first:

1. **The microphone prompt appears and recording works.** WKWebView grants `getUserMedia` through
   the app's `NSMicrophoneUsageDescription`, and the page is served from `capacitor://localhost`
   rather than HTTPS. If arming refuses as insecure, that scheme is why.
2. **Output routing while recording** (device-check §1), on both Session settings. The app shell is
   a different host from Safari, and the 2026-09-04 routing result was measured in Safari.
3. **Projects survive quitting the app.** IndexedDB in an app shell is the app's own storage rather
   than Safari's — it should be more durable, which is worth confirming rather than assuming.

Fonts load from Google Fonts, so offline the app falls back to the system font. Bundling them is a
follow-up, not a blocker.
