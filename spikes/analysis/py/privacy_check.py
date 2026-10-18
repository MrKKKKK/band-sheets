"""Check that nothing about the private recordings leaked into git-tracked files (task T3).

Usage: python py/privacy_check.py [--root DIR] [--recordings DIR] [--no-log] [--base REF] [--history]
Exit 0 = clean, 1 = a private term was found, 2 = usage error.

Private terms are read at RUNTIME from the gitignored recordings folder (nothing private is embedded here):
  * the stems of every file in recordings/ and the original file names in ids.local.json,
  * every non-empty line of recordings/private-terms.local.txt (song titles, artists; one per line),
  * annotation "title" / "artist" fields,
  * T28 chord-chart-only songs, recordings/charts/: the stems of the chart *.txt files, the original names in
    charts/ids.local.json, the comment lines (# ...) of the charts and every run of 6 chords of their bar lines and
    of their inline `[X]` chords (lyric charts), and of the converted chart-NN.song.json `bars` (T17),
  * lyric fragments (T17): every LYRIC_GRAM-character window (with a non-ASCII character) of the lyric text of the
    charts (chords, spaces and punctuation removed) and every LYRIC_WORDS-word window of its ASCII words, matched
    the same way in the scanned text,
  * every run of 6 consecutive chords (>= 3 distinct) from the *.chords.json annotations (chord progressions),
  * spike 4 humming: the original names in recordings/hum-ids.local.json, the stems of the files in hum-inbox/ and
    hum-originals/, and every run of HUM_RUN (8) consecutive notes (>= 4 distinct pitches, not a plain scale run) of
    the note sequences in recordings/hum-*.truth.json and out/rec/hum-*.truth.json. They are matched against the
    pitch tokens of a scanned file / added diff / commit message as a whole (note names like C4 Bb3 C#5, and bare
    MIDI numbers 21..108, in order, anything else in between ignored), exact pitch. The report only says
    "humming note sequence (k of n runs)" (once per file / diff / message). T15: the runs are also compared by their
    interval sequence (differences between consecutive pitches), so a transposed or octave-shifted copy of a run is
    found as well ("... transposed form"); interval windows with fewer than 3 distinct intervals are not used.
Chord runs that are a window of a generic loop (GENERIC_LOOPS, e.g. I-vi-IV-V of the T0 test signal) in any key are
allowed: they identify nothing and are used by tests.
Matching ignores case and treats space / _ / - / . as the same. Anonymous names (rec, rec-01 ...) and very short
terms (< 4 characters) are ignored. Scanned: git-tracked files under --root (or, without git, every text file
outside out/, recordings/, node_modules/, .git/) and the commit messages (the last 200 plus every commit of
<--base>..HEAD; terms, chord runs and lyric fragments). --history also scans every line added by the commits of
<--base>..HEAD (so content that was committed and later removed is found too). A tracked file under recordings/
is itself a violation. The report names file and line, never the term or the chords.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import unicodedata

CHORD_RUN = 6
HUM_RUN = 8  # consecutive melody notes (spike 4 humming truths) that count as a note sequence
LYRIC_GRAM = 8  # characters of lyric text (spaces / punctuation removed) that count as a fragment (non-ASCII)
LYRIC_WORDS = 5  # consecutive ASCII words that count as a fragment
DEFAULT_BASE = "research/audio-analysis"
# Generic loops (degree semitones above the tonic, 'M' major / 'm' minor): runs inside them, in any key, are allowed.
GENERIC_LOOPS = {
    "I-vi-IV-V": ((0, "M"), (9, "m"), (5, "M"), (7, "M")),  # tests/hooks_synth.py (T0 test signal)
}
_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_CHORD_TOKEN = re.compile(r"([A-G])([#b]?)(.*)")
SKIP_DIRS = {"out", "recordings", "node_modules", ".git", "soundfonts", "__pycache__"}
SEP = r"[\s_\-.]+"


def _norm(t):
    return re.sub(SEP, " ", t.strip().lower())


def _is_chord_token(tok):
    return bool(_CHORD_TOKEN.fullmatch(tok)) and " " not in tok


def chart_texts(text):
    """(comment lines, chord sequence, lyric lines) of a chart .txt, read leniently (no validation, so a broken chart
    is still covered): comments = lines starting with '#'; chords = the tokens of the '|' lines without '.' and N.C.,
    plus every inline `[X]` chord of any line (lyric / dash charts); lyric lines = the text of every other non-empty
    line with its `[...]` removed (ChordPro `{...}` directives and `key: value` header lines are skipped)."""
    comments, seq, lyrics = [], [], []

    def add(tok):
        tok = tok.strip().strip("-—–―－").strip()
        if tok and tok != "." and tok.upper() not in ("N.C.", "N") and _is_chord_token(tok) \
                and (not seq or seq[-1] != tok):
            seq.append(tok)

    for raw in text.lstrip("\ufeff").splitlines():
        line = unicodedata.normalize("NFKC", raw).replace("\u266f", "#").replace("\u266d", "b").strip()
        if line.startswith("#"):
            comments.append(line.lstrip("#").strip())
            continue
        if line.startswith("|"):
            for tok in re.sub(r"\[([^\]]*)\]", r" \1 ", line).replace("|", " ").split():
                add(tok)
            continue
        for m in re.finditer(r"\[([^\]]*)\]", line):
            add(m.group(1))
        rest = re.sub(r"\[[^\]]*\]", " ", line).strip()
        if not rest or rest.startswith("{") or re.match(r"^[^\s:：]{1,12}\s*[:：]", rest):
            continue
        lyrics.append(rest)
    return comments, seq, lyrics


def _squash(text):
    """Lyric matching form: NFKC, lower case, only letters / digits / CJK (spaces and punctuation removed)."""
    t = unicodedata.normalize("NFKC", text).lower()
    return "".join(ch for ch in t if ch.isalnum())


def _grams(line):
    """Lyric fragments of one line: LYRIC_GRAM-character windows that contain a non-ASCII character (Japanese text
    has no spaces), plus LYRIC_WORDS-word windows of the ASCII words ("w:" prefix; 8 ASCII letters alone match
    ordinary English prose too often)."""
    q = _squash(line)
    out = {q[i:i + LYRIC_GRAM] for i in range(len(q) - LYRIC_GRAM + 1)}
    out = {g for g in out if not g.isascii()}
    words = re.findall(r"[a-z0-9']+", unicodedata.normalize("NFKC", line).lower())
    out |= {"w:" + " ".join(words[i:i + LYRIC_WORDS]) for i in range(len(words) - LYRIC_WORDS + 1)}
    return out


def lyric_grams(lines):
    out = set()
    for ln in lines:
        out |= _grams(ln)
    return out


def _chord_class(tok):
    """'Am7' -> (9, 'm'); None when unreadable. Only root + major / minor (7ths etc. ignored)."""
    m = _CHORD_TOKEN.fullmatch(tok.split("/")[0])
    if not m:
        return None
    pc = (_PC[m.group(1)] + {"#": 1, "b": -1, "": 0}[m.group(2)]) % 12
    q = m.group(3)
    minor = q.startswith("m") and not q.lower().startswith("maj") and not q.startswith("M")
    return pc, "m" if minor else "M"


def is_generic_run(run):
    """True when the run is a window of a GENERIC_LOOPS loop (repeated) in some key."""
    cls = [_chord_class(c) for c in run]
    if any(c is None for c in cls):
        return False
    for loop in GENERIC_LOOPS.values():
        n = len(loop)
        for start in range(n):
            tonic = (cls[0][0] - loop[start][0]) % 12
            if all(cls[i] == ((tonic + loop[(start + i) % n][0]) % 12, loop[(start + i) % n][1])
                   for i in range(len(cls))):
                return True
    return False


def _runs(seq):
    out = set()
    for i in range(len(seq) - CHORD_RUN + 1):
        w = seq[i:i + CHORD_RUN]
        if len(set(w)) >= 3 and not is_generic_run(w):
            out.add(tuple(w))
    return out


def _song_json_seq(path):
    """Chord sequence of a converted chart-NN.song.json (`bars` = [[chord, eighths], ...] per bar)."""
    try:
        with open(path, encoding="utf-8") as f:
            song = json.load(f)
    except (OSError, ValueError):
        return []
    seq = []
    for bar in song.get("bars", []) if isinstance(song, dict) else []:
        for item in bar:
            c = item[0] if isinstance(item, list) and item else None
            if isinstance(c, str) and c.upper() not in ("N.C.", "N") and (not seq or seq[-1] != c):
                seq.append(c)
    return seq


def collect_terms(rec_dir):
    """-> (text_terms, chord_runs); both lists of strings. Never printed."""
    terms, runs, _ = collect_all(rec_dir)
    return terms, runs


def collect_all(rec_dir):
    """-> (text_terms, chord_runs, lyric_grams). Never printed."""
    terms = set()
    lyric_lines = []
    if not os.path.isdir(rec_dir):
        return [], [], set()
    for sub in ("", "inbox", "originals", "hum-inbox", "hum-originals"):
        d = os.path.join(rec_dir, sub)
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if fn.startswith(".") or fn in ("ids.local.json", "hum-ids.local.json", "private-terms.local.txt") \
                    or not os.path.isfile(os.path.join(d, fn)):
                continue
            terms.add(fn.split(".")[0] if fn.endswith((".chords.json", ".truth.json")) else os.path.splitext(fn)[0])
    chart_runs = set()
    cdir = os.path.join(rec_dir, "charts")
    if os.path.isdir(cdir):
        for fn in os.listdir(cdir):
            p = os.path.join(cdir, fn)
            if fn.startswith(".") or not os.path.isfile(p):
                continue
            if fn.endswith(".song.json"):
                chart_runs |= _runs(_song_json_seq(p))
                continue
            if not fn.lower().endswith(".txt"):
                continue
            terms.add(os.path.splitext(fn)[0])
            try:
                comments, seq, lyr = chart_texts(open(p, encoding="utf-8", errors="replace").read())
            except OSError:
                continue
            terms.update(comments)
            chart_runs |= _runs(seq)
            lyric_lines += lyr
        cids = os.path.join(cdir, "ids.local.json")
        if os.path.exists(cids):
            try:
                for e in json.load(open(cids, encoding="utf-8")).get("charts", {}).values():
                    terms.add(os.path.splitext(e.get("original", ""))[0])
            except ValueError:
                pass
    for ids_name in ("ids.local.json", "hum-ids.local.json"):
        ids_p = os.path.join(rec_dir, ids_name)
        if os.path.exists(ids_p):
            for e in json.load(open(ids_p)).get("recordings", {}).values():
                terms.add(os.path.splitext(e.get("original", ""))[0])
                for of in e.get("originalFiles", []) if ids_name.startswith("hum-") else []:
                    terms.add(os.path.splitext(of)[0])
    tp = os.path.join(rec_dir, "private-terms.local.txt")
    if os.path.exists(tp):
        terms.update(l.strip() for l in open(tp, encoding="utf-8") if l.strip())
    runs = set(chart_runs)
    for fn in os.listdir(rec_dir):
        if not fn.endswith(".chords.json"):
            continue
        try:
            ann = json.load(open(os.path.join(rec_dir, fn)))
        except ValueError:
            continue
        for k in ("title", "artist"):
            if isinstance(ann.get(k), str):
                terms.add(ann[k])
        seq = []
        for c in ann.get("pickupChords", []) + [c for bar in ann.get("bars", []) for c in bar]:
            if not seq or seq[-1] != c[0]:
                seq.append(c[0])
        runs |= _runs(seq)
    anon = r"(rec|chart|hum)( \d+)?( [a-f]\d*)?( max)?( (block|rec|rechard))?"
    good = sorted({_norm(t) for t in terms if len(_norm(t)) >= 4 and not re.fullmatch(anon, _norm(t))})
    return good, sorted(runs), lyric_grams(lyric_lines)


_HUM_TOKEN = re.compile(r"(?<![A-Za-z0-9#.])(?:([A-G])(#|b)?(-?\d)|(\d{2,3}))(?![A-Za-z0-9#.])")
_HUM_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def hum_pitches(text):
    """Pitch tokens of a text in order: note names (C4, C#4, Bb3 -> MIDI) and bare integers 21..108 (MIDI)."""
    out = []
    for m in _HUM_TOKEN.finditer(text):
        if m.group(1):
            out.append(12 * (int(m.group(3)) + 1) + _HUM_PC[m.group(1)] + {"#": 1, "b": -1, None: 0}[m.group(2)])
        elif 21 <= int(m.group(4)) <= 108:
            out.append(int(m.group(4)))
    return out


def _hum_runs(seq):
    """HUM_RUN-note windows with >= 4 distinct pitches that are not a plain scale run (all steps <= 2 semitones in
    one direction): scales identify nothing."""
    out = set()
    for i in range(len(seq) - HUM_RUN + 1):
        w = seq[i:i + HUM_RUN]
        d = [b - a for a, b in zip(w, w[1:])]
        scale = all(0 < x <= 2 for x in d) or all(-2 <= x < 0 for x in d)
        if len(set(w)) >= 4 and not scale:
            out.add(tuple(w))
    return out


def intervals(run):
    """Semitone differences of consecutive notes: the same for every transposition (octave shifts included)."""
    return tuple(b - a for a, b in zip(run, run[1:]))


def _distinctive_intervals(iv):
    """An interval window identifies a melody only when it has some variety (a constant or two-valued pattern like
    +7 +7 +7 or alternating +2 -2 occurs in plain data)."""
    return len(set(iv)) >= 3


def collect_hum(rec_dir):
    """Note runs of the humming truths (recordings/hum-*.truth.json and the copies in <analysis>/out/rec/). Never printed."""
    runs = set()
    dirs = [rec_dir, os.path.join(os.path.dirname(os.path.abspath(rec_dir)), "out", "rec")]
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if not (fn.startswith("hum-") and fn.endswith(".truth.json")):
                continue
            try:
                with open(os.path.join(d, fn), encoding="utf-8") as f:
                    truth = json.load(f)
            except (OSError, ValueError):
                continue
            notes = truth.get("notes", []) if isinstance(truth, dict) else []
            runs |= _hum_runs([n["midi"] for n in notes if isinstance(n, dict) and isinstance(n.get("midi"), int)])
    return sorted(runs)


def _chord_regex(run):
    return re.compile(r"(?<![A-Za-z0-9#])" + r"[\s,|>→–\-/]*".join(re.escape(c) for c in run) + r"(?![A-Za-z0-9#])")


def tracked_files(root):
    try:
        out = subprocess.run(["git", "-C", root, "ls-files", "-z"], capture_output=True, check=True).stdout
        top = subprocess.run(["git", "-C", root, "rev-parse", "--show-toplevel"], capture_output=True, check=True,
                             text=True).stdout.strip()
        base = os.path.abspath(root)
        files = [os.path.join(top, f) for f in out.decode().split("\0") if f]
        return [f for f in files if os.path.abspath(f).startswith(base + os.sep) and os.path.isfile(f)], True
    except (OSError, subprocess.CalledProcessError):
        pass
    files = []
    for d, dirs, fns in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        files += [os.path.join(d, f) for f in fns]
    return files, False


def _git(root, *args):
    return subprocess.run(["git", "-C", root, *args], capture_output=True, check=True).stdout.decode("utf-8", errors="replace")


def _ref_exists(root, ref):
    try:
        _git(root, "rev-parse", "--verify", "-q", ref + "^{commit}")
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def commit_messages(root, base=None):
    """["<sha>\0<body>", ...]: the last 200 commits plus every commit of base..HEAD (when base exists)."""
    out, seen = [], set()
    ranges = [["-n", "200"]] + ([[f"{base}..HEAD"]] if base and _ref_exists(root, base) else [])
    for r in ranges:
        try:
            msgs = _git(root, "log", *r, "--format=%H%x00%B%x01").split("\x01")
        except (OSError, subprocess.CalledProcessError):
            continue
        for m in msgs:
            sha = m.partition("\0")[0].strip()
            if sha and sha not in seen:
                seen.add(sha)
                out.append(m)
    return out


def history_lines(root, base):
    """(sha, path, text) of every line added by the commits of base..HEAD (diff to the first parent)."""
    if not base or not _ref_exists(root, base):
        return None
    try:
        log = _git(root, "log", "--first-parent", "-p", "--no-color", "--no-renames", "--format=%x01%H",
                   f"{base}..HEAD")
    except (OSError, subprocess.CalledProcessError):
        return None
    out, sha, path = [], None, None
    for line in log.splitlines():
        if line.startswith("\x01"):
            sha, path = line[1:].strip(), None
        elif line.startswith("Binary files "):
            path = None
        elif line.startswith("+++ "):
            path = line[4:].strip()
            path = path[2:] if path.startswith("b/") else path
        elif line.startswith("+") and not line.startswith("+++") and path:
            out.append((sha, path, line[1:]))
    return out


class Matcher:
    """Finds private terms, chord runs and lyric fragments in a line; reports only kind + index."""

    def __init__(self, rec_dir):
        terms, runs, grams = collect_all(rec_dir)
        self.n_terms, self.n_runs, self.n_grams = len(terms), len(runs), len(grams)
        self.term_res = [re.compile(re.escape(t).replace(r"\ ", SEP)) for t in terms]
        self.chord_res = [_chord_regex(r) for r in runs]
        self.by_first = {}  # first chord -> [(index, regex)]: a cheap substring test before the regex
        for i, (r, rx) in enumerate(zip(runs, self.chord_res)):
            self.by_first.setdefault(r[0], []).append((i, rx))
        self.grams = grams
        self.hum_runs = collect_hum(rec_dir)
        self.n_hum = len(self.hum_runs)
        self._hum_set = set(self.hum_runs)
        # interval sequence -> the run indexes it belongs to (transposed / octave-shifted copies)
        self._hum_iv = {}
        for i, r in enumerate(self.hum_runs):
            iv = intervals(r)
            if _distinctive_intervals(iv):
                self._hum_iv.setdefault(iv, set()).add(i)

    def hum_hits(self, text):
        """Humming note sequences found in a whole text (file, joined added lines, commit message)."""
        if not self._hum_set:
            return []
        seq = hum_pitches(text)
        wins = [tuple(seq[k:k + HUM_RUN]) for k in range(len(seq) - HUM_RUN + 1)]
        found = {i for i, r in enumerate(self.hum_runs) if r in set(wins)}
        moved = set()
        for w in wins:
            moved |= self._hum_iv.get(intervals(w), set())
        moved -= found
        allf = found | moved
        if not allf:
            return []
        return [f"humming note sequence ({len(allf)} of {self.n_hum} runs" + (", transposed form" if moved else "") + ")"]

    def name_hits(self, text):
        n = _norm(text)
        return [f"file name contains private term #{i + 1}" for i, rx in enumerate(self.term_res) if rx.search(n)]

    def line_hits(self, line):
        low = _norm(line)
        out = [f"private term #{i + 1}" for i, rx in enumerate(self.term_res) if rx.search(low)]
        hits = [i for fc, rxs in self.by_first.items() if fc in line for i, rx in rxs if rx.search(line)]
        out += [f"chord progression #{i + 1} from an annotation" for i in sorted(hits)]
        if self.grams and not self.grams.isdisjoint(_grams(line)):
            out.append("lyric fragment from a chart")
        return out


def check(root, rec_dir, check_log=True, base=DEFAULT_BASE, history=False, matcher=None):
    """-> list of violation strings (no private text in them)."""
    m = matcher or Matcher(rec_dir)
    files, is_git = tracked_files(root)
    rec_abs = os.path.abspath(rec_dir)
    bad = []
    for f in files:
        rel = os.path.relpath(f, root)
        if is_git and os.path.abspath(f).startswith(rec_abs + os.sep):
            bad.append(f"{rel}: private recordings folder is tracked")
            continue
        if os.path.abspath(f).startswith(rec_abs + os.sep):
            continue
        bad += [f"{rel}: {h}" for h in m.name_hits(rel.replace(os.sep, " "))]
        try:
            with open(f, "rb") as fh:
                raw = fh.read()
        except OSError:
            continue
        if b"\0" in raw[:8192]:
            continue
        text = raw.decode("utf-8", "replace")
        for ln, line in enumerate(text.splitlines(), 1):
            bad += [f"{rel}:{ln}: {h}" for h in m.line_hits(line)]
        bad += [f"{rel}: {h}" for h in m.hum_hits(text)]
    if check_log and is_git:
        for msg in commit_messages(root, base):
            sha, _, body = msg.partition("\0")
            hits = []
            for line in body.splitlines():
                hits += m.line_hits(line)
            hits += [h for h in m.line_hits(" ".join(body.split())) if h.startswith("private term")]
            hits += m.hum_hits(body)
            for h in dict.fromkeys(hits):
                bad.append(f"commit {sha.strip()[:8]}: {h}")
    if history and is_git:
        lines = history_lines(root, base)
        if lines is None:
            bad.append(f"history: base {base!r} not found (use --base)")
        else:
            rec_rel = os.path.relpath(rec_abs, _git(root, "rev-parse", "--show-toplevel").strip())
            seen = set()
            added = {}
            for sha, path, line in lines:
                added.setdefault((sha, path), []).append(line)
            for (sha, path), ls in added.items():
                if not path.startswith(rec_rel + "/"):
                    for h in m.hum_hits("\n".join(ls)):
                        key = (sha, path, h)
                        if key not in seen:
                            seen.add(key)
                            bad.append(f"history {sha[:8]} {path}: {h}")
            for sha, path, line in lines:
                if path.startswith(rec_rel + "/"):
                    key = (sha, path, "tracked")
                    if key not in seen:
                        seen.add(key)
                        bad.append(f"history {sha[:8]} {path}: private recordings folder was committed")
                    continue
                for h in m.name_hits(path.replace("/", " ")) + m.line_hits(line):
                    key = (sha, path, h)
                    if key not in seen:
                        seen.add(key)
                        bad.append(f"history {sha[:8]} {path}: {h}")
    return bad


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.path.dirname(here))
    ap.add_argument("--recordings", default=None, help="default: <analysis dir>/recordings")
    ap.add_argument("--no-log", action="store_true", help="do not scan commit messages")
    ap.add_argument("--base", default=DEFAULT_BASE, help="branch base: commits of BASE..HEAD are scanned")
    ap.add_argument("--history", action="store_true", help="also scan every line added by the commits of BASE..HEAD")
    a = ap.parse_args(argv)
    rec = a.recordings or os.path.join(os.path.dirname(here), "recordings")
    root = os.path.abspath(a.root)
    # default: scan the whole repo when it is available (git toplevel), else the analysis dir
    if a.root == os.path.dirname(here):
        try:
            root = subprocess.run(["git", "-C", root, "rev-parse", "--show-toplevel"], capture_output=True, check=True,
                                  text=True).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            pass
    m = Matcher(rec)
    bad = check(root, rec, not a.no_log, a.base, a.history, m)
    if bad:
        print(f"PRIVACY CHECK FAILED: {len(bad)} finding(s)")
        for b in bad:
            print("  " + b)
        return 1
    print(f"privacy check OK ({m.n_terms} terms, {m.n_runs} chord runs, {m.n_grams} lyric fragments, {m.n_hum} humming note runs checked"
          + (", branch history" if a.history else "") + ")")
    return 0


if __name__ == "__main__":
    sys.exit(main())
