"""Spike 3 T3: convert the theory tables (py/dsp/tables/*.toml, the only source) to ts/tables/<name>.json.

    python py/tools/tables_to_json.py          # (re)write ts/tables/*.json
    python py/tools/tables_to_json.py --check  # exit 1 if a committed JSON differs from a fresh conversion

Each JSON is the parsed TOML dict (the same structure the analyzer loads) plus `_source`: the provenance lines
from the TOML header comments (`# source:` block and `# books:` line), so the TS port keeps where the numbers
come from. Output is deterministic: sorted keys, 2-space indent, json float repr, trailing newline.
The drift guard is py/tests/test_tables_to_json.py (regenerate in memory, compare with the committed files).
"""
import json
import os
import sys
import tomllib

PY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(PY)  # spikes/analysis
TABLES_DIR = os.path.join(PY, 'dsp', 'tables')
JSON_DIR = os.path.join(ROOT, 'ts', 'tables')
NAMES = ('harmony', 'key_fit')


def source_lines(text: str) -> list[str]:
    """Header comment lines of `# source:` (with its indented continuation lines) and `# books:`."""
    out: list[str] = []
    in_source = False
    for raw in text.splitlines():
        if not raw.startswith('#'):
            break
        body = raw[1:].rstrip()
        if body.startswith(' source:') or body.startswith(' books:'):
            in_source = body.startswith(' source:')
            out.append(' '.join(body.split()))
        elif in_source and body.startswith('  ') and body.strip():
            out.append(' '.join(body.split()))
        else:
            in_source = False
    return out


def convert(name: str) -> str:
    path = os.path.join(TABLES_DIR, name + '.toml')
    with open(path, 'rb') as f:
        raw = f.read()
    data = tomllib.loads(raw.decode('utf-8'))
    src = source_lines(raw.decode('utf-8'))
    if not any(s.startswith('source:') for s in src) or not any(s.startswith('books:') for s in src):
        raise ValueError(f'{name}.toml: header lacks source / books lines')
    if '_source' in data:
        raise ValueError(f'{name}.toml: reserved key _source')
    data['_source'] = '\n'.join(src)
    return json.dumps(data, sort_keys=True, indent=2, ensure_ascii=False) + '\n'


def json_path(name: str) -> str:
    return os.path.join(JSON_DIR, name + '.json')


def main(argv: list[str]) -> int:
    check = '--check' in argv
    bad = 0
    for name in NAMES:
        text = convert(name)
        if check:
            try:
                with open(json_path(name), encoding='utf-8') as f:
                    same = f.read() == text
            except FileNotFoundError:
                same = False
            if not same:
                print(f'DRIFT: {json_path(name)}')
                bad += 1
        else:
            os.makedirs(JSON_DIR, exist_ok=True)
            with open(json_path(name), 'w', encoding='utf-8', newline='\n') as f:
                f.write(text)
            print('wrote', json_path(name))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
