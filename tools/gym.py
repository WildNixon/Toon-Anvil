#!/usr/bin/env python3
"""Run the application gym without a person and without a window.

    python tools/gym.py                 # logic + UI tiers, mutations, offline
    python tools/gym.py --logic         # the logic tier only: the fast gate
    python tools/gym.py --no-mutations  # skip the mutation check
    python tools/gym.py --no-offline    # skip the offline reload check
    python tools/gym.py --fuzz          # also run tools/fuzz.py at the instance
    python tools/gym.py --open          # start an isolated instance and open the
                                        # gym in your browser; ctrl-c stops it
    python tools/gym.py --json out.json # write the graded result as JSON
    python tools/gym.py --keep          # keep the instance directory afterwards

Exit status is 0 only when every bar is met, every mutation was caught, the
app reloads offline with every shell module served from cache, and the fuzz
sweep (if asked for) found nothing. Anything else is 1, with the reason
printed last.

WHAT THIS RUNS AGAINST
----------------------
An isolated copy of this tree, in a temporary directory whose name contains
"gym" and "test", served by its own serve.py on a free port. The gym closes
tables and writes records, so it must never point at the data/ a DM is
using; the page itself refuses unless the server's reported data directory
looks disposable, and this is the tool that makes one. The copy is deleted
afterwards unless --keep is given.

The browser is Chromium through Playwright (pip install playwright, then
`playwright install chromium`). With PLAYWRIGHT_CHROMIUM set, or the Claude
Code container's /opt/pw-browsers/chromium present, that executable is used
instead of a downloaded one.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Ten minutes for the logic tier alone; the UI tier boots the app forty
# times and the mutation check re-runs the logic tier once per mutation.
TIMEOUT_MS = {"logic": 10 * 60_000, "ui": 30 * 60_000}


# --------------------------------------------------------------------------
# the instance
# --------------------------------------------------------------------------

def build_instance() -> Path:
    """Copy the tree somewhere disposable. Code and compendium only: never
    data/, never the night and soak notebooks, never .git."""
    inst = Path(tempfile.mkdtemp(prefix="toon-anvil-gym-test-"))

    def ignore(d, names):
        skip = {n for n in names if n == "__pycache__"}
        if Path(d) == ROOT:
            skip |= {".git", ".github", "data", "night", "soak", "tests"}
        return skip

    shutil.copytree(ROOT, inst, ignore=ignore, dirs_exist_ok=True)
    (inst / "data").mkdir(exist_ok=True)
    return inst


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def health(base: str) -> dict | None:
    try:
        with urllib.request.urlopen(f"{base}/api/health", timeout=3) as r:
            return json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None


def start_server(inst: Path, port: int, log_path: Path) -> subprocess.Popen:
    log = log_path.open("a", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, "serve.py", "--port", str(port)],
        cwd=str(inst), stdout=log, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(60):
        time.sleep(0.25)
        h = health(base)
        if h:
            got = Path(h.get("dataDir", "")).resolve()
            want = (inst / "data").resolve()
            if got != want:
                proc.terminate()
                raise SystemExit(
                    f"ISOLATION BROKEN - refusing to continue.\n"
                    f"  server reports dataDir = {got}\n"
                    f"  expected              = {want}")
            return proc
        if proc.poll() is not None:
            break
    proc.terminate()
    raise SystemExit(f"the server on :{port} never came up - see {log_path}")


def stop_server(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


# --------------------------------------------------------------------------
# the browser
# --------------------------------------------------------------------------

def chromium_path() -> str | None:
    p = os.environ.get("PLAYWRIGHT_CHROMIUM")
    if p and Path(p).exists():
        return p
    fallback = Path("/opt/pw-browsers/chromium")
    return str(fallback) if fallback.exists() else None


def launch(pw):
    exe = chromium_path()
    kwargs = {"executable_path": exe} if exe else {}
    return pw.chromium.launch(**kwargs)


def tail(path: Path, n: int = 40) -> str:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(lines[-n:])


def run_gym(browser, base: str, *, ui: bool, mutate: bool, console_log: Path) -> dict:
    """Open the gym with ?auto= and wait for it to say it is done."""
    page = browser.new_page(viewport={"width": 1280, "height": 1000})
    log = console_log.open("a", encoding="utf-8")
    page.on("console", lambda m: log.write(f"[{m.type}] {m.text}\n"))
    page.on("pageerror", lambda e: log.write(f"[pageerror] {e}\n"))
    url = f"{base}/sim/gym.html?auto={'ui' if ui else 'logic'}&mutate={1 if mutate else 0}"
    print(f"  opening {url}")
    page.goto(url)
    try:
        # The mutation check re-runs the whole logic tier once per mutation,
        # so it gets the long budget whichever tier it rides on.
        page.wait_for_function("() => window.__GYM_DONE || window.__GYM_ERROR",
                               timeout=TIMEOUT_MS["ui" if (ui or mutate) else "logic"])
    except Exception as exc:                                     # noqa: BLE001
        log.close()
        raise SystemExit(f"the gym never finished: {type(exc).__name__}\n"
                         f"--- last console lines ---\n{tail(console_log)}") from None
    error = page.evaluate("() => window.__GYM_ERROR || null")
    if error:
        log.close()
        raise SystemExit(f"the gym reported a harness error:\n{error}\n"
                         f"--- last console lines ---\n{tail(console_log)}")
    result = page.evaluate("() => window.__GYM_DONE")
    log.close()
    page.close()
    return result


def print_grade(result: dict) -> list[str]:
    """Print the graded run the way the page does; return the reasons it is red."""
    g = result["grade"]
    red: list[str] = []
    print(f"\n  {'PASS' if g['pass'] else 'FAIL'} - {g['scenariosPassed']}/{g['scenarios']} "
          f"scenarios, {g['checksPassed']}/{g['checks']} checks, "
          f"{len(g['features'])} features")
    if g.get("ui"):
        u = g["ui"]
        print(f"  ui: {u['flowsPassed']}/{u['flows']} journeys, "
              f"{u['checksPassed']}/{u['checks']} checks")
    for b in g["bars"]:
        pct = b["id"] in ("featuresCovered", "noThinScenarios")
        val = f"{b['value']}/{b['bar']}" if pct else f"{b['value'] * 100:.0f}%"
        print(f"    {'ok ' if b['ok'] else 'BAD'} {b['id']:<20} {val}")
        if not b["ok"]:
            red.append(f"bar {b['id']}: {val}")
    for f in g["failures"]:
        print(f"    x {f}")
    for e in g["errors"]:
        print(f"    ! {e}")
    for t in g.get("thin", []):
        print(f"    thin: {t}")
    m = result.get("mutations")
    if m:
        caught = len(m["results"]) - m["escaped"]
        print(f"\n  mutations: {caught}/{len(m['results'])} caught")
        for r in m["results"]:
            if not r["caught"]:
                print(f"    ESCAPED {r['id']}: {r['what']}")
                red.append(f"mutation escaped: {r['id']}")
    return red


# --------------------------------------------------------------------------
# offline
# --------------------------------------------------------------------------

def shell_urls(base: str) -> list[str]:
    """The service worker's SHELL list, read from its source."""
    with urllib.request.urlopen(f"{base}/sw.js", timeout=5) as r:
        src = r.read().decode("utf-8")
    m = re.search(r"const SHELL = \[(.*?)^\];", src, re.S | re.M)
    if not m:
        raise SystemExit("could not find SHELL in sw.js")
    # One quoted entry per line. Not every quote in the block: the comments
    # between entries contain apostrophes, and pairing those up swallowed
    # most of the list.
    return re.findall(r"^\s*'(\./[^']*)',", m.group(1), re.M)


def check_offline(browser, base: str, console_log: Path) -> list[str]:
    """Load the app once online, then cut the network and reload.

    The service worker's promise is that an installed app opens on a train.
    Every previous check read sw.js as text; this one runs it. Returns the
    reasons it failed, empty when it held.
    """
    red: list[str] = []
    context = browser.new_context(viewport={"width": 1280, "height": 1000})
    page = context.new_page()
    log = console_log.open("a", encoding="utf-8")
    errors: list[str] = []
    page.on("console", lambda m: log.write(f"[offline {m.type}] {m.text}\n"))
    page.on("pageerror", lambda e: (errors.append(str(e)),
                                    log.write(f"[offline pageerror] {e}\n")))

    page.goto(f"{base}/")
    # Installed means the shell is in the cache, not merely that a worker
    # registered - install precaches, and precaching 1.7 MB takes a moment.
    page.wait_for_function(
        "() => navigator.serviceWorker.ready.then(() => caches.keys())"
        ".then((k) => k.length > 0).catch(() => false)", timeout=60_000)
    page.wait_for_function(
        "() => caches.match('./index.html').then((r) => !!r).catch(() => false)",
        timeout=60_000)
    page.wait_for_function(
        "() => caches.match('./modes/build/build.js').then((r) => !!r).catch(() => false)",
        timeout=60_000)

    context.set_offline(True)
    errors.clear()
    page.reload()
    # Booted means the app's OWN chrome is on screen: the mode bar, or the
    # welcome gate a fresh browser meets first. The static shell paints
    # "Loading…" into <main> before app.js runs at all, so text in <main> is
    # not evidence of anything.
    booted = True
    try:
        page.wait_for_function(
            "() => document.querySelectorAll('#modes button, .welcome').length > 0"
            " && !(document.querySelector('main')?.textContent || '').includes('Loading')",
            timeout=30_000)
    except Exception:                                            # noqa: BLE001
        booted = False
        red.append("the app did not boot offline: no mode bar or welcome gate "
                   "within 30 s (see the console log)")

    # Every module and data file in the shell must come back from cache.
    wanted = [u for u in shell_urls(base)
              if u.endswith((".js", ".json", ".css", ".html", ".webmanifest"))]
    missing = page.evaluate(
        """async (urls) => {
             const out = [];
             for (const u of urls) {
               try { const r = await fetch(u); if (!r.ok) out.push(`${u} (${r.status})`); }
               catch (e) { out.push(`${u} (${e.message})`); }
             }
             return out;
           }""", wanted)
    for m in missing:
        red.append(f"not served offline: {m}")
    for e in errors:
        if "Failed to fetch" in e or "import" in e.lower():
            red.append(f"offline page error: {e[:160]}")
    print(f"\n  offline: {len(wanted) - len(missing)}/{len(wanted)} shell files served "
          f"from cache, {'app rendered' if booted else 'app did NOT render'}")
    for r in red:
        print(f"    x {r}")
    log.close()
    context.close()
    return red


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--logic", action="store_true", help="logic tier only")
    ap.add_argument("--no-mutations", action="store_true")
    ap.add_argument("--no-offline", action="store_true")
    ap.add_argument("--fuzz", action="store_true", help="also run tools/fuzz.py")
    ap.add_argument("--open", action="store_true",
                    help="start an isolated instance, open the gym, keep serving")
    ap.add_argument("--json", metavar="PATH", help="write the result as JSON")
    ap.add_argument("--keep", action="store_true", help="keep the instance directory")
    args = ap.parse_args(argv[1:])

    inst = build_instance()
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    server_log = inst / "gym-server.log"
    console_log = inst / "gym-console.log"
    print(f"instance {inst}")
    proc = start_server(inst, port, server_log)
    print(f"serving  {base}  (dataDir is isolated)")

    red: list[str] = []
    result: dict = {}
    try:
        if args.open:
            url = f"{base}/sim/gym.html"
            print(f"\n  {url}\n  ctrl-c to stop\n")
            webbrowser.open(url)
            try:
                while proc.poll() is None:
                    time.sleep(1)
            except KeyboardInterrupt:
                pass
            return 0

        try:
            from playwright.sync_api import sync_playwright   # noqa: PLC0415
        except ImportError:
            raise SystemExit("playwright is not installed: pip install playwright "
                             "&& playwright install chromium") from None

        with sync_playwright() as pw:
            browser = launch(pw)
            try:
                print(f"running the {'logic tier' if args.logic else 'logic and UI tiers'}"
                      f"{'' if args.no_mutations else ' and the mutation check'}…")
                result = run_gym(browser, base, ui=not args.logic,
                                 mutate=not args.no_mutations, console_log=console_log)
                red += print_grade(result)
                if not args.no_offline:
                    result["offline"] = check_offline(browser, base, console_log)
                    red += result["offline"]
            finally:
                browser.close()

        if args.fuzz:
            print("\nfuzzing the instance…")
            code = subprocess.call([sys.executable, str(ROOT / "tools" / "fuzz.py"), base])
            result["fuzz"] = code
            if code:
                red.append(f"fuzz.py exit {code}")

        if args.json:
            Path(args.json).write_text(json.dumps(result, indent=1), encoding="utf-8")
            print(f"\nwrote {args.json}")
    finally:
        stop_server(proc)
        if args.keep or (red and not args.open):
            print(f"\ninstance kept at {inst}\n  server log:  {server_log}\n"
                  f"  console log: {console_log}")
        else:
            shutil.rmtree(inst, ignore_errors=True)

    if red:
        print(f"\nRED - {len(red)} reason{'s' if len(red) != 1 else ''}:")
        for r in red:
            print(f"  {r}")
        return 1
    print("\nGREEN")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
