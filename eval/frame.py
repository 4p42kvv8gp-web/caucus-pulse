"""Frame reconstruction for the classifier eval — shared by build.py and score.py.

Everything here is a replay of what the 2026-09-10T06:09:37Z backfill run
actually did, derived from files only (no API calls, no RNG, no clock):

  * the request chunks that were sent to the model (§1.3 of the design brief),
  * the per-chunk "mode" (macro-only vs subtopic) computed on PRE-correction
    labels (§1.4),
  * the §1.5 alias/probe content-balance screen,
  * the 19-stratum strict-priority partition of the 10,476-row frame (§2).

The taxonomy is pinned to the graded commit (46 subtopics), never HEAD (48).
"""

import datetime
import hashlib
import json
import os
import re
import subprocess

import yaml

EVAL_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(EVAL_DIR)


def load_config(path=None):
    with open(path or os.path.join(EVAL_DIR, "config.json"), encoding="utf-8") as fh:
        return json.load(fh)


def git_show(spec):
    """Read a file as it stood at a commit. Never touches the working tree."""
    out = subprocess.run(
        ["git", "-C", REPO, "show", spec],
        capture_output=True, text=True, check=True,
    )
    return out.stdout


def load_taxonomy(cfg):
    """The 46-subtopic taxonomy that actually ran (§1.2). NOT the working tree."""
    spec = cfg["artifact"]["taxonomy_source"]
    assert spec.startswith("git:"), spec
    tax = yaml.safe_load(git_show(spec[4:])) or {}
    n_macros = len(tax)
    n_subs = sum(len(v.get("subtopics") or {}) for v in tax.values())
    assert n_macros == cfg["artifact"]["taxonomy_macros"], f"macros {n_macros}"
    assert n_subs == cfg["artifact"]["taxonomy_subtopics"], f"subtopics {n_subs}"
    return tax


def read_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def archive_path(date):
    return os.path.join(REPO, "data", "archive", f"{date}.jsonl")


def topics_path(date):
    return os.path.join(REPO, "data", "topics", f"{date}.json")


def dedup(pairs):
    out = []
    for p in pairs:
        if p not in out:
            out.append(p)
    return out


def sha_key(*parts):
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


class Frame:
    """The whole replayed corpus: posts, chunks, labels, screens, strata."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.salt = cfg["salt"]
        self.dates = list(cfg["artifact"]["days"])
        self.tax = load_taxonomy(cfg)
        self._load_posts()
        self._load_topics()
        self._reconstruct_chunks()
        self._labels()
        self._chunk_modes()
        self._alias_screen()
        self._strata()

    # ---------- corpus ----------

    def _load_posts(self):
        self.posts = {}
        self.order = []
        self.by_date = {}
        for d in self.dates:
            rows = read_jsonl(archive_path(d))
            self.by_date[d] = rows
            for r in rows:
                r["_date"] = d
                self.posts[r["id"]] = r
                self.order.append(r["id"])
        assert len(self.posts) == len(self.order), "duplicate post id in archive"

    def _load_topics(self):
        self.assignments = {}
        self.unclassified = set()
        self.corrected = set()
        self.emerging = set()
        self.emerging_label = {}
        for d in self.dates:
            with open(topics_path(d), encoding="utf-8") as fh:
                day = json.load(fh)
            assert day["classifiedAt"].startswith(
                self.cfg["artifact"]["classified_at_prefix"]
            ), f"{d}: classifiedAt {day['classifiedAt']} is not the graded run"
            assert day["model"] == self.cfg["artifact"]["model"], d
            self.assignments.update(day["assignments"])
            self.unclassified.update(day["unclassified"])
            self.corrected.update((day.get("corrected") or {}).keys())
            for cluster in day["emerging"]:
                for pid in cluster["ids"]:
                    self.emerging.add(pid)
                    self.emerging_label.setdefault(pid, cluster["label"])

    # ---------- request chunks (§1.3) ----------

    def _corpus_ids(self, date):
        """archive ids for date-2 .. date — the corpusIds() window at 3e74a86."""
        ids = set()
        base = datetime.date.fromisoformat(date)
        for back in (2, 1, 0):
            dd = (base - datetime.timedelta(days=back)).isoformat()
            path = archive_path(dd)
            if os.path.exists(path):
                for r in read_jsonl(path):
                    ids.add(r["id"])
        return ids

    def _reconstruct_chunks(self):
        per = self.cfg["artifact"]["tweets_per_request"]
        self.chunks = {}
        self.post_chunk = {}
        self.deferred = set()
        for d in self.dates:
            corpus = self._corpus_ids(d)
            to_classify = []
            for t in self.by_date[d]:
                # priorAssignments() was {} for every day of the backfill, so the
                # corpusIds branch governs: an in-corpus retweet was deferred.
                if t["type"] == "retweet" and t.get("refId") in corpus:
                    self.deferred.add(t["id"])
                else:
                    to_classify.append(t)
            for i in range(0, len(to_classify), per):
                cid = f"{d}_chunk-{i // per}"
                members = [t["id"] for t in to_classify[i:i + per]]
                self.chunks[cid] = members
                for pid in members:
                    self.post_chunk[pid] = cid
        self.sent = set(self.post_chunk)

    # ---------- labels ----------

    def _labels(self):
        self.raw = {}
        self.ded = {}
        for pid in self.posts:
            pairs = [tuple(x) for x in self.assignments.get(pid, [])]
            self.raw[pid] = pairs
            self.ded[pid] = dedup(pairs)
        self.hallucinated = sorted(set(self.assignments) - set(self.posts))

    def macros_of(self, pid):
        return {m for (m, _s) in self.ded[pid]}

    def subtopics_of(self, pid):
        return {(m, s) for (m, s) in self.ded[pid] if s}

    # ---------- chunk mode (§1.4, PRE-correction) ----------

    def _chunk_modes(self):
        self.mode = {}
        self.chunk_subtopic_pairs = {}
        for cid, members in self.chunks.items():
            pairs = sum(
                len(self.subtopics_of(pid))
                for pid in members
                if pid not in self.corrected
            )
            self.chunk_subtopic_pairs[cid] = pairs
            self.mode[cid] = "subtopic" if pairs > 0 else "macro-only"

    def chunk_mode_of(self, pid):
        cid = self.post_chunk.get(pid)
        return self.mode[cid] if cid else None

    # ---------- §1.5 alias screen ----------

    def _alias_terms(self):
        conf = self.cfg["alias_screen"]
        terms = {}
        for mk, mv in self.tax.items():
            for sk, sv in (mv.get("subtopics") or {}).items():
                out = []
                for raw_term in [sv["label"]] + list(sv.get("aliases") or []):
                    parts = ([p.strip() for p in raw_term.split(conf["split_on"])]
                             if conf["split_on"] else [raw_term])
                    for part in parts:
                        if len(part) >= conf["min_chars"]:
                            out.append(part)
                terms[(mk, sk)] = sorted(set(out))
        return terms

    def _alias_screen(self):
        conf = self.cfg["alias_screen"]
        terms = self._alias_terms()
        self.alias_terms = terms
        flags = re.I if conf["case_insensitive"] else 0
        patterns = {}
        for key, tl in terms.items():
            if not tl:
                continue
            alts = []
            for t in tl:
                if conf["punctuation_insensitive"]:
                    words = [w for w in re.split(r"[^0-9A-Za-z]+", t) if w]
                    alts.append(r"\b" + r"\s+".join(re.escape(w) for w in words) + r"\b")
                else:
                    alts.append(r"\b" + re.escape(t) + r"\b")
            patterns[key] = re.compile("|".join(alts), flags)
        self.alias_hits = {}
        for pid, post in self.posts.items():
            text = post["text"]
            if conf["punctuation_insensitive"]:
                text = re.sub(r"[^0-9A-Za-z]+", " ", text)
            hits = set()
            for key, rx in patterns.items():
                if rx.search(text):
                    hits.add(key)
            self.alias_hits[pid] = hits

    def probe_hit(self, pid):
        """Text names a subtopic of a macro the post carries, but the subtopic
        was not assigned — the §1.5 'declined subtopic' probe."""
        carried = self.macros_of(pid)
        return any(
            m in carried and (m, s) not in self.ded[pid]
            for (m, s) in self.alias_hits[pid]
        )

    def balance_test(self):
        """§1.5 / C4.8: the two chunk-mode arms must carry the same content."""
        out = {}
        for arm in ("macro-only", "subtopic"):
            ids = [pid for cid, members in self.chunks.items() if self.mode[cid] == arm
                   for pid in members if pid not in self.unclassified]
            n = len(ids)
            hits = sum(1 for pid in ids if self.alias_hits[pid])
            probes = sum(1 for pid in ids if self.probe_hit(pid))
            out[arm] = {
                "posts": n,
                "alias_hits": hits,
                "alias_rate_pct": round(100 * hits / n, 2),
                "probe_hits": probes,
                "probe_rate_pct": round(100 * probes / n, 2),
            }
        out["alias_gap_pp"] = round(
            abs(out["macro-only"]["alias_rate_pct"] - out["subtopic"]["alias_rate_pct"]), 2
        )
        out["tolerance_pp"] = self.cfg["alias_screen"]["balance_tolerance_pp"]
        out["passes"] = out["alias_gap_pp"] <= out["tolerance_pp"]
        return out

    # ---------- the 19-stratum strict-priority partition (§2) ----------

    def _strata(self):
        cfg = self.cfg
        aca = re.compile(cfg["screens"]["aca"])
        repro = re.compile(cfg["screens"]["repro"])
        archived = set(self.posts)

        def s01(pid):
            return pid in self.unclassified

        def s02(pid):
            return pid in self.corrected

        def s03(pid):
            p = self.posts[pid]
            return (p["type"] == "retweet" and pid in self.sent
                    and p.get("refId") in archived)

        def s04(pid):
            return pid in self.emerging and len(self.ded[pid]) >= 1

        def s05(pid):
            return bool(aca.search(self.posts[pid]["text"]))

        def s06(pid):
            return (bool(repro.search(self.posts[pid]["text"]))
                    and not any(m == "reproductive-rights" for (m, _s) in self.ded[pid]))

        def s07(pid):
            return (len(self.ded[pid]) >= 1
                    and all(s is None for (_m, s) in self.ded[pid])
                    and self.chunk_mode_of(pid) == "subtopic")

        def s08(pid):
            return len(self.ded[pid]) >= 3

        def s09(pid):
            return len(self.subtopics_of(pid)) >= 1

        def s10(pid):
            return self.chunk_mode_of(pid) == "macro-only" and self.probe_hit(pid)

        def s11(pid):
            return len(self.raw[pid]) > len(self.ded[pid])

        def s12(pid):
            return pid in self.emerging

        def s13(pid):
            p = self.posts[pid]
            return (p["type"] == "retweet" and pid in self.sent
                    and p["text"].rstrip().endswith("…"))

        def s14(pid):
            return pid in self.deferred

        def s15(pid):
            return self.ded[pid] == [("constituent-services", None)]

        def s16(pid):
            p = self.posts[pid]
            return len(p["text"]) < 40 or p.get("lang") != "en"

        def s17(pid):
            return len(self.ded[pid]) == 0

        def s18(pid):
            return len(self.ded[pid]) == 1

        def s19(pid):
            return len(self.ded[pid]) == 2

        self.rules = [
            ("S01", s01), ("S02", s02), ("S03", s03), ("S04", s04), ("S05", s05),
            ("S06", s06), ("S07", s07), ("S08", s08), ("S09", s09), ("S10", s10),
            ("S11", s11), ("S12", s12), ("S13", s13), ("S14", s14), ("S15", s15),
            ("S16", s16), ("S17", s17), ("S18", s18), ("S19", s19),
        ]
        self.stratum = {}
        self.memberships = {}
        for pid in self.posts:
            hits = [sid for sid, fn in self.rules if fn(pid)]
            self.memberships[pid] = hits
            if not hits:
                raise AssertionError(
                    f"post {pid} matches no stratum — the partition is not exhaustive"
                )
            self.stratum[pid] = hits[0]
        self.pools = {sid: [] for sid, _ in self.rules}
        for pid in self.posts:
            self.pools[self.stratum[pid]].append(pid)
        for sid in self.pools:
            self.pools[sid].sort(key=lambda p: sha_key(p, self.salt))

    # ---------- helpers ----------

    def hash_key(self, pid):
        return sha_key(pid, self.salt)

    def order_key(self, pid, role=""):
        return sha_key(pid, role, "order") if role else sha_key(pid, "order")

    def subtopic_corpus_counts(self):
        counts = {}
        for pid in self.posts:
            for pair in self.subtopics_of(pid):
                counts[pair] = counts.get(pair, 0) + 1
        return counts

    def macro_corpus_counts(self):
        counts = {}
        for pid in self.posts:
            for m in self.macros_of(pid):
                counts[m] = counts.get(m, 0) + 1
        return counts


def build_frame(cfg=None):
    return Frame(cfg or load_config())
