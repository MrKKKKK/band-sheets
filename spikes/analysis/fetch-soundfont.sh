#!/bin/bash
# Fetch MuseScore_General.sf3 soundfont from official source
# License: MIT (FluidR3 derived; see MuseScore_General_License.md)
# Source: MuseScore official repository
# SHA-256 verification ensures integrity and idempotency

set -e

SOUNDFONT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/soundfonts"
mkdir -p "$SOUNDFONT_DIR"

SOUNDFONT_FILE="$SOUNDFONT_DIR/MuseScore_General.sf3"
LICENSE_FILE="$SOUNDFONT_DIR/MuseScore_General_License.md"

# Official source: MuseScore soundfont mirror
# The soundfont is distributed under MIT License (FluidR3 derived)
# Official MuseScore mirror (OSUOSL); version 0.2 (2020-05-13), hash pinned 2026-10-10
SOUNDFONT_URL="https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf3"

# SHA-256 hash (pinned after download verification)
# Computed: sha256sum MuseScore_General.sf3
# If this hash changes, the soundfont file has been modified
EXPECTED_SHA256="5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3"

# License file source for reference
LICENSE_URL="https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General_License.md"

echo "Fetching MuseScore_General.sf3 soundfont (MIT License)..."

# Check if file exists and verify hash (idempotent - skip if present and correct)
if [ -f "$SOUNDFONT_FILE" ]; then
  actual_sha256=$(sha256sum "$SOUNDFONT_FILE" | awk '{print $1}')
  if [ "$actual_sha256" = "$EXPECTED_SHA256" ]; then
    echo "✓ MuseScore_General.sf3 already present and verified (SHA-256 OK)"
    exit 0
  else
    echo "ERROR: Existing file has mismatched SHA-256"
    echo "  Expected: $EXPECTED_SHA256"
    echo "  Actual:   $actual_sha256"
    echo "  Please remove $SOUNDFONT_FILE and try again"
    exit 1
  fi
fi

# Download soundfont from official source
echo "  Downloading from: $SOUNDFONT_URL"
curl -fL -o "$SOUNDFONT_FILE" "$SOUNDFONT_URL" || {
  echo "ERROR: Failed to download soundfont"
  exit 1
}

# Verify downloaded file integrity via SHA-256
actual_sha256=$(sha256sum "$SOUNDFONT_FILE" | awk '{print $1}')
if [ "$actual_sha256" != "$EXPECTED_SHA256" ]; then
  echo "ERROR: Downloaded file hash mismatch"
  echo "  Expected: $EXPECTED_SHA256"
  echo "  Actual:   $actual_sha256"
  echo "  File integrity check failed; removed downloaded file"
  rm -f "$SOUNDFONT_FILE"
  exit 1
fi

file_size=$(du -h "$SOUNDFONT_FILE" | awk '{print $1}')
echo "✓ MuseScore_General.sf3 verified (${file_size})"

# Download and save license file for reference
echo "  Fetching license file..."
if timeout 10 curl -fL -o "$LICENSE_FILE" "$LICENSE_URL" 2>/dev/null; then
  echo "✓ License saved to MuseScore_General_License.md"
else
  echo "  (License file unavailable, but soundfont is valid)"
fi

echo ""
echo "Done: MuseScore_General soundfont ready at $SOUNDFONT_DIR/"
