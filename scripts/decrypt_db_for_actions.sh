#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

DB_FILE="${DB_FILE:-db.json}"
ENCRYPTED_DB_FILE="${ENCRYPTED_DB_FILE:-buildwise_private/db.json.gpg}"

[ -f "$ENCRYPTED_DB_FILE" ] || die "Missing encrypted database at $ENCRYPTED_DB_FILE. Commit the encrypted file or provide it before running the workflow."
[ -n "${BUILDWISE_DB_GPG_PASSPHRASE:-}" ] || die "Missing BUILDWISE_DB_GPG_PASSPHRASE. Add it as a GitHub Actions secret."
command -v gpg >/dev/null 2>&1 || die "gpg is required to decrypt the BuildWise database."

umask 077

printf '%s' "$BUILDWISE_DB_GPG_PASSPHRASE" | gpg \
  --batch \
  --yes \
  --pinentry-mode loopback \
  --passphrase-fd 0 \
  --decrypt \
  --output "$DB_FILE" \
  "$ENCRYPTED_DB_FILE"

[ -f "$DB_FILE" ] || die "Decryption finished but $DB_FILE was not created."

echo "BuildWise database decrypted for this run: $DB_FILE"
echo "Do not upload, print, or commit raw $DB_FILE."
