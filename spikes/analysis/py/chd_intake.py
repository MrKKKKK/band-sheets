"""Drop-folder intake of the 8 electric-piano takes of spike 7 (task T6, docs/audio-spike7-plan.md §3.2).

Usage (from spikes/analysis):  python py/chd_intake.py [--inbox recordings/chd-inbox] [--out out] [--reintake]
                               [--reintake-held-out] [--skip-start-check] [--reparse [chd-NN-x ...]]

Same steps as py/bass_intake.py (RECORDING.md §9, §10) with the CHORDS2 source:
  * files g … n (ids chd-07-g … chd-14-n, so they never share an id with spike 6's bas-01-a … bas-06-f, which T1
    re-registered in the same registry); dev = g-j, held-out = k-n, decided by the letter;
  * registry recordings/chd-ids.local.json with `split` and `heldOut` (ts/chords2/eval/guard.ts needs both), written
    with the log line (kind "register", input "chords2", `split`) BEFORE the audio file is opened;
  * the dev templates are committed (chord-scores/<x>.txt); the held-out templates live in the gitignored
    recordings/chd-heldout-scores/ (never in git, never printed);
  * the truth keeps the original quality of every chord (rec_truth `originalQuality`: `AmM7` -> mM7, `C6` -> 6).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bass_intake as B  # noqa: E402

HELDOUT_SCORES = "recordings/chd-heldout-scores"  # gitignored (recordings/); privacy_check reads its chord runs

CHORDS2 = B.Source(prefix="chd", letters="ghijklmn", held_out=frozenset("klmn"), ids_file="chd-ids.local.json",
                   inbox="recordings/chd-inbox", scores="chord-scores", heldout_scores=HELDOUT_SCORES,
                   log_input="chords2", manifest="manifest.chords2.json", originals="chd-originals",
                   original_quality=True, split=True)


def main(argv=None):
    return B.main(argv, CHORDS2)


if __name__ == "__main__":
    sys.exit(main())
