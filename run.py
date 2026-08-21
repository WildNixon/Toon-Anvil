"""Toon Anvil - start here.

    python run.py

Checks that everything needed is present, starts the local server, and opens
the app in your browser.

Every check prints what to do about a failure rather than just what failed. A
tool that says "missing compendium" and stops has told you nothing useful.

    python run.py --check      run the checks and exit
    python run.py --no-browser start the server without opening a browser
    python run.py --port 8080  use a different port
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APP = ROOT / "app"


def app_version() -> str:
    """The release number from VERSION at the root - the one file that is the
    truth for it. A checkout without it is not broken, just unlabelled."""
    try:
        return (ROOT / "VERSION").read_text(encoding="utf-8").strip() or "0.0.0+unknown"
    except OSError:
        return "0.0.0+unknown"

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
DIM = "\033[2m"
OFF = "\033[0m"

if sys.platform == "win32":
    # Enable ANSI on Windows terminals that need it; harmless if already on.
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleMode(
            ctypes.windll.kernel32.GetStdHandle(-11), 7)
    except Exception:                                          # noqa: BLE001
        GREEN = RED = YELLOW = DIM = OFF = ""


class Check:
    def __init__(self):
        self.failures: list[str] = []
        self.warnings: list[str] = []

    def ok(self, label: str, detail: str = "") -> None:
        print(f"  {GREEN}OK{OFF}    {label}" + (f" {DIM}{detail}{OFF}" if detail else ""))

    def warn(self, label: str, fix: str) -> None:
        print(f"  {YELLOW}NOTE{OFF}  {label}")
        print(f"        {DIM}{fix}{OFF}")
        self.warnings.append(label)

    def fail(self, label: str, fix: str) -> None:
        print(f"  {RED}FAIL{OFF}  {label}")
        print(f"        {DIM}{fix}{OFF}")
        self.failures.append(label)


def run_checks() -> Check:
    c = Check()
    print(f"\n{DIM}Checking your setup...{OFF}\n")

    # --- python ------------------------------------------------------------
    if sys.version_info < (3, 9):
        c.fail(f"Python {sys.version_info.major}.{sys.version_info.minor} is too old",
               "Toon Anvil needs Python 3.9 or newer. Install from python.org.")
    else:
        c.ok(f"Python {sys.version_info.major}.{sys.version_info.minor}")

    # --- dependencies ------------------------------------------------------
    required = {
        "pypdf": "reading PDFs you drop in",
        "pdfplumber": "reading PDF columns correctly",
        "reportlab": "writing character sheet PDFs",
        "numpy": "confidence intervals in the analysis",
        "matplotlib": "the offline charts",
        "PIL": "rendering the app icons",
    }
    missing = []
    for mod, why in required.items():
        try:
            __import__(mod)
        except ImportError:
            missing.append(f"{mod} ({why})")
    if missing:
        c.fail(f"{len(missing)} Python package(s) missing",
               "Run:  pip install -r requirements.txt\n        Missing: "
               + ", ".join(missing))
    else:
        c.ok("Python packages", f"{len(required)} present")

    # --- the app itself ----------------------------------------------------
    if not (APP / "index.html").exists():
        c.fail("app/index.html not found",
               f"Run this from inside the project folder. Looked in {APP}")
    else:
        c.ok("App files")

    # --- version -----------------------------------------------------------
    # VERSION at the root is the truth; app/version.js, the service worker's
    # cache name and the CHANGELOG's top released entry mirror it. A mirror
    # that drifts is how an update ships under last month's number - or under
    # a cache name that never busts, so installed phones keep the old app.
    version_file = ROOT / "VERSION"
    if not version_file.exists():
        c.fail("VERSION file missing",
               "Create VERSION at the repo root holding the release number, e.g. 2.0.0")
    else:
        truth = version_file.read_text(encoding="utf-8").strip()
        mirrors: dict[str, str | None] = {}

        def _grab(path: Path, pattern: str) -> str | None:
            try:
                m = re.search(pattern, path.read_text(encoding="utf-8"), re.MULTILINE)
            except OSError:
                return None
            return m.group(1) if m else None

        mirrors["app/version.js"] = _grab(APP / "version.js", r"VERSION\s*=\s*'([^']+)'")
        mirrors["app/sw.js"] = _grab(APP / "sw.js", r"'toon-anvil-v([^']+)'")
        # The first RELEASED heading: [Unreleased] has no digits and is skipped.
        mirrors["CHANGELOG.md"] = _grab(ROOT / "CHANGELOG.md", r"^## \[(\d+\.\d+\.\d+)\]")
        drift = {k: v for k, v in mirrors.items() if v != truth}
        if drift:
            c.fail(f"Version drift: VERSION says {truth}",
                   "These disagree: " + ", ".join(
                       f"{k} says {v or 'nothing'}" for k, v in drift.items())
                   + "\n        Bump every mirror in the same commit as VERSION, then tag.")
        else:
            c.ok(f"Version {truth}", "VERSION, app/version.js, sw.js and CHANGELOG agree")

    # --- bundled rules data ------------------------------------------------
    meta = APP / "data" / "compendium" / "_meta.json"
    if not meta.exists():
        c.fail("Rules data missing",
               "The SRD compendium ships with the repo, so this usually means an\n"
               "        incomplete download. Rebuild it with:\n"
               "          python tools/fetch_srd.py && python tools/srd_convert.py")
    else:
        try:
            m = json.loads(meta.read_text(encoding="utf-8"))
            counts = m.get("counts", {})
            c.ok(f"Rules data (SRD {m.get('srdVersion', '?')})",
                 f"{counts.get('spells', 0)} spells, {counts.get('monsters', 0)} "
                 f"monsters, {counts.get('classes', 0)} classes")
        except json.JSONDecodeError:
            c.fail("Rules data is corrupt",
                   "Rebuild:  python tools/srd_convert.py")

    # --- fonts (cosmetic only) --------------------------------------------
    fonts = list((APP / "data" / "fonts").glob("*.woff2"))
    if len(fonts) < 5:
        c.warn(f"{len(fonts)}/5 bundled fonts present",
               "The app still works and falls back to system fonts.\n"
               "        Restore with:  python tools/fetch_fonts.py")
    else:
        c.ok("Fonts", "5 bundled")

    # --- folders -----------------------------------------------------------
    (ROOT / "inbox").mkdir(exist_ok=True)
    (ROOT / "library" / "extracted").mkdir(parents=True, exist_ok=True)
    c.ok("Folders", "inbox/ and library/ ready")

    # --- something to try --------------------------------------------------
    examples = list((ROOT / "examples").glob("*.json")) if (ROOT / "examples").exists() else []
    inbox_files = [p for p in (ROOT / "inbox").iterdir()
                   if p.is_file() and p.suffix.lower() != ".txt"]
    if not inbox_files and examples:
        c.ok("Example subclass", f"{examples[0].name} - open Homebrew to try it")
    elif inbox_files:
        c.ok("Inbox", f"{len(inbox_files)} file(s) waiting")

    return c


def _open_when_ready(port: int, url: str, timeout: float = 60.0) -> None:
    """Open the browser once the server answers - never before.

    Polls the socket rather than sleeping a fixed amount, so a slow start
    delays the browser instead of breaking it. If the server never comes up
    the browser is NOT opened at all: a page that cannot load is worse than
    no page, because it looks like the app is broken rather than absent.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.4)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                webbrowser.open(url)
                return
        time.sleep(0.1)
    print(f"{YELLOW}The server did not start within {timeout:.0f}s, so the "
          f"browser was not opened.{OFF}")
    print(f"{DIM}  If it comes up later, open {url} yourself.{OFF}")


def already_running(port: int) -> dict | None:
    """Is a Toon Anvil ALREADY serving here?

    Without this, a second launch silently drifts to the next free port and
    you end up with two servers, two data dirs in play and a bookmark that
    points at whichever one you started first. Saying so is far kinder than
    picking a different port and hoping.
    """
    import json as _json                                       # noqa: PLC0415
    import urllib.request                                      # noqa: PLC0415
    try:
        with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/health", timeout=1.5) as r:
            body = _json.loads(r.read().decode() or "{}")
        return body if body.get("app") == "toon-anvil" else None
    except Exception:                                          # noqa: BLE001
        return None


def free_port(port: int, host: str = "127.0.0.1") -> bool:
    """Can this port actually be BOUND on the interface we will serve on?

    The old probe connect_ex'd loopback, which answers "is something
    listening there" - not "can we bind 0.0.0.0", which is what --lan
    needs. Binding is the question, so binding is the test. A socket that
    was only bound (never listened) does not enter TIME_WAIT, so the
    immediate rebind by the real server is safe.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def _lan_ip() -> str:
    """This machine's address on the local network.

    Connecting a UDP socket sends nothing; it just asks the routing table which
    interface would be used, which is the only reliable way to get the address
    a player should type.
    """
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:                                      # noqa: BLE001
        return "your-ip-address"


def main() -> int:
    ap = argparse.ArgumentParser(description="Start Toon Anvil")
    ap.add_argument("--port", type=int, default=7801)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--check", action="store_true", help="run checks and exit")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--keep-alive", action="store_true",
                    help="keep serving after the browser closes "
                         "(default: stop once nothing is connected "
                         "and nobody is seated)")
    ap.add_argument("--lan", action="store_true",
                    help="let other devices on your network join this table")
    args = ap.parse_args()

    width = shutil.get_terminal_size((70, 20)).columns
    print("\n" + "=" * min(62, width))
    print(f"  TOON ANVIL {app_version()}")
    print("  Drop in homebrew. Get back a balanced subclass, a sheet, a plan.")
    print("=" * min(62, width))

    c = run_checks()

    if c.failures:
        print(f"\n{RED}Cannot start: {len(c.failures)} problem(s) above.{OFF}")
        print(f"{DIM}Fix those and run this again.{OFF}\n")
        return 1
    if c.warnings:
        print(f"\n{YELLOW}Starting with {len(c.warnings)} note(s).{OFF}")
    else:
        print(f"\n{GREEN}Everything checks out.{OFF}")

    if args.check:
        return 0

    # --lan is the one switch that makes the table reachable by phones:
    # bind every interface instead of loopback. Everything the DM opens
    # locally still goes through 127.0.0.1 - the server treats loopback
    # as the trusted seat.
    host = "0.0.0.0" if args.lan else args.host

    port = args.port
    if not free_port(port, host):
        mine = already_running(port)
        if mine:
            # Almost always the real answer: an earlier run is still up.
            # Starting a second server on another port would leave two
            # builds running against two data folders.
            print()
            print(f"{YELLOW}Toon Anvil is ALREADY running on "
                  f"http://127.0.0.1:{port}{OFF}")
            print(f"{DIM}  data: {mine.get('dataDir', '?')}{OFF}")
            print(f"{DIM}  version: {mine.get('version', '?')}{OFF}")
            print(f"{DIM}  Opening that one. Close its window first if you "
                  f"wanted a fresh start.{OFF}")
            print()
            if not args.no_browser:
                webbrowser.open(f"http://127.0.0.1:{port}/#lobby")
            return 0
        for candidate in range(port + 1, port + 12):
            if free_port(candidate, host):
                print(f"{YELLOW}Port {port} is busy, using {candidate}.{OFF}")
                port = candidate
                break
        else:
            print(f"{RED}No free port near {args.port}.{OFF}")
            return 1

    # The DM's own browser always opens on loopback; 0.0.0.0 is a bind
    # address, not a place a browser can go.
    local_url = (f"http://127.0.0.1:{port}" if host in ("0.0.0.0", "")
                 else f"http://{host}:{port}")
    # Land on the lobby, not on a character sheet. Starting the server and
    # starting a GAME used to be two unrelated acts: the server came up, the
    # browser opened someone's sheet, and hosting was five taps away inside
    # the DM shell. The launch now opens the room where a session begins -
    # host, or join, or play alone, all from the first screen.
    lobby_url = f"{local_url}/#lobby"
    print(f"\n  Inbox:  {ROOT / 'inbox'}")
    print(f"{DIM}  Put homebrew files in the inbox folder; PDFs are split "
          f"automatically.{OFF}")

    # The addresses themselves are printed by serve.main(), once, after the
    # socket is bound - so the URL a DM reads off the bottom of the screen
    # is one that already works. Printing them here too meant the same two
    # addresses appeared twice under two different labels, which at setup
    # time reads as two different answers. These notes ride along instead.
    notes = [
        f"{DIM}  The browser opens on the Lobby: host a game and read the "
        f"code out, or play on your own.{OFF}",
        f"{DIM}  Closing the app stops this server too, unless players "
        f"are seated (--keep-alive to always stay up).{OFF}",
    ]
    if args.lan:
        notes += [
            f"{DIM}  Anyone on this network can reach the app now - the "
            f"join code gates seats,{OFF}",
            f"{DIM}  not the pages. Use --lan only on a network you "
            f"trust.{OFF}",
            f"{DIM}  If phones cannot connect, allow Python through the "
            f"Windows firewall{OFF}",
            f"{DIM}  (Private networks) - the prompt appears on first "
            f"--lan run.{OFF}",
        ]

    if not args.no_browser:
        # Wait for the socket to actually ACCEPT, then open the browser.
        #
        # This used to be a flat 1.2s timer, which is a guess about how long
        # loading 1.7MB of SRD takes on somebody else's machine. Measured
        # here it is ~0.7s, so the guess held - but a cold disk, a slower
        # laptop or an antivirus scanner pushes it past 1.2s and the browser
        # then opens on a connection-refused page. The user sees "the app
        # will not launch" and the server behind it is perfectly fine.
        threading.Thread(
            target=_open_when_ready, args=(port, lobby_url), daemon=True,
        ).start()

    sys.argv = [sys.argv[0], "--port", str(port), "--host", host]
    # Close together. Only when WE opened the browser: --no-browser is
    # how somebody runs this as a plain server, and exiting under them
    # because nothing has connected yet would be a bad surprise. The
    # server also refuses to idle out while players are seated, so a DM
    # closing their own tab never ends everybody else's session.
    if not args.no_browser and not args.keep_alive:
        sys.argv += ["--exit-when-idle", "120"]
    import serve                                               # noqa: PLC0415
    serve.BANNER_NOTES = notes
    return serve.main()


if __name__ == "__main__":
    raise SystemExit(main())
