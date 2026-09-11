#!/usr/bin/env python3
"""Grade a blind labeling pass against the production classifier.

Reads verdicts.jsonl (the sealed package's only output), joins it to the
crosswalk answer key, and reports where the independent labeler and the
shipped pipeline disagree.

WHAT THIS MEASURES, AND WHAT IT DOES NOT
----------------------------------------
Almost everything here is AGREEMENT, not accuracy. Two labelers disagreeing
tells you one of them is wrong; it does not tell you which. The only rows in
this report that carry truth are the calibration subset (§calibration), and
only once a human has filled owner_labels in keys/calibration.csv. Every
other number is a disagreement rate, and the report labels it as such.

The exception worth trusting on its own is SELF-consistency: verbatim twins
are the same post shown twice under two item ids, so a labeler that disagrees
with ITSELF is unambiguously unreliable, with no second opinion needed.

Population estimates use the stratum weights (N_h/n_h) and cover originals
only -- twins and canaries are repeats of posts already drawn, so counting
them would double-count those strata.

Usage:
    python3 eval/score.py verdicts.jsonl
    python3 eval/score.py verdicts.jsonl --keys-dir eval/keys --json out/score.json
"""

import argparse
import collections
import csv
import json
import os
import sys

EVAL_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(EVAL_DIR)

CONFIDENCE = {"high", "medium", "low"}
BASIS = {"clear", "debatable"}
UNREADABLE = {None, "truncated", "no-text", "not-english"}


class ScoreError(Exception):
    pass


# --------------------------------------------------------------------------
# loading
# --------------------------------------------------------------------------

def load_keys(keys_dir):
    def path(name):
        p = os.path.join(keys_dir, name)
        if not os.path.exists(p):
            raise ScoreError(f"missing answer-key file: {p}")
        return p

    with open(path("taxonomy_map.json"), encoding="utf-8") as fh:
        tax = json.load(fh)
    with open(path("crosswalk.csv"), encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))
    with open(path("repeats.csv"), encoding="utf-8", newline="") as fh:
        repeats = list(csv.DictReader(fh))
    calib = []
    cp = os.path.join(keys_dir, "calibration.csv")
    if os.path.exists(cp):
        with open(cp, encoding="utf-8", newline="") as fh:
            calib = list(csv.DictReader(fh))
    nosweep = ""
    np_ = os.path.join(keys_dir, "no-sweep.txt")
    if os.path.exists(np_):
        with open(np_, encoding="utf-8") as fh:
            nosweep = fh.read()
    return tax, rows, repeats, calib, nosweep


def load_verdicts(path):
    out, seen = [], set()
    with open(path, encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            if line.startswith("```"):
                raise ScoreError(
                    f"{path}:{n} starts a markdown fence. The brief asks for "
                    "raw JSONL with nothing between the lines; strip the fences.")
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                raise ScoreError(f"{path}:{n} is not valid JSON: {e}") from None
            iid = obj.get("item_id")
            if not iid:
                raise ScoreError(f"{path}:{n} has no item_id")
            if iid in seen:
                raise ScoreError(f"{path}:{n} repeats item_id {iid}")
            seen.add(iid)
            out.append(obj)
    if not out:
        raise ScoreError(f"{path} contains no verdict lines")
    return out


# --------------------------------------------------------------------------
# normalisation
# --------------------------------------------------------------------------

def pairs_from_verdict(obj, tax, where):
    """Verdict labels (M-keys) -> a set of (macro, subtopic-or-None) real keys."""
    labels = obj.get("labels")
    if labels is None:
        raise ScoreError(f"{where}: no 'labels' field")
    if not isinstance(labels, list):
        raise ScoreError(f"{where}: 'labels' is {type(labels).__name__}, want a list")
    out = []
    for pair in labels:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise ScoreError(f"{where}: label {pair!r} is not a [macro, subtopic] pair")
        mk, sk = pair
        macro = tax["macros"].get(mk)
        if macro is None:
            raise ScoreError(f"{where}: unknown macro key {mk!r}")
        if sk is None:
            out.append((macro, None))
            continue
        full = tax["subtopics"].get(sk)
        if full is None:
            raise ScoreError(f"{where}: unknown subtopic key {sk!r}")
        parent, _, sub = full.partition("/")
        if parent != macro:
            raise ScoreError(
                f"{where}: {sk!r} ({full}) is not a subtopic of {mk!r} ({macro})")
        out.append((macro, sub))
    if len(set(out)) != len(out):
        raise ScoreError(f"{where}: the same pair appears twice in 'labels'")
    return set(out)


def pairs_from_pipeline(raw, where):
    """crosswalk pipeline_labels JSON -> the same (macro, sub-or-None) shape."""
    if not raw:
        return set()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ScoreError(f"{where}: crosswalk pipeline_labels unparseable: {e}") from None
    out = set()
    for pair in data:
        macro, sub = (pair + [None])[:2] if isinstance(pair, list) else (pair, None)
        out.add((macro, sub if sub else None))
    return out


def macros_of(pairs):
    return {m for m, _ in pairs}


def jaccard(a, b):
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)


# --------------------------------------------------------------------------
# validation
# --------------------------------------------------------------------------

def validate(verdicts, rows, tax):
    """Every item once, in order, with a well-formed body. Raises on any breach."""
    expected = [r["item_id"] for r in rows]
    got = [v["item_id"] for v in verdicts]
    missing = [i for i in expected if i not in set(got)]
    extra = [i for i in got if i not in set(expected)]
    problems = []
    if missing:
        problems.append(f"{len(missing)} item(s) never labelled, first: {missing[:5]}")
    if extra:
        problems.append(f"{len(extra)} unknown item_id(s), first: {extra[:5]}")
    if not missing and not extra and got != expected:
        first = next(i for i, (a, b) in enumerate(zip(got, expected)) if a != b)
        problems.append(
            f"items are out of order from position {first} "
            f"(got {got[first]}, expected {expected[first]})")
    if problems:
        raise ScoreError("verdicts do not match the package:\n  - " + "\n  - ".join(problems))

    soft = []
    for v in verdicts:
        w = f"item {v['item_id']}"
        pairs_from_verdict(v, tax, w)          # raises on bad keys
        if v.get("confidence") not in CONFIDENCE:
            soft.append(f"{w}: confidence {v.get('confidence')!r}")
        if v.get("basis") not in BASIS:
            soft.append(f"{w}: basis {v.get('basis')!r}")
        if v.get("unreadable") not in UNREADABLE:
            soft.append(f"{w}: unreadable {v.get('unreadable')!r}")
        gap = v.get("gap")
        if gap and v.get("labels"):
            soft.append(f"{w}: gap {gap!r} set alongside labels (brief says labels must be [])")
        alts = v.get("alternatives") or []
        if len(alts) > 2:
            soft.append(f"{w}: {len(alts)} alternatives (max 2)")
        if len(v.get("labels") or []) > 4:
            soft.append(f"{w}: {len(v['labels'])} labels (max 4)")
    return soft


# --------------------------------------------------------------------------
# scoring
# --------------------------------------------------------------------------

def score(verdicts, rows, tax):
    by_id = {v["item_id"]: v for v in verdicts}
    per = {}
    for r in rows:
        iid = r["item_id"]
        v = by_id[iid]
        mine = pairs_from_verdict(v, tax, f"item {iid}")
        theirs = pairs_from_pipeline(r.get("pipeline_labels"), f"item {iid}")
        per[iid] = {
            "row": r,
            "verdict": v,
            "mine": mine,
            "theirs": theirs,
            "exact": mine == theirs,
            "macro_exact": macros_of(mine) == macros_of(theirs),
            "jaccard": jaccard(mine, theirs),
            "macro_jaccard": jaccard(macros_of(mine), macros_of(theirs)),
            "weight": float(r["weight"] or 0),
            "stratum": r["stratum"],
            "role": r["role"],
        }
    return per


def weighted(per, predicate):
    """Population share (of the 10,476-row frame) where predicate holds."""
    num = den = 0.0
    for p in per.values():
        if p["role"] != "original":
            continue
        den += p["weight"]
        if predicate(p):
            num += p["weight"]
    return (num / den if den else 0.0), den


def consistency(per, repeats):
    """Twins are the same post twice; canaries are the same post with one place
    name swapped. Either changing the label is the labeler contradicting itself."""
    out = {"verbatim": {"n": 0, "same": 0, "cases": []},
           "paraphrase": {"n": 0, "same": 0, "cases": []}}
    for rep in repeats:
        iid, twin, kind = rep["item_id"], rep["twin_of"], rep["kind"]
        if iid not in per or twin not in per:
            continue
        bucket = out["verbatim"] if kind == "verbatim" else out["paraphrase"]
        a, b = per[iid]["mine"], per[twin]["mine"]
        bucket["n"] += 1
        if a == b:
            bucket["same"] += 1
        else:
            bucket["cases"].append({
                "item_id": iid, "twin_of": twin,
                "labels_a": sorted(map(list, a)), "labels_b": sorted(map(list, b)),
            })
    return out


def calibration(per, calib, tax):
    """The only truth in the file: a human's labels for 40 items."""
    graded = [c for c in calib if (c.get("owner_labels") or "").strip()]
    if not graded:
        return {"graded": 0}
    res = {"graded": 0, "codex_exact": 0, "pipeline_exact": 0,
           "codex_macro": 0, "pipeline_macro": 0, "both_wrong": 0, "cases": []}
    for c in graded:
        iid = c["item_id"]
        if iid not in per:
            continue
        try:
            truth = pairs_from_pipeline(c["owner_labels"], f"calibration {iid}")
        except ScoreError:
            continue
        p = per[iid]
        res["graded"] += 1
        ce, pe = p["mine"] == truth, p["theirs"] == truth
        res["codex_exact"] += ce
        res["pipeline_exact"] += pe
        res["codex_macro"] += macros_of(p["mine"]) == macros_of(truth)
        res["pipeline_macro"] += macros_of(p["theirs"]) == macros_of(truth)
        if not ce and not pe:
            res["both_wrong"] += 1
        if not (ce and pe):
            res["cases"].append({
                "item_id": iid,
                "human": sorted(map(list, truth)),
                "blind": sorted(map(list, p["mine"])),
                "pipeline": sorted(map(list, p["theirs"])),
            })
    return res


def nosweep_effect(per, nosweep_text):
    """Did marking one batch NO-SWEEP change how those items were labelled?"""
    import re
    m = re.search(r"items:\s*(E\d+)\.\.(E\d+)", nosweep_text or "")
    if not m:
        return None
    lo, hi = m.group(1), m.group(2)
    inside = [p for iid, p in per.items() if lo <= iid <= hi and p["stratum"] == "S10"]
    outside = [p for iid, p in per.items()
               if not (lo <= iid <= hi) and p["stratum"] == "S10"]
    if not inside or not outside:
        return None

    def rate(group):
        g = list(group)
        return sum(1 for p in g if not p["mine"]) / len(g), len(g)

    ins_rate, ins_n = rate(inside)
    out_rate, out_n = rate(outside)
    return {"batch": f"{lo}..{hi}", "inside_n": ins_n, "outside_n": out_n,
            "inside_empty_rate": ins_rate, "outside_empty_rate": out_rate,
            "delta_pp": (ins_rate - out_rate) * 100}


# --------------------------------------------------------------------------
# report
# --------------------------------------------------------------------------

def pct(x):
    return f"{x * 100:5.1f}%"


def render(per, soft, cons, calib, sweep, cfg_strata):
    L = []
    A = L.append
    originals = [p for p in per.values() if p["role"] == "original"]
    n = len(originals)

    A("# Blind classifier eval — results")
    A("")
    A(f"{len(per)} items graded ({n} distinct posts, "
      f"{len(per) - n} repeats used for self-consistency).")
    A("")
    A("**Read the top table as disagreement, not error.** It says how often an "
      "independent labeler and the shipped pipeline differ; it does not say "
      "which one is right. Only the calibration section below carries truth.")
    A("")

    A("## 1. Agreement with the shipped pipeline")
    A("")
    exact = sum(1 for p in originals if p["exact"]) / n
    macro = sum(1 for p in originals if p["macro_exact"]) / n
    wj = sum(p["jaccard"] for p in originals) / n
    wmj = sum(p["macro_jaccard"] for p in originals) / n
    w_exact, _ = weighted(per, lambda p: p["exact"])
    w_macro, _ = weighted(per, lambda p: p["macro_exact"])
    A("| measure | sample | weighted to the corpus |")
    A("|---|---|---|")
    A(f"| identical label set | {pct(exact)} | {pct(w_exact)} |")
    A(f"| identical macro set (subtopics ignored) | {pct(macro)} | {pct(w_macro)} |")
    A(f"| mean Jaccard, full pairs | {wj:.3f} | — |")
    A(f"| mean Jaccard, macros only | {wmj:.3f} | — |")
    A("")

    A("## 2. Where the empties are")
    A("")
    A("The question this eval exists to answer: how much of the corpus does the "
      "pipeline leave unlabelled that a careful reader would label?")
    A("")
    both = sum(1 for p in originals if not p["mine"] and not p["theirs"])
    only_pipe = sum(1 for p in originals if p["mine"] and not p["theirs"])
    only_blind = sum(1 for p in originals if not p["mine"] and p["theirs"])
    neither = n - both - only_pipe - only_blind
    w_only_pipe, _ = weighted(per, lambda p: p["mine"] and not p["theirs"])
    A("| | blind labeler labelled it | blind labeler left it empty |")
    A("|---|---|---|")
    A(f"| **pipeline labelled it** | {neither} | {only_blind} |")
    A(f"| **pipeline left it empty** | **{only_pipe}** | {both} |")
    A("")
    A(f"The bold cell is the miss rate: **{pct(only_pipe / n)} of sampled posts** "
      f"(**{pct(w_only_pipe)}** weighted to the corpus) carry no pipeline label "
      "but were labelled by an independent reader.")
    gaps = collections.Counter(
        (p["verdict"].get("gap") or "").strip()
        for p in originals if (p["verdict"].get("gap") or "").strip())
    if gaps:
        A("")
        A("Subjects the labeler said the taxonomy has no macro for "
          "(`gap`), most common first:")
        A("")
        for subject, count in gaps.most_common(15):
            A(f"- `{subject}` — {count}")
    A("")

    A("## 3. Self-consistency (no second opinion needed)")
    A("")
    for kind, label in (("verbatim", "verbatim twins (identical text)"),
                        ("paraphrase", "paraphrase canaries (one place name swapped)")):
        b = cons[kind]
        if not b["n"]:
            continue
        A(f"- **{label}**: {b['same']}/{b['n']} labelled identically "
          f"({pct(b['same'] / b['n'])}).")
        for c in b["cases"][:5]:
            A(f"  - {c['item_id']} vs {c['twin_of']}: "
              f"`{c['labels_a']}` vs `{c['labels_b']}`")
    A("")
    A("A labeler that contradicts itself on identical text sets a ceiling on "
      "every other number in this report.")
    A("")

    A("## 4. By stratum")
    A("")
    names = {s["id"]: s["name"] for s in cfg_strata}
    A("| stratum | what it probes | n | identical | macro-identical |")
    A("|---|---|---|---|---|")
    for sid in sorted({p["stratum"] for p in originals}):
        g = [p for p in originals if p["stratum"] == sid]
        A(f"| {sid} | {names.get(sid, '?')} | {len(g)} | "
          f"{pct(sum(1 for p in g if p['exact']) / len(g))} | "
          f"{pct(sum(1 for p in g if p['macro_exact']) / len(g))} |")
    A("")

    A("## 5. What the labeler said about its own confidence")
    A("")
    conf = collections.Counter(p["verdict"].get("confidence") for p in originals)
    basis = collections.Counter(p["verdict"].get("basis") for p in originals)
    A(f"- confidence: " + ", ".join(f"{k} {v}" for k, v in conf.most_common()))
    A(f"- basis: " + ", ".join(f"{k} {v}" for k, v in basis.most_common()))
    for level in ("high", "medium", "low"):
        g = [p for p in originals if p["verdict"].get("confidence") == level]
        if g:
            A(f"- agreement when it said **{level}**: "
              f"{pct(sum(1 for p in g if p['exact']) / len(g))} ({len(g)} items)")
    A("")
    A("Confidence that does not track agreement is worse than no confidence "
      "field, because it invites trusting the wrong rows.")
    A("")

    A("## 6. Calibration — the only truth in this report")
    A("")
    if not calib.get("graded"):
        A("**Not yet graded.** `keys/calibration.csv` has 40 items with an empty "
          "`owner_labels` column. Until a human fills it in, every number above "
          "is agreement between two automated labelers and neither is a "
          "reference. Filling in those 40 rows is what converts this from "
          "\"they disagree\" into \"the pipeline is wrong here.\"")
    else:
        g = calib["graded"]
        A(f"{g} items carry human labels.")
        A("")
        A("| labeler | exact match with the human | macro match |")
        A("|---|---|---|")
        A(f"| blind labeler | {pct(calib['codex_exact'] / g)} | {pct(calib['codex_macro'] / g)} |")
        A(f"| shipped pipeline | {pct(calib['pipeline_exact'] / g)} | {pct(calib['pipeline_macro'] / g)} |")
        A("")
        A(f"Both wrong on {calib['both_wrong']} item(s) — those are taxonomy "
          "problems, not labeler problems.")
        if calib["cases"]:
            A("")
            A("Disagreements with the human:")
            A("")
            for c in calib["cases"][:20]:
                A(f"- `{c['item_id']}` human `{c['human']}` · "
                  f"blind `{c['blind']}` · pipeline `{c['pipeline']}`")
    A("")

    if sweep:
        A("## 7. NO-SWEEP instruction effect")
        A("")
        A(f"Batch {sweep['batch']} was marked NO-SWEEP. Among S10 (recall-probe) "
          f"items: empty-label rate {pct(sweep['inside_empty_rate'])} inside "
          f"(n={sweep['inside_n']}) vs {pct(sweep['outside_empty_rate'])} outside "
          f"(n={sweep['outside_n']}), a {sweep['delta_pp']:+.1f}pp difference.")
        A("")
        A(f"With n={sweep['inside_n']} inside the batch this is indicative at "
          "best; it is not powered to be conclusive.")
        A("")

    if soft:
        A("## Format problems")
        A("")
        A(f"{len(soft)} line(s) departed from the schema without being fatal:")
        A("")
        for s in soft[:25]:
            A(f"- {s}")
        if len(soft) > 25:
            A(f"- …and {len(soft) - 25} more")
        A("")

    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("verdicts", help="verdicts.jsonl handed back by the labeler")
    ap.add_argument("--keys-dir", default=os.path.join(EVAL_DIR, "keys"))
    ap.add_argument("--config", default=os.path.join(EVAL_DIR, "config.json"))
    ap.add_argument("--out", help="write the markdown report here (default: stdout)")
    ap.add_argument("--json", help="also write the raw numbers here")
    args = ap.parse_args()

    try:
        with open(args.config, encoding="utf-8") as fh:
            cfg = json.load(fh)
        tax, rows, repeats, calib_rows, nosweep = load_keys(args.keys_dir)
        verdicts = load_verdicts(args.verdicts)
        soft = validate(verdicts, rows, tax)
    except ScoreError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    per = score(verdicts, rows, tax)
    cons = consistency(per, repeats)
    calib = calibration(per, calib_rows, tax)
    sweep = nosweep_effect(per, nosweep)
    report = render(per, soft, cons, calib, sweep, cfg["strata"])

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(report + "\n")
        print(f"wrote {args.out}")
    else:
        print(report)

    if args.json:
        originals = [p for p in per.values() if p["role"] == "original"]
        blob = {
            "n_items": len(per),
            "n_originals": len(originals),
            "exact": sum(1 for p in originals if p["exact"]) / len(originals),
            "macro_exact": sum(1 for p in originals if p["macro_exact"]) / len(originals),
            "weighted_exact": weighted(per, lambda p: p["exact"])[0],
            "pipeline_missed": weighted(per, lambda p: p["mine"] and not p["theirs"])[0],
            "consistency": cons,
            "calibration": calib,
            "nosweep": sweep,
            "format_problems": soft,
            "per_item": {
                iid: {"stratum": p["stratum"], "role": p["role"],
                      "exact": p["exact"], "jaccard": p["jaccard"],
                      "blind": sorted(map(list, p["mine"])),
                      "pipeline": sorted(map(list, p["theirs"]))}
                for iid, p in per.items()
            },
        }
        os.makedirs(os.path.dirname(os.path.abspath(args.json)), exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(blob, fh, indent=1, sort_keys=True)
        print(f"wrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
