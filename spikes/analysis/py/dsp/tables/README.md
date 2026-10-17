# py/dsp/tables — hand-made tables for the analyzer

Rules for the table files here (docs/audio-spike2-plan.md, design decision 13 and the 「AI を使わない」 rule).

- Format: TOML (`*.toml`), read with Python 3.12's standard `tomllib` (no extra dependency). Keep each file small and readable by a person.
- Every file starts with a comment block that says where its values come from. Only two sources are allowed:
  1. **Music theory** (harmony: chord functions, progressions). Cite only the sections (§) of the note 「和声法ノート v3（band-sheets 音声解析用）」. No book is cited: the user has no books at hand, the note summarizes general harmony / popular-music theory in our own words (`# books: なし…`, user answer 2026-10-17). Never copy text from a book.
  2. **Tuning on our own synthetic audio / recordings** (weights only). Cite the T14 round, e.g. `# weights: T14 round 2`. Follow the held-out rules (never tune on held-out data).
- Not allowed: values taken from chord sheets or corpora on the internet (e.g. ChordWiki), and anything from a trained model.
- Never write the title, chords or file name of a private recording here.

Planned files:

| File          | Task                                   | Content                                                     |
| ------------- | -------------------------------------- | ----------------------------------------------------------- |
| `key_fit.toml` | T22 (weights: T14)                     | how well a chord fits a key (diatonic, borrowed, secondary) |
| `harmony.toml` | T26 (weights: T14)                     | transition bonuses by function (T-S-D, V/V, tritone sub …)  |

Example header:

```toml
# source: note 「和声法ノート v3（band-sheets 音声解析用）」 §3
# books:  なし（手元の文献なし。根拠は和声法ノート v3 の § のみ）
# weights: T14 round 1
```
