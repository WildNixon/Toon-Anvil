# The night run — what the app does as a campaign grows

## Provenance, and what this run cannot tell you

- instance: `D:\Dnd\grimoire-night` on port `7904`
- cycles attempted: 49 · measured: 49 · **excluded: 0**
- rows: 7644 · questions: 60 · seats: 6

> **Browser-tier coverage is 0%.** Everything about *taps*, on-screen visibility and redraw survival below rests on that fraction of the run. The availability curves are unaffected — they need no browser. This sentence is at the top rather than in a footnote because a reader who misses it would over-read the cost numbers.

**Recorded divergences from the app you actually ship:** `app/sw.js` is deleted in the measured copy (a stale service worker across hundreds of reloads is a trap, and PWA-1 says its shell list is already stale), and campaign states were written over HTTP by `tools/age.py` rather than through the UI — so this run can describe states the UI could not have produced. Every finding below carries a UI-reachability re-check before it is acted on.

## Controls — checked before any curve is believed

| question | expected | measured | | why it is a control |
| --- | --- | --- | --- | --- |
| `initiative_order` | 1 | [1] over 49 rows | **ok** | the runner panel is first in .cockpit-main - already on screen, and the bench always has a fight running |
| `campaign_lore` | 1 | [1] over 33 rows | **ok** | written by deck.js and read by nothing: once it EXISTS it is present in the payload, so availability must say 1 while the UI cannot reach it at all |
| `session_count` | 0 | [0] over 49 rows | **ok** | setContext never sets sessionId, so no event carries one |
| `did_i_hit` | 0 | [0] over 245 rows | **ok** | sheet.js passes no target, so hit is never computed at all |

All four controls behave as the code says they should, so the measurements below are about the app rather than about the probe.

## Availability as the campaign grows

| in-world day | DM available | player available |
| --- | --- | --- |
| 1 | 0.00 (n=288) | 1.00 (n=960) |
| 2 | 1.00 (n=288) | 1.00 (n=960) |
| 4 | 1.00 (n=288) | 1.00 (n=960) |
| 8 | 1.00 (n=288) | 1.00 (n=960) |
| 15 | 1.00 (n=288) | 1.00 (n=960) |
| 30 | 1.00 (n=288) | 1.00 (n=960) |
| 60 | 1.00 (n=36) | 1.00 (n=120) |

A flat line here is a real result, not a null one: it says the *data* keeps up. Whether the SCREENS keep up is the browser tier's question, and the disagreement table below is where the two meet.

## Available, but the DM has to go and find it

Every question whose answer is sitting in a payload the seat already receives. Where the browser tier ran, `taps` is what it cost to get it onto a screen; `—` means that question has availability data only.

| question | id | seat | bytes the answer is buried in | taps | note |
| --- | --- | --- | --- | --- | --- |
| Who has not acted this round? | `who_has_acted` | dm | 110,591 | — | only turn_done carries it; the encounter record does not |
| How much has the party spent, and when? | `gold_spent_by_day` | dm | 110,591 | — |  |
| How often is the table critting? | `crit_rate` | dm | 110,591 | — | counts exist; the denominator is unused |
| When did they last take a long rest? | `rest_cadence` | dm | 110,591 | — |  |
| What did that player just roll? | `recent_rolls` | dm | 110,591 | — |  |
| Which player has rolled the least this session? | `spotlight_balance` | dm | 110,591 | — | raw material present; no aggregate |
| How has that standing moved over the campaign? | `faction_standing_history` | dm | 110,591 | — |  |
| How fast have the clocks been filling? | `clock_history` | dm | 110,574 | — | only strikes are logged; ordinary segment taps are not |
| Where is the party standing? | `current_region` | dm | 5,193 | — |  |
| What day is it and what is the sky doing? | `day_and_weather` | dm | 5,193 | — | weather is computed from seed+day |
| What did the book say about this region? | `region_note` | dm | 5,193 | — | stored by the Deck's ingest, rendered by nothing |
| What lore did I file about this place? | `campaign_lore` | dm | 5,193 | — | CONTROL: written by deck.js, read by nothing in the app |
| How does the Veiled Hand regard the party? | `faction_standing_now` | dm | 5,193 | — |  |
| What is that faction secretly after? | `faction_agenda` | dm | 5,193 | — | redact_campaign strips agenda for players |
| How full is the ritual clock? | `clock_state` | dm | 5,193 | — |  |
| Which map pins have I not revealed yet? | `hidden_pins` | dm | 4,517 | — | redact_map drops unrevealed pins entirely |
| What day is it in the world? | `the_day` | player | 2,434 | — |  |
| What is everyone's AC? | `party_ac` | dm | 1,370 | — | AC is derived client-side from the character record |
| What is the party's passive Perception? | `party_passive_perception` | dm | 1,370 | — | AC is derived client-side from the character record |
| Who is good at Constitution saves? | `party_saves` | dm | 1,370 | — | AC is derived client-side from the character record |
| Is anyone resistant to fire? | `party_resistances` | dm | 1,370 | — | AC is derived client-side from the character record |
| Roll one of my attacks. | `roll_an_attack` | player | 1,370 | — | attacks are derived from the record |
| Cast a prepared spell. | `cast_a_spell` | player | 1,370 | — | attacks are derived from the record |
| How many spell slots do I have left? | `slots_left` | player | 1,370 | — | attacks are derived from the record |
| What are my hit points? | `my_hp` | player | 1,370 | — | attacks are derived from the record |

## Not in any payload, at any size

These are not slow to reach. The data does not exist, so no amount of UI work would surface them — each one needs something *written* first.

| question | id | seat | why | control? |
| --- | --- | --- | --- | --- |
| How much damage has the party taken this campaign? | `damage_taken_total` | dm | the runner logs PC damage as damage_dealt with no characterId |  |
| Who has been down, and how often? | `death_saves_made` | dm |  |  |
| Did I hit? | `did_i_hit` | player | CONTROL: sheet.js passes no target, so hit is never computed | yes |
| Was that fight the difficulty I budgeted for? | `encounter_difficulty` | dm | encounter_start logs a count and nothing else |  |
| How did the last fight actually go? | `encounter_outcome` | dm | the DM's runner never logs encounter_end at all |  |
| What are the ogre's exact hit points? | `enemy_hp_number` | player | CONTROL: redact_encounter must pop hp for a player seat | yes |
| What is that faction secretly after? | `faction_agenda_player` | player | redact_campaign strips agenda for players | yes |
| How much has the party sold or been given? | `gold_earned` | dm |  |  |
| What is at that unrevealed pin? | `hidden_pin_player` | player | redact_map drops unrevealed pins entirely | yes |
| How much damage did I do? | `how_much_damage` | player |  |  |
| How does that NPC feel about the party? | `npc_disposition` | dm | the npcs kind is read only by the player's RP mode |  |
| How much gold does the party have? | `party_wealth` | dm | currency is on the record; derive() exposes copper |  |
| What ambush did I prepare? | `prepared_encounters` | dm | redact_campaign pops encounterTemplates for players |  |
| How many sessions has this campaign run? | `session_count` | dm | CONTROL: setContext never sets sessionId, so every event is null | yes |
| How much happened last session versus this one? | `session_pacing` | dm | CONTROL: setContext never sets sessionId, so every event is null |  |

## How to read this

- **Available but expensive** is a UI problem, and the cheapest to fix.
- **Not available at all** is a data problem: something has to start being recorded before any screen can show it.
- **A control marked `redacted`** appearing as unavailable to a player is the redaction working, not a defect.
