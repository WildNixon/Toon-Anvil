# Toon Anvil — soak run findings

Generated 2026-08-12T04:13:52+00:00 from `soak/findings.jsonl` (28 findings, 5 already fixed).

Every item below was **confirmed against a running server**, not inferred from reading. Anything I could not reproduce is not here.

Most of these have a **live reproduction** carrying the same id, in `app/sim/pending.js`. Open `/sim/pending.html` and run them: each one is expected to FAIL, and a failure is the defect still being present. When a fix lands its reproduction turns green — promote it into `appgym.js` and delete it from `pending.js`, so the gym guards it from then on. They are kept out of the graded gym on purpose: a suite with a permanent red in it stops being a gate.

| Severity | Count | Means |
| --- | --- | --- |
| critical | 1 | A security hole or data loss. Fix before the next session. |
| high | 7 | Breaks a shipped feature in normal play. A DM or player hits this. |
| medium | 7 | Wrong or confusing, but there is a way round it. |
| low | 3 | Papercut, polish, or a latent trap that needs an odd setup. |
| idea | 10 | Not a defect - an expansion or refinement worth discussing. |

## Critical

### SEC-1-join-dm — Anyone holding the join code can mint a DM token

**CRITICAL** · area: server / table permissions · effort: S · status: confirmed

**Evidence.** tools/table.py:116-117 honours a client-supplied profile_id (`if profile_id and profile_id in data["profiles"]: prof = data["profiles"][profile_id]`), and p-dm is always present because open_table() creates it at table.py:88. No caller in app/ ever populates it - session.js:246 defaults profileId to null - so this is dead weight in the client and a live back door on the wire.

**Reproduction.** Against an isolated instance: POST /api/table/open (loopback) -> code ANVIL-CF4T. Then POST /api/table/join {"code":"ANVIL-CF4T","profileId":"p-dm","name":"M"} returns {"role":"dm"} and a working token. Control: an honest join with the same code correctly sees lore=None, agendas=[], only the public clock, no templates. The escalated token returns THE-LORE-SECRET, THE-AGENDA-SECRET, the secret clock label THE-RITUAL-COMPLETES and the prepared ambush - byte-identical to the real DM's view.

**Proposed fix.** Stop honouring profile_id for role selection in join(). The DM seat's anchor is open_table(), which is loopback-only; the join code was never meant to buy it. Removing the escalation path is behaviour-preserving for the real client since nothing sends it.

## High

### FIGHT-1-resistance-dead — Resistance and immunity never applied in the shared fight - FIXED

**HIGH** · area: shared combat runner · effort: M · status: fixed

**Evidence.** runner.js:675 called applyTo(c.id, mult * Math.abs(n)) with two arguments, so damageType was always null and mitigate() (engine.js:269) returned early on every hit ever taken in the shared runner. The res.mitigation toast was dead code. applyTo's own docstring and README:201 both claimed resistance was applied.

**Reproduction.** FIXED. The ribbon now carries a damage-type picker (untyped by default, so the two-tap flow is exactly as fast as before) and passes it as applyTo's third argument; healing never carries a type whatever the picker says. DAMAGE_TYPES now lives in core/engine.js beside mitigate(), the thing that consumes it, so a screen offering a choice and the engine resolving it cannot drift apart on spelling. The row also shows what the creature actually resists or is immune to - the picker is a guess without it, since the statblock is not on that screen.

**Proposed fix.** Promoted into the graded gym as `damage_type_reaches_the_engine`. NOTE the reproduction I first wrote for this was WRONG and the harness caught it: it called applyTo(id, -10) with two arguments, copying the buggy call, so it could never have gone green however the app was fixed - untyped damage passing through unmitigated is correct and deliberate. The defect was that a DM had no way to say 'fire', so the test now asserts the CONTROL exists as well as the arithmetic. STILL OPEN, separately: the player sheet's own HP ribbon (app.js:100-116) passes neither a damage type nor the character's resistances, so a player adjusting their own HP gets no mitigation either.

### FIGHT-2-midfight-initiative — Monsters deployed mid-fight never rolled initiative - FIXED

**HIGH** · area: shared combat runner · effort: M · status: fixed

**Evidence.** rollInitiative() was only rendered under `if (!state.started && !empty)` (runner.js:455), so anything added after the fight began kept init:null, sorted to the bottom via `b.init ?? -99`, rendered as '--' and never acted. That broke the C2 prepared-encounter Deploy button, whose entire purpose is dropping monsters into a running fight.

**Reproduction.** FIXED. A new admit() puts every combatant into the fight and, when the fight is already running, rolls its initiative and sorts it into the order. All three constructors - addCharacter, addMonsters, addCustom - go through it. Sorting renumbers everybody and state.turn is an INDEX, so admit() carries the turn marker across by identity via a new keepTurn() helper.

**Proposed fix.** Promoted into the graded gym as `a_fight_survives_its_own_roster_changing`, which asserts the late arrival rolls, lands in order, and does not move whose turn it is.

### LEAK-1-clock-events — The event log leaked the DM's prep to every player - FIXED

**HIGH** · area: redaction / event log · effort: M · status: fixed

**Evidence.** GET /api/events applied no redaction at all - no _viewer(), no token, no may_read - and it sits ABOVE the KINDS block in the dispatch, so it was never going to inherit any. Four leaks, not one: secret clock labels (deck.js:200, :343), non-public faction names and standings (deck.js:548, which redact_campaign removes entirely so even their existence leaked), lore titles and unmet NPC names (deck.js:1074), and prepared-encounter names with full monster rosters (combat.js:100, :125). The dice rail made it land: it asks for 400 events with NO character filter, so world events reached every player's browser regardless. describe() (events.js:179) also bakes payload text into `summary`, so scrubbing the payload alone would have left 'The Veiled Hand: standing -3' in the next field.

**Reproduction.** FIXED, and proved by A/B against an instance running the pre-fix server: STILL BROKEN there, FIXED here. Measured on the isolated instance with a campaign holding one secret clock and one public one. A player now receives only the public clock's strike - the secret one is ABSENT, not blanked, because a secret clock striking is itself the tell - the secret faction shift and the lore filing are gone, and an encounter's roster becomes {combatants: 2}. The DM still sees every one of them.

**Proposed fix.** Three parts. Server: redact_events() in tools/table.py dispatched through _viewer(), failing closed - an event whose subject cannot be resolved is treated as secret, since the cost of a false negative is a missing log line and the cost of a false positive is the DM's ambush on screen. Client: deck.js logs clockId/factionId rather than the DM's prose, so the secret is never written into a shared log at all; the DM's Story resolves ids back against the campaign it may see. Write side: POST /api/events refuses world-category types from anything but a DM token, judged on the TYPE against a server-side list rather than the client-supplied `cat`. Gym: promoted as `the_log_is_redacted_like_everything_else` and `only_the_dm_authors_the_world`, with an `events_carry_the_dms_prep` mutation.

### NIGHT-1-event-window-truncation — Anything counted from the event log silently becomes a count of the last N events

**HIGH** · area: DM screens / event log · effort: M · status: confirmed

**Evidence.** Measured across 124 cycles on the isolated instance, days 1-120. The payload a DM-facing answer is buried in grows ~15x from day 1 (7,471 bytes) to day 15 (108,692), then plateaus at ~110KB. The plateau is the 400-event window filling - dicerail.js asks for 400, and the ager produces ~26 events/day, so it fills at ~day 15. At that point every 'how often / how much / who last' answer is computed from the most recent slice of the campaign, with nothing on screen saying so. Same arithmetic puts story.js (limit 1000) at ~day 38 and the server clamp (2000) at ~day 77.

**Reproduction.** python tools/night.py --minutes 5 --fresh, then read the 'What it costs to answer' table in NIGHT-REPORT.md. The 400-event case is MEASURED; the 1000 and 2000 cases are inferred from the same rate and should be confirmed before being acted on.

**Proposed fix.** Either say so on screen (a 'from the last N events' note beside any derived count), or count server-side where the whole log is available. The second is the honest fix; the first is the cheap one and is still better than a number that quietly stops being true.

### NIGHT-2-fifteen-questions-have-no-answer — Fifteen questions a DM or player asks have no answer in any payload, at any campaign size

**HIGH** · area: data model · effort: L · status: confirmed

**Evidence.** 60 catalogue questions x 6 seats x 64 campaign sizes, 19,344 rows, 124 valid cycles, all four controls green. 15 questions are unavailable at EVERY size - they are not slow to reach, the data does not exist. Highlights: encounter outcome (the DM's runner never logs encounter_end), encounter difficulty (encounter_start logs a combatant count and nothing else), damage attributable to a player (runner.js:751 logs PC damage as damage_dealt with no characterId), session count and pacing (setContext never sets sessionId), party wealth on any DM screen, NPC disposition for the DM, and whether a player hit (sheet.js passes no target to resolveAttack).

**Reproduction.** python tools/night.py; see the 'Not in any payload, at any size' table. Four of the fifteen are deliberate redaction controls and are correct behaviour, marked as such.

**Proposed fix.** Each needs something WRITTEN before any screen could show it. Cheapest first: log encounter_end from the DM's runner; give encounter_start its XP/CR/party-levels; fix the damage_dealt/damage_taken mis-typing so damage can be attributed; set sessionId in setContext.

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

### FIGHT-3-remove-shifts-turn — Removing a combatant above the turn marker moved the turn - FIXED

**MEDIUM** · area: shared combat runner · effort: S · status: fixed

**Evidence.** remove() filtered the array and only guarded `turn >= length`, so deleting anything BELOW the marker's index shifted everyone up while turn kept its old number, silently pointing at a different creature.

**Reproduction.** FIXED alongside FIGHT-2, because it is the same invariant: state.turn is an index into a list that changed. keepTurn() captures whose turn it is by id, runs the mutation, and restores the index; if the marked combatant is the one that left, the index stays put and is clamped, which lands it on whoever is next in order. Fixing FIGHT-2 without this would have introduced FIGHT-3 on a new path, so the two could not honestly be separated.

**Proposed fix.** Covered by `a_fight_survives_its_own_roster_changing` in the graded gym.

### FIGHT-4-death-saves-persist — Death saves are only ever cleared by a long rest, so the next fight starts with old failures showing

**MEDIUM** · area: engine / character sheet · effort: S · status: confirmed

**Evidence.** deathSaves: { successes: 0, failures: 0 } appears exactly once in engine.js, at line 507, inside longRest(). Nothing else resets it: adjustHp (app.js:100-120) writes only c.hp. So a character healed from 0 keeps the pips they had, and sheet.js:396 renders them - two failures still lit at the start of an unrelated fight, one bad roll from 'Fallen.' Nothing marks a character dead at three failures beyond the word (sheet.js:418-419).

**Reproduction.** Drop a character to 0, fail two death saves, have someone heal them. The sheet still shows two failures. Take them to 0 again in the next fight: they begin one failed save from death.

**Proposed fix.** Clear deathSaves whenever hp rises above 0 - that is the rule (stabilising or being healed ends the death-save sequence), and it belongs in the engine so every screen inherits it rather than in each caller.

### HARNESS-1-cold-join-flows — Standalone join flows are flaky on a cold instance - improved from 3 failures to 1, not cured

**MEDIUM** · area: gym harness · effort: M · status: partly fixed

**Evidence.** The three flows needing an UNSEATED browser waited for the .welcome gate with a 10s budget and then dereferenced the result, so a timeout threw 'Cannot read properties of null' from the line AFTER the one that failed - a timeout wearing a crash's clothes. Measured across five runs on the same build: freshly started instance, all THREE fail; same instance warm, one fails; run standalone with nothing competing, it passes with 13 checks. Booting a frame by hand and settling 4s finds .welcome present, so the app renders the gate correctly and the budget is what runs out. Also proven not to be a code regression - the identical failures occur against the pre-fix server with the same tests.

**Reproduction.** PARTIALLY FIXED, and measured on a fourth, genuinely cold instance (port 7903, empty data dir, fresh browser origin): a warm-up frame is now booted and discarded before the standalone block, the gate budget is 25s, and a miss is reported as 'the join gate never appeared'. Result on cold: THREE failures became ONE. player_sees_a_players_table and join_deeplink now pass cold; join_gate still fails, but with the honest message instead of a TypeError. Logic tier unaffected throughout: 127/127 scenarios, 1586/1586 checks.

**Proposed fix.** The residual is NOT root-caused and I will not pretend otherwise. What is ruled out: a stale localStorage token (clearing it changes nothing), a leaked iframe (every flow removes its frame in a finally), and the app failing to render the gate (a hand-booted frame shows it). What remains to try: waitUntilSettled instead of a bare waitFor, and instrumenting the frame's own console during the wait so the next failure says WHY rather than only that it timed out. Worth finishing before relying on unattended overnight runs, because a suite that is only green on a warm server cannot gate anything.

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

### SHEET-2-player-hp-no-mitigation — A player adjusting their own HP gets no resistance or immunity either

**MEDIUM** · area: character sheet · effort: M · status: confirmed

**Evidence.** The other half of FIGHT-1, left open when the shared runner was fixed. app.js:100-116 adjustHp() calls applyDamage with only { name: derived.name } - no damageType AND no resistances or immunities from derive(). So even if a type were supplied, mitigate() has nothing to match against. A player taking fire damage on their own sheet takes the full number regardless of what their character resists.

**Reproduction.** Not yet reproduced as a scenario - the runner fix was scoped to the shared fight, where the README's claim lives. The code path is unambiguous: adjustHp passes neither of the two things mitigation needs.

**Proposed fix.** Pass derived.resistances / derived.immunities through, and add a damage-type control to the sheet's HP ribbon. Note the ribbon's buttons are frozen strings the gym asserts on, so the control goes BESIDE them rather than replacing anything. Smaller than it sounds now that DAMAGE_TYPES exists and the runner has a working pattern to copy.

## Low

### API-2-pdf-500-on-long-name — A long character name makes the sheet PDF export return 500

**LOW** · area: server / PDF export · effort: S · status: confirmed

**Evidence.** Found by tools/fuzz.py: POST /api/pdf with {"id":"x","name":"AAAA..."} (20000 chars) returns HTTP 500 rather than a refusal. It is the only 5xx in a 236-request sweep, so the route knows it failed but has no bound on what it will attempt to typeset. /api/pdf is also completely unauthenticated and unvalidated (serve.py:704-725): sheet = payload.get('sheet') or payload, straight into build_pdf.

**Reproduction.** python tools/fuzz.py http://127.0.0.1:7902 -> SERVER  POST /api/pdf  huge string  HTTP 500.

**Proposed fix.** Cap the name (and any other free-text field the PDF typesets) to a sane length and return 400 above it. Worth doing with API-1 since it is the same route family and the same missing habit - validate the body before acting on it.

### FIGHT-5-custom-has-no-side — A custom combatant had no side, so the first ally/foe tap did nothing - FIXED

**LOW** · area: shared combat runner · effort: S · status: fixed

**Evidence.** addCharacter emitted side:'ally' and addMonsters side:'enemy'; addCustom emitted neither, so the chip rendered 'foe' for undefined and toggleSide turned undefined into 'enemy' - the value already on screen.

**Reproduction.** FIXED. addCustom now emits side:'ally' and concentrating:null like its two neighbours - an ally by default because a combatant a DM types in mid-fight is usually a hireling, a summon or an NPC fighting alongside the party.

**Proposed fix.** Covered by `a_fight_survives_its_own_roster_changing` in the graded gym.

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

### GOOD-2-engine-holds-on-fresh-seeds — Confirmed SOUND: 3,600 campaigns on seeds the project has never run, zero invariant violations

**IDEA** · area: engine / campaign emulator · effort: S · status: confirmed

**Evidence.** The gym is fully deterministic - every seed hardcoded - so repeating it adds nothing. The campaign emulator is the one harness here that genuinely varies (runner.js:87 seeds 0..n-1), and every sweep in the repo's history has used that same low range, most recently 0..95. So the whole seed space above 96 had never been touched. Ran all 12 SRD subclasses against seeds 1000-1299 - 300 seeds none of them had ever seen - each to level 20, checking every INVARIANT at every tick: hp within bounds, temp hp non-negative, resources within pool, slots within pool, prepared within budget.

**Reproduction.** 3600 campaigns. violations 0, errors 0, incomplete 0. Driven by calling campaign.runCampaign directly from /sim/sim.html on the isolated instance, rather than runSweep, because runSweep only ever generates seeds 0..n-1 and so cannot reach new ground however large n gets.

**Proposed fix.** No action on the engine - this is the strongest single piece of evidence in the run that the rules core is sound, and it is worth recording precisely because a report of nothing but faults misrepresents where the code stands. One harness note though: runSweep's seed range starting at 0 every time means a bigger sweep is always a SUPERSET of the last one, never new territory. A seedFrom option would make repeat sweeps able to explore instead of re-confirm - cheap, and the difference between a long run that learns something and one that does not.

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

### NIGHT-3-availability-holds-but-cost-was-not-measured — The DATA keeps up as a campaign grows; whether the SCREENS do is still unmeasured

**IDEA** · area: measurement · effort: M · status: confirmed

**Evidence.** Availability is flat at 1.00 for both roles from day 2 to day 120 (day 1 is 0.00 for the DM only because an empty campaign genuinely has no factions, clocks or lore yet). So nothing goes missing as the campaign grows - the question is entirely about what it costs to reach, and browser-tier coverage for this run was 0%.

**Reproduction.** NIGHT-REPORT.md, 'Availability as the campaign grows'.

**Proposed fix.** Finish the cost tier: app/sim/reach.js holds 60 declared routes and app/sim/probe.js the tap primitives; what is missing is the six-seat sequential driver (seats.js) and the fronted page (night.html). The two tiers already merge on question id, and missing browser rows are reported as availability-only rather than dropped.
