"""Toon Anvil static server + JSON API.

    python serve.py [--port 7801] [--host 127.0.0.1]

Serves app/ as a PWA (correct MIME types, no-cache on source so edits show up
on reload) and exposes a small JSON API so the installed PWA and the Chrome
side-panel extension - which live on different origins and therefore cannot
share IndexedDB - can read and write ONE dataset.

Records are stored as readable JSON on disk under data/, so characters are
diffable, backup-able and directly handable to a DM. The event log is JSON
Lines, appended never rewritten, rotated at 100 MB.

Stdlib only. No dependencies, no build step.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import re
import shutil
import socket
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

ROOT = Path(__file__).resolve().parent
APP = ROOT / "app"
DATA = ROOT / "data"
# The release number, from the one file that is the truth for it. A copy
# of the repo without it still boots - it just says so in /api/health
# rather than inventing a number.
try:
    VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip() or "0.0.0+unknown"
except OSError:
    VERSION = "0.0.0+unknown"

KINDS = {"characters", "campaigns", "homebrew", "npcs", "shops", "encounters", "maps",
         # Content ingested from a dropped PDF or written by hand. Kept apart
         # from app/data/compendium so the bundled SRD can be rebuilt without
         # taking somebody's homebrew with it.
         "custom-monsters", "custom-items", "custom-spells",
         # Who is at the table. Written by tools/table.py on join; stored
         # here too so a DM can rename or recolour a player.
         "profiles"}
EVENT_LOG = DATA / "events.jsonl"
MAX_LOG_BYTES = 100 * 1024 * 1024

# The inbox is the ONLY place a human puts files, and nothing else writes to
# it. Previously extraction dumped 118 generated files here, which buried the
# thing it is for.
INBOX = ROOT / "inbox"
LIBRARY = ROOT / "library"
EXTRACTED = LIBRARY / "extracted"
CORPUS = LIBRARY / "corpus"
MANIFEST = LIBRARY / "_manifest.json"
# Where the user's source PDFs LIVE, one category folder each - the inbox is
# only a doorway. tools/shelf.py owns the layout; the routes here just call it.
SHELF = LIBRARY / "shelf"
EXAMPLES = ROOT / "examples"

DROP_SUFFIXES = {".html", ".htm", ".json", ".md", ".markdown", ".pdf", ".txt"}

# tools/ is not a package, so the dozen routes that reach into it import
# lazily and each one used to push the path itself. Unguarded, that grew
# without bound: _table() runs on nearly every API call, so an evening of
# play left thousands of identical entries for every subsequent import to
# walk. Once is enough, and once is what this does.
TOOLS = ROOT / "tools"

# run.py is the documented front door. It runs its checks, then hands these
# lines down so the addresses print ONCE, last, after the socket is actually
# bound - what a DM reads off the screen is then a URL that already works.
# Two address blocks under two different labels is two answers to the only
# question anyone asks at setup: what do the players type?
BANNER_NOTES: list[str] = []


def tools_on_path() -> None:
    """Make `import table` and friends work, exactly once per process."""
    p = str(TOOLS)
    if p not in sys.path:
        sys.path.insert(0, p)


def read_manifest() -> dict:
    if MANIFEST.exists():
        try:
            return json.loads(MANIFEST.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"processed": {}}


def write_manifest(man: dict) -> None:
    LIBRARY.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(man, ensure_ascii=False, indent=1),
                        encoding="utf-8")


def file_hash(path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def autosplit_inbox() -> list[dict]:
    """Split any PDF in the inbox that we have not already processed.

    Keyed by file HASH rather than name, so re-dropping the same document is a
    no-op and renaming it is not. Output goes to library/extracted/<document>/,
    never back into the inbox.
    """
    if not INBOX.exists():
        return []
    done = read_manifest().get("processed", {})
    results = []
    fresh = {}

    for path in sorted(INBOX.iterdir()):
        if not path.is_file() or path.suffix.lower() != ".pdf":
            continue
        try:
            digest = file_hash(path)
        except OSError:
            continue
        if digest in done or digest in fresh:
            continue
        try:
            tools_on_path()
            from split_pdf import split as split_pdf_file      # noqa: PLC0415
            report = split_pdf_file(path)
            fresh[digest] = {
                "file": path.name,
                "at": now_iso(),
                "outputDir": report.get("outputDir"),
                "written": report.get("written", {}),
            }
            results.append(report)
        except Exception as exc:                               # noqa: BLE001
            fresh[digest] = {"file": path.name, "at": now_iso(),
                             "error": f"{type(exc).__name__}: {exc}"}
            results.append({"file": path.name, "error": str(exc)})

    # Write only when something actually changed - this used to rewrite the
    # manifest on EVERY /api/library call, which would clobber entries a CLI
    # organise wrote in between our read and our write. And take the shelf's
    # lock: every manifest writer shares the one lock or none of them count.
    if fresh:
        tools_on_path()
        from shelf import MANIFEST_LOCK                        # noqa: PLC0415
        with MANIFEST_LOCK:
            man = read_manifest()
            man.setdefault("processed", {}).update(fresh)
            write_manifest(man)
    return results

# --------------------------------------------------------------------------
# change feed
# --------------------------------------------------------------------------
#
# Every write bumps a counter and appends {rev, kind, id} to a small ring.
# Clients hold the last rev they saw and ask what has happened since, either by
# holding a stream open or by polling. That is the whole mechanism: the server
# says WHAT changed, never the record itself, so a client re-fetches only what
# it actually displays and there is one source of truth for the data.
#
# In memory on purpose. A restart resets the counter, and clients handle that
# by re-fetching everything - which is the correct response to "the server you
# were talking to went away".
_rev = 0
_changes: list[dict] = []
_rev_lock = threading.Lock()
_rev_wake = threading.Condition(_rev_lock)
MAX_CHANGES = 500

# One thread per held stream, so this is a real resource. Six players is
# nothing; a runaway client reconnecting in a loop is not.
MAX_STREAMS = 16
_streams = 0
_stream_lock = threading.Lock()


def bump(kind: str, rid: str | None = None, by: str | None = None) -> int:
    """Record that something changed. Returns the new revision.

    `by` is the client that caused it, so a browser can ignore the echo of its
    own write. Without that a tab re-renders on its own keystrokes and the
    cursor jumps mid-word.
    """
    global _rev
    with _rev_wake:
        _rev += 1
        _changes.append({"rev": _rev, "kind": kind, "id": rid,
                         "by": by, "at": time.time()})
        if len(_changes) > MAX_CHANGES:
            del _changes[:-MAX_CHANGES]
        _rev_wake.notify_all()
        return _rev


def changes_since(since: int) -> tuple[int, list[dict], bool]:
    """(current rev, changes after `since`, whether the gap was too large).

    `gap` is the honest answer to "you have been away longer than my memory".
    A client that sees it re-fetches everything rather than believing it is up
    to date on the strength of a partial list.
    """
    with _rev_lock:
        # A client AHEAD of us means this process restarted and the counter
        # reset. Everything they believe may be stale, so that is a gap too -
        # not "nothing new since 99".
        if since > _rev:
            return _rev, [], True
        if not _changes:
            return _rev, [], False
        oldest = _changes[0]["rev"]
        gap = since < oldest - 1
        return _rev, [c for c in _changes if c["rev"] > since], gap


ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,180}$")
_write_lock = threading.Lock()
# Book uploads currently being split, by content hash. A double-drop of the
# same 300-page PDF must not run two pdfplumber passes into one output dir;
# the second request gets a 409 and the toast says so.
_shelving: set[str] = set()


def safe_name(raw: str) -> bool:
    """Filenames may contain spaces and parentheses; they may not traverse."""
    if not raw or ".." in raw or "/" in raw or "\\" in raw:
        return False
    return bool(NAME_RE.match(raw))


def extract_pdf_text(path) -> tuple[str, str | None]:
    """Pull text out of a PDF.

    This is the lowest-fidelity ingest path by a wide margin: GM Binder and
    Homebrewery exports are multi-column with decorative frames, and pypdf
    recovers glyphs in layout order, which interleaves columns. We return what
    we get and flag it rather than pretending it is clean.
    """
    try:
        from pypdf import PdfReader
    except ImportError:
        return "", "pypdf is not installed"
    try:
        reader = PdfReader(str(path))
        pages = []
        for page in reader.pages:
            pages.append(page.extract_text() or "")
        return "\n\n".join(pages), None
    except Exception as exc:                      # noqa: BLE001 - report, don't crash
        return "", f"{type(exc).__name__}: {exc}"

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("audio/mpeg", ".mp3")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def kind_dir(kind: str) -> Path:
    d = DATA / kind
    d.mkdir(parents=True, exist_ok=True)
    return d


def _clamp(raw, low: float, high: float, default: float) -> float:
    """A number from a request body, forced into a range it cannot escape.

    Used on every knob that decides how much a connector call costs. The old
    code did `int(payload.get("maxTokens") or 400)` with no ceiling, which
    means a request could ask for any completion length it liked and bill the
    key owner for it. Junk falls back to the default rather than raising: the
    caller asked for something reasonable and got it.
    """
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return default
    if val != val:                                         # NaN
        return default
    return max(low, min(high, val))


def safe_id(raw: str) -> str | None:
    """Reject anything that could escape the data directory."""
    if not ID_RE.match(raw or ""):
        return None
    if ".." in raw or "/" in raw or "\\" in raw:
        return None
    return raw


# When a browser last made a real request. The idle watchdog reads it so
# the server can stop with the app rather than outliving it.
LAST_SEEN = time.time()


def touch() -> None:
    """Somebody is still here."""
    global LAST_SEEN                                           # noqa: PLW0603
    LAST_SEEN = time.time()


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(APP), **kw)

    # ---- plumbing ------------------------------------------------------
    def parse_request(self) -> bool:
        # A stamp per REAL request, and only a real one. Stamping on
        # every accepted socket instead meant a bare TCP connect - a
        # port probe, an editor polling the port, the launcher's own
        # readiness check - kept the server alive forever. Measured:
        # the idle exit never fired because the test harness was
        # connecting once a second to ask whether it had exited.
        ok = super().parse_request()
        if ok:
            touch()
        return ok

    def log_message(self, fmt: str, *args) -> None:
        if getattr(self, "_quiet", False):
            return
        sys.stderr.write(f"  {self.address_string()} - {fmt % args}\n")

    def _cors(self) -> None:
        # The extension runs on chrome-extension://<id>; let it talk to us.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                 "Content-Type,Authorization,X-Toon-Token,X-Filename")

    def _send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    # ---- table identity -------------------------------------------------
    #
    # With NO TABLE OPEN none of this runs: single-player must not grow a
    # login. The moment a DM opens a table, every mutating route is checked
    # here - a player's browser can ask for anything, so hiding a button in
    # the UI proves nothing.
    def _table(self):
        try:
            tools_on_path()
            import table as table_mod                      # noqa: PLC0415
            return table_mod
        except Exception:                                  # noqa: BLE001
            return None

    def _is_local(self) -> bool:
        """Is this request from the machine running the server?

        Opening a table is a DM action taken at their own keyboard. Allowing it
        over the network would let a player rotate the code and shut the DM
        out of their own game.
        """
        host = (self.client_address[0] if self.client_address else "")
        return host in ("127.0.0.1", "::1", "localhost")

    def _client(self) -> str | None:
        """Which browser tab sent this. Absent for curl, which is fine."""
        return (self.headers.get("X-Toon-Client") or "").strip()[:40] or None

    # A browser that has not joined, while a table IS open. whoami() answers
    # None for two very different situations - "no table, nobody to hide
    # from" (solo play) and "a table is open and you are not seated" - and
    # the redactors, which see only a profile, cannot tell them apart. They
    # read None as the first, so an unjoined device on the wifi was handed
    # monster hit points, faction agendas, lore, prepared encounters and
    # secret clocks: everything the DM had decided not to show. The seat is
    # what earns the player view; no seat earns strictly less, never more.
    UNSEATED = {"id": None, "role": "unseated", "characterIds": []}

    def _viewer(self):
        """The profile the redactors should judge this reader by."""
        mod = self._table()
        if mod is None:
            return None
        who = mod.whoami(self._token())
        if who is not None:
            return who
        # Open table + no valid token: least privilege, not most.
        return dict(self.UNSEATED) if mod.read().get("open") else None

    def _token(self) -> str | None:
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            return auth[7:].strip() or None
        return self.headers.get("X-Toon-Token") or None

    def _guard_write(self, kind: str, rid: str, incoming=None):
        """(allowed, response_tuple_or_None). Open door when no table.

        Loads the record from DISK to decide ownership. It must never be taken
        from the request body: that is attacker-controlled, and reading it from
        there let a player overwrite anybody's character just by omitting the
        ownerId field.

        `incoming` (the PUT payload; None on DELETE) is passed through so the
        character-building gate can ask what CHANGED - identity fields are set
        at the forge, levelling needs the DM's grant. Ownership still comes
        from disk alone.
        """
        mod = self._table()
        if mod is None:
            return True, None
        if not mod.read().get("open"):
            return True, None                              # solo: unchanged

        path = kind_dir(kind) / f"{rid}.json"
        exists = path.exists()
        stored = None
        if exists:
            try:
                stored = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                stored = None

        who = mod.whoami(self._token())
        ok, why = mod.may_write(who, kind, rid, stored, exists, incoming)
        if ok:
            return True, None
        return False, ({"error": why, "needsJoin": who is None},
                       401 if who is None else 403)

    def _read_json(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if n <= 0 or n > 32 * 1024 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def _read_bytes(self, cap: int = 64 * 1024 * 1024):
        """Raw request body. _read_json cannot carry a PDF: it utf-8-decodes,
        and base64-inside-JSON under the 32MB cap tops out below a real
        Monster Manual. 64MB covers every book on the shelf with room."""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if n <= 0 or n > cap:
            return None
        raw = self.rfile.read(n)
        return raw if len(raw) == n else None

    def _shelf_guard(self):
        """(allowed, response_tuple). The forge posture exactly: with no table
        open the door is open - solo must not grow a login - and the moment a
        table exists, filing books is strictly the DM's token. Deliberately no
        local-machine bypass: every browser on the DM's machine is local."""
        mod = self._table()
        if mod is None or not mod.read().get("open"):
            return True, None
        who = mod.whoami(self._token())
        if not who:
            return False, ({"error": "join first", "needsJoin": True}, 401)
        if who.get("role") != "dm":
            return False, ({"error": "only the DM files books on the shelf"}, 403)
        return True, None

    def end_headers(self) -> None:
        # App source must never be cached by the dev server, or edits appear not
        # to take. "no-cache" only forces revalidation - the browser's ES module
        # registry can still reuse an already-resolved module for the same URL,
        # which silently serves stale code after an edit. "no-store" forbids
        # keeping it at all. The service worker handles real offline caching.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- routing -------------------------------------------------------
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        # /samples/ is handled by the API router too - it reads from the parent
        # folder, not from app/, so it must not reach the static handler.
        if (parsed.path.startswith("/api/") or parsed.path.startswith("/samples/")
                or parsed.path.startswith("/drop/")
                or parsed.path.startswith("/examples/")
                or parsed.path.startswith("/library/")):
            return self._api_get(parsed)
        # SPA fallback: unknown non-file paths render the app shell.
        candidate = APP / parsed.path.lstrip("/")
        if parsed.path not in ("/", "") and not candidate.exists() and "." not in candidate.name:
            self.path = "/index.html"
        return super().do_GET()

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        if len(parts) != 3 or parts[0] != "api" or parts[1] not in KINDS:
            return self._send_json({"error": "unknown endpoint"}, 404)
        rid = safe_id(parts[2])
        if not rid:
            return self._send_json({"error": "bad id"}, 400)
        payload = self._read_json()
        if payload is None:
            return self._send_json({"error": "bad json body"}, 400)
        payload.setdefault("id", rid)

        allowed, refusal = self._guard_write(parts[1], rid, payload)
        if not allowed:
            return self._send_json(*refusal)

        payload["updatedAt"] = now_iso()
        path = kind_dir(parts[1]) / f"{rid}.json"
        with _write_lock:
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(
                json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
            )
            tmp.replace(path)  # atomic: never leave a half-written character
        rev = bump(parts[1], rid, self._client())
        if parts[1] == "characters":
            # A grant is a promise to reach a level; once the character is
            # there, the promise is kept and the gate closes again. Whoever
            # made the write - the DM levelling a player's sheet consumes too.
            mod = self._table()
            if mod and mod.consume_grant(rid, payload):
                # Deliberately authorless: the WRITER's own client must see
                # this too (their Build has to disappear), and clients drop
                # changes carrying their own id as echoes of their own writes.
                # The grant clearing is the server's act, not the client's.
                bump("table", rid, None)
        if parts[1] == "profiles":
            # The table record is what status() hands every seat; the kind
            # file is the shelf copy. A recolour or rename must reach both -
            # and only the cosmetic fields cross. Authorless for the same
            # reason as grants: every seat repaints, including the writer's.
            mod = self._table()
            if mod and mod.restyle_profile(rid, payload).get("ok"):
                bump("table", rid, None)
        return self._send_json({"ok": True, "id": rid, "rev": rev,
                                "updatedAt": payload["updatedAt"]})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/shelf":
            # A book arrives: detect what it is, file it under
            # library/shelf/<category>/, extract it. Raw PDF body + X-Filename
            # header; synchronous - the threading server keeps every other
            # route live while a big book splits, and the client shows a busy
            # toast rather than pretending this is instant.
            # Body FIRST, verdicts after: an early return that leaves the body
            # unread poisons the keep-alive socket - the next request parses
            # as '{"hash":...}POST' and 501s. Every route here drains before
            # judging.
            raw = self._read_bytes()
            allowed, err = self._shelf_guard()
            if not allowed:
                return self._send_json(*err)
            name = (self.headers.get("X-Filename") or "").strip()
            if not safe_name(name) or not name.lower().endswith(".pdf"):
                return self._send_json(
                    {"error": "X-Filename must be a .pdf file name"}, 400)
            if raw is None:
                return self._send_json(
                    {"error": "body must be the PDF bytes, 64MB or less"}, 400)
            if not raw.startswith(b"%PDF-"):
                return self._send_json({"error": "that is not a PDF"}, 400)

            tools_on_path()
            import shelf as shelf_mod                          # noqa: PLC0415
            q = parse_qs(parsed.query)
            category = (q.get("category") or [None])[0]
            if category is not None and category not in shelf_mod.CATEGORIES:
                return self._send_json({"error": "unknown category"}, 400)

            digest = hashlib.sha256(raw).hexdigest()[:16]
            with _write_lock:
                if digest in _shelving:
                    return self._send_json(
                        {"busy": True,
                         "error": "that book is already being filed"}, 409)
                _shelving.add(digest)
            try:
                incoming = SHELF / ".incoming"
                incoming.mkdir(parents=True, exist_ok=True)
                tmp = incoming / f"{digest}-{name}"
                tmp.write_bytes(raw)
                entry = shelf_mod.shelve_file(tmp, category, origin="upload",
                                              name=name)
                # alreadyKnown returns early without moving; drop the temp.
                if tmp.exists():
                    tmp.unlink()
                return self._send_json({
                    "ok": True, "alreadyKnown": entry.get("alreadyKnown", False),
                    "name": entry.get("file"), "hash": entry.get("hash", digest),
                    "category": entry.get("category"),
                    "confidence": entry.get("confidence"),
                    "evidence": entry.get("evidence", []),
                    "slug": shelf_mod.slug_for(entry.get("file", name)),
                    "written": entry.get("written", {}),
                    "pages": entry.get("pages"),
                    "error": entry.get("error"),
                })
            except Exception as exc:                           # noqa: BLE001
                return self._send_json(
                    {"error": f"{type(exc).__name__}: {exc}"}, 500)
            finally:
                with _write_lock:
                    _shelving.discard(digest)

        if parsed.path == "/api/shelf/refile":
            # The unsorted rescue, and the fix for a wrong guess: move a book
            # between category folders. Works even when extraction failed.
            payload = self._read_json()          # drain before judging
            allowed, err = self._shelf_guard()
            if not allowed:
                return self._send_json(*err)
            if payload is None:
                return self._send_json({"error": "bad json body"}, 400)
            tools_on_path()
            import shelf as shelf_mod                          # noqa: PLC0415
            digest = str(payload.get("hash") or "")
            category = str(payload.get("category") or "")
            if category not in shelf_mod.CATEGORIES:
                return self._send_json({"error": "unknown category"}, 400)
            with shelf_mod.MANIFEST_LOCK:
                man = read_manifest()
                entry = man.get("processed", {}).get(digest)
                if not entry or not entry.get("shelfPath"):
                    return self._send_json(
                        {"error": "no such book on the shelf"}, 404)
                src = Path(entry["shelfPath"])
                if SHELF.resolve() not in src.resolve().parents:
                    return self._send_json(
                        {"error": "manifest path is not under the shelf"}, 500)
                if not src.exists():
                    return self._send_json(
                        {"error": "the shelf copy is missing"}, 404)
                dest_dir = SHELF / category
                dest_dir.mkdir(parents=True, exist_ok=True)
                dest = dest_dir / src.name
                if src.resolve() != dest.resolve():
                    shutil.move(str(src), str(dest))
                entry.update({"category": category, "shelfPath": str(dest),
                              "confidence": 1.0,
                              "evidence": ["refiled by hand"],
                              "at": now_iso()})
                write_manifest(man)
            return self._send_json({"ok": True, "hash": digest,
                                    "category": category})

        if parsed.path == "/api/shelf/remove":
            # Undo an accidental drop. ONLY for uploads: an uploaded file's
            # source still sits wherever the user dragged it from, but a book
            # the CLI organised onto the shelf IS the user's only copy.
            payload = self._read_json()          # drain before judging
            allowed, err = self._shelf_guard()
            if not allowed:
                return self._send_json(*err)
            if payload is None:
                return self._send_json({"error": "bad json body"}, 400)
            tools_on_path()
            import shelf as shelf_mod                          # noqa: PLC0415
            digest = str(payload.get("hash") or "")
            with shelf_mod.MANIFEST_LOCK:
                man = read_manifest()
                done = man.get("processed", {})
                entry = done.get(digest)
                if not entry or not entry.get("shelfPath"):
                    return self._send_json(
                        {"error": "no such book on the shelf"}, 404)
                if entry.get("origin") != "upload":
                    return self._send_json(
                        {"error": "this book was organised from your files - "
                                  "the shelf copy is the only copy, so remove "
                                  "it by hand if you really mean to"}, 403)
                removed = []
                src = Path(entry["shelfPath"]).resolve()
                if SHELF.resolve() in src.parents and src.exists():
                    src.unlink()
                    removed.append("pdf")
                out_dir = entry.get("outputDir")
                if out_dir:
                    out = Path(out_dir).resolve()
                    if EXTRACTED.resolve() in out.parents and out.exists():
                        shutil.rmtree(out)
                        removed.append("extraction")
                del done[digest]
                write_manifest(man)
            return self._send_json({"ok": True, "removed": removed})

        if parsed.path == "/api/vectors":
            payload = self._read_json()
            if payload is None:
                return self._send_json({"error": "bad json body"}, 400)
            # A truncated or half-built payload must not clobber a good
            # artifact: refuse shapeless bodies, and keep the previous file
            # as _vectors.prev.json (safe from loadCorpus, which skips _*).
            if not isinstance(payload.get("axes"), list) or not payload["axes"]:
                return self._send_json(
                    {"error": "payload has no axes list - refusing to clobber"}, 400)
            if not isinstance(payload.get("vectors"), list) or not payload["vectors"]:
                return self._send_json(
                    {"error": "payload has no vectors - refusing to clobber"}, 400)
            LIBRARY.mkdir(parents=True, exist_ok=True)
            with _write_lock:
                vp = LIBRARY / "_vectors.json"
                if vp.exists():
                    (LIBRARY / "_vectors.prev.json").write_text(
                        vp.read_text(encoding="utf-8"), encoding="utf-8")
                vp.write_text(
                    json.dumps(payload, ensure_ascii=False, indent=1),
                    encoding="utf-8")
            return self._send_json({
                "ok": True,
                "vectors": len(payload.get("vectors", [])),
                "excluded": len(payload.get("excluded", [])),
            })

        if parsed.path == "/api/pdf":
            # Render a derived sheet to PDF. The numbers arrive pre-computed by
            # derive.js so there is exactly one rules engine, not two.
            payload = self._read_json()
            if payload is None:
                return self._send_json({"error": "bad json body"}, 400)
            sheet = payload.get("sheet") or payload
            try:
                tools_on_path()
                from make_pdf import build as build_pdf   # noqa: PLC0415
            except Exception as exc:                       # noqa: BLE001
                return self._send_json(
                    {"error": f"reportlab unavailable: {exc}"}, 500)

            out_dir = DATA / "sheets"
            out_dir.mkdir(parents=True, exist_ok=True)
            stem = re.sub(r"[^A-Za-z0-9._-]", "-",
                          f"{sheet.get('name', 'sheet')}-L{sheet.get('level', '')}")
            path = out_dir / f"{stem}.pdf"
            try:
                with _write_lock:
                    build_pdf(sheet, path)
            except Exception as exc:                       # noqa: BLE001
                return self._send_json(
                    {"error": f"{type(exc).__name__}: {exc}"}, 500)

            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Disposition",
                             f'attachment; filename="{path.name}"')
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)
            return None

        if parsed.path == "/api/variant":
            # Tuned homebrew variants are versioned alongside the originals,
            # never over them. The source .html files the user authored are
            # read-only inputs to this whole pipeline.
            payload = self._read_json()
            if payload is None:
                return self._send_json({"error": "bad json body"}, 400)
            rid = safe_id(str(payload.get("id", "")))
            if not rid:
                return self._send_json({"error": "bad id"}, 400)
            vdir = DATA / "homebrew-variants"
            vdir.mkdir(parents=True, exist_ok=True)
            existing = sorted(vdir.glob(f"{rid}.v*.json"))
            version = len(existing) + 1
            path = vdir / f"{rid}.v{version}.json"
            with _write_lock:
                path.write_text(
                    json.dumps(payload.get("variant", {}), ensure_ascii=False, indent=1),
                    encoding="utf-8",
                )
            return self._send_json({"ok": True, "file": path.name, "version": version})

        # ---- the table -------------------------------------------------
        if parsed.path.startswith("/api/table/"):
            mod = self._table()
            if mod is None:
                return self._send_json({"error": "table support unavailable"}, 503)
            payload = self._read_json() or {}
            action = parsed.path.rsplit("/", 1)[-1]

            if action == "open":
                # Only from the machine running the server. A player who could
                # open a table could rotate the code and lock the DM out.
                if not self._is_local():
                    return self._send_json(
                        {"error": "only the DM's own machine can open a table"}, 403)
                # The campaign is optional - a pickup game names none. The id
                # goes through safe_id because it becomes part of the record
                # other seats read; the name is display-only and table.py
                # trims it.
                out = mod.open_table(
                    payload.get("name") or "DM",
                    campaign_id=safe_id(str(payload.get("campaignId") or ""))
                    or None,
                    campaign_name=payload.get("campaignName") or None)
                bump("table", None, self._client())
                return self._send_json(out)

            if action == "close":
                who = mod.whoami(self._token())
                if not self._is_local() and (not who or who.get("role") != "dm"):
                    return self._send_json({"error": "only the DM can close the table"}, 403)
                out = mod.close_table()
                bump("table", None, self._client())
                return self._send_json(out)

            if action == "join":
                # profileId is deliberately NOT forwarded any more - see
                # table.join(). A payload naming a profile is not evidence
                # it owns it, and "p-dm" is a profile like any other.
                out = mod.join(payload.get("code") or "",
                               payload.get("name") or "Player")
                if out.get("ok"):
                    bump("table", None, self._client())
                return self._send_json(out, 200 if out.get("ok") else 403)

            if action == "leave":
                out = mod.revoke(self._token() or "")
                bump("table", None, self._client())
                return self._send_json(out)

            if action == "claim":
                # Bind a character to the profile behind this token.
                who = mod.whoami(self._token())
                if not who:
                    return self._send_json({"error": "join first"}, 401)
                is_dm = who["role"] == "dm"
                target = payload.get("profileId") if is_dm else who["id"]
                cid = safe_id(str(payload.get("characterId") or ""))
                if not cid:
                    return self._send_json({"error": "bad character id"}, 400)
                # Only the DM may take a character off another player, and
                # that is a handover rather than a second claim.
                out = mod.set_owner(target or who["id"], cid, force=is_dm)
                if not out.get("ok"):
                    return self._send_json(out, 409)
                bump("table", cid, self._client())
                return self._send_json(out)

            if action == "forge":
                # Open or close character building. Strictly the DM's token -
                # deliberately NO local-machine bypass, unlike close. Close's
                # hatch is disaster recovery; a forge hatch would make every
                # browser on the DM's machine (including a player's) the DM.
                who = mod.whoami(self._token())
                if not who:
                    return self._send_json({"error": "join first"}, 401)
                if who.get("role") != "dm":
                    return self._send_json(
                        {"error": "only the DM can open or close the forge"}, 403)
                out = mod.set_forge(bool(payload.get("open")))
                bump("table", None, self._client())
                return self._send_json(out)

            if action == "start":
                # Begin the session. DM token only, same reasoning as forge:
                # close has a local-machine hatch for disaster recovery, but a
                # start hatch would let any browser on the DM's machine drag
                # five phones out of the lobby.
                who = mod.whoami(self._token())
                if not who:
                    return self._send_json({"error": "join first"}, 401)
                if who.get("role") != "dm":
                    return self._send_json(
                        {"error": "only the DM starts the session"}, 403)
                out = mod.set_started(bool(payload.get("started", True)))
                bump("table", None, self._client())
                return self._send_json(out)

            if action == "grant":
                # Permit a character (or every player's character) to level.
                # DM token only - same reasoning as the forge above.
                who = mod.whoami(self._token())
                if not who:
                    return self._send_json({"error": "join first"}, 401)
                if who.get("role") != "dm":
                    return self._send_json(
                        {"error": "only the DM grants level-ups"}, 403)

                raw = str(payload.get("characterId") or "")
                if raw == "party":
                    data = mod.read()
                    targets = sorted({cid
                                      for prof in data.get("profiles", {}).values()
                                      if prof.get("role") == "player"
                                      for cid in prof.get("characterIds", [])})
                else:
                    cid = safe_id(raw)
                    if not cid:
                        return self._send_json({"error": "bad character id"}, 400)
                    targets = [cid]

                granted, revoked = {}, []
                for cid in targets:
                    if payload.get("revoke"):
                        if mod.clear_grant(cid):
                            revoked.append(cid)
                        continue
                    path = kind_dir("characters") / f"{cid}.json"
                    if not path.exists():
                        continue
                    try:
                        stored = json.loads(path.read_text(encoding="utf-8"))
                    except (json.JSONDecodeError, OSError):
                        continue
                    cur = mod.total_level(stored)
                    try:
                        target = int(payload.get("toLevel") or cur + 1)
                    except (TypeError, ValueError):
                        target = cur + 1
                    target = max(1, min(20, target))
                    if target <= cur:
                        continue        # a no-op grant is not written
                    mod.set_grant(cid, target)
                    granted[cid] = target
                bump("table", None, self._client())
                return self._send_json({"ok": True, "granted": granted,
                                        "revoked": revoked})

            return self._send_json({"error": "unknown table action"}, 404)

        # ---- optional connectors ---------------------------------------
        #
        # The browser never receives a key: it posts here, and this process
        # calls the provider using whatever the USER configured in their
        # environment or secrets.json. No key ships with this project.
        if parsed.path.startswith("/api/llm") or parsed.path.startswith("/api/image") \
                or parsed.path.startswith("/api/sfx"):
            payload = self._read_json()
            if payload is None:
                return self._send_json({"error": "bad json body"}, 400)

            # THE GATE. These are the only routes that can spend the user's
            # money, and until now they were the only POST routes with no
            # guard of any kind - so under --lan any phone at the table could
            # run up the DM's bill, with maxTokens unclamped.
            #
            # Loopback-or-DM, the same shape /api/table/open already uses:
            # solo play on your own machine must not need a token, and once a
            # table is open only the DM's token spends. Deliberately without
            # close's local-machine hatch - that hatch is disaster recovery,
            # and a spending hatch would simply be the hole again.
            tbl = self._table()
            if tbl is not None and tbl.read().get("open"):
                who = tbl.whoami(self._token())
                if not who:
                    return self._send_json(
                        {"ok": False, "error": "join the table first"}, 401)
                if who.get("role") != "dm":
                    return self._send_json(
                        {"ok": False, "error": "only the DM's own key is spent "
                         "here, and only the DM spends it."}, 403)
            elif not self._is_local():
                return self._send_json(
                    {"ok": False, "error": "with no table open, only the "
                     "machine running the server may use a connector."}, 403)

            try:
                tools_on_path()
                import connectors                          # noqa: PLC0415
                import spend                               # noqa: PLC0415
            except Exception as exc:                       # noqa: BLE001
                return self._send_json(
                    {"error": f"connectors unavailable: {exc}"}, 503)

            # The cap, checked BEFORE the call, so it is a cap rather than a
            # post-mortem.
            refusal = spend.check_budget()
            if refusal:
                return self._send_json(refusal, 402)

            # An id that is not in the catalogue is refused here rather than in
            # each provider, because the ledger and the privacy rule both read
            # from that row. Naming nothing stays fine - that is a transport
            # probe, and it carries nothing of yours.
            cap_id = payload.get("capability")
            cap = connectors.capability(cap_id)
            if cap is None:
                return self._send_json(
                    {"ok": False, "error": f"'{cap_id}' is not a capability in "
                     "the catalogue, so there is no way to know whether it may "
                     "leave this machine or what it should cost. Refusing "
                     "rather than guessing."}, 400)

            try:
                if parsed.path == "/api/llm":
                    out = connectors.generate_text(
                        prompt=str(payload.get("prompt") or ""),
                        system=payload.get("system"),
                        provider=payload.get("provider"),
                        # CLAMPED. An unclamped integer out of a request body
                        # is how one call becomes a hundred dollars.
                        max_tokens=int(_clamp(payload.get("maxTokens"),
                                              1, 2000, 400)),
                        temperature=_clamp(payload.get("temperature"),
                                           0, 2, 0.9),
                        cap_id=cap_id)
                elif parsed.path == "/api/image":
                    out = connectors.generate_image(
                        prompt=str(payload.get("prompt") or ""),
                        size=str(payload.get("size") or "512x512"),
                        provider=payload.get("provider"))
                elif parsed.path == "/api/sfx/search":
                    out = connectors.search_sounds(
                        query=str(payload.get("query") or ""),
                        limit=int(_clamp(payload.get("limit"), 1, 50, 8)))
                elif parsed.path == "/api/sfx/generate":
                    out = connectors.generate_sound(
                        prompt=str(payload.get("prompt") or ""),
                        seconds=_clamp(payload.get("seconds"), 0.5, 22, 4))
                else:
                    return self._send_json({"error": "unknown endpoint"}, 404)
            except Exception as exc:                       # noqa: BLE001
                # Never echo the request back: a provider error body can quote
                # headers, and headers carry the key.
                return self._send_json(
                    {"ok": False, "error": f"{type(exc).__name__}"}, 502)

            # Record what it actually cost. Every provider already tells us,
            # and the app used to throw it away - so the ledger's figures are
            # measured rather than a second guess at the estimate.
            if out.get("ok"):
                cat = connectors.catalogue()
                prices = cat.get("prices", {})
                kind = cap.get("kind") or (
                    "llm" if parsed.path == "/api/llm"
                    else "image" if parsed.path == "/api/image" else "sfx")
                out["spend"] = spend.record(
                    cap_id=cap_id, provider=out.get("provider"),
                    model=out.get("model"), kind=kind,
                    usage=out.get("usage"), prices=prices,
                    est_cents=connectors.estimate_cents(
                        cap, out.get("provider"), prices) if cap else None)
            return self._send_json(out, 200 if out.get("ok") else 502)

        if parsed.path == "/api/appgym":
            payload = self._read_json()
            if payload is None:
                return self._send_json({"error": "bad json body"}, 400)
            payload["at"] = now_iso()
            DATA.mkdir(parents=True, exist_ok=True)
            with _write_lock:
                # Append-only. A regression must remain in the record; the
                # point of the history is that it can get worse.
                with (DATA / "appgym.jsonl").open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
            return self._send_json({"ok": True, "at": payload["at"]})

        if parsed.path == "/api/sim":
            payload = self._read_json()
            if payload is None:
                return self._send_json({"error": "bad json body"}, 400)
            sim_dir = DATA / "sim"
            sim_dir.mkdir(parents=True, exist_ok=True)
            label = re.sub(r"[^A-Za-z0-9._-]", "-", str(payload.get("label", "sweep")))
            stamp = time.strftime("%Y%m%d-%H%M%S")
            path = sim_dir / f"{label}-{stamp}.json"
            body = payload.get("payload", payload)
            with _write_lock:
                path.write_text(
                    json.dumps(body, ensure_ascii=False, indent=1), encoding="utf-8",
                )
                # A stable pointer so tooling never has to guess the newest run.
                (sim_dir / "latest.json").write_text(
                    json.dumps(body, ensure_ascii=False, indent=1), encoding="utf-8",
                )
            return self._send_json({"ok": True, "file": path.name,
                                    "bytes": path.stat().st_size})

        if parsed.path != "/api/events":
            return self._send_json({"error": "unknown endpoint"}, 404)
        payload = self._read_json()
        if payload is None:
            return self._send_json({"error": "bad json body"}, 400)
        events = payload if isinstance(payload, list) else [payload]

        # The log is ungated ON PURPOSE - a seated player's roleplay beat has
        # to land even though the npcs KIND is the DM's (see rp.js). That is
        # a deliberate dependency and it stays. What does not stay is anyone
        # being able to forge the WORLD: a player POSTing a clock strike or a
        # faction shift writes DM prep into every seat's Chronicle, and the
        # redactor on the way out cannot tell a forged event from a real one.
        # The DM authors the world; everybody authors their own play.
        mod = self._table()
        if mod is not None and mod.read().get("open"):
            who = mod.whoami(self._token())
            if not who or who.get("role") != "dm":
                world = getattr(mod, "WORLD_TYPES", set())
                forged = [e for e in events if isinstance(e, dict)
                          and e.get("type") in world]
                if forged:
                    return self._send_json(
                        {"error": "only the DM writes what the world does",
                         "refused": [e.get("type") for e in forged]}, 403)

        DATA.mkdir(parents=True, exist_ok=True)
        with _write_lock:
            if EVENT_LOG.exists() and EVENT_LOG.stat().st_size > MAX_LOG_BYTES:
                stamp = time.strftime("%Y%m%d-%H%M%S")
                shutil.move(str(EVENT_LOG), str(DATA / f"events-{stamp}.jsonl"))
            with EVENT_LOG.open("a", encoding="utf-8") as fh:
                for ev in events:
                    ev.setdefault("ts", now_iso())
                    fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
        return self._send_json({"ok": True, "written": len(events),
                                "rev": bump("events", None, self._client())})

    def do_DELETE(self) -> None:
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if len(parts) != 3 or parts[0] != "api" or parts[1] not in KINDS:
            return self._send_json({"error": "unknown endpoint"}, 404)
        rid = safe_id(parts[2])
        if not rid:
            return self._send_json({"error": "bad id"}, 400)
        path = kind_dir(parts[1]) / f"{rid}.json"

        # A delete needs the same check as a write - removing somebody's
        # character is the most destructive thing a player could do.
        allowed, refusal = self._guard_write(parts[1], rid)
        if not allowed:
            return self._send_json(*refusal)

        if path.exists():
            path.unlink()
            return self._send_json({"ok": True, "deleted": rid,
                                    "rev": bump(parts[1], rid, self._client())})
        return self._send_json({"error": "not found"}, 404)

    # ---- the change stream ----------------------------------------------
    #
    # Server-Sent Events over the existing HTTP server. ThreadingHTTPServer
    # gives each held connection its own thread, which is fine for a table of
    # six and is why MAX_STREAMS exists - a client stuck in a reconnect loop
    # would otherwise eat the pool.
    #
    # Deliberately short-lived: the stream ends itself after a few minutes and
    # EventSource reconnects on its own. A connection that lives forever is a
    # connection nobody notices leaking.
    STREAM_SECONDS = 240
    HEARTBEAT_SECONDS = 20

    def _stream(self, query) -> None:
        global _streams
        with _stream_lock:
            if _streams >= MAX_STREAMS:
                # Refuse rather than degrade. The client polls instead, which
                # is slower and completely correct.
                return self._send_json(
                    {"error": "too many open streams; poll /api/changes instead"}, 503)
            _streams += 1

        try:
            since = int((query.get("since") or ["0"])[0])
        except ValueError:
            since = 0

        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self._cors()
            self.end_headers()
            # No Content-Length, so the body is delimited by the close. Telling
            # the base class not to reuse this connection keeps it honest.
            self.close_connection = True

            def send(payload: dict) -> None:
                self.wfile.write(
                    f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()

            rev, items, gap = changes_since(since)
            send({"type": "hello", "rev": rev, "gap": gap, "changes": items})

            deadline = time.time() + self.STREAM_SECONDS
            last = rev
            while time.time() < deadline:
                with _rev_wake:
                    # Wake on a write, or on the heartbeat - whichever first.
                    _rev_wake.wait(timeout=self.HEARTBEAT_SECONDS)
                    current = _rev
                if current != last:
                    rev, items, gap = changes_since(last)
                    send({"type": "change", "rev": rev, "gap": gap, "changes": items})
                    last = rev
                else:
                    # Somebody is holding this stream open, so they are
                    # very much still here - one request that lasts
                    # minutes would otherwise read as an idle server.
                    touch()
                    # A comment line keeps proxies and idle timeouts happy
                    # without looking like data to the client.
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()

            send({"type": "bye", "rev": last})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # The player closed the tab. Entirely normal; not worth a log line.
            pass
        except Exception as exc:                               # noqa: BLE001
            sys.stderr.write(f"  stream ended: {type(exc).__name__}\n")
        finally:
            with _stream_lock:
                _streams -= 1
        return None

    def _api_get(self, parsed) -> None:
        # Percent-decode each segment. urlparse does not, so a document named
        # "Monster Manual" arrived as "Monster%20Manual" and was rejected by
        # safe_name() - every file with a space in its name was unreachable.
        parts = [unquote(p) for p in parsed.path.split("/") if p]
        query = parse_qs(parsed.query)

        if parts == ["api", "health"]:
            counts = {k: len(list(kind_dir(k).glob("*.json"))) for k in sorted(KINDS)}
            return self._send_json({
                "ok": True, "app": "toon-anvil", "version": VERSION,
                "time": now_iso(),
                "dataDir": str(DATA), "counts": counts,
                "events": EVENT_LOG.stat().st_size if EVENT_LOG.exists() else 0,
            })

        if parts == ["api", "shelf"]:
            # The whole collection grouped by what each book IS. Deliberately
            # its own route: /api/library triggers the inbox autosplit on
            # every call, and the Deck needs a cheap, side-effect-free poll.
            tools_on_path()
            import shelf as shelf_mod                          # noqa: PLC0415
            cats: dict[str, list] = {c: [] for c in shelf_mod.CATEGORIES}
            for digest, e in read_manifest().get("processed", {}).items():
                if not e.get("category"):
                    continue        # inbox / seeded entries are not shelved
                sp = e.get("shelfPath")
                # The manifest's written counts are a snapshot from the drop.
                # The extraction dir's _report.json is the source of truth -
                # a re-extraction (better splitter, CLI re-run) updates it,
                # and the Deck must report what the book yields NOW.
                written = e.get("written", {})
                out_dir = e.get("outputDir")
                if out_dir:
                    rep_fp = Path(out_dir) / "_report.json"
                    try:
                        if rep_fp.is_file():
                            written = json.loads(rep_fp.read_text(
                                encoding="utf-8")).get("written", written)
                    except (OSError, json.JSONDecodeError):
                        pass
                cats.setdefault(e["category"], []).append({
                    "name": e.get("file"), "hash": digest,
                    "slug": shelf_mod.slug_for(e.get("file", "")),
                    "category": e["category"],
                    "confidence": e.get("confidence"),
                    "evidence": e.get("evidence", []),
                    "written": written,
                    "pages": e.get("pages"),
                    "origin": e.get("origin"),
                    "present": bool(sp and Path(sp).exists()),
                    "extractedOk": bool(e.get("outputDir")) and not e.get("error"),
                    "error": e.get("error"),
                    "at": e.get("at"),
                })
            for rows in cats.values():
                rows.sort(key=lambda r: (r.get("name") or "").lower())
            return self._send_json({"shelfDir": str(SHELF), "categories": cats})

        if len(parts) == 4 and parts[:3] == ["api", "shelf", "sections"]:
            # A shelved book in reading order, ready for the Deck's review
            # rows. Statblock kinds stay out unless ?all=1 - they surface
            # one-by-one in the workshop, not as a thousand-row ingest.
            slug = unquote(parts[3])
            if not safe_name(slug):
                return self._send_json({"error": "bad document name"}, 400)
            tools_on_path()
            import shelf as shelf_mod                          # noqa: PLC0415
            include_all = (parse_qs(parsed.query).get("all") or ["0"])[0] == "1"
            rows = shelf_mod.sections_for(slug, include_all=include_all)
            return self._send_json({"slug": slug, "total": len(rows),
                                    "sections": rows})

        if parts == ["api", "split", "selftest"]:
            # The PDF splitter's quality gate, run in-process on SRD-rendered
            # fixtures (never book text). The gym calls this so the Python
            # pipeline sits behind the same green-or-red door as the app.
            tools_on_path()
            import split_pdf as split_mod                      # noqa: PLC0415
            try:
                return self._send_json(split_mod.selftest())
            except Exception as exc:                           # noqa: BLE001
                return self._send_json(
                    {"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 500)

        if parts == ["api", "library"] or parts == ["api", "drop"]:
            # One structured view of everything the app can see, grouped by
            # where it came from. The old flat list mixed 118 generated files
            # in with the corpus and whatever the user had dropped.
            split_reports = autosplit_inbox()

            inbox_files = []
            if INBOX.exists():
                for p in sorted(INBOX.iterdir()):
                    if not p.is_file() or p.suffix.lower() not in DROP_SUFFIXES:
                        continue
                    # Our own instructions are not homebrew. Listing README.txt
                    # with an Analyse button next to it is noise, and it hides
                    # the empty state that offers the shipped example.
                    if p.name.lower() in ("readme.txt", "readme.md"):
                        continue
                    inbox_files.append({
                        "name": p.name, "size": p.stat().st_size,
                        "kind": p.suffix.lower().lstrip("."),
                        "url": f"/library/inbox/{p.name}",
                    })

            # Which shelf category (if any) each extraction belongs to, so the
            # workshop can badge a document without a second request.
            cat_by_doc = {}
            for e in read_manifest().get("processed", {}).values():
                if e.get("category") and e.get("outputDir"):
                    cat_by_doc[Path(e["outputDir"]).name] = e["category"]

            documents = []
            if EXTRACTED.exists():
                for d in sorted(EXTRACTED.iterdir()):
                    if not d.is_dir():
                        continue
                    report = {}
                    rp = d / "_report.json"
                    if rp.exists():
                        try:
                            report = json.loads(rp.read_text(encoding="utf-8"))
                        except json.JSONDecodeError:
                            report = {}
                    contents = {}
                    for f in sorted(d.glob("*.json")):
                        if f.name.startswith("_"):
                            continue
                        try:
                            items = json.loads(f.read_text(encoding="utf-8"))
                            contents[f.stem] = len(items) if isinstance(items, list) else 1
                        except json.JSONDecodeError:
                            contents[f.stem] = 0
                    # Monsters, items and spells alongside subclasses. Only a
                    # title and a size go in the listing; the text is fetched
                    # when something is actually opened, so a 258-page archive
                    # does not arrive with every page listing.
                    other = {}
                    for kind in ("monster", "magic_item", "spell", "feat", "species"):
                        f = d / f"{kind}.json"
                        if not f.exists():
                            continue
                        try:
                            rows = json.loads(f.read_text(encoding="utf-8"))
                        except json.JSONDecodeError:
                            continue
                        if isinstance(rows, list) and rows:
                            other[kind] = [
                                {"title": r.get("title") or "(untitled)",
                                 "chars": len(r.get("text") or ""),
                                 "confidence": r.get("confidence"),
                                 "page": r.get("page")}
                                for r in rows
                            ]

                    documents.append({
                        "document": d.name,
                        "source": report.get("file", d.name),
                        "pages": report.get("pages"),
                        "category": cat_by_doc.get(d.name),
                        "contents": contents,
                        "subclasses": report.get("subclasses", []),
                        "other": other,
                        "url": f"/library/extracted/{d.name}",
                    })

            corpus_files = []
            for base in (CORPUS, DATA / "corpus"):
                if not base.exists():
                    continue
                for p in sorted(base.glob("*.json")):
                    if p.name.startswith("_"):
                        continue
                    corpus_files.append({
                        "name": p.name, "size": p.stat().st_size, "kind": "json",
                        "url": f"/library/corpus/{p.name}",
                    })
                break

            return self._send_json({
                "inboxDir": str(INBOX),
                "libraryDir": str(LIBRARY),
                "accepts": sorted(DROP_SUFFIXES),
                "inbox": inbox_files,
                "documents": documents,
                "corpus": corpus_files,
                "justSplit": [r.get("file") for r in split_reports if r.get("file")],
                # Kept so older callers keep working during the transition.
                "files": (
                    [{**f, "origin": "inbox"} for f in inbox_files]
                    + [{**f, "origin": "corpus"} for f in corpus_files]
                ),
            })

        if parts == ["api", "changes"]:
            # The polling half. Always available, never blocks, and the answer
            # a client falls back to when a held stream drops.
            try:
                since = int((query.get("since") or ["0"])[0])
            except ValueError:
                since = 0
            rev, items, gap = changes_since(since)
            return self._send_json({"rev": rev, "changes": items, "gap": gap})

        if parts == ["api", "stream"]:
            return self._stream(query)

        if parts == ["api", "table"]:
            mod = self._table()
            if mod is None:
                return self._send_json({"open": False, "me": None, "profiles": []})
            out = mod.status(self._token())
            # The code goes to the machine running the server, or to whoever
            # holds the DM token: the DM who opened the table at the desk and
            # then sat on the couch with a laptop is still the DM. Players
            # never see it - status() itself never embeds it, this branch
            # adds it only for the trusted seat.
            me = out.get("me") or {}
            if out["open"] and (self._is_local() or me.get("role") == "dm"):
                out["code"] = mod.read().get("code")
                # Where players can actually reach this table, computed from
                # the socket the server bound - not from what run.py intended.
                # If 7801 was busy and we drifted to 7802, this says 7802.
                bhost, bport = self.server.server_address[:2]
                if bhost in ("0.0.0.0", ""):
                    lan = _lan_ip()
                    out["addresses"] = ([f"http://127.0.0.1:{bport}"]
                                        + ([f"http://{lan}:{bport}"] if lan
                                           else []))
                    out["lanHint"] = True
                else:
                    out["addresses"] = [f"http://{bhost}:{bport}"]
                    out["lanHint"] = False
            return self._send_json(out)

        if parts == ["api", "providers"]:
            # Reports only WHETHER each connector is configured - never a key's
            # value, so this is safe for the browser to hold and display.
            try:
                tools_on_path()
                import connectors                          # noqa: PLC0415
                return self._send_json(connectors.describe())
            except Exception as exc:                       # noqa: BLE001
                return self._send_json({
                    "available": False,
                    "reason": f"connectors unavailable: {type(exc).__name__}",
                    "providers": {},
                })

        if parts == ["api", "spend"]:
            # What the connectors have actually cost. Read-only and local-ish
            # by nature: it carries no key, only counts and totals, and a
            # player seeing the DM's spend is not a secret worth defending.
            try:
                tools_on_path()
                import spend                               # noqa: PLC0415
                return self._send_json(spend.summary())
            except Exception as exc:                       # noqa: BLE001
                return self._send_json({
                    "calls": 0, "cents": 0,
                    "reason": f"ledger unavailable: {type(exc).__name__}",
                })

        if parts == ["api", "appgym"]:
            # Graded runs of the application gym, newest last. Append-only so
            # the loop can be graphed over time; a run that regressed must stay
            # visible rather than being overwritten by the next green one.
            gp = DATA / "appgym.jsonl"
            if not gp.exists():
                return self._send_json([])
            rows = []
            for line in gp.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
            return self._send_json(rows[-200:])

        if parts == ["api", "vectors"]:
            vp = LIBRARY / "_vectors.json"
            if not vp.exists():
                return self._send_json({"error": "no vectors yet"}, 404)
            return self._send_json(json.loads(vp.read_text(encoding="utf-8")))

        if len(parts) == 4 and parts[0] == "library" and parts[1] == "extracted":
            doc, name = parts[2], parts[3]
            if not safe_name(doc) or not safe_name(name):
                return self._send_json({"error": "bad path"}, 400)
            path = EXTRACTED / doc / name
            if not path.exists():
                return self._send_json({"error": "not found"}, 404)
            return self._send_json(json.loads(path.read_text(encoding="utf-8")))

        if len(parts) == 3 and parts[0] in ("library", "drop"):
            origin, name = parts[1], parts[2]
            bases = {"inbox": INBOX, "corpus": CORPUS if CORPUS.exists() else DATA / "corpus",
                     "drop": INBOX}
            base = bases.get(origin)
            if base is None or not safe_name(name):
                return self._send_json({"error": "bad path"}, 400)
            path = base / name
            if not path.exists():
                return self._send_json({"error": "not found"}, 404)

            # PDFs are extracted to text server-side: pypdf is Python-only, and
            # keeping one extraction path means the browser only ever deals in
            # text. The response says it was extracted so the UI can warn.
            if path.suffix.lower() == ".pdf":
                text, err = extract_pdf_text(path)
                return self._send_json({
                    "name": name, "kind": "pdf", "extracted": True,
                    "text": text, "error": err,
                    "warning": "PDF text extraction loses column order and "
                               "formatting markers; check the parsed features.",
                })

            body = path.read_bytes()
            ctype = {
                ".html": "text/html", ".htm": "text/html",
                ".json": "application/json", ".md": "text/markdown",
                ".markdown": "text/markdown", ".txt": "text/plain",
            }.get(path.suffix.lower(), "application/octet-stream")
            self.send_response(200)
            self.send_header("Content-Type", f"{ctype}; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)
            return None

        if parts == ["api", "examples"]:
            # Shipped with the repo, MIT licensed. This is what a first-time
            # user presses when their inbox is empty, so it must always exist.
            found = []
            for p in sorted(EXAMPLES.glob("*.*")):
                if p.suffix.lower() in (".html", ".htm", ".md", ".json", ".txt"):
                    found.append({"name": p.name, "size": p.stat().st_size,
                                  "url": f"/examples/{p.name}"})
            return self._send_json({"dir": str(EXAMPLES), "files": found})

        if len(parts) == 2 and parts[0] == "examples":
            name = parts[1]
            if "/" in name or "\\" in name or ".." in name:
                return self._send_json({"error": "bad name"}, 400)
            path = EXAMPLES / name
            if not path.exists() or not path.is_file():
                return self._send_json({"error": "not found"}, 404)
            body = path.read_bytes()
            ctype = {
                ".html": "text/html", ".htm": "text/html",
                ".md": "text/markdown", ".json": "application/json",
            }.get(path.suffix.lower(), "text/plain")
            self.send_response(200)
            self.send_header("Content-Type", f"{ctype}; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)
            return None

        if parts == ["api", "samples"]:
            # The user's hand-written homebrew pages live beside this project.
            # Listing them lets Homebrew mode offer one-click import instead of
            # making them hunt through a file picker every time.
            #
            # Loopback only. This is the one route that reaches OUTSIDE the
            # project, and under --lan it was handing every phone on the wifi
            # a directory listing of the folder holding the app - then serving
            # any .html in it whole. Reading the DM's drafts off their own
            # disk is a this-machine action; a player's phone has no business
            # in it, and a table being open does not change that.
            if not self._is_local():
                return self._send_json({"error": "that folder is only "
                                        "readable on the DM's own machine"}, 403)
            found = []
            for p in sorted(ROOT.parent.glob("*.htm*")):
                found.append({"name": p.name, "size": p.stat().st_size,
                              "url": f"/samples/{p.name}"})
            return self._send_json({"dir": str(ROOT.parent), "files": found})

        if len(parts) == 2 and parts[0] == "samples":
            # Same rule as the listing above: the folder beside the project
            # is the DM's own, and only reachable from the DM's own machine.
            if not self._is_local():
                return self._send_json({"error": "that folder is only "
                                        "readable on the DM's own machine"}, 403)
            name = parts[1]
            if "/" in name or "\\" in name or ".." in name or not name.endswith((".html", ".htm")):
                return self._send_json({"error": "bad name"}, 400)
            path = ROOT.parent / name
            if not path.exists():
                return self._send_json({"error": "not found"}, 404)
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)
            return None

        if parts == ["api", "events"]:
            if not EVENT_LOG.exists():
                return self._send_json([])
            want_char = (query.get("character") or [None])[0]
            want_campaign = (query.get("campaign") or [None])[0]
            try:
                limit = int((query.get("limit") or ["2000"])[0])
            except ValueError:
                limit = 2000
            out = []
            with EVENT_LOG.open("r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        continue  # a torn last line must not kill the log
                    if want_char and ev.get("characterId") != want_char:
                        continue
                    if want_campaign and ev.get("campaignId") != want_campaign:
                        continue
                    out.append(ev)
            out = out[-limit:]
            # The kind routes have redacted since the beginning. This one
            # never did, and it sits ABOVE them in the dispatch, so it was
            # never going to inherit it - which is how a secret clock's
            # label reached every player's Chronicle.
            #
            # Redaction runs AFTER the limit so the work is bounded by what
            # was asked for rather than by the size of the log. A player can
            # therefore receive slightly fewer than `limit` events, which is
            # the correct trade: the alternative is resolving every clock in
            # a hundred-thousand-line log to fill a quota.
            mod = self._table()
            if mod and hasattr(mod, "redact_events"):
                out = mod.redact_events(out, self._viewer())
            return self._send_json(out)

        if len(parts) >= 2 and parts[0] == "api" and parts[1] in KINDS:
            d = kind_dir(parts[1])
            if len(parts) == 2:
                records = []
                for p in sorted(d.glob("*.json")):
                    try:
                        records.append(json.loads(p.read_text(encoding="utf-8")))
                    except json.JSONDecodeError:
                        records.append({"id": p.stem, "_error": "unreadable"})
                # The list endpoint reads the same files as the single-record
                # route, so it needs the same redaction - one mapping for
                # both, because the list route was missed once and the leak
                # was silent.
                mod = self._table()
                if mod:
                    fn = {"encounters": mod.redact_encounter,
                          "campaigns": mod.redact_campaign,
                          "maps": mod.redact_map}.get(parts[1])
                    if fn:
                        me = self._viewer()
                        records = [fn(r, me) for r in records]
                return self._send_json(records)
            rid = safe_id(parts[2])
            if not rid:
                return self._send_json({"error": "bad id"}, 400)
            path = d / f"{rid}.json"
            if not path.exists():
                return self._send_json({"error": "not found"}, 404)
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                return self._send_json({"error": "unreadable record"}, 500)
            mod = self._table()
            if mod:
                fn = {"encounters": mod.redact_encounter,
                      "campaigns": mod.redact_campaign,
                      "maps": mod.redact_map}.get(parts[1])
                if fn:
                    record = fn(record, self._viewer())
            return self._send_json(record)

        return self._send_json({"error": "unknown endpoint"}, 404)


def _lan_ip() -> str | None:
    """This machine's address on the local network, or None if unknowable.

    The UDP connect sends nothing; it asks the routing table which interface
    faces the network - the only reliable way to get the address a player
    should type. (Deliberately duplicated from run.py rather than imported:
    serve must stay runnable on its own.)
    """
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("10.255.255.255", 1))
        ip = probe.getsockname()[0]
        probe.close()
        return ip
    except OSError:
        return None


def _players_seated() -> bool:
    """Is anyone actually at a table? Never strand a live session."""
    try:
        tools_on_path()
        import table as table_mod                              # noqa: PLC0415
        data = table_mod.read()
        if not data.get("open"):
            return False
        return any(p.get("role") == "player"
                   for p in (data.get("profiles") or {}).values())
    except Exception:                                          # noqa: BLE001
        # If we cannot tell, assume somebody IS there. Wrongly staying up
        # costs a stray process; wrongly exiting ends five people's game.
        return True


def _idle_watch(srv, seconds: float) -> None:
    """Stop when the app has gone, so the server does not outlive it.

    Starting the server and starting the app are one act now, and stopping
    should be too: close the tab and this should not still be holding a
    port an hour later. Two guards keep that from becoming a foot-gun:

      - the app polls while any tab is open, so "idle" really does mean
        nobody is looking;
      - a table with players seated NEVER idles out, because the DM closing
        their own tab must not end everyone else's session.
    """
    while True:
        time.sleep(5)
        if time.time() - LAST_SEEN < seconds:
            continue
        if _players_seated():
            continue
        print()
        print(f"no browser for {seconds:.0f}s and nobody seated - stopping")
        threading.Thread(target=srv.shutdown, daemon=True).start()
        return


def main() -> int:
    ap = argparse.ArgumentParser(description="Toon Anvil server")
    ap.add_argument("--port", type=int, default=7801)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--exit-when-idle", type=float, default=0,
                    metavar="SECONDS",
                    help="stop once no browser has called for this long "
                         "and no players are seated. 0 never exits.")
    args = ap.parse_args()

    if not APP.exists():
        print(f"missing {APP}", file=sys.stderr)
        return 1
    DATA.mkdir(parents=True, exist_ok=True)
    for k in KINDS:
        kind_dir(k)
    INBOX.mkdir(parents=True, exist_ok=True)
    LIBRARY.mkdir(parents=True, exist_ok=True)
    EXTRACTED.mkdir(parents=True, exist_ok=True)

    readme = INBOX / "README.txt"
    if not readme.exists():
        readme.write_text(
            "PUT YOUR HOMEBREW FILES IN THIS FOLDER.\n"
            "Nothing else writes here, so it stays yours.\n\n"
            "Accepted: .pdf .html .htm .md .markdown .json .txt\n\n"
            "Drop a PDF and it is split automatically the next time you open\n"
            "the app. Whatever it finds - subclasses, spells, magic items,\n"
            "feats - lands in:\n\n"
            "    library/extracted/<name of your PDF>/\n\n"
            "and shows up in the app under 'From your PDFs'.\n\n"
            "How well a format reads:\n"
            "  .json  best  - already structured\n"
            "  .html  best  - formatting markers survive\n"
            "  .md    good  - headings give feature boundaries\n"
            "  .pdf   rough - text extraction loses columns; the app flags\n"
            "                 low-confidence results so you can check them\n",
            encoding="utf-8",
        )

    compendium = APP / "data" / "compendium" / "_meta.json"
    if compendium.exists():
        meta = json.loads(compendium.read_text(encoding="utf-8"))
        counts = meta.get("counts", {})
        print(f"compendium: SRD {meta.get('srdVersion')} - "
              f"{counts.get('spells', 0)} spells, {counts.get('monsters', 0)} monsters, "
              f"{counts.get('classes', 0)} classes")
    else:
        print("compendium: MISSING - run python tools/srd_convert.py")

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    if args.host in ("0.0.0.0", ""):
        # 0.0.0.0 is a bind address, not a place a browser can go - print
        # the two URLs people actually type.
        lan_ip = _lan_ip() or "your-ip-address"
        print(f"\n  Toon Anvil (you)      ->  http://127.0.0.1:{args.port}")
        print(f"  Toon Anvil (players)  ->  http://{lan_ip}:{args.port}")
    else:
        print(f"\n  Toon Anvil  ->  http://{args.host}:{args.port}")
    for line in BANNER_NOTES:
        print(line)
    print(f"  data      ->  {DATA}")
    print("  ctrl-c to stop\n")
    if args.exit_when_idle > 0:
        threading.Thread(target=_idle_watch, daemon=True,
                         args=(srv, args.exit_when_idle)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
