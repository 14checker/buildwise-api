#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

DB_FILE="${DB_FILE:-db.json}"
ENCRYPTED_DB_FILE="${ENCRYPTED_DB_FILE:-buildwise_private/db.json.gpg}"

[ -f "$DB_FILE" ] || die "Missing $DB_FILE. Run this from the repo root with a local db.json available."
[ -n "${BUILDWISE_DB_GPG_PASSPHRASE:-}" ] || die "BUILDWISE_DB_GPG_PASSPHRASE is required. Store the same passphrase as a GitHub Actions secret."
command -v gpg >/dev/null 2>&1 || die "gpg is required to encrypt the BuildWise database."

mkdir -p "$(dirname "$ENCRYPTED_DB_FILE")"

printf '%s' "$BUILDWISE_DB_GPG_PASSPHRASE" | gpg \
  --batch \
  --yes \
  --pinentry-mode loopback \
  --passphrase-fd 0 \
  --cipher-algo AES256 \
  --symmetric \
  --output "$ENCRYPTED_DB_FILE" \
  "$DB_FILE"

[ -f "$ENCRYPTED_DB_FILE" ] || die "Encryption did not create $ENCRYPTED_DB_FILE."

echo "Encrypted BuildWise database created: $ENCRYPTED_DB_FILE"
echo "Store the same passphrase as GitHub secret BUILDWISE_DB_GPG_PASSPHRASE."
echo "Raw $DB_FILE was left in place and must remain ignored."
