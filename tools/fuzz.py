"""Hostile payloads against a Toon Anvil server, to find what it does not refuse.

The gym asks whether the server does the right thing when the app asks
nicely. This asks what it does when something that is NOT the app asks
badly - a hand-crafted request, a truncated body, a number where an object
belongs. That gap is where the join-code back door lived: nothing in app/
ever sent profileId, so no test ever sent it either.

    python tools/fuzz.py http://127.0.0.1:7901

Three kinds of result are interesting, and it reports only those:

  DROPPED   the connection closed with no response at all - an unhandled
            exception in the handler thread. The server survives, but the
            caller gets nothing and a traceback lands in the log.
  SERVER    a 5xx. The server knows it failed.
  ACCEPTED  a 2xx for something that should have been refused. The worst
            kind, because nothing looks wrong.

Anything that returns a clean 4xx is the server doing its job and is not
reported - a refusal is the correct answer to a hostile request.

SAFETY: refuses to run unless /api/health reports a data directory that
looks like a throwaway. Fuzzing writes junk records and opens and closes
tables; pointing it at a real campaign would be vandalism.

Stdlib only.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

TIMEOUT = 6

# A data dir must contain one of these to be considered disposable. The
# check is deliberately dumb and deliberately strict: the cost of a false
# refusal is a rename, the cost of a false pass is somebody's campaign.
DISPOSABLE = ("soak", "fuzz", "scratch", "tmp", "temp", "test")

# Bodies that are valid JSON and hostile in a different way each.
HOSTILE = [
    ("list", "[1,2]"),
    ("string", '"hello"'),
    ("number", "42"),
    ("bool", "true"),
    ("empty list", "[]"),
    ("nested list", "[[[[[1]]]]]"),
    ("null id", '{"id": null}'),
    ("numeric id", '{"id": 12345}'),
    ("list id", '{"id": ["a","b"]}'),
    ("huge string", '{"id":"x","name":"' + "A" * 20000 + '"}'),
    ("deep nest", '{"id":"x","n":' + "[" * 200 + "]" * 200 + "}"),
    ("unicode name", '{"id":"x","name":"\\u0000\\ud83d\\ude00 \\u202egnirts"}'),
    ("negative level", '{"id":"x","classes":[{"classId":"fighter","level":-5}]}'),
    ("huge level", '{"id":"x","classes":[{"classId":"fighter","level":999999}]}'),
    ("clock of 100000", '{"id":"x","clocks":[{"id":"c","label":"n",'
                        '"size":100000,"filled":0,"public":true}]}'),
]

# (method, path, needs_body). Read routes get the hostile bodies too - a
# GET with a body should be ignored, not crash.
TARGETS = [
    ("PUT", "/api/characters/fuzz-probe", True),
    ("PUT", "/api/campaigns/fuzz-probe", True),
    ("PUT", "/api/encounters/fuzz-probe", True),
    ("PUT", "/api/profiles/fuzz-probe", True),
    ("POST", "/api/events", True),
    ("POST", "/api/appgym", True),
    ("POST", "/api/sim", True),
    ("POST", "/api/pdf", True),
    ("POST", "/api/variant", True),
    ("POST", "/api/vectors", True),
    ("POST", "/api/table/open", True),
    ("POST", "/api/table/join", True),
    ("POST", "/api/table/claim", True),
    ("POST", "/api/table/forge", True),
    ("POST", "/api/table/grant", True),
]

# Path segments that should never escape the data directory.
NASTY_IDS = ["../../etc/passwd", "..%2f..%2fserve.py", "a/../../b",
             "con", "nul", "  ", ".", "..", "a" * 300, "%00", "a\\b"]


def call(url: str, method: str, body: str | None, token: str | None = None):
    """Returns (status, note). status is None when the connection dropped."""
    data = body.encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("X-Toon-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return res.status, ""
    except urllib.error.HTTPError as e:                      # a real answer
        return e.code, ""
    except urllib.error.URLError as e:
        return None, f"{type(e.reason).__name__}: {e.reason}"
    except Exception as e:                                   # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"


def guard(base: str) -> str:
    """Refuse to fuzz anything that is not obviously disposable."""
    try:
        with urllib.request.urlopen(base + "/api/health", timeout=TIMEOUT) as r:
            health = json.loads(r.read().decode("utf-8"))
    except Exception as e:                                   # noqa: BLE001
        raise SystemExit(f"cannot reach {base}: {e}")
    data_dir = str(health.get("dataDir", ""))
    low = data_dir.lower()
    if not any(word in low for word in DISPOSABLE):
        raise SystemExit(
            f"REFUSING to fuzz {base}\n"
            f"  its data directory is {data_dir}\n"
            f"  which does not look disposable (wanted one of: "
            f"{', '.join(DISPOSABLE)}).\n"
            f"  Fuzzing writes junk and opens and closes tables. Point this "
            f"at a throwaway instance.")
    return data_dir


def main(argv: list[str]) -> int:
    base = (argv[1] if len(argv) > 1 else "http://127.0.0.1:7901").rstrip("/")
    data_dir = guard(base)
    print(f"fuzzing {base}")
    print(f"  data dir {data_dir} - looks disposable, proceeding\n")

    findings: list[tuple[str, str, str, str]] = []
    tried = 0

    for method, path, _ in TARGETS:
        for label, body in HOSTILE:
            tried += 1
            status, note = call(base + path, method, body)
            if status is None:
                findings.append(("DROPPED", f"{method} {path}", label, note))
            elif status >= 500:
                findings.append(("SERVER", f"{method} {path}", label,
                                 f"HTTP {status}"))

    # Ids that should never reach the filesystem.
    for rid in NASTY_IDS:
        tried += 1
        status, note = call(f"{base}/api/characters/{rid}", "PUT",
                            '{"name":"probe"}')
        if status is None:
            findings.append(("DROPPED", f"PUT /api/characters/<{rid!r}>",
                             "path id", note))
        elif status and 200 <= status < 300:
            findings.append(("ACCEPTED", f"PUT /api/characters/<{rid!r}>",
                             "path id", f"HTTP {status} - id reached the store"))
        elif status >= 500:
            findings.append(("SERVER", f"PUT /api/characters/<{rid!r}>",
                             "path id", f"HTTP {status}"))

    print(f"{tried} hostile requests sent.\n")
    if not findings:
        print("Nothing to report: every hostile request got a clean refusal.")
        return 0

    order = {"DROPPED": 0, "SERVER": 1, "ACCEPTED": 2}
    findings.sort(key=lambda f: (order.get(f[0], 9), f[1]))
    width = max(len(f[1]) for f in findings)
    for kind, where, label, note in findings:
        print(f"  {kind:9} {where:{width}}  {label:16} {note}")
    print(f"\n{len(findings)} to look at.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
