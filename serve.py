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
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
APP = ROOT / "app"
DATA = ROOT / "data"

KINDS = {"characters", "campaigns", "homebrew", "npcs", "shops"}
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
EXAMPLES = ROOT / "examples"

DROP_SUFFIXES = {".html", ".htm", ".json", ".md", ".markdown", ".pdf", ".txt"}


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
    man = read_manifest()
    done = man.setdefault("processed", {})
    results = []

    for path in sorted(INBOX.iterdir()):
        if not path.is_file() or path.suffix.lower() != ".pdf":
            continue
        try:
            digest = file_hash(path)
        except OSError:
            continue
        if digest in done:
            continue
        try:
            sys.path.insert(0, str(ROOT / "tools"))
            from split_pdf import split as split_pdf_file      # noqa: PLC0415
            report = split_pdf_file(path)
            done[digest] = {
                "file": path.name,
                "at": now_iso(),
                "outputDir": report.get("outputDir"),
                "written": report.get("written", {}),
            }
            results.append(report)
        except Exception as exc:                               # noqa: BLE001
            done[digest] = {"file": path.name, "at": now_iso(),
                            "error": f"{type(exc).__name__}: {exc}"}
            results.append({"file": path.name, "error": str(exc)})
    write_manifest(man)
    return results

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,180}$")
_write_lock = threading.Lock()


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


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def kind_dir(kind: str) -> Path:
    d = DATA / kind
    d.mkdir(parents=True, exist_ok=True)
    return d


def safe_id(raw: str) -> str | None:
    """Reject anything that could escape the data directory."""
    if not ID_RE.match(raw or ""):
        return None
    if ".." in raw or "/" in raw or "\\" in raw:
        return None
    return raw


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(APP), **kw)

    # ---- plumbing ------------------------------------------------------
    def log_message(self, fmt: str, *args) -> None:
        if getattr(self, "_quiet", False):
            return
        sys.stderr.write(f"  {self.address_string()} - {fmt % args}\n")

    def _cors(self) -> None:
        # The extension runs on chrome-extension://<id>; let it talk to us.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

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
        payload["updatedAt"] = now_iso()
        path = kind_dir(parts[1]) / f"{rid}.json"
        with _write_lock:
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(
                json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
            )
            tmp.replace(path)  # atomic: never leave a half-written character
        return self._send_json({"ok": True, "id": rid, "updatedAt": payload["updatedAt"]})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/vectors":
            payload = self._read_json()
            if payload is None:
                return self._send_json({"error": "bad json body"}, 400)
            LIBRARY.mkdir(parents=True, exist_ok=True)
            with _write_lock:
                (LIBRARY / "_vectors.json").write_text(
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
                sys.path.insert(0, str(ROOT / "tools"))
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
        DATA.mkdir(parents=True, exist_ok=True)
        with _write_lock:
            if EVENT_LOG.exists() and EVENT_LOG.stat().st_size > MAX_LOG_BYTES:
                stamp = time.strftime("%Y%m%d-%H%M%S")
                shutil.move(str(EVENT_LOG), str(DATA / f"events-{stamp}.jsonl"))
            with EVENT_LOG.open("a", encoding="utf-8") as fh:
                for ev in events:
                    ev.setdefault("ts", now_iso())
                    fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
        return self._send_json({"ok": True, "written": len(events)})

    def do_DELETE(self) -> None:
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if len(parts) != 3 or parts[0] != "api" or parts[1] not in KINDS:
            return self._send_json({"error": "unknown endpoint"}, 404)
        rid = safe_id(parts[2])
        if not rid:
            return self._send_json({"error": "bad id"}, 400)
        path = kind_dir(parts[1]) / f"{rid}.json"
        if path.exists():
            path.unlink()
            return self._send_json({"ok": True, "deleted": rid})
        return self._send_json({"error": "not found"}, 404)

    def _api_get(self, parsed) -> None:
        parts = [p for p in parsed.path.split("/") if p]
        query = parse_qs(parsed.query)

        if parts == ["api", "health"]:
            counts = {k: len(list(kind_dir(k).glob("*.json"))) for k in sorted(KINDS)}
            return self._send_json({
                "ok": True, "app": "toon-anvil", "time": now_iso(),
                "dataDir": str(DATA), "counts": counts,
                "events": EVENT_LOG.stat().st_size if EVENT_LOG.exists() else 0,
            })

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
                    documents.append({
                        "document": d.name,
                        "source": report.get("file", d.name),
                        "pages": report.get("pages"),
                        "contents": contents,
                        "subclasses": report.get("subclasses", []),
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
            found = []
            for p in sorted(ROOT.parent.glob("*.htm*")):
                found.append({"name": p.name, "size": p.stat().st_size,
                              "url": f"/samples/{p.name}"})
            return self._send_json({"dir": str(ROOT.parent), "files": found})

        if len(parts) == 2 and parts[0] == "samples":
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
            return self._send_json(out[-limit:])

        if len(parts) >= 2 and parts[0] == "api" and parts[1] in KINDS:
            d = kind_dir(parts[1])
            if len(parts) == 2:
                records = []
                for p in sorted(d.glob("*.json")):
                    try:
                        records.append(json.loads(p.read_text(encoding="utf-8")))
                    except json.JSONDecodeError:
                        records.append({"id": p.stem, "_error": "unreadable"})
                return self._send_json(records)
            rid = safe_id(parts[2])
            if not rid:
                return self._send_json({"error": "bad id"}, 400)
            path = d / f"{rid}.json"
            if not path.exists():
                return self._send_json({"error": "not found"}, 404)
            try:
                return self._send_json(json.loads(path.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                return self._send_json({"error": "unreadable record"}, 500)

        return self._send_json({"error": "unknown endpoint"}, 404)


def main() -> int:
    ap = argparse.ArgumentParser(description="Toon Anvil server")
    ap.add_argument("--port", type=int, default=7801)
    ap.add_argument("--host", default="127.0.0.1")
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
    print(f"\n  Toon Anvil  ->  http://{args.host}:{args.port}")
    print(f"  data      ->  {DATA}")
    print("  ctrl-c to stop\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
