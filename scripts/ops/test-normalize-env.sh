#!/bin/bash
# Test hors-serveur de la normalisation .env utilisée par kauri-vps-fix.sh
# usage: bash scripts/ops/test-normalize-env.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# Reproduit le cas réel : CRLF, clé Firebase multi-ligne entre guillemets, JWT à 15d/30d,
# valeur contenant '=' et ':'.
printf 'PORT=5000\r\nJWT_ACCESS_EXPIRATION=15d\r\nJWT_REFRESH_EXPIRATION=30d\r\nFIREBASE_PROJECT_ID=demo\r\nFIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\r\nAAAAbbbb+cccc/dddd==\r\nEEEEffff\r\n-----END PRIVATE KEY-----\r\n"\r\nFIREBASE_CLIENT_EMAIL=x@demo.iam.gserviceaccount.com\r\nSWAGGER_PASSWORD=pa$$:word=with=equals\r\n' > "$T/in.env"

export KAURI_FIX_SOURCE_ONLY=1
# shellcheck disable=SC1091
source "$HERE/kauri-vps-fix.sh"
normalize_env "$T/in.env" > "$T/out.env"
normalize_env "$T/out.env" > "$T/out2.env"

fail=0
check() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

nonkv=$(grep -vcE '^[A-Z_]+=' "$T/out.env")
[ "$nonkv" = 0 ] && check "toutes les lignes sont KEY=VALUE (plus de fragments de clé)" ok || check "toutes les lignes sont KEY=VALUE" ko

key=$(grep '^FIREBASE_PRIVATE_KEY=' "$T/out.env")
n=$(printf '%s' "$key" | grep -o '\\n' | wc -l | tr -d ' ')
[ "$n" = 4 ] && check "clé Firebase sur une ligne avec 4 \\n littéraux" ok || check "clé Firebase sur une ligne ($n \\n)" ko

# décodage identique à src/config/firebase.ts : replace(/\\n/g, '\n')
decoded=$(printf '%s' "${key#FIREBASE_PRIVATE_KEY=}" | sed -e 's/^"//' -e 's/"$//' -e 's/\\n/\n/g')
first=$(printf '%s\n' "$decoded" | sed -n 1p); last=$(printf '%s\n' "$decoded" | sed -n 4p)
[ "$first" = "-----BEGIN PRIVATE KEY-----" ] && [ "$last" = "-----END PRIVATE KEY-----" ] && check "décodage côté app = PEM valide" ok || check "décodage PEM" ko

grep -qx 'JWT_ACCESS_EXPIRATION=15m' "$T/out.env" && check "JWT access = 15m" ok || check "JWT access" ko
grep -qx 'JWT_REFRESH_EXPIRATION=7d' "$T/out.env" && check "JWT refresh = 7d" ok || check "JWT refresh" ko
grep -qx 'ADMIN_URL=https://admin.kauri-app.com' "$T/out.env" && check "ADMIN_URL ajouté" ok || check "ADMIN_URL" ko
grep -qx 'SWAGGER_PASSWORD=pa$$:word=with=equals' "$T/out.env" && check "valeurs avec = et : intactes" ok || check "valeurs intactes" ko
grep -q $'\r' "$T/out.env" && check "CRLF supprimés" ko || check "CRLF supprimés" ok
diff -q "$T/out.env" "$T/out2.env" >/dev/null && check "idempotent (2e passe identique)" ok || check "idempotent" ko

exit $fail
