#!/usr/bin/env bash
# Generate a throwaway CA and a server certificate for the database and the
# box's HTTPS. KEIKO_TLS_NAMES sets the names in the server certificate, as
# comma-separated DNS:<name> or IP:<address>; the default is loopback, and
# compose adds its service names. Compose runs this in the image, so the host
# needs no openssl.
# Idempotent: a complete, verifiable set issued for the same names is reused.
# Other names, or incomplete leftovers, replace the whole set, so a crash
# mid-generation does not poison the next start. tls/names records the names
# and is written last; without it the names are read from the certificate.
# The database copies these files at container start; rotating a live box is
# out of scope (restart the database and the box).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/tls"
lock="$dir/.lock"
tmp=""
default_names="DNS:localhost,IP:127.0.0.1"
names="${KEIKO_TLS_NAMES:-$default_names}"
entry='(DNS:[A-Za-z0-9*.-]+|IP:[0-9A-Fa-f.:]+)'
if [[ ! "$names" =~ ^$entry(,$entry)*$ ]]; then
  echo "KEIKO_TLS_NAMES must be comma-separated DNS:<name> or IP:<address> entries" >&2
  exit 1
fi
mkdir -p "$dir"

usable() {
  local base="$1" cert_pub key_pub
  [[ -s "$base/ca.crt" && -s "$base/server.crt" && -s "$base/server.key" ]] || return 1
  openssl x509 -in "$base/ca.crt" -noout >/dev/null 2>&1 || return 1
  openssl x509 -in "$base/server.crt" -noout >/dev/null 2>&1 || return 1
  openssl verify -CAfile "$base/ca.crt" "$base/server.crt" >/dev/null 2>&1 || return 1
  cert_pub="$(openssl x509 -in "$base/server.crt" -noout -pubkey 2>/dev/null)" || return 1
  key_pub="$(openssl pkey -in "$base/server.key" -pubout 2>/dev/null)" || return 1
  [[ -n "$cert_pub" && "$cert_pub" == "$key_pub" ]] || return 1
  [[ "$(issued_names "$base")" == "$names" ]] || return 1
}

# The names a set was issued for. Without the marker (a set from before it
# existed, or a crash mid-install), read them from the certificate; a form that
# does not round-trip, such as some IPv6 spellings, mismatches and regenerates.
issued_names() {
  if [[ -s "$1/names" ]]; then
    cat "$1/names"
  else
    openssl x509 -in "$1/server.crt" -noout -text 2>/dev/null |
      awk '/Subject Alternative Name/ { getline; gsub(/ /, ""); gsub(/IPAddress:/, "IP:"); print }'
  fi
}

cleanup() {
  [[ -n "$tmp" ]] && rm -rf "$tmp"
}

if usable "$dir"; then
  exit 0
fi

command -v openssl >/dev/null || {
  echo "openssl is required to generate the database TLS authority" >&2
  exit 1
}
command -v flock >/dev/null || {
  echo "flock is required to generate the database TLS authority" >&2
  exit 1
}

exec 9>"$lock"
flock 9
trap cleanup EXIT
if usable "$dir"; then
  exit 0
fi

tmp="$(mktemp -d "$dir/.gen.XXXXXX")"

# Config files instead of -addext, so both OpenSSL and LibreSSL can build the chain.
cat > "$tmp/ca.cnf" <<'CNF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = keiko-db-ca
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
CNF
echo "$names" > "$tmp/names"
cat > "$tmp/server.ext" <<EXT
subjectAltName = $names
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
EXT

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -config "$tmp/ca.cnf" -extensions v3_ca \
  -keyout "$tmp/ca.key" \
  -out "$tmp/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -config "$tmp/ca.cnf" -subj "/CN=localhost" \
  -keyout "$tmp/server.key" \
  -out "$tmp/server.csr" >/dev/null 2>&1
openssl x509 -req -days 3650 \
  -in "$tmp/server.csr" \
  -CA "$tmp/ca.crt" \
  -CAkey "$tmp/ca.key" \
  -CAcreateserial \
  -extfile "$tmp/server.ext" \
  -out "$tmp/server.crt" >/dev/null 2>&1
chmod 600 "$tmp/ca.key" "$tmp/server.key"
usable "$tmp"

# The marker goes first and comes back last, so a crash in between leaves a set
# that is judged by its certificate, never by a stale marker.
rm -f "$dir/names"
mv "$tmp/ca.crt" "$dir/ca.crt"
mv "$tmp/ca.key" "$dir/ca.key"
mv "$tmp/server.crt" "$dir/server.crt"
mv "$tmp/server.key" "$dir/server.key"
mv "$tmp/names" "$dir/names"
