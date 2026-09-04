// Static file server for the UI pass. Serves the repo root so the app can load the design kit
// from docs/kit/ and the compiled domain from ui/dist/ with no copying and no bundler.
//
// Deliberately dependency-free, like everything else here.
//
// **HTTPS when `Tools/certs/` holds a pair, plain HTTP otherwise**, so nothing changes for
// `localhost`. It is not about secrecy on a home network: `getUserMedia` and `AudioWorklet` are
// secure-context only, and `http://192.168.x.x` is not one — so over the LAN the recorder does not
// merely warn, it refuses, and the app looks broken on the device you are trying to test.
// `Tools/make-cert.sh` writes the pair; `docs/device-check.md` is what to do once it serves.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = Number(process.env.PORT ?? 5173);
const CERTS = path.join(import.meta.dirname, 'certs');

function credentials() {
  try {
    return {
      key: fs.readFileSync(path.join(CERTS, 'dev-key.pem')),
      cert: fs.readFileSync(path.join(CERTS, 'dev-cert.pem')),
    };
  } catch {
    return undefined;
  }
}

/** Every address a phone on the same network could reach, so the URL is not guesswork. */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const handler = (req, res) => {
  {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const rel = url === '/' ? 'ui/index.html' : url.replace(/^\/+/, '');
    const file = path.join(ROOT, rel);

    // Never serve outside the repo, however the path is spelled.
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end(`not found: ${rel}`);
        return;
      }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    });
  }
};

const tls = credentials();
const scheme = tls ? 'https' : 'http';
const server = tls ? https.createServer(tls, handler) : http.createServer(handler);

server.listen(PORT, () => {
  console.log(`serving ${ROOT} on ${scheme}://localhost:${PORT}`);
  for (const address of lanAddresses()) console.log(`  on this network: ${scheme}://${address}:${PORT}`);
  if (!tls) {
    console.log('\nHTTP only. A phone or tablet can load the app but NOT record:');
    console.log('getUserMedia and AudioWorklet need a secure context, and a LAN IP is not one.');
    console.log('Run  bash Tools/make-cert.sh  and restart to serve HTTPS.');
  }
});
