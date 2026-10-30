#!/bin/bash
# Fetch the drum sample kits for spike 5's synthetic data (docs/audio-spike5-plan.md §4, T1).
# Kits and licenses: see DRUM_SAMPLES.md (B, C: CC0 1.0; D: CC-BY 4.0, tuning only, attribution in
# ts/THIRD_PARTY.md; kit A is MuseScore_General, MIT, via fetch-soundfont.sh). Samples go to spikes/analysis/drumkits/ (gitignored) and never into git
# or the app. SHA-256 pinned 2026-10-25; a mismatch aborts.
#
# Usage: bash spikes/analysis/fetch-drum-samples.sh [--keep-zip]
#   --keep-zip  keep the downloaded zip in drumkits/_dl/ after extraction (default: delete)
# Idempotent: a kit whose drumkits/<dir>/.sha256 matches the pin is skipped.
# Needs: curl, sha256sum, and unzip (or python3 as a fallback extractor). 2.2 GB download,
# 2.5 GB extracted (+ the zips with --keep-zip).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KITS_DIR="$HERE/drumkits"
DL_DIR="$KITS_DIR/_dl"
KEEP_ZIP=0
[ "${1:-}" = "--keep-zip" ] && KEEP_ZIP=1
mkdir -p "$DL_DIR"

# name | dir | url | sha256 | text the archive's license file must contain
# Kit D has no release: the archive of a fixed commit (codeload; the same bytes were served twice on 2026-10-25).
KITS=(
  "Virtuosity Drums v0.925 (CC0 1.0)|virtuosity_drums|https://github.com/sfzinstruments/virtuosity_drums/releases/download/v0.925/Virtuosity_Drums_v0.925.zip|c6c5d0fe11a394e94be3146a950c3377ec102cb57d189d5a23cec26183d1963a|CC0 1.0 Universal"
  "Big Rusty Drums v1.100 (CC0 1.0)|big_rusty_drums|https://github.com/sfzinstruments/karoryfer.big-rusty-drums/releases/download/v1.100/Big_Rusty_Drums_1100.zip|d4a9990acd19376d91ce446dae415c81428728b5adebb6a88eddbb3a6aac8744|CC0 1.0 Universal"
  "MuldjordKit v1.0 sfz (CC-BY 4.0, tuning only)|muldjord_kit|https://codeload.github.com/sfzinstruments/DrumGizmo.MuldjordKit/zip/fc165714974aa843125ce88597f341b31376e1d5|98ed34f4d5fbb47c72cd760c458db0528aa71f28d7dd219652a145d5d8ce3259|Attribution 4.0 International"
)

extract() { # zip dest
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$1" -d "$2"
  else
    # zipfile's extractall drops absolute paths and ".." components
    python3 -I -m zipfile -e "$1" "$2"
  fi
}

# Kit A (tuning): MuseScore_General, via the existing pinned script.
bash "$HERE/fetch-soundfont.sh"

for entry in "${KITS[@]}"; do
  IFS='|' read -r name dir url sha license <<<"$entry"
  dest="$KITS_DIR/$dir"
  zip="$DL_DIR/$dir.zip"
  echo "== $name"

  if [ -f "$dest/.sha256" ] && [ "$(cat "$dest/.sha256")" = "$sha" ]; then
    echo "✓ already extracted at drumkits/$dir (SHA-256 $sha)"
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
    echo "ERROR: no license file with \"$license\" found in drumkits/$dir; check the archive by hand"
    exit 1
  fi
  echo "✓ license: ${lic#"$KITS_DIR/"}"

  echo "$sha" >"$dest/.sha256"
  [ "$KEEP_ZIP" = 1 ] || rm -f "$zip"
  echo "✓ extracted to drumkits/$dir ($(du -sh "$dest" | awk '{print $1}'))"
done

echo ""
echo "Done: drum kits ready in $KITS_DIR/"
