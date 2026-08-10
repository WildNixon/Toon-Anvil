# Toon Anvil — soak run findings

Generated 2026-08-10T21:58:07+00:00 from `soak/findings.jsonl` (23 findings, 0 already fixed).

Every item below was **confirmed against a running server**, not inferred from reading. Anything I could not reproduce is not here.

Most of these have a **live reproduction** carrying the same id, in `app/sim/pending.js`. Open `/sim/pending.html` and run them: each one is expected to FAIL, and a failure is the defect still being present. When a fix lands its reproduction turns green — promote it into `appgym.js` and delete it from `pending.js`, so the gym guards it from then on. They are kept out of the graded gym on purpose: a suite with a permanent red in it stops being a gate.

| Severity | Count | Means |
| --- | --- | --- |
| critical | 1 | A security hole or data loss. Fix before the next session. |
| high | 5 | Breaks a shipped feature in normal play. A DM or player hits this. |
| medium | 6 | Wrong or confusing, but there is a way round it. |
| low | 3 | Papercut, polish, or a latent trap that needs an odd setup. |
| idea | 8 | Not a defect - an expansion or refinement worth discussing. |

## Critical

### SEC-1-join-dm — Anyone holding the join code can mint a DM token

**CRITICAL** · area: server / table permissions · effort: S · status: confirmed

**Evidence.** tools/table.py:116-117 honours a client-supplied profile_id (`if profile_id and profile_id in data["profiles"]: prof = data["profiles"][profile_id]`), and p-dm is always present because open_table() creates it at table.py:88. No caller in app/ ever populates it - session.js:246 defaults profileId to null - so this is dead weight in the client and a live back door on the wire.

**Reproduction.** Against an isolated instance: POST /api/table/open (loopback) -> code ANVIL-CF4T. Then POST /api/table/join {"code":"ANVIL-CF4T","profileId":"p-dm","name":"M"} returns {"role":"dm"} and a working token. Control: an honest join with the same code correctly sees lore=None, agendas=[], only the public clock, no templates. The escalated token returns THE-LORE-SECRET, THE-AGENDA-SECRET, the secret clock label THE-RITUAL-COMPLETES and the prepared ambush - byte-identical to the real DM's view.

**Proposed fix.** Stop honouring profile_id for role selection in join(). The DM seat's anchor is open_table(), which is loopback-only; the join code was never meant to buy it. Removing the escalation path is behaviour-preserving for the real client since nothing sends it.

## High

### FIGHT-1-resistance-dead — Resistance and immunity never apply in the shared fight, though the code and README both say they do

**HIGH** · area: shared combat runner · effort: M · status: confirmed

**Evidence.** runner.js:675 calls applyTo(c.id, mult * Math.abs(n)) with TWO arguments. applyTo's signature (runner.js:342) is (id, delta, damageType = null), so damageType is always null, and mitigate() (engine.js:269) returns early on `if (!damageType)`. There is no damage-type control anywhere in the runner UI, so nothing can ever supply one. The res.mitigation toast at runner.js:677-679 is therefore dead code. applyTo's own docstring (runner.js:339-340) says 'resistance is halved - by hand, both are routinely missed', and README:201 claims 'resistances applied by the engine'. addCustom (runner.js:285) does initialise resistances/immunities arrays, so the data path exists - only the call and the control are missing. The player sheet has the same gap (app.js:104-108 passes no damage type).

**Reproduction.** Add a monster with resistances to a shared fight, hit it for 10 in the runner ribbon: full 10 is applied, no mitigation toast. Since this project's ethos is measured-not-claimed, the docstring and README line are part of the defect.

**Proposed fix.** Add a damage-type selector to the ribbon (a small select beside the number, remembered per combatant), pass it as applyTo's third argument, and let the existing mitigation toast finally fire. Until the control exists, the two claims in the docstring and README should be corrected rather than left standing.

### FIGHT-2-midfight-initiative — Monsters deployed mid-fight never roll initiative and never get a turn - this breaks the Deploy button

**HIGH** · area: shared combat runner · effort: M · status: confirmed

**Evidence.** rollInitiative() (runner.js:301-310) is idempotent and would handle late arrivals correctly - it only rolls where c.init === null. But its ONLY render site is guarded by `if (!state.started && !empty)` (runner.js:455); the started branch offers Next/Prev turn and no re-roll. addCustom (runner.js:284) and addMonsters both set init: null. sort() is only ever called from rollInitiative (runner.js:306). So a combatant added after the fight starts keeps init: null, sorts to the bottom via `b.init ?? -99` (runner.js:313), renders as '--' (runner.js:614) and never acts. This directly breaks LAN C2: the prepared-encounter drawer's Deploy button (stage.js:125-135) exists precisely to drop monsters into a running fight.

**Reproduction.** Start a fight, then deploy a prepared encounter (or add a custom combatant). The new arrivals show '--' for initiative, sit at the bottom of the order, and Next turn never reaches them.

**Proposed fix.** Roll initiative for any combatant with init === null at the moment it is added, and insert it into the existing order rather than re-sorting the whole array (re-sorting mid-fight moves the turn marker - see FIGHT-3). The DM should not have to think about it; a monster that walks in is a monster in the order.

### LEAK-1-clock-events — A secret clock's label reaches every player through the unredacted event log

**HIGH** · area: redaction / event log · effort: M · status: confirmed

**Evidence.** deck.js:200-202 and deck.js:343-346 both log clock_advanced with `clock: c.label` and no check of c.public. events.js:89 marks clock_advanced notable, so it lands in the Chronicle - which is a PLAYER mode (app.js:42). GET /api/events (serve.py:1453-1477) applies no redaction at all: no _viewer(), no filtering, it streams the raw log to anyone. tools/table.py:490 strips non-public clocks from the campaign record with the comment 'its label alone (the ritual completes) is the spoiler' - so the intent is explicit and the event log walks straight around it. README:304 claims 'the secret ones never leave the server'.

**Reproduction.** On the isolated instance: DM opens a table, a player joins. POST /api/events with the exact payload deck.js:343 sends for a struck secret clock ({type: clock_advanced, payload: {clock: THE-RITUAL-COMPLETES, struck: true}}). The player token then reads GET /api/campaigns/soak-camp and correctly sees only ['Public festival'] - the redactor works. The SAME player token reads GET /api/events?limit=50 and gets back THE-RITUAL-COMPLETES.

**Proposed fix.** Two halves, and both are needed. (1) Server: GET /api/events must redact through _viewer() the way the kind routes do - at minimum drop notable world events whose payload names a non-public clock. (2) Client: deck.js should not put a secret label in a shared log at all; log the clock id and let each reader resolve it against the record they are allowed to see. The server half is the one that counts, since a player's browser can ask for anything.

### SEC-2-samples-parent — /api/samples serves the project's PARENT directory with no auth and no local gate

**HIGH** · area: server / static routes · effort: S · status: confirmed

**Evidence.** serve.py:1432 globs ROOT.parent.glob('*.htm*') and serve.py:1441 reads ROOT.parent / name. _is_local() is used at serve.py:774, 783 and 1297 but never on this branch, and neither route consults _viewer(). With the project at D:/Dnd/grimoire, ROOT.parent is D:/Dnd - so the user's own unpublished homebrew drafts are the payload.

**Reproduction.** With a table open, one tokenless caller on the soak instance: GET /api/campaigns/soak-camp correctly returns lore=None and only the public clock (yesterday's least-privilege fix working). The SAME caller then gets GET /api/samples -> dir 'D:/Dnd', files [ferrous-sorcery.html, lodestone-sorcery.html, way-of-the-fool-monk.html], and GET /samples/lodestone-sorcery.html returns all 26877 bytes. Path traversal IS blocked (serve.py:1439); the parent-directory exposure is the defect. NOTE: the off-loopback leg is established by code inspection - there is no _is_local() on the branch - not by binding a server to the LAN, which I declined to do for a test.

**Proposed fix.** Gate both routes behind _is_local(). Importing a homebrew page from the folder beside the project is inherently a this-machine action; a phone at the table has no business listing the DM's filesystem.

### SEC-3-claim-anyones — Any seated player can claim - and then overwrite - another player's character

**HIGH** · area: server / table permissions · effort: S · status: confirmed

**Evidence.** tools/table.py:188-199 set_owner() adds the character id to the caller's profile with no check that it is already owned by someone else. may_write (table.py:420) then reports is_mine=true for both profiles. The same gap makes the honest case racy: two phones tapping the same pregen at joingate.js:152 both succeed.

**Reproduction.** Alice joins and claims hero-alice: ok. Bob joins with the same code and POSTs /api/table/claim {characterId: hero-alice}: also ok. Bob then PUTs /api/characters/hero-alice with name 'Bob Was Here': accepted, rev 8. The file on disk now reads 'Bob Was Here'. Alice's sheet was taken and rewritten by another player.

**Proposed fix.** set_owner refuses a character already bound to a different profile. Keep the DM's legitimate reassignment (session.js:262 - 'mine, or anyone's if I am the DM') behind an explicit role check, so the DM can still hand a character over.

## Medium

### API-1-nondict-body-drops — A JSON body that is not an object drops the connection on ELEVEN routes

**MEDIUM** · area: server / input validation · effort: S · status: confirmed

**Evidence.** _read_json (serve.py:405-415) rejects only None; anything else that parses as JSON goes straight through to code that assumes a dict. do_PUT calls payload.setdefault (serve.py:489), /api/appgym does payload['at'] = ... (serve.py:934), /api/pdf does payload.get (serve.py:689). Server-side tracebacks captured: 'TypeError: list indices must be integers or slices, not str' and "AttributeError: 'list' object has no attribute 'get'". BaseHTTPRequestHandler does not catch these, so the socket closes with no response at all.

**Reproduction.** tools/fuzz.py sent 236 hostile requests at an isolated instance and reported 69 connection drops across ELEVEN routes: PUT on characters, campaigns, encounters and profiles, and POST on events, appgym, sim, pdf, variant, vectors, table/open and table/join. Each drops on any of list, string, number, bool, empty list or nested list. Only `null` is handled (400). The server survives - ThreadingHTTPServer isolates the thread - so this is robustness and log noise rather than a crash. Reachable only by a hand-crafted request, which is the same blind spot that hid the profileId back door: nothing in app/ sends these shapes, so nothing tested them.

**Proposed fix.** One guard in _read_json: if the parsed payload is not a dict - or not a list, for /api/events - return the 'bad json body' 400 that the None case already gets. Three lines turns sixty-nine silent connection drops into one honest refusal.

### FIGHT-3-remove-shifts-turn — Removing a combatant above the turn marker silently advances the turn to someone else

**MEDIUM** · area: shared combat runner · effort: S · status: confirmed

**Evidence.** runner.js:289-292: remove() filters the array and then only guards `if (state.turn >= state.combatants.length) state.turn = 0`. state.turn is a positional index, so deleting anything at an index BELOW the marker shifts every later combatant up one while turn keeps its old number - it now points at a different creature. 'Remove the dead thing' is one of the most-pressed buttons in a fight, which is what makes this land often.

**Reproduction.** Five combatants, turn === 3 (the fourth). Remove the combatant at index 1. The array shifts; turn still reads 3, which is now the fifth creature. Somebody's turn is skipped and nobody notices, because the highlight simply moves.

**Proposed fix.** Capture the current combatant's id before filtering and restore the index by id afterwards, clamping only if that combatant was the one removed (in which case the turn should stay on the next one along, not jump to 0).

### FIGHT-4-death-saves-persist — Death saves are only ever cleared by a long rest, so the next fight starts with old failures showing

**MEDIUM** · area: engine / character sheet · effort: S · status: confirmed

**Evidence.** deathSaves: { successes: 0, failures: 0 } appears exactly once in engine.js, at line 507, inside longRest(). Nothing else resets it: adjustHp (app.js:100-120) writes only c.hp. So a character healed from 0 keeps the pips they had, and sheet.js:396 renders them - two failures still lit at the start of an unrelated fight, one bad roll from 'Fallen.' Nothing marks a character dead at three failures beyond the word (sheet.js:418-419).

**Reproduction.** Drop a character to 0, fail two death saves, have someone heal them. The sheet still shows two failures. Take them to 0 again in the next fight: they begin one failed save from death.

**Proposed fix.** Clear deathSaves whenever hp rises above 0 - that is the rule (stabilising or being healed ends the death-save sequence), and it belongs in the engine so every screen inherits it rather than in each caller.

### HARNESS-1-cold-join-flows — Three standalone join flows are FLAKY under load - they fail, then pass, with no code change

**MEDIUM** · area: gym harness · effort: S · status: confirmed

**Evidence.** runJoinGate, runPlayerView and runJoinDeeplink (uiflows.js:2301, 2674, 2978) boot /index.html and wait for the .welcome join gate with waitFor(..., {timeout: 10000}) (uiflows.js:2337). When the wait times out, gate is null and the very next line - gate.querySelector at uiflows.js:2343 - throws the TypeError that appears in the log, so a timing miss is reported as a crash rather than as 'the gate did not appear'. Measured across four runs on the same build: on a freshly started instance all THREE fail; on the same instance warm, only join_gate fails; run standalone with nothing else competing, runJoinGate passes with 13 checks and zero failures. Booting the frame by hand and settling 4s finds .welcome present, so the app renders the gate correctly - the budget is what runs out. Proven not to be a code regression: the identical failures occur on an instance running the pre-fix server (git HEAD) with the same new tests - before FAIL 125/127 with three UI flows red, after PASS 127/127 with the same flows red.

**Reproduction.** Run the UI tier on a freshly started instance: three flows fail. Re-run without changing anything: fewer fail. Call flows.runJoinGate(Check) alone from the gym console: it passes. Nothing about the app changed between those three outcomes.

**Proposed fix.** Two parts. (1) Stop reporting a timeout as a TypeError - waitFor returning null should fail the check with 'the join gate never appeared', which is the truth and is diagnosable. A crash in the assertion line hides which of ten things went wrong. (2) Use waitUntilSettled (uiflows.js:101), this project's existing anti-flake primitive, and raise the budget for a first boot; or boot and discard one warm-up frame before the standalone block so first-module-fetch is paid once outside the measurement. This matters more now than it did: isolated instances are the plan for unattended runs, and a suite that is only green on a warm, lived-in server cannot gate anything overnight.

### PWA-1-stale-service-worker — The service worker is still v9 and caches none of the LAN modules, so an installed PWA breaks offline

**MEDIUM** · area: offline / service worker · effort: S · status: confirmed

**Evidence.** app/sw.js:25 is still VERSION = 'toon-anvil-v9', unchanged across all fifteen LAN commits. Grepping its SHELL list for the five modules those epics added returns zero hits each: ui/qr.js, ui/vendor/qrcodegen.js, ui/components/rollcard.js, ui/components/dicerail.js, core/pregen.js. An installed PWA opened offline therefore fails to import them, which takes out Setup (QR), roll cards, the dice rail and quick party - precisely the couch features.

**Reproduction.** Install the PWA, go offline, open it. The modules added by the LAN epics are not in the cache and the imports fail. Not yet reproduced on a real installed PWA - established from the SHELL list and the version constant, which are unambiguous.

**Proposed fix.** Add the five modules to SHELL and bump VERSION to v10 so existing installs re-cache. Worth a gym check that every ES module under app/ reachable from index.html appears in SHELL, since this list has now drifted silently across three epics and will do it again.

### SHEET-1-advantage-invisible — Advantage stays armed after you leave the Overview tab, with nothing on screen saying so

**MEDIUM** · area: character sheet · effort: S · status: confirmed

**Evidence.** rollMode is module-level state (sheet.js:36) and is only cleared when a roll consumes it (sheet.js:50-51). But rollModeBar() - the ONLY thing that renders the armed state - is appended in a single place, sheet.js:148, inside the `overview` branch (the next branch begins `else if (tab === 'spells')` at sheet.js:153). So the state outlives the control that displays it.

**Reproduction.** On the sheet's Overview tab, tap Advantage. Switch to Spells or Features. The armed state is invisible there, but still set: the next roll takes advantage, and if you never roll it stays armed until you do - potentially firing on an unrelated roll much later.

**Proposed fix.** Either render the bar on every tab that can roll, or clear rollMode when the tab changes. Clearing on tab change is the smaller, safer change and matches the 'armed per roll, auto-reset' intent the LAN B1 work described.

## Low

### API-2-pdf-500-on-long-name — A long character name makes the sheet PDF export return 500

**LOW** · area: server / PDF export · effort: S · status: confirmed

**Evidence.** Found by tools/fuzz.py: POST /api/pdf with {"id":"x","name":"AAAA..."} (20000 chars) returns HTTP 500 rather than a refusal. It is the only 5xx in a 236-request sweep, so the route knows it failed but has no bound on what it will attempt to typeset. /api/pdf is also completely unauthenticated and unvalidated (serve.py:704-725): sheet = payload.get('sheet') or payload, straight into build_pdf.

**Reproduction.** python tools/fuzz.py http://127.0.0.1:7902 -> SERVER  POST /api/pdf  huge string  HTTP 500.

**Proposed fix.** Cap the name (and any other free-text field the PDF typesets) to a sane length and return 400 above it. Worth doing with API-1 since it is the same route family and the same missing habit - validate the body before acting on it.

### FIGHT-5-custom-has-no-side — A custom combatant has no side, so the first ally/foe tap appears to do nothing

**LOW** · area: shared combat runner · effort: S · status: confirmed

**Evidence.** side: appears exactly twice in runner.js - line 208 (addCharacter, 'ally') and line 260 (addMonsters, 'enemy'). addCustom (runner.js:280-287) sets neither side nor concentrating. The row chip reads c.side === 'ally' (runner.js:619) so an undefined side renders as 'foe'; toggleSide does c.side === 'enemy' ? 'ally' : 'enemy', so undefined becomes 'enemy' - the value it was already displaying. The first tap therefore changes nothing on screen and the DM taps again. The board token defaults to data-side='enemy' (map.js:285) for the same reason. adopt() (runner.js:103) patches it, but only after a server round-trip.

**Reproduction.** Add a custom combatant in the shared runner. It shows as a foe. Tap the side chip once: still a foe. Tap again: now an ally.

**Proposed fix.** Give addCustom the same defaults as its neighbours - side: 'ally' (a custom combatant the DM types in is usually an NPC ally or a summon) and concentrating: null - so all three constructors emit the same shape.

### RAIL-1-createdAt-no-offset — The dice rail's session boundary compares a timezone-less timestamp against UTC ones

**LOW** · area: dice rail / table record · effort: S · status: confirmed

**Evidence.** This is a defect in yesterday's own fix, found by holding it to the same standard as everything else. table.py:86 writes createdAt with time.strftime('%Y-%m-%dT%H:%M:%S') - local wall clock, no offset - while every event ts comes from now_iso() (serve.py:269), which is datetime.now(timezone.utc).isoformat() and carries +00:00. dicerail.js:38 does Date.parse(since) on the first and Date.parse(e.ts) on the second. Per the ECMAScript rules an ISO date-time WITHOUT an offset is interpreted as the BROWSER's local time, so the two sides are only on the same clock when the phone and the server agree.

**Reproduction.** Measured with a real record. createdAt on disk: 2026-08-10T16:48:38; the instant it really was: 2026-08-10T21:48:38Z (server on UTC-5, DST). What a phone computes for `since`: same timezone as the server - correct, which is the ordinary couch case and why this did not show up at the table. A phone on UTC - 5h EARLY, so the rail lets in five hours of the PREVIOUS session's rolls, which is exactly the bug the `since` filter was added to kill. UTC+2 - 7h early. UTC-10 - 5h LATE, so the rail silently hides the first five hours of this session. A DST disagreement inside one timezone is worth 1h on its own.

**Proposed fix.** Write createdAt with an offset - now_iso() already exists in serve.py and is the house format; table.py should use the same thing rather than a second, subtly different one. Two timestamp formats in one record set is the actual defect; the rail is just where it showed. Old records with a bare timestamp keep parsing as they do today, so the change is safe to land alone.

## Idea

### GOOD-1-path-ids-are-safe — Confirmed SOUND: hostile path ids are all refused - safe_id holds

**IDEA** · area: server / input validation · effort: S · status: confirmed

**Evidence.** Recorded because a soak report that only lists faults gives a false picture of where the code stands. tools/fuzz.py put ten hostile ids into the record path - '../../etc/passwd', 'a/../../b', '..%2f..%2fserve.py', a 300-character name, '%00', 'con', 'nul', '.', '..' and whitespace - and every one was refused. Zero ACCEPTED results in a 236-request sweep. Combined with the traversal check on /samples (serve.py:1439) and the resolved-path containment on shelf refile and remove, client-supplied strings do not reach the filesystem.

**Proposed fix.** No action. Keep tools/fuzz.py in the repo and re-run it after any route change - it is cheap, it refuses to point at a real data directory, and this result is the baseline it defends.

### IDEA-1-one-combat-model — The 'one combat model' epic did not land - joining a table still LOSES features

**IDEA** · area: combat · effort: L · status: proposed

**Evidence.** LAN C1 was titled 'One combat model: side + concentration in shared runner', and it did move side and concentration across. But two combat implementations still exist. modes/combat/combat.js (solo, 16.8 KB) has death-save tracking, fireTriggers for homebrew triggers and rollOnTable (combat.js:449-459). modes/dm/runner.js (the shared fight, 28 KB) has none of those three. The solo tracker is hidden at a table (app.js:36, soloOnly: true), so sitting down with friends silently costs you homebrew trigger firing and death-save tracking - the two things a homebrew-analysis tool should be proudest of.

**Proposed fix.** Finish the extraction the epic started: move fireTriggers and rollOnTable into core/engine.js beside applyHit, and have both screens call them. Death saves belong there too (see FIGHT-4). The test is simple and worth writing down - a feature that exists in solo play and not at a table is a bug in the shared runner, not a feature of the solo one.

### IDEA-2-story-lens-thin — Story is the thinnest lens by far, and the DM's view of the log is poorer than the players'

**IDEA** · area: DM lenses · effort: M · status: proposed

**Evidence.** By file size the DM shell is wildly lopsided: deck.js 47 KB, runner.js 28 KB, world.js 18 KB, stage.js 16 KB, setup.js 10 KB, party.js 6.4 KB, story.js 5 KB (143 lines). Story is three panels, a 12-row thread cap (story.js:80), a 200-row feed cap (story.js:120), no search, no date grouping, no export. The player-facing Chronicle (chronicle.js, 12.5 KB) has Markdown, HTML and JSON export. So the DM's view of the same event log is strictly worse than what every player already has. Separately story.js:132 slices the raw UTC string for its time while chronicle.js:185 uses toLocaleString, so the two screens disagree about when the same event happened by the machine's UTC offset, and Story has no date separators at all - a multi-session campaign shows bare HH:MM with no way to tell Tuesday from Saturday.

**Proposed fix.** Cheapest first: date separators and toLocaleString (fixes the disagreement and the multi-session confusion in one edit). Then a search box over the feed, then reuse Chronicle's existing exporters rather than writing new ones. This is the highest ratio of DM value to effort on the list.

### IDEA-3-clock-factionid-dead — Clocks carry a factionId that nothing anywhere reads

**IDEA** · area: clocks · effort: M · status: proposed

**Evidence.** campaign.js:131 puts factionId on the clock record. Nothing in app/ or tools/ ever reads it - no rendering, no filtering, no effect on faction standing. Clocks also have no strike text (what actually happens when it fills), no history, and exactly one rate: one segment per day or manual.

**Proposed fix.** Either wire it or drop it. Wired is more interesting and is what the field was obviously reaching for: a clock that fills nudges its faction's standing, and the Deck shows clocks grouped under the faction driving them - which is the 'strategy game for the DM' the epic was aiming at. Dropping it is a one-line honesty fix if that is not wanted. A field nothing reads is a promise the code is not keeping.

### IDEA-4-silent-failures — The three silent failures that will cost a session, out of 46 empty catch blocks

**IDEA** · area: error handling · effort: M · status: proposed

**Evidence.** Most of the 46 are fine. Three are not. (1) runner.js:157-163 publish() returns {ok:false,error} and NO caller ever reads it - stage.js:61 calls publish() bare - so a failed publish leaves every player's screen frozen on a stale fight and tells nobody. (2) runner.js:167-174 pull() returns null on any error and table.js:75-78 then adopts an empty fight, so one network blip makes the whole encounter VANISH from a player's phone and read as 'No fight running'; stale would be far better than gone. (3) db.js:227-229 get() swallows every error, so a 403 refusal, a 500 and 'no such record' are indistinguishable - which is why a permissions problem can surface as 'The DM has not put a map on the table yet'. Also live.js:100-102: the server dying is completely silent, and although live.status() exposes the mode, nothing in the UI renders it.

**Proposed fix.** dicerail.js:90-93 is already the house pattern done right - it catches and SAYS 'The dice feed is unavailable.' Apply the same to those three: publish failure raises a toast to the DM, pull failure keeps the last known fight and marks it stale, and db.get distinguishes 'refused' from 'absent'. None of these is a big change; all three are the difference between a confusing session and a diagnosable one.

### IDEA-5-stage-redraw — Every player's die roll rebuilds the DM's whole Stage, clearing work in progress

**IDEA** · area: DM Stage · effort: S · status: proposed

**Evidence.** stage-mode.js:37 subscribes to ['table','characters','campaigns','events'] and calls a full draw(). A roll event from any phone bumps 'events', so the entire Stage is torn down and rebuilt: the monster search box (runner.js:522) is cleared mid-word, every damage input is wiped, and the battle board's map is rebuilt so zoom and pan snap back to default (mapView keeps k/px/py in a closure, map.js:42-44). README:203 explicitly names this failure mode as SOLVED for the World lens - 'a half-typed search survives a player's die roll' - but Stage has a search and does not. The players' map has the same problem via table.js:60-71.

**Proposed fix.** Two options. Narrow: drop 'events' from the Stage subscription and let the dice rail refresh itself, since the rail is the only part of Stage that cares about events. Better: give mapView and the search box the same preserve-across-redraw treatment World already uses, so the fix generalises to the players' map too. The narrow one is a one-line change and would remove the worst of it today.

### IDEA-6-runpy-dependency-wall — run.py refuses to start without matplotlib and numpy, neither of which is on the play path

**IDEA** · area: first run · effort: S · status: proposed

**Evidence.** run.py:78-95 lists all six packages as `required` and calls c.fail (not c.warn) when any is missing, printing 'Cannot start'. matplotlib and numpy are used only by tools/charts.py and tools/grade.py - the simulation reporting tools. Nothing in the app, the server or a session at the table imports them. So a new user who just wants to play has to install a plotting stack first, on a project whose pitch is stdlib-only and no build step. Also run.py:167-181 _lan_ip() is now dead code, since the address printing moved into serve.main().

**Proposed fix.** Split the check into required (pypdf and friends actually used at runtime) and optional (matplotlib, numpy - warn, naming what will not work without them). Delete the dead _lan_ip. Small change, removes a real barrier to the first five minutes.

### IDEA-7-board-token-bench — A token cannot be taken off the battle board, and the bench is invisible to players

**IDEA** · area: battle board · effort: S · status: proposed

**Evidence.** Bounded by design and rightly so - README:141 says tokens on a picture, not a VTT - but inside those bounds there are gaps. There is no way to remove a placed token or send it back to the bench; stage.js:203-210 puts unplaced tokens in a bench row that table.js:217-218 filters out entirely, so players never see it. No dead-token styling either, so a defeated monster sits on the map looking alive.

**Proposed fix.** Drag-off-the-edge to bench (the clamp added in C3 already computes the off-map case - it currently snaps back, and could bench instead), and render downed combatants' tokens differently. Both are small and both are things a DM reaches for in the first fight.
