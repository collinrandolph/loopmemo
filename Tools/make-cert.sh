#!/usr/bin/env bash
# A self-signed certificate for serving the UI pass over HTTPS on the local network, so an
# iPhone or iPad can actually exercise the recorder (see docs/device-check.md).
#
# Why this is needed at all: `getUserMedia` and `AudioWorklet` are secure-context only, and
# `http://192.168.x.x` is not a secure context. Over the LAN without TLS the app loads and then
# refuses to arm, which looks like a bug in the app rather than a property of the URL.
#
# Three details that are the difference between working and a day lost:
#
#   1. **subjectAltName, not just CN.** WebKit ignores the Common Name entirely and rejects a
#      certificate with no matching SAN. The IP goes in as `IP:`, not `DNS:`.
#   2. **365 days.** Safari refuses server certificates valid for more than 398 days, so the
#      tempting `-days 3650` produces one iOS will not accept no matter how it is trusted.
#   3. **Trusting it on iOS is two separate steps in two different screens**, and doing only the
#      first is the usual failure — see docs/device-check.md.
#
# Usage:  bash Tools/make-cert.sh [ip-address]
# With no argument it uses this machine's first non-internal IPv4 address.

set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
out="$dir/certs"
mkdir -p "$out"

ip="${1:-$(node -e "const os=require('os');const a=Object.values(os.networkInterfaces()).flat().find(x=>x&&x.family==='IPv4'&&!x.internal);process.stdout.write(a?a.address:'')")}"

if [ -z "$ip" ]; then
  echo "No LAN address found. Pass one explicitly: bash Tools/make-cert.sh 192.168.1.23" >&2
  exit 1
fi

echo "Issuing a certificate for $ip (and localhost), valid 365 days."

# The subject goes in a config file rather than `-subj`, because Git Bash on Windows rewrites the
# leading slash of `/CN=...` into a drive path and hands openssl `C:/Program Files/Git/CN=...`.
# `MSYS_NO_PATHCONV=1` fixes that and breaks the *file* arguments in the same stroke — they need
# the conversion. A config file needs neither exception, and reads better besides.
#
# Do not redirect stderr away to quiet openssl's progress dots: that is what hid the first error.
cnf="$out/dev-cert.cnf"
cat > "$cnf" <<CONF
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3

[dn]
CN = Loop Recorder dev

[v3]
subjectAltName = IP:$ip,IP:127.0.0.1,DNS:localhost
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
CONF

openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -keyout "$out/dev-key.pem" -out "$out/dev-cert.pem" -config "$cnf"

echo
echo "Wrote $out/dev-cert.pem and dev-key.pem (both gitignored)."
echo "Restart the server:  npm run ui"
echo "Then open  https://$ip:5173  on the device and follow docs/device-check.md."
