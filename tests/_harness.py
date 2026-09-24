"""Shared fixtures for the Python tests.

Stdlib only, like everything else here. Two things every test file needs:

  * `serve` and `table` importable as modules. Neither is a package: serve.py
    lives at the repo root and table.py under tools/, so both directories go
    on sys.path once, here.

  * A way to point the server at a THROWAWAY data directory. serve.py and
    table.py resolve their paths at import time, so the fixture rebinds the
    module globals for the life of one test and puts them back afterwards.
    Nothing a test writes can reach the real data/ folder.

The live-server fixture starts a real ThreadingHTTPServer on a free port and
speaks raw HTTP to it. That is deliberate: the interesting failures are the
ones a hand-crafted request causes, and a helper that only sends what the app
sends would never find them - the fuzz tool's whole lesson.
"""
from __future__ import annotations

import http.client
import json
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for p in (str(ROOT), str(ROOT / "tools")):
    if p not in sys.path:
        sys.path.insert(0, p)

import serve   # noqa: E402
import table   # noqa: E402


class Sandbox:
    """A throwaway data directory that serve.py and table.py both use."""

    def __init__(self):
        # "test" in the path is what tools/fuzz.py and the gym's isolation
        # guard look for before they agree to write anything.
        self.dir = Path(tempfile.mkdtemp(prefix="toon-anvil-test-"))
        self.data = self.dir / "data"
        self.data.mkdir()
        self._saved = {}

    def __enter__(self):
        self._rebind(serve, "DATA", self.data)
        self._rebind(serve, "EVENT_LOG", self.data / "events.jsonl")
        self._rebind(table, "TABLE", self.data / "table.json")
        # redact_events resolves campaigns from ROOT/data, not from TABLE.
        self._rebind(table, "ROOT", self.dir)
        serve._rev = 0
        serve._changes.clear()
        return self

    def __exit__(self, *exc):
        for (mod, name), value in self._saved.items():
            setattr(mod, name, value)
        shutil.rmtree(self.dir, ignore_errors=True)
        return False

    def _rebind(self, mod, name, value):
        self._saved[(mod, name)] = getattr(mod, name)
        setattr(mod, name, value)

    def write_record(self, kind: str, rid: str, record: dict) -> Path:
        d = self.data / kind
        d.mkdir(parents=True, exist_ok=True)
        path = d / f"{rid}.json"
        path.write_text(json.dumps(record), encoding="utf-8")
        return path


class QuietHandler(serve.Handler):
    _quiet = True


class Response:
    __slots__ = ("status", "headers", "raw", "body")

    def __init__(self, status, headers, raw):
        self.status = status
        self.headers = headers
        self.raw = raw
        try:
            self.body = json.loads(raw.decode("utf-8")) if raw else None
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.body = None

    @property
    def dropped(self) -> bool:
        """The connection closed with no response at all."""
        return self.status is None


class LiveServer(unittest.TestCase):
    """A test case with a real server on a sandboxed data directory.

    The sandbox is per test method so no test can lean on another's state.
    """

    def setUp(self):
        self.sandbox = Sandbox().__enter__()
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.port = self.srv.server_address[1]
        self.thread = threading.Thread(target=self.srv.serve_forever,
                                       kwargs={"poll_interval": 0.05},
                                       daemon=True)
        self.thread.start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.thread.join(timeout=5)
        self.sandbox.__exit__(None, None, None)

    def request(self, method: str, path: str, body=None, *,
                raw: bytes | None = None, token: str | None = None,
                headers: dict | None = None) -> Response:
        """One request, one connection. `body` is JSON-encoded; `raw` is
        sent as-is so a test can send exactly the bytes it wants."""
        hdrs = {"Content-Type": "application/json"}
        if token:
            hdrs["X-Toon-Token"] = token
        if headers:
            hdrs.update(headers)
        if raw is None and body is not None:
            raw = json.dumps(body).encode("utf-8")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path, body=raw, headers=hdrs)
            res = conn.getresponse()
            return Response(res.status, dict(res.getheaders()), res.read())
        except (http.client.RemoteDisconnected, http.client.BadStatusLine,
                ConnectionResetError, BrokenPipeError):
            return Response(None, {}, b"")
        finally:
            conn.close()

    def get(self, path, **kw):
        return self.request("GET", path, **kw)

    def post(self, path, body=None, **kw):
        return self.request("POST", path, body, **kw)

    def put(self, path, body=None, **kw):
        return self.request("PUT", path, body, **kw)

    def delete(self, path, **kw):
        return self.request("DELETE", path, **kw)

    def open_table(self, name="DM") -> dict:
        """Open a table in the sandbox directly, bypassing the loopback route,
        and return the DM's token and code."""
        return table.open_table(name)

    def join(self, code, name) -> dict:
        return table.join(code, name)
