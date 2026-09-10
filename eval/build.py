#!/usr/bin/env python3
"""Build the sealed evaluation package + the crosswalk that holds the answers.

    python3 eval/build.py [--package-dir DIR] [--keys-dir DIR] [--force]

Two directory trees come out, and they are NEVER nested:

    <package-dir>/   ships to the grader.  No labels, no post ids, no chunk ids,
                     no dates, no handles.  BRIEF.md taxonomy.md items.jsonl
                     schema.md examples.jsonl MANIFEST.txt
    <keys-dir>/      stays behind, gitignored.  crosswalk.csv taxonomy_map.json
                     repeats.csv calibration.csv no-sweep.txt build-report.json

Deterministic by construction: every ordering is a sha256 over the post id and
a fixed salt, there is no RNG, no clock reads and no timestamps in any output,
so two runs produce byte-identical trees.

DEVIATIONS from the design brief are collected in DEVIATIONS below and echoed
into <keys-dir>/build-report.json.  None of them is silent.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import frame as frame_mod  # noqa: E402

EVAL_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(EVAL_DIR)

DEVIATIONS = []


def deviate(tag, text):
    DEVIATIONS.append({"tag": tag, "detail": text})
    print(f"[deviation:{tag}] {text}")


# --------------------------------------------------------------------------
# BRIEF.md key repair (§5 of the design vs the §3.2-C2 rekeying rule)
# --------------------------------------------------------------------------
# C2 fixes the opaque keys as M01..M15 in the ALPHABETICAL order of the original
# macro keys.  Under that rule M05 = district & constituent services (which has
# no subtopics at all), M12 = labor, M14 = reproductive rights.  The worked
# examples in §5 use M05 for the economy, M12_S01 for gun violence and M14 for
# technology, i.e. they were written against a different numbering.  Shipping
# them verbatim would hand the grader worked examples that point at the wrong
# categories and one key (M05_S01) that does not exist.  Each illustration is
# therefore re-pointed at the key that carries the concept the surrounding prose
# names.  Nothing else in the brief is touched.
BRIEF_KEY_FIXES = [
    ('`["M05", "M05_S01"]`, do **not** also emit `["M05", null]`',
     '`["M07", "M07_S03"]`, do **not** also emit `["M07", null]`',
     'rule 4 example: economy / prices-inflation'),
    ('a post about a new rural broadband grant is `[["M14", null]]`',
     'a post about a new rural broadband grant is `[["M15", null]]`',
     'rule 6 example: technology is M15'),
    ('`[["M12", "M12_S01"]]` (guns & public safety / gun violence)',
     '`[["M13", "M13_S02"]]` (guns & public safety / gun violence)',
     '[] boundary example: public-safety / gun-violence'),
    (' "labels":[["M05","M05_S01"],["M07",null]],',
     ' "labels":[["M07","M07_S03"],["M10",null]],',
     'schema example: grocery costs (economy/prices) + health care'),
    (' "alternatives":[["M02",null]],',
     ' "alternatives":[["M01",null]],',
     'schema example: a defensible near-miss for a costs/premiums post'),
    ('Keys are the ids left of the colon in `taxonomy.md` (`"M05"`, `"M05_S01"`),',
     'Keys are the ids left of the colon in `taxonomy.md` (`"M07"`, `"M07_S03"`),',
     'field rules: use keys that exist'),
]

# Concepts the fixed keys must actually carry — asserted against taxonomy_map.
BRIEF_KEY_EXPECTATIONS = {
    "M07": "economy",
    "M07_S03": "economy/prices-inflation",
    "M10": "healthcare",
    "M13": "public-safety",
    "M13_S02": "public-safety/gun-violence",
    "M15": "tech",
    "M01": "budget-appropriations",
}

# --------------------------------------------------------------------------
# Paraphrase canaries (§3.3): swap exactly one place name per post.
# --------------------------------------------------------------------------
# A city is swapped for an invented town, which keeps the sentence natural and
# cannot be searched for.  A state would have to be swapped for another real
# state, which risks moving the label (a "Texas border" post is not a "Vermont
# border" post), so states are only a fallback and the build prefers cities.
CANARY_CITIES = [
    "Akron", "Albany", "Allentown", "Anaheim", "Arlington", "Atlanta", "Aurora",
    "Austin", "Bakersfield", "Baltimore", "Baton Rouge", "Bethlehem",
    "Birmingham", "Boise", "Boston", "Bridgeport", "Brooklyn", "Buffalo",
    "Cambridge", "Camden", "Charlotte", "Chattanooga", "Chicago", "Cincinnati",
    "Cleveland", "Columbus", "Dallas", "Dayton", "Denver", "Des Moines",
    "Detroit", "Durham", "El Paso", "Flint", "Fresno", "Grand Rapids",
    "Greensboro", "Harrisburg", "Hartford", "Houston", "Indianapolis",
    "Jacksonville", "Kalamazoo", "Kansas City", "Knoxville", "Lansing",
    "Las Vegas", "Lexington", "Little Rock", "Long Beach", "Louisville",
    "Lowell", "Madison", "Memphis", "Mesa", "Miami", "Milwaukee", "Minneapolis",
    "Modesto", "Nashville", "Newark", "Norfolk", "Oakland", "Oklahoma City",
    "Omaha", "Orlando", "Paterson", "Philadelphia", "Phoenix", "Pittsburgh",
    "Portland", "Providence", "Raleigh", "Reno", "Richmond", "Riverside",
    "Rochester", "Sacramento", "Salem", "San Antonio", "San Jose", "Savannah",
    "Scranton", "Seattle", "Spokane", "Springfield", "St. Louis", "Stockton",
    "Syracuse", "Tacoma", "Tampa", "Toledo", "Trenton", "Tucson", "Tulsa",
    "Wichita", "Wilmington", "Worcester", "Yonkers", "Youngstown",
]
CANARY_STATES = [
    "Alabama", "Arizona", "Arkansas", "California", "Colorado", "Connecticut",
    "Delaware", "Florida", "Georgia", "Illinois", "Indiana", "Iowa", "Kansas",
    "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan",
    "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada",
    "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Tennessee", "Texas", "Utah",
    "Vermont", "Virginia", "Washington", "Wisconsin", "Wyoming",
]
CITY_SUBSTITUTES = [
    "Ashford", "Bellview", "Cedar Falls", "Clearwater Bend", "Eastvale",
    "Fairhaven", "Glenmont", "Harborview", "Kingsford", "Lakeport",
    "Maplewood", "Northfield", "Oakridge", "Pinehurst", "Riverton",
    "Stonebridge", "Summerfield", "Westbrook", "Willowdale", "Yorkfield",
]


def sha256_hex(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def write_text(path, text):
    """Every shipped file is UTF-8 with LF endings and a trailing newline."""
    if not text.endswith("\n"):
        text += "\n"
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


class BuildError(RuntimeError):
    pass


# ==========================================================================
# 1. sampling
# ==========================================================================

def draw_stratum(fr, spec, taken):
    """Hash-ordered walk with per-chunk caps (§2.1, §2.2)."""
    sid, n_h, cap = spec["id"], spec["n_h"], spec.get("cap")
    pool = [p for p in fr.pools[sid] if p not in taken]
    picked, per_chunk, skipped_by_cap = [], {}, 0
    for pid in pool:
        if len(picked) >= n_h:
            break
        cid = fr.post_chunk.get(pid)
        if cap is not None and cid is not None:
            if per_chunk.get(cid, 0) >= cap:
                skipped_by_cap += 1
                continue
            per_chunk[cid] = per_chunk.get(cid, 0) + 1
        picked.append(pid)
    return picked, {"skipped_by_cap": skipped_by_cap,
                    "distinct_chunks": len({fr.post_chunk.get(p) for p in picked} - {None})}


def draw_s09(fr, spec, taken):
    """§2.1 greedy subtopic coverage: walk the hash-ordered pool taking any post
    that still supplies an under-quota subtopic (quota = min(corpus_count, 3))."""
    n_h = spec["n_h"]
    quota_cap = spec.get("coverage_quota", 3)
    corpus_counts = fr.subtopic_corpus_counts()
    pool = [p for p in fr.pools["S09"] if p not in taken]
    quota = {pair: min(cnt, quota_cap) for pair, cnt in corpus_counts.items()}
    have = {pair: 0 for pair in quota}
    picked = []
    for pid in pool:
        if len(picked) >= n_h:
            break
        subs = sorted(fr.subtopics_of(pid))
        if any(have.get(pair, 0) < quota.get(pair, 0) for pair in subs):
            picked.append(pid)
            for pair in subs:
                have[pair] = have.get(pair, 0) + 1
    filled_by_coverage = len(picked)
    if len(picked) < n_h:  # top up in hash order
        for pid in pool:
            if len(picked) >= n_h:
                break
            if pid not in picked:
                picked.append(pid)
                for pair in sorted(fr.subtopics_of(pid)):
                    have[pair] = have.get(pair, 0) + 1
    shortfall = {f"{m}/{s}": {"quota": quota[(m, s)], "reached": have.get((m, s), 0),
                              "corpus_count": corpus_counts[(m, s)]}
                 for (m, s) in sorted(quota) if have.get((m, s), 0) < quota[(m, s)]}
    covered = sum(1 for pair in quota if have.get(pair, 0) > 0)
    return picked, {"filled_by_coverage": filled_by_coverage,
                    "subtopics_in_corpus": len(quota),
                    "subtopics_covered": covered,
                    "shortfall": shortfall}


def macro_topup(fr, taken, floor):
    """§2.3: bring every macro to >= `floor` sampled posts, hash order."""
    def counts():
        out = {m: 0 for m in fr.tax}
        for pid in taken:
            for m in fr.macros_of(pid):
                out[m] = out.get(m, 0) + 1
        return out

    before = counts()
    added = []
    for macro in sorted(fr.tax):
        while counts().get(macro, 0) < floor:
            pool = [p for p in fr.order
                    if p not in taken and macro in fr.macros_of(p)]
            pool.sort(key=fr.hash_key)
            if not pool:
                deviate("S20-exhausted",
                        f"macro {macro} cannot reach the {floor}-post floor: "
                        f"only {counts().get(macro, 0)} available in the frame")
                break
            pid = pool[0]
            taken.add(pid)
            added.append(pid)
    return added, before, counts()


# ==========================================================================
# 2. repeat items (§3.3)
# ==========================================================================

def _banned_terms(fr):
    """Never touch a word the taxonomy itself screens on (e.g. "Dilley")."""
    banned = set()
    for terms in fr.alias_terms.values():
        for t in terms:
            banned.add(t.lower())
            for w in re.split(r"[^0-9A-Za-z]+", t):
                if w:
                    banned.add(w.lower())
    return banned


def find_place(fr, text, names, banned):
    """First swappable place name in the post: word boundary, not a handle,
    not inside a link, and never a term the taxonomy screens on."""
    link_spans = [(m.start(), m.end()) for m in re.finditer(r"https?://\S+", text)]
    best = None
    for place in names:
        if place.lower() in banned:
            continue
        for m in re.finditer(r"(?<![@#\w])" + re.escape(place) + r"(?![\w])", text):
            if any(a <= m.start() < b for a, b in link_spans):
                continue
            if best is None or m.start() < best[1]:
                best = (place, m.start())
            break
    return best[0] if best else None


def make_canary(fr, pid, text, kind, banned):
    names = CANARY_CITIES if kind == "city" else CANARY_STATES
    subs = CITY_SUBSTITUTES if kind == "city" else CANARY_STATES
    place = find_place(fr, text, names, banned)
    if place is None:
        return None
    h = int(sha256_hex(f"{pid}|canary-sub"), 16)
    for i in range(len(subs)):
        sub = subs[(h + i) % len(subs)]
        if sub.lower() == place.lower() or sub in text or sub.lower() in banned:
            continue
        new = re.sub(r"(?<![@#\w])" + re.escape(place) + r"(?![\w])", sub, text)
        if new != text:
            return {"place": place, "substitute": sub, "kind": kind, "text": new}
    return None


def pick_repeats(fr, drawn, cfg):
    n_can = cfg["repeats"]["paraphrase_canaries"]
    n_twin = cfg["repeats"]["verbatim_twins"]
    banned = _banned_terms(fr)
    candidates = sorted(drawn, key=lambda p: sha256_hex(f"{p}|canary"))
    canaries = []
    for kind in ("city", "state"):  # cities first: an invented town moves no label
        for pid in candidates:
            if len(canaries) >= n_can:
                break
            if any(c["post_id"] == pid for c in canaries):
                continue
            made = make_canary(fr, pid, fr.posts[pid]["text"], kind, banned)
            if made:
                made["post_id"] = pid
                canaries.append(made)
    if len(canaries) < n_can:
        raise BuildError(
            f"only {len(canaries)} of {n_can} paraphrase canaries could be built "
            "— widen CANARY_PLACES")
    used = {c["post_id"] for c in canaries}
    twins = [p for p in sorted(drawn, key=lambda p: sha256_hex(f"{p}|twin"))
             if p not in used][:n_twin]
    if len(twins) < n_twin:
        raise BuildError("not enough drawn posts to build the verbatim twins")
    return twins, canaries


# ==========================================================================
# 3. ordering (§2.2 + §3.3 separation)
# ==========================================================================

def order_items(items, min_sep):
    """Sort by the order hash, then repair twin/original separation."""
    seq = sorted(items, key=lambda it: it["order_key"])
    by_post = {}
    for i, it in enumerate(seq):
        by_post.setdefault(it["post_id"], []).append(i)
    repeat_posts = {p for p, idx in by_post.items() if len(idx) > 1}
    free = [i for i, it in enumerate(seq) if it["post_id"] not in repeat_posts]
    free_set = set(free)
    n = len(seq)
    moves = 0
    for pid in sorted(repeat_posts):
        while True:
            pos = [i for i, it in enumerate(seq) if it["post_id"] == pid]
            if len(pos) < 2 or abs(pos[1] - pos[0]) >= min_sep:
                break
            origin, dup = pos[0], pos[1]
            target = None
            for off in range(n):
                cand = (origin + n // 2 + off) % n
                if cand in free_set and abs(cand - origin) >= min_sep:
                    target = cand
                    break
            if target is None:
                raise BuildError(f"cannot separate the repeat pair for {pid}")
            seq[dup], seq[target] = seq[target], seq[dup]
            free_set.discard(target)
            free_set.add(dup)
            moves += 1
    for pid in sorted(repeat_posts):
        pos = [i for i, it in enumerate(seq) if it["post_id"] == pid]
        if abs(pos[1] - pos[0]) < min_sep:
            raise BuildError(f"repeat pair for {pid} still closer than {min_sep}")
    for i, it in enumerate(seq):
        it["item_id"] = f"E{i + 1:04d}"
        it["position"] = i
    return seq, moves


# ==========================================================================
# 4. the shipped taxonomy (§3.2 C2)
# ==========================================================================

def rekey_taxonomy(fr):
    macro_map, sub_map = {}, {}
    lines = []
    for mi, mkey in enumerate(sorted(fr.tax), start=1):
        mid = f"M{mi:02d}"
        macro_map[mid] = mkey
        macro = fr.tax[mkey]
        lines.append(f"- {mid}: {macro['label']}")
        for si, skey in enumerate(sorted(macro.get("subtopics") or {}), start=1):
            sid = f"{mid}_S{si:02d}"
            sub_map[sid] = f"{mkey}/{skey}"
            sub = macro["subtopics"][skey]
            aliases = sub.get("aliases") or []
            extra = f" (also: {', '.join(aliases)})" if aliases else ""
            lines.append(f"  - {sid}: {sub['label']}{extra}")
    body = "\n".join(lines)
    header = (
        "# Topic taxonomy\n\n"
        f"{len(macro_map)} macro topics, {len(sub_map)} subtopics. This list is "
        "closed: every key you may use is below.\nThe `(also: ...)` notes are "
        "hints about what a subtopic covers, not matching rules.\n\n"
    )
    return header + body + "\n", macro_map, sub_map


# ==========================================================================
# 5. package writing
# ==========================================================================

SCHEMA_MD = """# Output format

One JSON object per line, one line per item, in the order the items were given.
No prose, no markdown fences, nothing between the lines.

```json
{"item_id":"E0142",
 "labels":[["M07","M07_S03"],["M10",null]],
 "confidence":"high",
 "basis":"debatable",
 "alternatives":[["M01",null]],
 "gap":null,
 "unreadable":null,
 "note":"Grocery costs plus premiums; health care is secondary."}
```

| field | type | rule |
|---|---|---|
| `item_id` | string | exactly as given, every item once, in order |
| `labels` | array of pairs | 0-4 `[macro_key, subtopic_key_or_null]` pairs; keys come from `taxonomy.md`; no pair twice |
| `confidence` | string | `"high"` / `"medium"` / `"low"` — how sure you are of your own set |
| `basis` | string | `"clear"` / `"debatable"` — `debatable` whenever a careful reader could defend an alternative |
| `alternatives` | array of pairs | 0-2 pairs you weighed and did not assign. Never padded |
| `gap` | string or null | kebab-case subject when no macro fits at all; `labels` must then be `[]` |
| `unreadable` | string or null | `null` / `"truncated"` / `"no-text"` / `"not-english"` |
| `note` | string | <= 25 words, plain English, no numbers longer than 6 digits |

A macro-only judgement is `[macro, null]` — that is a label, not a gap.
`labels: []` with `gap: null` means the post has no policy content at all.

Hand back one file, `verdicts.jsonl`, and nothing else.
"""


def examples_lines():
    """Seven worked output lines, keyed to the worked cases in BRIEF.md."""
    return [
        {"item_id": "X001",
         "labels": [["M07", "M07_S03"], ["M10", None]],
         "confidence": "high", "basis": "debatable",
         "alternatives": [["M01", None]], "gap": None, "unreadable": None,
         "note": "Grocery costs plus premiums; health care is secondary."},
        {"item_id": "X002", "labels": [], "confidence": "high", "basis": "clear",
         "alternatives": [], "gap": None, "unreadable": None,
         "note": "Parade invitation, pure scheduling, no policy content."},
        {"item_id": "X003", "labels": [["M13", "M13_S02"]], "confidence": "high",
         "basis": "clear", "alternatives": [], "gap": None, "unreadable": None,
         "note": "Condolence after a shooting still counts as gun violence."},
        {"item_id": "X004", "labels": [], "confidence": "medium", "basis": "clear",
         "alternatives": [], "gap": "agriculture-farm-policy", "unreadable": None,
         "note": "Farm bill payment schedule; no macro covers agriculture."},
        {"item_id": "X005", "labels": [["M05", None]], "confidence": "high",
         "basis": "clear", "alternatives": [], "gap": None, "unreadable": None,
         "note": "Casework helping families obtain benefits."},
        {"item_id": "X006", "labels": [["M11", "M11_S05"]], "confidence": "medium",
         "basis": "debatable", "alternatives": [["M06", None]], "gap": None,
         "unreadable": "truncated",
         "note": "Cut off mid-sentence but the enforcement raid is explicit."},
        {"item_id": "X007", "labels": [], "confidence": "low", "basis": "clear",
         "alternatives": [], "gap": None, "unreadable": "no-text",
         "note": "Bare link with no words to judge."},
    ]


def build_brief(cfg, sub_map, macro_map):
    # Relative paths resolve against eval/, so the source travels with the
    # repo. It used to point at a session scratchpad, which meant the build
    # stopped being reproducible the moment that session ended.
    src = cfg["package"]["brief_source"]
    if not os.path.isabs(src):
        src = os.path.join(EVAL_DIR, src)
    with open(src, encoding="utf-8") as fh:
        text = fh.read()
    applied = []
    for old, new, why in BRIEF_KEY_FIXES:
        if old not in text:
            raise BuildError(f"BRIEF source does not contain the expected string: {old!r}")
        text = text.replace(old, new)
        applied.append({"from": old.strip(), "to": new.strip(), "why": why})
    for key, expect in BRIEF_KEY_EXPECTATIONS.items():
        got = sub_map.get(key) or macro_map.get(key)
        if got != expect:
            raise BuildError(f"rekeying moved {key}: expected {expect}, got {got}")
    deviate("BRIEF-keys",
            "§5's worked-example keys were re-pointed at the concepts the prose "
            "names, because C2's alphabetical numbering gives them different "
            f"meanings ({len(applied)} substitutions, listed in build-report.json)")
    return text, applied


# ==========================================================================
# 6. assertions (§3.2 C4)
# ==========================================================================

FORBIDDEN_FILENAME = re.compile(
    r"topics|rollup|report|stories|narrative|incident|correction|metrics|"
    r"caucus|pulse|4p42kvv8gp|github", re.I)
HARD_CONTENT_BANS = ["caucus-pulse", "caucus pulse", "4p42kvv8gp",
                     "data/topics", "data/archive", "config/taxonomy",
                     "classify.js", "rollup.js", "topic-days", "topics-live"]
SOFT_CONTENT_TOKENS = ["caucus", "pulse", "github"]
DIGIT_RUN = re.compile(r"\d{15,}")


def run_assertions(fr, pkg, items, macro_map, sub_map, canaries, report):
    """C4.1-C4.8. Any failure raises; the caller deletes the partial package."""
    checks = []

    def ok(name, passed, detail=""):
        checks.append({"check": name, "pass": bool(passed), "detail": detail})
        if not passed:
            raise BuildError(f"{name}: {detail}")

    files = sorted(os.listdir(pkg))
    contents = {}
    for name in files:
        path = os.path.join(pkg, name)
        ok("C4.6-no-symlink", not os.path.islink(path), name)
        with open(path, encoding="utf-8") as fh:
            contents[name] = fh.read()

    # C4.1 — items.jsonl shape
    # NB: split on "\n" only — a post text may contain U+2028/U+2029,
    # which str.splitlines() would treat as a line break.
    lines = contents["items.jsonl"].rstrip("\n").split("\n")
    ok("C4.1-line-count", len(lines) == len(items),
       f"{len(lines)} lines vs {len(items)} items")
    seen = set()
    for i, line in enumerate(lines):
        obj = json.loads(line)
        ok("C4.1-key-set", set(obj) == {"item_id", "text"}, f"line {i + 1}: {sorted(obj)}")
        ok("C4.1-types", isinstance(obj["item_id"], str) and isinstance(obj["text"], str),
           f"line {i + 1}")
        ok("C4.1-unique-id", obj["item_id"] not in seen, obj["item_id"])
        seen.add(obj["item_id"])
    ok("C4.1-id-sequence", [json.loads(l)["item_id"] for l in lines]
       == [f"E{i + 1:04d}" for i in range(len(lines))], "item_id order")

    # C4.2 — no post id can survive outside `text`
    for i, line in enumerate(lines):
        obj = json.loads(line)
        ok("C4.2-no-id-outside-text", not DIGIT_RUN.search(obj["item_id"]),
           f"line {i + 1}")
    for name in files:
        if name in ("items.jsonl", "MANIFEST.txt"):
            continue
        m = DIGIT_RUN.search(contents[name])
        ok("C4.2-no-long-digit-run", m is None, f"{name}: {m.group(0) if m else ''}")

    # C4.3 — the original taxonomy keys ship nowhere as identifiers
    original_keys = sorted(fr.tax) + sorted(
        f"{m}/{s}" for m in fr.tax for s in (fr.tax[m].get("subtopics") or {}))
    sub_keys_only = sorted({s for m in fr.tax for s in (fr.tax[m].get("subtopics") or {})})
    hyphenated = [k for k in sorted(fr.tax) + sub_keys_only if "-" in k or "/" in k]
    leaks = []
    for name in files:
        body = contents[name]
        if name == "items.jsonl":
            body = "\n".join(json.loads(l)["item_id"] for l in lines)
        elif name == "BRIEF.md":
            continue  # natural-language prose; handled below
        for key in hyphenated:
            if key in body:
                leaks.append(f"{name}:{key}")
    ok("C4.3-no-hyphenated-keys", not leaks, ", ".join(leaks[:5]))
    tax_md = contents["taxonomy.md"]
    word_leaks = [k for k in sorted(fr.tax)
                  if re.search(r"\b" + re.escape(k) + r"\b", tax_md)]
    ok("C4.3-no-macro-keys-in-taxonomy", not word_leaks, ", ".join(word_leaks))
    # informational: the same strings as ordinary English inside post text
    text_blob = "\n".join(json.loads(l)["text"] for l in lines)
    natural = {k: len(re.findall(r"\b" + re.escape(k) + r"\b", text_blob, re.I))
               for k in original_keys}
    report["natural_language_key_hits_in_item_text"] = {
        k: v for k, v in sorted(natural.items()) if v}

    # C4.4 — fingerprints
    for name in files:
        ok("C4.4-filename", not FORBIDDEN_FILENAME.search(name), name)
    for name in files:
        low = contents[name].lower()
        for ban in HARD_CONTENT_BANS:
            ok("C4.4-hard-content", ban not in low, f"{name}: {ban}")
    soft = {}
    for name in files:
        body = contents[name]
        if name == "items.jsonl":
            body = "\n".join(json.loads(l)["item_id"] for l in lines)
        if name == "BRIEF.md":
            continue
        for tok in SOFT_CONTENT_TOKENS:
            n = len(re.findall(re.escape(tok), body, re.I))
            if n:
                soft[f"{name}:{tok}"] = n
    ok("C4.4-soft-content", not soft, json.dumps(soft))

    # C4.5 — texts are byte-identical to the archive except the canaries
    archive_texts = {}
    for pid, post in fr.posts.items():
        archive_texts.setdefault(post["text"], set()).add(pid)
    canary_ids = {c["item_id"] for c in canaries}
    for it, line in zip(items, lines):
        obj = json.loads(line)
        if obj["item_id"] in canary_ids:
            ok("C4.5-canary-differs", obj["text"] != fr.posts[it["post_id"]]["text"],
               obj["item_id"])
            continue
        ok("C4.5-verbatim", obj["text"] == fr.posts[it["post_id"]]["text"], obj["item_id"])
        ok("C4.5-in-archive", obj["text"] in archive_texts, obj["item_id"])

    # C4.6 — the manifest is the file list
    manifest = contents["MANIFEST.txt"]
    listed = re.findall(r"^([0-9a-f]{64})  (.+)$", manifest, re.M)
    ok("C4.6-manifest-matches", sorted(n for _h, n in listed)
       == sorted(f for f in files if f != "MANIFEST.txt"),
       f"{sorted(n for _h, n in listed)}")
    for h, name in listed:
        ok("C4.6-manifest-hash", h == sha256_file(os.path.join(pkg, name)), name)

    # C4.7 — the partition
    pops = {sid: len(fr.pools[sid]) for sid, _ in fr.rules}
    total = sum(pops.values())
    ok("C4.7-frame-sum", total == fr.cfg["frame"]["expected_n"],
       f"strata sum to {total}, expected {fr.cfg['frame']['expected_n']}")
    ok("C4.7-frame-size", total == len(fr.posts), f"{total} vs {len(fr.posts)} posts")
    off = {s["id"]: [pops[s["id"]], s["design_N"]]
           for s in fr.cfg["strata"] if pops[s["id"]] != s["design_N"]}
    checks.append({"check": "C4.7-per-stratum-vs-design", "pass": not off,
                   "detail": json.dumps(off)})

    # C4.8 — the content-balance precondition
    bal = fr.balance_test()
    ok("C4.8-content-balance", bal["passes"],
       f"alias-hit arms differ by {bal['alias_gap_pp']} pp "
       f"(> {bal['tolerance_pp']}); disable per-chunk collapsing in score.py")

    # the property this whole package exists to have
    ok("SEALED-no-label-field",
       not re.search(r'"(labels|topics|macro|subtopic|assignments|gap|stratum|chunk_id)"',
                     contents["items.jsonl"]),
       "a label-bearing key appears in items.jsonl")
    ok("SEALED-no-opaque-keys-in-items",
       not re.search(r"\bM\d{2}(_S\d{2})?\b",
                     "\n".join(json.loads(l)["item_id"] for l in lines)),
       "an opaque taxonomy key appears in an item id")
    summary = {}
    for c in checks:
        e = summary.setdefault(c["check"], {"run": 0, "failed": 0, "detail": ""})
        e["run"] += 1
        if not c["pass"]:
            e["failed"] += 1
            e["detail"] = c["detail"]
    report["checks"] = dict(sorted(summary.items()))
    report["checks_run"] = len(checks)
    report["balance_test"] = bal
    return checks


# ==========================================================================
# 7. main
# ==========================================================================

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--package-dir", default=os.path.expanduser("~/cp-eval-package"))
    ap.add_argument("--keys-dir", default=os.path.join(EVAL_DIR, "keys"))
    ap.add_argument("--config", default=os.path.join(EVAL_DIR, "config.json"))
    ap.add_argument("--force", action="store_true",
                    help="overwrite an existing package directory")
    args = ap.parse_args()

    cfg = frame_mod.load_config(args.config)
    pkg = os.path.abspath(os.path.expanduser(args.package_dir))
    keys = os.path.abspath(os.path.expanduser(args.keys_dir))

    # ---- C3: the package is built outside the repo, and the answers are not
    #      inside the package.
    if os.path.commonpath([pkg, REPO]) == REPO:
        raise BuildError(f"package dir {pkg} is inside the repository {REPO}")
    if os.path.commonpath([keys, pkg]) == pkg:
        raise BuildError(f"crosswalk dir {keys} is INSIDE the package {pkg}")
    probe = subprocess.run(["git", "-C", os.path.dirname(pkg), "rev-parse",
                            "--show-toplevel"], capture_output=True, text=True)
    if probe.returncode == 0:
        raise BuildError(f"{os.path.dirname(pkg)} is inside a git work tree "
                         f"({probe.stdout.strip()}) — build the package somewhere "
                         "with no git history")

    print(f"[build] repo      {REPO}")
    print(f"[build] package   {pkg}")
    print(f"[build] crosswalk {keys}")

    fr = frame_mod.build_frame(cfg)
    f = cfg["frame"]
    assert len(fr.posts) == f["expected_n"], len(fr.posts)
    assert len(fr.chunks) == f["expected_chunks"], len(fr.chunks)
    assert len(fr.sent) == f["expected_sent"], len(fr.sent)
    assert len(fr.deferred) == f["expected_deferred"], len(fr.deferred)
    assert len(fr.assignments) == f["expected_assignment_keys"], len(fr.assignments)
    assert len(fr.unclassified) == f["expected_unclassified"]
    assert len(fr.hallucinated) == f["expected_hallucinated_keys"]
    modes = {"macro-only": 0, "subtopic": 0}
    for m in fr.mode.values():
        modes[m] += 1
    assert modes["macro-only"] == f["expected_macro_only_chunks"], modes
    assert modes["subtopic"] == f["expected_subtopic_chunks"], modes
    print(f"[build] frame {len(fr.posts)} posts · {len(fr.chunks)} chunks "
          f"({modes['macro-only']} macro-only / {modes['subtopic']} subtopic) · "
          f"{len(fr.sent)} sent · {len(fr.deferred)} deferred")

    # ---- populations
    pops = {sid: len(fr.pools[sid]) for sid, _ in fr.rules}
    total = sum(pops.values())
    print("\n  #    stratum                       N_h   design   n_h")
    for spec in cfg["strata"]:
        sid = spec["id"]
        flag = "" if pops[sid] == spec["design_N"] else "  <-- differs"
        print(f"  {sid}  {spec['name']:<28} {pops[sid]:>5} {spec['design_N']:>8} "
              f"{spec['n_h']:>5}{flag}")
    print(f"       {'SUM':<28} {total:>5} {cfg['frame']['expected_n']:>8}")
    if total != cfg["frame"]["expected_n"]:
        raise BuildError(
            f"ABORT: the 19 stratum populations sum to {total}, not "
            f"{cfg['frame']['expected_n']} — the partition is wrong")
    off = {s["id"]: [pops[s["id"]], s["design_N"]]
           for s in cfg["strata"] if pops[s["id"]] != s["design_N"]}
    if off:
        deviate("S-populations",
                "realized vs design N_h differ for " + ", ".join(
                    f"{k} {v[0]}!={v[1]}" for k, v in sorted(off.items())) +
                " — the §1.5 alias screen is described but not specified in the "
                "design, so the probe that defines S10 is a reconstruction; the "
                "spill lands in the strata below it. Weights use realized N_h.")

    # ---- the draw
    taken, picks, stratum_stats = set(), {}, {}
    for spec in cfg["strata"]:
        if spec.get("greedy_subtopic_coverage"):
            got, stats = draw_s09(fr, spec, taken)
        else:
            got, stats = draw_stratum(fr, spec, taken)
        if len(got) != spec["n_h"]:
            raise BuildError(f"{spec['id']}: drew {len(got)} of {spec['n_h']}")
        picks[spec["id"]] = got
        stratum_stats[spec["id"]] = stats
        taken.update(got)
    nominal = sum(len(v) for v in picks.values())
    print(f"\n[build] nominal draw {nominal} posts (design {cfg['expected']['nominal_draw']})")
    s09 = stratum_stats["S09"]
    print(f"[build] S09 coverage: {s09['subtopics_covered']}/{s09['subtopics_in_corpus']} "
          f"used subtopics reached, {s09['filled_by_coverage']} of "
          f"{len(picks['S09'])} posts taken by the greedy pass")
    for name, sh in sorted(s09["shortfall"].items()):
        print(f"          shortfall {name}: {sh['reached']}/{sh['quota']} "
              f"(corpus count {sh['corpus_count']})")

    # ---- macro quota top-up (§2.3)
    topups, before, after = macro_topup(fr, taken, cfg["macro_quota"]["floor"])
    for pid in topups:
        picks.setdefault("S20", []).append(pid)
    print(f"\n[build] macro quota top-up: +{len(topups)} posts "
          f"(design {cfg['macro_quota']['design_topup']})")
    for macro in sorted(fr.tax):
        if after[macro] != before[macro]:
            print(f"          {macro}: {before[macro]} -> {after[macro]}")
    distinct = len(taken)
    print(f"[build] distinct posts {distinct} (design {cfg['expected']['distinct_posts']})")

    primary = {}
    for sid, pids in picks.items():
        for pid in pids:
            primary[pid] = fr.stratum[pid] if sid == "S20" else sid
    topup_set = set(topups)

    weights = {}
    for spec in cfg["strata"]:
        n_h = len(picks[spec["id"]])
        weights[spec["id"]] = 1.0 if spec["census"] else round(pops[spec["id"]] / n_h, 4)

    # ---- repeats (§3.3)
    twins, canaries = pick_repeats(fr, sorted(taken), cfg)

    items = []
    for pid in sorted(taken):
        items.append({"post_id": pid, "role": "original",
                      "text": fr.posts[pid]["text"],
                      "order_key": fr.order_key(pid)})
    for pid in twins:
        items.append({"post_id": pid, "role": "twin",
                      "text": fr.posts[pid]["text"],
                      "order_key": fr.order_key(pid, "twin")})
    for c in canaries:
        items.append({"post_id": c["post_id"], "role": "canary",
                      "text": c["text"],
                      "order_key": fr.order_key(c["post_id"], "canary")})
    if len(items) != cfg["expected"]["items"]:
        deviate("item-count",
                f"{len(items)} items, design says {cfg['expected']['items']}")
    seq, moves = order_items(items, cfg["repeats"]["min_separation"])
    print(f"[build] {len(seq)} items ordered "
          f"({len(twins)} verbatim twins + {len(canaries)} paraphrase canaries, "
          f"{moves} separation repairs)")

    pos_of = {}
    for it in seq:
        pos_of.setdefault(it["post_id"], {})[it["role"]] = it
    for c in canaries:
        c["item_id"] = pos_of[c["post_id"]]["canary"]["item_id"]

    # ---- write the package
    if os.path.exists(pkg):
        if not args.force and os.listdir(pkg):
            raise BuildError(f"{pkg} exists and is not empty (use --force)")
        shutil.rmtree(pkg)
    os.makedirs(pkg)
    os.makedirs(keys, exist_ok=True)

    report = {}
    try:
        tax_md, macro_map, sub_map = rekey_taxonomy(fr)
        write_text(os.path.join(pkg, "taxonomy.md"), tax_md)
        brief, brief_fixes = build_brief(cfg, sub_map, macro_map)
        write_text(os.path.join(pkg, "BRIEF.md"), brief)
        write_text(os.path.join(pkg, "schema.md"), SCHEMA_MD)
        write_text(os.path.join(pkg, "examples.jsonl"), "\n".join(
            json.dumps(e, ensure_ascii=False, sort_keys=False) for e in examples_lines()))
        write_text(os.path.join(pkg, "items.jsonl"), "\n".join(
            json.dumps({"item_id": it["item_id"], "text": it["text"]},
                       ensure_ascii=False) for it in seq))
        manifest = [f"items: {len(seq)}", ""]
        for name in sorted(os.listdir(pkg)):
            manifest.append(f"{sha256_file(os.path.join(pkg, name))}  {name}")
        write_text(os.path.join(pkg, "MANIFEST.txt"), "\n".join(manifest))

        # ---- write the crosswalk (SIBLING tree, never inside the package)
        rows = ["item_id,role,post_id,date,chunk_id,chunk_mode,stratum,memberships,"
                "weight,quota_topup,twin_of,text_altered,pipeline_labels,"
                "pipeline_labels_raw,emerging_label"]
        for it in seq:
            pid = it["post_id"]
            sid = primary[pid]
            cid = fr.post_chunk.get(pid, "")
            row = [
                it["item_id"], it["role"], pid, fr.posts[pid]["_date"], cid,
                fr.mode.get(cid, "deferred"), sid,
                "|".join(fr.memberships[pid]),
                f"{weights[sid]:.4f}", "true" if pid in topup_set else "false",
                pos_of[pid]["original"]["item_id"] if it["role"] != "original" else "",
                "true" if it["role"] == "canary" else "false",
                json.dumps([[m, s] for (m, s) in fr.ded[pid]], ensure_ascii=False),
                json.dumps([[m, s] for (m, s) in fr.raw[pid]], ensure_ascii=False),
                fr.emerging_label.get(pid, ""),
            ]
            rows.append(",".join('"' + str(c).replace('"', '""') + '"' for c in row))
        write_text(os.path.join(keys, "crosswalk.csv"), "\n".join(rows))

        write_text(os.path.join(keys, "taxonomy_map.json"), json.dumps(
            {"macros": macro_map, "subtopics": sub_map,
             "reverse": {v: k for k, v in list(macro_map.items()) + list(sub_map.items())}},
            indent=2, sort_keys=True, ensure_ascii=False))

        rrows = ["item_id,twin_of,kind,post_id,replaced,substitute,swap_kind"]
        for pid in twins:
            it = pos_of[pid]["twin"]
            rrows.append(f'"{it["item_id"]}","{pos_of[pid]["original"]["item_id"]}",'
                         f'"verbatim","{pid}","","",""')
        for c in canaries:
            pid = c["post_id"]
            rrows.append(f'"{c["item_id"]}","{pos_of[pid]["original"]["item_id"]}",'
                         f'"paraphrase","{pid}","{c["place"]}","{c["substitute"]}",'
                         f'"{c["kind"]}"')
        write_text(os.path.join(keys, "repeats.csv"), "\n".join(rrows))

        crows = ["item_id,post_id,owner_labels,owner_gap,owner_confidence,owner_note,text"]
        for it in seq[:cfg["calibration"]["n"]]:
            txt = it["text"].replace('"', '""')
            crows.append(f'"{it["item_id"]}","{it["post_id"]}","","","","","{txt}"')
        write_text(os.path.join(keys, "calibration.csv"), "\n".join(crows))

        # which 20-item batch ships without the rule-5 sweep instruction (§4)
        batch = cfg["expected"]["batch_size"]
        counts = {}
        for it in seq:
            if it["role"] == "original" and primary[it["post_id"]] == "S10":
                counts[it["position"] // batch] = counts.get(it["position"] // batch, 0) + 1
        best = min(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0] if counts else 0
        lo, hi = best * batch + 1, min((best + 1) * batch, len(seq))
        write_text(os.path.join(keys, "no-sweep.txt"), (
            "NO-SWEEP batch (design §4): mark this batch, and only this batch,\n"
            "NO-SWEEP at the top of the grading turn.\n\n"
            f"batch index (0-based): {best}\n"
            f"items: E{lo:04d}..E{hi:04d}\n"
            f"S10 items inside it: {counts.get(best, 0)}\n\n"
            "The design asks for 'one batch of 20 S10 items'. §2.2 shuffles items\n"
            "by hash so no batch is single-stratum; the instruction effect is\n"
            "therefore measured on the S10 items that fall inside this batch."))
        if counts.get(best, 0) < 20:
            deviate("NO-SWEEP-batch",
                    f"§4 wants a 20-item batch of pure S10; the §2.2 shuffle makes "
                    f"that impossible. Batch {best} (E{lo:04d}..E{hi:04d}) carries "
                    f"{counts.get(best, 0)} S10 items and is marked instead.")

        checks = run_assertions(fr, pkg, seq, macro_map, sub_map, canaries, report)
    except Exception:
        shutil.rmtree(pkg, ignore_errors=True)
        print("\n[build] ABORTED — partial package deleted", file=sys.stderr)
        raise

    macro_sample = {}
    for pid in taken:
        for m in fr.macros_of(pid):
            macro_sample[m] = macro_sample.get(m, 0) + 1
    report.update({
        "frame": {"posts": len(fr.posts), "chunks": len(fr.chunks),
                  "sent": len(fr.sent), "deferred": len(fr.deferred),
                  "assignment_keys": len(fr.assignments),
                  "unclassified": sorted(fr.unclassified),
                  "hallucinated_keys": fr.hallucinated,
                  "macro_only_chunks": modes["macro-only"],
                  "subtopic_chunks": modes["subtopic"]},
        "populations": pops, "populations_sum": total,
        "design_populations": {s["id"]: s["design_N"] for s in cfg["strata"]},
        "sample_sizes": {sid: len(v) for sid, v in sorted(picks.items())},
        "weights": weights,
        "stratum_stats": stratum_stats,
        "macro_quota": {"floor": cfg["macro_quota"]["floor"],
                        "before": before, "after": after,
                        "topup_posts": len(topups)},
        "macro_coverage_final": dict(sorted(macro_sample.items())),
        "distinct_posts": distinct,
        "items": len(seq),
        "repeats": {"verbatim_twins": len(twins), "paraphrase_canaries": len(canaries),
                    "separation_repairs": moves,
                    "min_separation": cfg["repeats"]["min_separation"]},
        "brief_key_fixes": brief_fixes,
        "deviations": DEVIATIONS,
        "package_files": sorted(os.listdir(pkg)),
        "package_sha256": {n: sha256_file(os.path.join(pkg, n))
                           for n in sorted(os.listdir(pkg))},
    })
    write_text(os.path.join(keys, "build-report.json"),
               json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))

    print(f"\n[build] {len(checks)} assertions passed")
    print(f"[build] package   {pkg}")
    for name in sorted(os.listdir(pkg)):
        print(f"          {os.path.getsize(os.path.join(pkg, name)):>9,}  {name}")
    print(f"[build] crosswalk {keys}")
    for name in sorted(os.listdir(keys)):
        print(f"          {os.path.getsize(os.path.join(keys, name)):>9,}  {name}")
    print(f"[build] SEALED: {len(seq)} items, {distinct} distinct posts, "
          f"0 labels in the package")


if __name__ == "__main__":
    try:
        main()
    except BuildError as e:
        print(f"\n[build] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
