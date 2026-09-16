/**
 * Assemble the web app the iOS shell ships: `app/www/`, Capacitor's `webDir`.
 *
 * **The same files at the same paths the dev server serves**, and nothing rewritten. `ui/index.html`
 * loads `/docs/kit/…` and `/ui/dist/…` by absolute path and the recorder fetches
 * `/ui/worklets/capture.js`; Capacitor serves `webDir` as the origin root, so copying the tree as it
 * stands keeps every one of those URLs valid. A bundler would mean a second build of the app that
 * could drift from the one `npm run ui` tests, which is the thing this avoids.
 *
 * Run `npm run build:ui` first — `npm run build:app` does both.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'app', 'www');

/** Everything the page loads, and nothing else — no verify pages, no source maps' sources. */
const COPY = [
  'ui/index.html',
  'ui/app.css',
  'ui/worklets',
  'ui/dist',
  'docs/kit/lr-kit.js',
  'docs/kit/lr-kit.css',
];

if (!existsSync(join(ROOT, 'ui/dist/ui/src/app.js'))) {
  console.error('ui/dist is missing — run `npm run build:ui` first.');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
for (const path of COPY) {
  const to = join(OUT, path);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(ROOT, path), to, {
    recursive: true,
    // The browser instruments are development tools; they stay out of the app.
    filter: (src) => !/[\\/]verify-[^\\/]*$/.test(src),
  });
}

// Capacitor opens `webDir/index.html`. A redirect rather than a copy, so the page still lives at
// /ui/index.html and every relative assumption the dev server makes holds here too.
writeFileSync(
  join(OUT, 'index.html'),
  '<!doctype html><meta charset="utf-8"><script>location.replace("/ui/index.html")</script>\n',
);

console.log(`app/www assembled from ${COPY.length} entries`);
