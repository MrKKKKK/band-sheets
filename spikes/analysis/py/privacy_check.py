"""Check that nothing about the private recordings leaked into git-tracked files (task T3).

Usage: python py/privacy_check.py [--root DIR] [--recordings DIR] [--no-log]
Exit 0 = clean, 1 = a private term was found, 2 = usage error.

Private terms are read at RUNTIME from the gitignored recordings folder (nothing private is embedded here):
  * the stems of every file in recordings/ and the original file names in ids.local.json,
  * every non-empty line of recordings/private-terms.local.txt (song titles, artists; one per line),
  * annotation "title" / "artist" fields,
  * T28 chord-chart-only songs, recordings/charts/: the stems of the chart *.txt files, the original names in
    charts/ids.local.json, the comment lines (# ...) of the charts and every run of 6 chords of their bar lines,
  * every run of 6 consecutive chords (>= 3 distinct) from the *.chords.json annotations (chord progressions).
Matching ignores case and treats space / _ / - / . as the same. Anonymous names (rec, rec-01 ...) and very short
terms (< 4 characters) are ignored. Scanned: git-tracked files under --root (or, without git, every text file
outside out/, recordings/, node_modules/, .git/) and the last 200 commit messages. A tracked file under recordings/
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
SKIP_DIRS = {"out", "recordings", "node_modules", ".git", "soundfonts", "__pycache__"}
SEP = r"[\s_\-.]+"


def _norm(t):
    return re.sub(SEP, " ", t.strip().lower())


def chart_texts(text):
    """(comment lines, chord sequence) of a chart .txt, read leniently (no validation, so a broken chart is still
    covered): comments = lines starting with '#'; chords = the tokens of the '|' lines without '.' and N.C."""
    comments, seq = [], []
    for raw in text.lstrip("\ufeff").splitlines():
        line = unicodedata.normalize("NFKC", raw).replace("\u266f", "#").replace("\u266d", "b").strip()
        if line.startswith("#"):
            comments.append(line.lstrip("#").strip())
        elif line.startswith("|"):
            for tok in line.replace("|", " ").split():
                if tok != "." and tok.upper() not in ("N.C.", "N") and (not seq or seq[-1] != tok):
                    seq.append(tok)
    return comments, seq


def _runs(seq):
    out = set()
    for i in range(len(seq) - CHORD_RUN + 1):
        w = seq[i:i + CHORD_RUN]
        if len(set(w)) >= 3:
            out.add(tuple(w))
    return out


def collect_terms(rec_dir):
    """-> (text_terms, chord_runs); both lists of strings. Never printed."""
    terms = set()
    if not os.path.isdir(rec_dir):
        return [], []
    for sub in ("", "inbox", "originals"):
        d = os.path.join(rec_dir, sub)
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if fn.startswith(".") or fn in ("ids.local.json", "private-terms.local.txt") \
                    or not os.path.isfile(os.path.join(d, fn)):
                continue
            terms.add(fn.split(".")[0] if fn.endswith(".chords.json") else os.path.splitext(fn)[0])
    chart_runs = set()
    cdir = os.path.join(rec_dir, "charts")
    if os.path.isdir(cdir):
        for fn in os.listdir(cdir):
            p = os.path.join(cdir, fn)
            if fn.startswith(".") or not os.path.isfile(p) or not fn.lower().endswith(".txt"):
                continue
            terms.add(os.path.splitext(fn)[0])
            try:
                comments, seq = chart_texts(open(p, encoding="utf-8", errors="replace").read())
            except OSError:
                continue
            terms.update(comments)
            chart_runs |= _runs(seq)
        cids = os.path.join(cdir, "ids.local.json")
        if os.path.exists(cids):
            try:
                for e in json.load(open(cids, encoding="utf-8")).get("charts", {}).values():
                    terms.add(os.path.splitext(e.get("original", ""))[0])
            except ValueError:
                pass
    ids_p = os.path.join(rec_dir, "ids.local.json")
    if os.path.exists(ids_p):
        for e in json.load(open(ids_p)).get("recordings", {}).values():
            terms.add(os.path.splitext(e.get("original", ""))[0])
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
        for i in range(len(seq) - CHORD_RUN + 1):
            w = seq[i:i + CHORD_RUN]
            if len(set(w)) >= 3:
                runs.add(tuple(w))
    anon = r"(rec|chart)( \d+)?( max)?( (block|rec|rechard))?"
    good = sorted({_norm(t) for t in terms if len(_norm(t)) >= 4 and not re.fullmatch(anon, _norm(t))})
    return good, sorted(runs)


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


def commit_messages(root):
    try:
        return subprocess.run(["git", "-C", root, "log", "-n", "200", "--format=%H%x00%B%x01"], capture_output=True,
                              check=True, text=True).stdout.split("\x01")
    except (OSError, subprocess.CalledProcessError):
        return []


def check(root, rec_dir, check_log=True):
    """-> list of violation strings (no private text in them)."""
    terms, runs = collect_terms(rec_dir)
    term_res = [re.compile(re.escape(t).replace(r"\ ", SEP)) for t in terms]
    chord_res = [_chord_regex(r) for r in runs]
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
        name_n = _norm(rel.replace(os.sep, " "))
        for i, rx in enumerate(term_res):
            if rx.search(name_n):
                bad.append(f"{rel}: file name contains private term #{i + 1}")
        try:
            with open(f, "rb") as fh:
                raw = fh.read()
        except OSError:
            continue
        if b"\0" in raw[:8192]:
            continue
        for ln, line in enumerate(raw.decode("utf-8", "replace").splitlines(), 1):
            low = _norm(line)
            for i, rx in enumerate(term_res):
                if rx.search(low):
                    bad.append(f"{rel}:{ln}: private term #{i + 1}")
            for i, rx in enumerate(chord_res):
                if rx.search(line):
                    bad.append(f"{rel}:{ln}: chord progression #{i + 1} from an annotation")
    if check_log and is_git:
        for msg in commit_messages(root):
            sha, _, body = msg.partition("\0")
            low = _norm(body)
            for i, rx in enumerate(term_res):
                if rx.search(low):
                    bad.append(f"commit {sha.strip()[:8]}: private term #{i + 1}")
    return bad


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.path.dirname(here))
    ap.add_argument("--recordings", default=None, help="default: <analysis dir>/recordings")
    ap.add_argument("--no-log", action="store_true", help="do not scan commit messages")
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
    bad = check(root, rec, not a.no_log)
    terms, runs = collect_terms(rec)
    if bad:
        print(f"PRIVACY CHECK FAILED: {len(bad)} finding(s)")
        for b in bad:
            print("  " + b)
        return 1
    print(f"privacy check OK ({len(terms)} terms, {len(runs)} chord runs checked)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
