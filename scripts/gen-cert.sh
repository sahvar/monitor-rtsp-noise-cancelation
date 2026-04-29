#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT_DIR/certs"
KEY_FILE="$CERT_DIR/server.key"
CERT_FILE="$CERT_DIR/server.crt"
CONFIG_FILE="$CERT_DIR/openssl.cnf"

mkdir -p "$CERT_DIR"

HOST_IPS="$(hostname -I 2>/dev/null || true)"
SAN_ENTRIES="DNS:localhost,IP:127.0.0.1"

for ip in $HOST_IPS; do
  case "$ip" in
    *:*) ;;
    *) SAN_ENTRIES="$SAN_ENTRIES,IP:$ip" ;;
  esac
done

cat > "$CONFIG_FILE" <<EOF
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = iphone-mic-rtsp.local

[v3_req]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = $SAN_ENTRIES
EOF

openssl req \
  -x509 \
  -newkey rsa:2048 \
  -nodes \
  -sha256 \
  -days 365 \
  -keyout "$KEY_FILE" \
  -out "$CERT_FILE" \
  -config "$CONFIG_FILE"

echo "Created:"
echo "  $CERT_FILE"
echo "  $KEY_FILE"
echo
echo "Open the HTTPS page from the iPhone and accept the certificate warning."
