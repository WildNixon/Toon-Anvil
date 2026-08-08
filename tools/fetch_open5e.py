"""Fetch the Open5e archetype corpus for end-to-end testing.

    python tools/fetch_open5e.py [--force]

Open5e (https://open5e.com, API at https://api.open5e.com) aggregates SRD and
open-licensed third-party 5e content behind a JSON API built for programmatic
use. Every archetype carries document__title / document__url /
document__license_url, so provenance travels with the data instead of having to
be reconstructed.

Sources present at time of writing: 5e Core Rules, Kobold Press *Tome of
Heroes*, *Critical Role: Tal'Dorei Campaign Setting*, and Open5e Original
Content - roughly 10-15 subclasses per class.

A note on "most popular": Open5e exposes no view or vote counts, so popularity
is proxied by "published in a reputable source". These are professionally
designed and edited subclasses rather than the most-upvoted amateur ones. That
is arguably a better yardstick for a balance analyser, but it is NOT the same
thing, and corpus_report.py says so in its output.

This corpus is a LOCAL TEST FIXTURE. It is written to data/corpus/ and is not
redistributed by the app - we are measuring our analyser against it, not
shipping it.

Deliberately NOT used: dandwiki. Its robots.txt disallows ClaudeBot, GPTBot,
CCBot and similar with Content-Signal "ai-train=no". A human exporting pages and
dropping them in drop/ is a different matter, and that path exists.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    import truststore

    truststore.inject_into_ssl()
except ImportError:
    pass

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "corpus"

API = "https://api.open5e.com/v1/classes/?limit=50"
UA = "toon-anvil-homebrew-analyser/1.0 (local balance testing; contact: local user)"

# Be a good citizen: the API is public and built for this, but there is no need
# to hammer it.
DELAY_SECONDS = 1.0


def get(url: str) -> dict:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    force = "--force" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    index_path = OUT / "_index.json"

    if index_path.exists() and not force:
        idx = json.loads(index_path.read_text(encoding="utf-8"))
        print(f"corpus already present: {idx['counts']['archetypes']} archetypes "
              f"across {idx['counts']['classes']} classes")
        print("  (use --force to refetch)")
        return 0

    print(f"fetching {API}")
    try:
        payload = get(API)
    except (urllib.error.URLError, urllib.error.HTTPError) as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1

    classes = payload.get("results", [])
    print(f"  {len(classes)} classes\n")

    archetypes = []
    by_class: dict[str, int] = {}
    by_document: dict[str, int] = {}

    for cls in classes:
        cls_slug = cls.get("slug") or cls["name"].lower()
        arcs = cls.get("archetypes") or []
        by_class[cls_slug] = len(arcs)
        for arc in arcs:
            doc = arc.get("document__title", "unknown")
            by_document[doc] = by_document.get(doc, 0) + 1
            archetypes.append({
                "id": arc.get("slug") or arc["name"].lower().replace(" ", "-"),
                "name": arc["name"],
                "class": cls_slug,
                "className": cls["name"],
                "desc": arc.get("desc", ""),
                "source": {
                    "document": doc,
                    "slug": arc.get("document__slug"),
                    "url": arc.get("document__url"),
                    "licenseUrl": arc.get("document__license_url"),
                },
                "fetchedFrom": "open5e",
            })
        print(f"  {cls['name']:<12} {len(arcs):>3} archetypes")
        time.sleep(DELAY_SECONDS / 4)

    # One file per archetype so the drop-folder path and the batch path can use
    # exactly the same adapter.
    for arc in archetypes:
        (OUT / f"{arc['class']}--{arc['id']}.json").write_text(
            json.dumps(arc, ensure_ascii=False, indent=1), encoding="utf-8",
        )

    index = {
        "fetched": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "api": API,
        "note": (
            "LOCAL TEST FIXTURE. Not redistributed by the app. 'Most popular' is "
            "proxied by 'published in a reputable source' - Open5e exposes no "
            "view counts."
        ),
        "counts": {
            "classes": len(classes),
            "archetypes": len(archetypes),
        },
        "byClass": by_class,
        "byDocument": by_document,
        "licenses": sorted({
            a["source"]["licenseUrl"] for a in archetypes if a["source"]["licenseUrl"]
        }),
        "archetypes": [
            {"id": a["id"], "class": a["class"], "name": a["name"],
             "document": a["source"]["document"], "descChars": len(a["desc"])}
            for a in archetypes
        ],
    }
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1),
                          encoding="utf-8")

    print(f"\n{len(archetypes)} archetypes -> {OUT}")
    print("\nby document")
    for doc, n in sorted(by_document.items(), key=lambda kv: -kv[1]):
        print(f"  {n:>4}  {doc}")
    print("\nlicenses")
    for lic in index["licenses"]:
        print(f"  {lic}")

    # A description that is too short cannot contain level-gated features, so
    # flag them now rather than discovering it as an ingest failure later.
    thin = [a for a in archetypes if len(a["desc"]) < 400]
    if thin:
        print(f"\n! {len(thin)} archetypes have very short descriptions "
              f"(<400 chars) and will likely map poorly:")
        for a in thin[:8]:
            print(f"    {a['class']}/{a['name']} ({len(a['desc'])} chars)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
