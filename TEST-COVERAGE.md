# Test coverage: where the gym reaches, and where it does not

An audit of what the test harness in `app/sim/` actually exercises, measured
against what ships, with the gaps ranked by how likely each one is to let a
real bug through. Written 2026-09-24 against v2.3.1.

The short version: the browser gym is unusually disciplined, and everything
outside it is untested. The gaps are structural, not cultural. Twenty-five of
the last forty commits changed the gym alongside the feature they shipped.

## What landed since

Every gap below has a change against it. The audit stays as written so the
reasoning can be read; this is the ledger.

| Gap | Change |
|---|---|
| 1. No Python tests | `tests/`, a stdlib `unittest` suite: pure server rules, the permission model, both redactors and the event log's, the shelf detector, the splitter's self-test, and the server over raw HTTP. 112 tests. |
| 2. Nothing runs headless | `tools/gym.py` drives the gym in headless Chromium on an isolated copy; `.github/workflows/checks.yml` runs it, the Python suite and `run.py --check` on every push. |
| 3. No isolation guard | The gym page refuses any server whose data directory does not look disposable, the fuzz tool's rule. `tools/gym.py --open` starts one that does. |
| 4. Service worker tested by string match | A scenario walks the import graph from `app.js` and fails on any module the shell omits; the runner loads the app, cuts the network, reloads, and fetches every shell file. Found four modules missing on the first run. |
| 5. API-1 and API-2 open | Both fixed, both pinned by route tests and (API-1) a gym scenario. The fuzz sweep reports nothing. |
| 6. Mutations stop at the older suites | Eight mutations added across deeds, roll cards, the dice feed, the QR, the change feed, the store and effect shapes. The mutation check is a bar. |
| 7. Six modules no suite imported | Six suites, fifteen scenarios; the coverage bar rose from 63 to 70. |
| 8. README figures unenforced | `tests/test_readme.py` counts suites, journeys, mutations and invariants from the sources; scenario and check counts are reported by the gym, not written down. |

Found along the way, and fixed: `safe_id` accepted an id with a trailing
newline, because `$` matches before one; `cleanTitle` kept `.pdf` on a name
with a trailing space, for the same reason.

## What exists

Testing lives in `app/sim/`, run by opening a page in a browser with the
server up. These counts come from the code. The README's figures are stale on
every row.

| Tier | Count | README says |
|---|---|---|
| Logic suites in the gym (`appgym.js`) | 31 | 11 |
| Logic scenarios | 81 | 38 |
| UI journeys driving the real app (`uiflows.js`) | 43 | 11 |
| Mutations injected by the mutation check | 37 | 5 |
| Simulator invariants (`invariants.js`) | 15 | - |
| Pending reproductions for known bugs (`pending.js`) | 4 | - |
| Python unit tests | 0 | - |
| Continuous integration | none | - |

What the gym does well, and should keep doing:

- **An empty scenario is a failure.** A scenario that asserts nothing cannot
  pass. `noThinScenarios` refuses any scenario under two checks.
- **The coverage bar ratchets.** `minFeaturesCovered` has moved from 18 to 63
  and the comment trail records why at every step.
- **The mutation check asks whether the suite would notice.** Thirty-seven
  deliberate defects are patched into the context and the board must go red
  for each.
- **Known bugs live in `pending.js` with the sign inverted.** A permanent red
  never enters the gate, and a reproduction that turns green is a prompt to
  promote it.
- **Hostile input has its own tool.** `tools/fuzz.py` sends what the app never
  would, refuses to run against a real data directory, and found the join-code
  back door that no honest client could have surfaced.
- **Three of the four soak security findings are fixed** and each fix is held
  by a gym scenario: `join()` no longer honours a caller-supplied profile,
  `/api/samples` is gated behind `_is_local()`, and `set_owner` refuses a
  character another profile already holds.

## The gaps, in priority order

### 1. The Python side has no tests of its own

`serve.py` is 2,058 lines and `tools/` is roughly 9,000 more. All of it is
reached only over HTTP from the browser gym. Branches the app never triggers
are never exercised.

The clearest example is the 2.3.1 fix. The whole change is the seated-table
ceiling in `_should_stop()` (`serve.py:1933`), but the gym scenario added with
it only asserts that a GET to the stop endpoint is refused. The ceiling logic
has no test.

Pure functions in the same position, each a few lines to test directly:

| Function | Where | Why it matters |
|---|---|---|
| `_should_stop` | `serve.py:1933` | The 2.3.1 fix. Untested. |
| `changes_since` | `serve.py:212` | Gap semantics, including the restart branch where a client is ahead of the server. The gym has a mutation for a client ignoring gaps, not for the server computing them wrongly. |
| `safe_id`, `safe_name`, `_clamp` | `serve.py:241-312` | The soak confirmed they hold by fuzzing. A unit test pins that permanently. |
| `may_write`, `may_read`, `redact_*` | `tools/table.py:406-726` | The entire permission model. Only tested indirectly through the gym's table suite. |
| the shelf detector | `tools/shelf.py` | Described in its own docstring as pure and deterministic. |
| `split_pdf.selftest` | `tools/split_pdf.py` | Exists, but only runs when the gym fetches `/api/split/selftest`. |

**Proposal.** A `tests/` directory using `unittest`, which matches the
project's stdlib-only posture better than adding pytest. `serve.py` imports
cleanly when `DATA` points at a temporary directory. Start with the six rows
above.

### 2. Nothing runs without a human pressing a button

There is no CI, no headless runner, and the gym cannot be started from a
shell. Release commits are unverifiable after the fact.

Chromium and Playwright make this cheap: a script that starts `serve.py` on a
throwaway data directory, opens `/sim/gym.html` headless, and exits non-zero
when the grade is red. A GitHub Actions workflow can then run that script,
`python run.py --check`, `tools/fuzz.py`, and the unit tests from gap 1 on
every push. `tools/night.py` already has a Python tier that needs no browser,
so the pattern exists in the repo.

### 3. The gym has no isolation guard, and the fuzz tool does

The table suite calls `/api/table/close` sixty times. Opened against a
development server, it ends whatever table is live and revokes every token.
`tools/fuzz.py` refuses to run unless `/api/health` reports a data directory
that looks like a throwaway. The gym should apply the same refusal before
running any server-backed suite.

### 4. The service worker is tested by reading its source, not by running it

`app/sw.js` changed eight times in the last forty commits, including two
performance commits about the offline cache. The gym's only checks fetch the
file as text and look for strings. Nothing exercises the fetch handler's
cache-first and validator paths, and nothing tests that the shell loads
offline.

Two things to add:

- A Playwright journey that loads the app, goes offline, reloads, and asserts
  the shell renders.
- The `PWA-1` reproduction in `pending.js` is now stale: `sw.js` is at 2.3.1
  and lists the modules it was missing. Promote it into the gym as a permanent
  scenario, and make it derive the import graph from `app.js` and diff it
  against `SHELL`, so it cannot rot again.

### 5. Two fuzz findings are open, and the routes they hit have no harness

- **API-1.** A JSON body that is not an object still drops the connection on
  eleven routes. `_read_json()` (`serve.py:461`) has no type guard.
- **API-2.** `POST /api/pdf` still returns 500 on a long character name.

Beyond those two, no scenario ever calls `/api/pdf`, `/api/spend`,
`/api/examples`, `/api/sfx/search`, or `/api/sfx/generate`. Fix the two
findings, promote their reproductions from `pending.js` into the gym, and add
one request per untested route.

### 6. The mutation check does not reach the newer suites

All thirty-seven mutations patch the engine, the DM tools, the table
transport, the campaign, or the simulator. None target derivation, the 2024
rules helpers, pregens, the dice rail, roll cards, the QR encoder, deeds, or
the voice pitch shifter. The code records that `payload_scoring_flat` escaped
once before its tripwire was widened.

Two rules would keep this honest, in the same spirit as `noThinScenarios`:

- A bar that every mutation must be caught, so the mutation check joins the
  pass gate instead of sitting beside it.
- A minimum of one mutation per suite.

### 7. Several pure modules are never imported by any suite

These have no DOM dependency and could each take a small logic scenario. Today
they can only fail through the UI tier, which is the slowest and coarsest
place to find out.

| Module | Lines | What it does |
|---|---|---|
| `core/live.js` | 289 | The client side of change polling and gap recovery |
| `core/store.js` | 142 | The client record store |
| `ui/map.js` | 304 | The map's pin model |
| `homebrew/effects.js` | 310 | Effect shapes for homebrew features |
| `modes/dm/founding.js` | 173 | Founding a campaign from a book |
| `ui/chart.js` | 114 | The history chart |

The live poller's gap handling and the map's pin model are the two most
likely to hide a real bug.

### 8. The README's test numbers should be enforced or removed

Every figure the README quotes is off by a factor of two or more. The
`release` suite already checks that four files agree on the version. Either it
also asserts the README's scenario and mutation counts, or the README stops
quoting counts.

## Suggested order

1. Add `tests/` with `unittest` cases for `_should_stop`, `changes_since`,
   the id and name guards, and the permission model. Highest value for the
   least work.
2. Add a headless gym runner and a workflow that runs it, the unit tests,
   `run.py --check`, and the fuzz tool on every push.
3. Give the gym the fuzz tool's throwaway-directory refusal.
4. Fix API-1 and API-2 and promote their reproductions into the gym.
5. Add the offline-reload journey and the shell-versus-import-graph scenario.
6. Add one mutation per uncovered suite and gate the mutation check.
