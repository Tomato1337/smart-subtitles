#!/usr/bin/env python3
"""Build license-clean open English frequency + CEFR index for Smart Subtitles.

Downloads ONLY permissively licensed open lists (CC BY-SA 4.0 and CEFR-J educational attribution;
strictly excludes SUBTLEX-US and CSAVL/CSAVL-S) and writes `src-tauri/data/vocab.tsv.gz`.

Usage:
  python3 scripts/build-vocab.py [--cache-dir DIR] [--source-dir DIR] [--out FILE]
"""
from __future__ import annotations

import argparse
import csv
import gzip
import io
import math
import re
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "src-tauri" / "data" / "vocab.tsv.gz"

NGSL = "https://www.newgeneralservicelist.com/s/"
CEFRJ = "https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj/master/"

SOURCES = [
    ("NGSL_12_stats.csv", NGSL + "NGSL_12_stats.csv"),
    ("NGSL_12_lemmatized_for_research.csv", NGSL + "NGSL_12_lemmatized_for_research.csv"),
    ("NGSL-Spoken_12_stats.csv", NGSL + "NGSL-Spoken_12_stats.csv"),
    ("NGSL-Spoken_12_lemmatized_for_research.csv", NGSL + "NGSL-Spoken_12_lemmatized_for_research.csv"),
    ("BSL_120_stats.csv", NGSL + "BSL_120_stats.csv"),
    ("BSL_120_lemmatized_for_research.csv", NGSL + "BSL_120_lemmatized_for_research.csv"),
    ("cefrj-vocabulary-profile-1.5.csv", CEFRJ + "cefrj-vocabulary-profile-1.5.csv"),
    ("octanove-vocabulary-profile-c1c2-1.0.csv", CEFRJ + "octanove-vocabulary-profile-c1c2-1.0.csv"),
    (
        "en_50k.txt",
        "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt",
    ),
]

LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"]
WORD_RE = re.compile(r"^[a-z]+(?:'[a-z]+)?$")


def fetch(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (smart-subtitle build-vocab)"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
    if not data:
        raise RuntimeError(f"empty response from {url}")
    tmp = dest.with_name(dest.name + ".part")
    tmp.write_bytes(data)
    tmp.replace(dest)


def ensure_sources(cache_dir: Path, source_dir: Path | None) -> Path:
    if source_dir is not None:
        return source_dir
    cache_dir.mkdir(parents=True, exist_ok=True)
    for filename, url in SOURCES:
        dest = cache_dir / filename
        if dest.exists() and dest.stat().st_size > 0:
            print(f"keep  {filename}")
        else:
            print(f"fetch {url}")
            fetch(url, dest)
    return cache_dir


def read_text(path: Path) -> str:
    return path.read_bytes().decode("utf-8-sig")


def clean_word(w: str) -> str:
    return re.sub(r"\s+", " ", w.strip().lower())


def rows_without_comments(text: str) -> list[list[str]]:
    lines = [ln for ln in text.lstrip("\ufeff").splitlines() if ln.strip() and not ln.lstrip().startswith("##")]
    return [[c.strip() for c in row] for row in csv.reader(lines)]


def parse_ranked_csv(text: str) -> dict[str, int]:
    rows = rows_without_comments(text)
    if not rows:
        return {}
    header = [h.lower() for h in rows[0]]
    rank_col = next((i for i, h in enumerate(header) if h.endswith("rank")), None)
    out: dict[str, int] = {}
    for n, row in enumerate(rows[1:], 1):
        if not row or not row[0]:
            continue
        word = clean_word(row[0])
        rank = n
        if rank_col is not None and rank_col < len(row):
            raw = row[rank_col].removesuffix(".0")
            if raw.isdigit():
                rank = int(raw)
        if word not in out or rank < out[word]:
            out[word] = rank
    return out


def parse_forms_csv(text: str) -> dict[str, str]:
    rows = [r for r in rows_without_comments(text) if r and r[0]]
    forms: dict[str, str] = {}
    for row in rows:
        lemma = clean_word(row[0])
        if lemma not in ("lemma", "word", "headword"):
            forms.setdefault(lemma, lemma)
    for row in rows:
        lemma = clean_word(row[0])
        if lemma in ("lemma", "word", "headword"):
            continue
        for cell in row[1:]:
            for form in re.split(r"[,;]", cell):
                form = clean_word(form)
                if form:
                    forms.setdefault(form, lemma)
    return forms


def build_forms(ngsl: dict[str, int], ngsl_s: dict[str, int], *form_files: dict[str, str]) -> dict[str, str]:
    forms = {w: w for w in (*ngsl, *ngsl_s)}
    for table in form_files:
        for form, lemma in table.items():
            forms.setdefault(form, lemma)
    return forms


def expand_headword(headword: str) -> list[str]:
    variants = []
    for part in headword.split("/"):
        v = clean_word(part)
        if v and v not in variants:
            variants.append(v)
    return variants


def parse_cefr_csv(text: str, source_code: str) -> dict[str, tuple[str, str]]:
    reader = csv.DictReader(io.StringIO(text))
    out: dict[str, tuple[str, str]] = {}
    for row in reader:
        norm = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items() if k is not None}
        level = norm.get("cefr", "").upper()
        headword = norm.get("headword", "")
        if level not in LEVELS or not headword:
            continue
        for variant in expand_headword(headword):
            prev = out.get(variant)
            if prev is None or LEVELS.index(level) < LEVELS.index(prev[0]):
                out[variant] = (level, source_code)
    return out


def parse_en_50k(text: str) -> tuple[list[tuple[str, int, int]], int]:
    rows: list[tuple[str, int, int]] = []
    seen: set[str] = set()
    total_tokens = 0
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        word = clean_word(parts[0])
        if word in seen or not WORD_RE.match(word):
            continue
        try:
            count = int(parts[1])
        except ValueError:
            continue
        if count <= 0:
            continue
        seen.add(word)
        rank = len(rows) + 1
        rows.append((word, rank, count))
        total_tokens += count
    return rows, total_tokens


def build(src_dir: Path, out_path: Path) -> None:
    text = lambda name: read_text(src_dir / name)  # noqa: E731
    ngsl = parse_ranked_csv(text("NGSL_12_stats.csv"))
    ngsl_s = parse_ranked_csv(text("NGSL-Spoken_12_stats.csv"))
    bsl = parse_ranked_csv(text("BSL_120_stats.csv"))
    forms = build_forms(
        ngsl,
        ngsl_s,
        parse_forms_csv(text("NGSL_12_lemmatized_for_research.csv")),
        parse_forms_csv(text("NGSL-Spoken_12_lemmatized_for_research.csv")),
        parse_forms_csv(text("BSL_120_lemmatized_for_research.csv")),
    )
    cefr = parse_cefr_csv(text("cefrj-vocabulary-profile-1.5.csv"), "J")
    for word, val in parse_cefr_csv(text("octanove-vocabulary-profile-c1c2-1.0.csv"), "O").items():
        cefr.setdefault(word, val)

    fw_rows, total_tokens = parse_en_50k(text("en_50k.txt"))
    if total_tokens <= 0:
        raise RuntimeError("en_50k.txt produced zero valid tokens")

    lemmas: dict[str, dict] = {}

    def entry(lemma: str) -> dict:
        return lemmas.setdefault(lemma, {})

    for key, ranks in (("ngsl", ngsl), ("ngsl_s", ngsl_s), ("bsl", bsl)):
        for lemma, rank in ranks.items():
            entry(lemma)[key] = rank

    for lemma, (level, src_code) in cefr.items():
        e = entry(lemma)
        e["cefr"] = level
        e["cefr_src"] = src_code

    fw_counts: dict[str, int] = {}
    for form, rank, count in fw_rows:
        lemma = forms.get(form, form)
        e = entry(lemma)
        if "fw" not in e or rank < e["fw"]:
            e["fw"] = rank
        fw_counts[lemma] = fw_counts.get(lemma, 0) + count

    per_million_base = total_tokens / 1_000_000.0
    for lemma, count in fw_counts.items():
        zipf_x100 = round((math.log10(count / per_million_base) + 3.0) * 100)
        lemmas[lemma]["zipf_x100"] = max(0, min(999, zipf_x100))

    lines = ["# vocab v1", "@lemmas"]
    for lemma in sorted(lemmas):
        e = lemmas[lemma]
        row = [
            lemma,
            str(e["ngsl"]) if "ngsl" in e else "",
            str(e["ngsl_s"]) if "ngsl_s" in e else "",
            str(e["bsl"]) if "bsl" in e else "",
            str(e["fw"]) if "fw" in e else "",
            str(e["zipf_x100"]) if "zipf_x100" in e else "",
            e.get("cefr", ""),
            e.get("cefr_src", ""),
        ]
        lines.append("\t".join(row))

    lines.append("@forms")
    folded_forms = {f: l for f, l in forms.items() if f != l}
    for form in sorted(folded_forms):
        lines.append(f"{form}\t{folded_forms[form]}")

    payload = ("\n".join(lines) + "\n").encode("utf-8")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_name(out_path.name + ".part")
    with tmp.open("wb") as raw_f:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw_f, compresslevel=9, mtime=0) as gz:
            gz.write(payload)
    tmp.replace(out_path)

    print(
        f"NGSL {len(ngsl)} · NGSL-S {len(ngsl_s)} · BSL {len(bsl)} · "
        f"CEFR {len(cefr)} · FW {len(fw_rows)} ({total_tokens:,} tokens)"
    )
    print(f"lemmas {len(lemmas)} · forms {len(folded_forms)} · {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache-dir", type=Path, default=None, help="Directory to cache downloaded raw lists")
    ap.add_argument("--source-dir", type=Path, default=None, help="Existing directory containing all 9 source files")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"Output .tsv.gz path (default: {DEFAULT_OUT})")
    args = ap.parse_args(argv)

    if args.source_dir is not None:
        build(args.source_dir, args.out)
    elif args.cache_dir is not None:
        src = ensure_sources(args.cache_dir, None)
        build(src, args.out)
    else:
        with tempfile.TemporaryDirectory(prefix="smart-subtitle-vocab-") as tmp:
            src = ensure_sources(Path(tmp), None)
            build(src, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
