# The player cockpit — what changed, and what we should decide

A running log of the player-facing rebuild, written to be read together.
Each stage says what it changed, what was **measured** rather than assumed,
and what it deliberately did **not** do. The open questions are collected at
the end — those are the ones I want your call on.

Companion to `SOAK-REPORT.md`, which is the defect list. This is the change
log.

---

## Why this work exists

Two measurements started it.

**A player could not see what their own character resists.** `derive()` has
always computed `resistances`, `immunities`, `conditionImmunities`,
`hitDice`, `critRange`, `attacksPerAction`, `damageRiders`, `reactions`,
`advantages`, `actions` and `rollTables` — and not one of those words
appeared anywhere in `app/modes/sheet/sheet.js`. All of it computed, none of
it shown.

**Cause and effect were on different screens.** Actions lived on Play, their
results lived on Party. You rolled on one screen and walked to another to
find out what happened. That is the thing that makes an app feel like a form
instead of a game.

Decisions taken up front: phone-first at 390px with the laptop widening for
free; keep the sheet's panels and frozen strings and change the *frame*;
deliver pre-roll, post-roll and consequence; and give the player real agency
at the fight.

---

## B1 — The sheet and the table are one screen  ·  `0062fc1`

The sheet became a **cockpit**: the character in `.cockpit-main`, the live
table in `.cockpit-rail`, reusing the grid the DM's Stage already had.

- **The fight, dice and world moved into `app/ui/components/liveside.js`**
  rather than being copied there. `table.js` is ~75 lines lighter and imports
  them. Both player screens now render one implementation — two renderers for
  one initiative order is exactly how two views end up disagreeing about
  whose turn it is.
- The your-turn **buzz** lives there too, so it fires once per turn rather
  than once per screen showing that turn.
- **Solo play gets no rail at all**, rather than an empty one.

**The constraint that shaped it.** The rail is appended AFTER the character
in the DOM, always, and paints above it on a phone using CSS `order`. Not a
style choice: the gym reads the first `main input[type=number]` as the damage
field and uses `Adjust HP` to know the screen is loaded.

**Measured** at 390×844: one column, rail `order: -1`, rail rectangle above
the sheet's, and `cockpit.children[1] === rail` — so it paints first and is
second in the document. No sideways scroll on `main` or the page; first input
still computes to exactly 16px. At 1280: 786px of sheet, 340px of rail.

Nothing here writes. The server refuses a player's write to `encounters`
whatever a screen offers.

## B2 — Everything the character is

New panels for what was computed and never shown.

- **Defences** (Overview, after the vitals): resistances, immunities,
  condition immunities, hit dice. This is the headline — it is the
  information a player could not reach at all.
- **Readiness** (Features): reactions and advantage rules. At a table the
  question between your turns is "can I do anything about that", and the
  answer was buried in feature prose.
- **Your kit** (Features): feature actions, and homebrew tables that roll.
  These existed only in the solo Combat tracker, which is `soloOnly` — so
  **sitting down with friends silently took them away**. A homebrew
  subclass's whole point stopped being reachable the moment a table opened.
  Same handlers, moved to the screen a player actually has. (This is the
  first real payment against `IDEA-1`, "the one combat model epic did not
  land".)
- **Attacks** gained a facts line: attacks per action, crit range, damage
  riders. A Champion could not see their own crit range; a Rogue could not
  see that Sneak Attack exists.

Every panel returns `null` when it has nothing to say, so a plain SRD
character sees no empty furniture.

**Measured** by feeding the sheet a derived object carrying all of them:
`Resistant to fire poison / Immune to necrotic / Cannot be charmed
frightened / Hit dice d10 — 3 of 5 left`, `2 attacks per action · crits on
19-20 · 2d6 Sneak Attack`, and working `Second Wind` / `Roll Wild Magic (d8)`
buttons. Frozen strings re-checked after: `Adjust HP` present, `HP44of 44`
still matches the adjacency regex, first number input still the damage field.

## B3 — Pre-roll clarity, and two roll bugs

Shipped with B2 in one commit, because both live in `sheet.js` and a gym
result should correspond to exactly the tree that ships.

**The breakdown.** Every rollable now carries its sum in words, always
visible: a skill row reads `Stealth +3 DEX +4 expertise` beside its `+7`, and
an ability tile shows what its save is made of. No taps, because a phone has
no hover and an extra tap mid-fight is an extra tap mid-fight. `+7` is a
number you have to trust; `+7 = +3 DEX +4 expertise` is one you can argue
with when the DM says something different.

**Two real bugs, both "derive knew and the sheet never asked".**

- **Crit range was dead.** `resolveAttack` has taken a `critRange` option
  from the beginning and the sheet's call never passed it, so it defaulted to
  20 — a Champion's Improved Critical did nothing on the one screen a player
  rolls attacks from.
- **Exhaustion skipped ability checks.** I said in the plan I would verify
  this rather than assume it, and the answer was narrower than the guess:
  `d20Penalty` **is** folded into saves, skills, attack bonuses and
  initiative by `derive()`, and is **not** in `mods` — which is exactly what
  a raw ability check uses. So exhaustion applied everywhere except the one
  roll type. Fixed at the call site rather than in `derive()`, because `mods`
  is the plain modifier everything else is built from and folding it in there
  would count the penalty twice.

**Deliberately not done:** `damageRiders` are shown but not auto-applied.
Sneak Attack is conditional ("once per turn", "if you have advantage") and
this project does not fake adjudication it has not modelled — the honest
move is to tell the player the rider exists and let them apply it. See the
open questions.

---

## Open questions — for us to decide

1. **Where should Defences live?** It is on Overview now, which is the
   crowded tab. It is combat-critical ("am I resistant to this?"), but
   Overview is also the tab a phone scrolls most. Candidate: a fifth tab, or
   fold it into the vitals panel.

2. **`useFeatureAction` spends the resource and logs, but adjudicates
   nothing.** It is honest — the app has never claimed to resolve features —
   but "used" with no effect may read as broken to a new player. Do we want
   the app to say what a feature *does*, or keep it as a tracker?

3. **The player sheet still applies no mitigation** (`SHEET-2`). The DM's
   fight honours resistance now; a player adjusting their own HP does not,
   because `adjustHp` passes neither a damage type nor the character's
   resistances. Worth doing next, and it is small now.

4. **The rail duplicates the Party screen.** With the fight beside the sheet,
   `Party` mode is now the map, the party vitals table, and a second copy of
   the fight. Does Party become *just* the party and the map?

5. **Two combat models still exist.** B2 moved actions and tables across, but
   `combat.js` still owns death-save tracking and homebrew trigger firing
   that `runner.js` lacks. Finishing that is the rest of `IDEA-1`.

6. **Should damage riders apply themselves?** Right now the attacks line
   says `2d6 Sneak Attack` and the player adds it by hand. Auto-applying
   means modelling conditions the app has never modelled ("once per turn",
   "if you have advantage") and would be the first place this app guesses at
   a rule rather than reporting one. My instinct is to leave it — but a
   Rogue player adding 2d6 by hand every turn is exactly the friction this
   rebuild is meant to remove. Possible middle: a "+ Sneak Attack" button
   on the roll card that the player taps when it applies.

7. **The breakdown text on a 390px phone.** It fits, but skills rows are now
   two visual lines on the narrowest screens. Worth looking at on your actual
   phone before deciding whether it should be behind a toggle.

*(Stages B3–B5 append here as they land.)*
