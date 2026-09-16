/**
 * Assemble the deployable web app: `app/www/`. GitHub Pages publishes it
 * (`.github/workflows/pages.yml`), and the parked iOS shell uses it as Capacitor's `webDir`.
 *
 * **The same files at the same relative positions the dev server serves**, and nothing rewritten.
 * Every URL the app loads is relative — `ui/index.html` reaches `../docs/kit/…`, the recorder and the
 * service worker resolve against their own modules — so the tree works at a site root or under
 * Pages' `/<repo>/` subfolder alike. A bundler would mean a second build of the app that could drift
 * from the one `npm run ui` tests, which is the thing this avoids.
 *
 * Run `npm run build:ui` first — `npm run build:app` does both.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'app', 'www');

/** Everything the page loads, and nothing else. */
const COPY = [
  'ui/index.html',
  'ui/app.css',
  'ui/sw.js',
  'ui/manifest.webmanifest',
  'ui/icons',
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
    // The browser instruments are development tools; they stay out of the published app.
    filter: (src) => !/[\\/]verify-[^\\/]*$/.test(src),
  });
}

// The site root opens `index.html`. A redirect rather than a copy, so the page still lives at
// ui/index.html and every relative URL in it resolves the way it does on the dev server. Relative,
// or it would leave Pages' subfolder; the `<meta>` covers a browser with scripts blocked.
writeFileSync(
  join(OUT, 'index.html'),
  '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=ui/index.html">' +
    '<script>location.replace("ui/index.html")</script>\n',
);
// Pages runs Jekyll by default, which drops any path beginning with an underscore. Nothing here has
// one today; this keeps it from mattering the day something does.
writeFileSync(join(OUT, '.nojekyll'), '');

console.log(`app/www assembled from ${COPY.length} entries`);
