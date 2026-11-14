#!/bin/bash
# Fetch the bass sample libraries for spike 6's synthetic data (docs/audio-spike6-plan.md section 4, T1).
# Timbres and licenses: see BASS_SAMPLES.md (B, C and the alternates: all CC0 1.0; timbre A is
# MuseScore_General, MIT, via fetch-soundfont.sh). Samples go to spikes/analysis/basskits/ (gitignored) and never
# into git or the app. SHA-256 pinned 2026-11-01; a mismatch aborts.
#
# Usage: bash spikes/analysis/fetch-bass-samples.sh [--with-alternates] [--keep-zip]
#   --with-alternates  also fetch the alternates B' (Swagbass) and C' (Pastabass)
#   --keep-zip         keep the downloaded zip in basskits/_dl/ after extraction (default: delete)
# Idempotent: a library whose basskits/<dir>/.sha256 matches the pin is skipped.
# Needs: curl, sha256sum, and unzip (or python3 as a fallback extractor). B + C: 0.43 GB download,
# 0.46 GB extracted; with the alternates 0.89 GB / 1.1 GB.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KITS_DIR="$HERE/basskits"
DL_DIR="$KITS_DIR/_dl"
KEEP_ZIP=0
ALTERNATES=0
for arg in "$@"; do
  case "$arg" in
    --keep-zip) KEEP_ZIP=1 ;;
    --with-alternates) ALTERNATES=1 ;;
    *)
      echo "unknown option: $arg"
      exit 2
      ;;
  esac
done
mkdir -p "$DL_DIR"

# name | dir | url | sha256 | text the archive's license file must contain
LIBS=(
  "B: Growlybass v1.002 (CC0 1.0, tuning/dev)|growlybass|https://github.com/sfzinstruments/karoryfer.growlybass/releases/download/v1.002/Karoryfer.Growlybass.v1.002.zip|b92dca75494fa39d6e8d8b8addaabfe70c5aaa59b5f9a0f624be6de51a2374bc|CC0 1.0 Universal"
  "C: D. Smolken double bass v1.001 (CC0 1.0, held-out only)|dsmolken_double_bass|https://github.com/sfzinstruments/dsmolken.double-bass/releases/download/v1.001/DSmolken.double_bass.v1.001.zip|380986bb52ee6b6469d28e9089792a3ed37cbd163fe5a19160bf4f98785e7ccb|CC0 1.0 Universal"
)
if [ "$ALTERNATES" = 1 ]; then
  LIBS+=(
    "B' (alternate): Swagbass v1.001 (CC0 1.0)|swagbass|https://github.com/sfzinstruments/karoryfer.swagbass/releases/download/v1.001/Karoryfer.Swagbass.v1.001.zip|4b4db964413be99a597da246651961e1c4dbb0004db49daccd11387c5f9a535a|CC0 1.0 Universal"
    "C' (alternate): Pastabass v1.101 (CC0 1.0)|pastabass|https://github.com/sfzinstruments/karoryfer.pastabass/releases/download/v1.101/Karoryfer.Pastabass.v1.101.zip|df2bf12256e24bb3407d204105365cf29f4b8d90211225ee1a9d507f0670805c|CC0 1.0 Universal"
  )
fi

extract() { # zip dest
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$1" -d "$2"
  else
    # zipfile's extractall drops absolute paths and ".." components
    python3 -I -m zipfile -e "$1" "$2"
  fi
}

# Timbre A (tuning/dev): MuseScore_General's GM basses, via the existing pinned script.
bash "$HERE/fetch-soundfont.sh"

for entry in "${LIBS[@]}"; do
  IFS='|' read -r name dir url sha license <<<"$entry"
  dest="$KITS_DIR/$dir"
  zip="$DL_DIR/$dir.zip"
  echo "== $name"

  if [ -f "$dest/.sha256" ] && [ "$(cat "$dest/.sha256")" = "$sha" ]; then
    echo "✓ already extracted at basskits/$dir (SHA-256 $sha)"
    continue
  fi

  if [ ! -f "$zip" ]; then
    echo "  Downloading $url"
    curl -fL --retry 3 -o "$zip.part" "$url"
    mv "$zip.part" "$zip"
  fi

  actual=$(sha256sum "$zip" | awk '{print $1}')
  if [ "$actual" != "$sha" ]; then
    echo "ERROR: SHA-256 mismatch for $(basename "$zip")"
    echo "  Expected: $sha"
    echo "  Actual:   $actual"
    rm -f "$zip"
    exit 1
  fi
  echo "✓ SHA-256 OK ($(du -h "$zip" | awk '{print $1}'))"

  rm -rf "$dest"
  mkdir -p "$dest"
  extract "$zip" "$dest"

  # The license file inside the archive must still be the expected license.
  lic=$(find "$dest" -maxdepth 3 -type f -iname 'license*' | head -n 1)
  if [ -z "$lic" ] || ! grep -q "$license" "$lic"; then
    echo "ERROR: no license file with \"$license\" found in basskits/$dir; check the archive by hand"
    exit 1
  fi
  echo "✓ license: ${lic#"$KITS_DIR/"}"

  echo "$sha" >"$dest/.sha256"
  [ "$KEEP_ZIP" = 1 ] || rm -f "$zip"
  echo "✓ extracted to basskits/$dir ($(du -sh "$dest" | awk '{print $1}'))"
done

echo ""
echo "Done: bass samples ready in $KITS_DIR/"
