# Hosting and installing v1 — a Home Screen web app

**v1 ships as a web app on GitHub Pages**, added to the iPhone's Home Screen. Decided 2026-09-16 —
`docs/platform-decision.md` §9 has why, and why the native shell in `ios/` is parked rather than
deleted.

## How a change reaches the phone

Push to `main`. `.github/workflows/pages.yml` runs `npm run check` — **a build that fails is never
published** — assembles `app/www/` with `npm run build:app`, and deploys it. The site is
`https://<user>.github.io/<repo>/`.

**One-time setup in the GitHub repo:** Settings → Pages → Source: **GitHub Actions**.

The app picks the new version up the next time it loads with a connection: `ui/sw.js` is network
first, so it never serves an old build while online. An open Home Screen app keeps the code it
launched with until it is closed and reopened — swipe it away in the app switcher to be sure.

## Installing on the iPhone

1. Open the site in **Safari** (not another browser — only Safari can add a full-screen web app).
2. Share → **Add to Home Screen** → Add.
3. **Open it from the Home Screen icon, from then on.** That is what makes it full screen; the same
   site in a Safari tab has an address bar, tab swiping and pull-to-reload.

**Projects live in that Home Screen app, not in Safari.** The two keep separate storage, so a sketch
recorded in a Safari tab is not in the Home Screen app, and vice versa. Deleting the icon deletes its
projects and takes.

## What each mode locks down

| Gesture | Safari tab | Home Screen app |
|---|---|---|
| Address bar swipe between tabs | yes | **gone** |
| Address bar collapsing, resizing the page | yes | **gone** |
| Pull down to reload | yes | **gone** |
| Rubber-band bounce past the end | stopped by `overscroll-behavior` | stopped |
| Long-press menu / selection loupe | stopped by `-webkit-touch-callout` | stopped |
| Double-tap and pinch zoom | stopped (five mechanisms — CLAUDE.md) | stopped |
| Left-edge swipe back | leaves the app if there is history | nothing to go back to |
| **Swipe up from the bottom edge** | **always** | **always** |
| Tap near the bottom brings the toolbar back | yes — the footer keeps 44px clear | no toolbar |

The bottom-edge swipe is iOS's and no web page can defer it. The footer's buttons are kept out of
the bottom band either way: in the Home Screen app by the home indicator's inset, and in a Safari
tab by a 44px reserve, because a tap there restores Safari's collapsed toolbar instead of pressing
the button (reported 2026-09-16). Both are padding *inside* the footer, so Edit Layer's fit-to-screen
measurement still includes them. If taps still bring the toolbar up, `--bottom-reserve` in `app.css`
is the number to raise.

## Storage

- **Home Screen apps are exempt from Safari's 7-day storage eviction.** A Safari tab is not: a site
  not opened for about a week can have its IndexedDB cleared, which here is every take. Use the Home
  Screen app for anything you want to keep.
- `navigator.storage.persist()` is requested at startup (`store.ts`).
- There is no backup. Export is the only copy that leaves the phone.

## Offline

`ui/sw.js` caches the app as it loads, plus the recording worklet up front, so the Home Screen app
opens with no connection after it has been opened once with one. Verified in headless Edge under a
Pages-style subfolder: with the network cut, a reload booted all seven projects and served the
worklet from cache. **Not yet verified on the iPhone**, which is the one that matters.

## Still to check on the device

1. **Full screen from the Home Screen icon**, and the status bar readable over the header.
2. **Recording works in the Home Screen app** — the microphone prompt, and the output-routing test in
   `docs/device-check.md` §1 on both Session settings. The 2026-09-04 result was in a Safari tab.
3. **Nothing at the bottom of a screen is lost under the home indicator.**
4. **It opens in airplane mode** after one online launch.
5. **Projects survive closing the app** from the app switcher and reopening.
