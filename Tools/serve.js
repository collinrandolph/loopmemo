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
/**
 * The other secret the document root publishes.
 *
 * `/.git/config` and `/.git/HEAD` returned 200 for the same reason the private key did: the repo
 * root *is* the document root, so anything committed — or anything git keeps beside what is
 * committed — is on the wire. And this server prints LAN addresses at startup, because phone
 * testing needs them, so the audience is everyone on the network rather than localhost.
 *
 * A repository is a bigger leak than one key: `.git/config` carries remotes and sometimes
 * credentials in the URL, and the object store carries every version of every file ever committed,
 * including ones deleted later for being secret.
 */
const GITDIR = path.join(ROOT, '.git');

function credentials() {
  // `LR_HTTP=1` forces plain HTTP even when certificates exist. `localhost` is a secure context
  // over HTTP, so nothing is lost locally — and tools that drive the page for verification
  // (the Browser pane among them) refuse a self-signed certificate outright, which otherwise
  // means deleting the certificates to run a check and re-issuing them afterwards.
  if (process.env.LR_HTTP) return undefined;
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

    // Never serve outside the repo, however the path is spelled — and never the TLS material,
    // which lives inside it. The private key was reachable at `/Tools/certs/dev-key.pem` the
    // moment this server learned to speak HTTPS: the repo root is the document root, so adding a
    // secret to the repo published it. The certificate is handed out deliberately, by the helper
    // below, and nothing needs the key over the wire.
    if (!file.startsWith(ROOT) || file.startsWith(CERTS) || file.startsWith(GITDIR)) {
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

/**
 * A plain-HTTP listener on the next port whose only job is handing out the certificate.
 *
 * Without it the device is in a loop: the certificate has to be trusted before the HTTPS server
 * will load, and the certificate lives on the HTTPS server. The usual way out is mailing the file
 * to yourself, which drags a mail client and an account into a local-network test.
 *
 * **It serves the certificate and nothing else** — one hardcoded path, no directory traversal to
 * get wrong. Handing out a public certificate over HTTP gives nothing away; it is public by
 * definition and is what every browser on the network is about to be shown. The private key is
 * never read here.
 *
 * `application/x-x509-ca-cert` is what makes iOS treat the download as a profile to install
 * rather than a file to drop in Downloads.
 */
function startCertHelper(cert, port) {
  const page = (address) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Loop Recorder — trust this certificate</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:28px 22px;max-width:34em}
h1{font-size:20px;margin:0 0 4px}p{color:#444}ol{padding-left:22px}li{margin:10px 0}
a.btn{display:inline-block;margin:18px 0;padding:14px 20px;background:#111;color:#fff;
text-decoration:none;border-radius:10px;font-weight:600}code{background:#eee;padding:2px 5px;border-radius:4px}</style>
<h1>Trust the dev certificate</h1>
<p>So this iPad can record from the Loop Recorder build running on your PC.</p>
<a class="btn" href="/cert">Download the certificate</a>
<ol>
<li>Tap the button. Allow the download when asked.</li>
<li><b>Settings → General → VPN &amp; Device Management</b> → tap the downloaded profile → <b>Install</b>.</li>
<li><b>Settings → General → About → Certificate Trust Settings</b> → switch it on.
<br>This is a <i>different screen</i> from step 2 and only appears once step 2 is done. Skipping it
is the usual failure, and it looks exactly like the certificate not working at all.</li>
<li>Open <code>https://${address}:${PORT}</code></li>
</ol>`;

  http
    .createServer((req, res) => {
      if ((req.url ?? '/').startsWith('/cert')) {
        res.writeHead(200, {
          'content-type': 'application/x-x509-ca-cert',
          'content-disposition': 'attachment; filename="loop-recorder-dev.crt"',
        });
        res.end(cert);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(lanAddresses()[0] ?? 'localhost'));
    })
    .listen(port);
}

const tls = credentials();
const scheme = tls ? 'https' : 'http';
const server = tls ? https.createServer(tls, handler) : http.createServer(handler);

server.listen(PORT, () => {
  console.log(`serving ${ROOT} on ${scheme}://localhost:${PORT}`);
  const lan = lanAddresses();
  for (const address of lan) console.log(`  on this network: ${scheme}://${address}:${PORT}`);
  if (tls) {
    startCertHelper(tls.cert, PORT + 1);
    console.log('\nOn the iPhone or iPad, FIRST open:');
    for (const address of lan) console.log(`  http://${address}:${PORT + 1}   (plain http — this is the certificate)`);
    console.log('Follow the three steps on that page, then load the app URL above.');
    console.log('Details and what to test: docs/device-check.md');
  } else {
    console.log('\nHTTP only. A phone or tablet can load the app but NOT record:');
    console.log('getUserMedia and AudioWorklet need a secure context, and a LAN IP is not one.');
    console.log('Run  bash Tools/make-cert.sh  and restart to serve HTTPS.');
  }
});
