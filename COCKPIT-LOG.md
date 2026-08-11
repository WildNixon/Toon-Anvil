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

## B4 — Post-roll: what the total was made of

B3 put the arithmetic on the sheet *before* you roll. This puts it on the
result *after*, and keeps it around once the card has gone.

**The card grew a `why` line.** A skill tap now produces a card reading
`22 · +4 DEX +8 expertise`, and it is **the same string the row shows** —
computed once and handed to both, so the card can never disagree with the
sheet it came from. Wired at four call sites: skills, ability checks, saving
throws, attacks.

**"Your rolls" — a rail fold that outlives the cards.** Cards expire after
9 seconds, which is right for a notification and wrong for a record: "wait,
what did I roll for that" gets asked about thirty seconds later. The fold
holds the last eight with their breakdowns, newest first. It repaints on a
**push**, not on a redraw — a skill tap changes nothing about the character,
so a panel that waited for `draw()` would show the roll before last. The
listener cancels itself once its node is off the page, because a listener
held by a detached node is a leak with opinions.

**Consequence needed no new code.** Your card is the cause; the rail's fight
panel — already live-synced — shows the target's HP band move. That is what
putting them on one screen was for.

### Two judgement calls worth your attention

**Attack breakdowns are checked before they are shown.** `derive()` computes
`attackBonus` through `modFor()`, which honours substitutions — a Hexblade's
`WIS replaces STR for attacks`. Rebuilding the sum from `mods[ability]` would
then print a confident sentence that disagrees with the number beside it. So
the reconstruction is **summed and compared to the real bonus, and dropped
when it does not match**. A missing breakdown is a gap; a wrong one is a
thing a player argues with their DM about. Verified with a deliberately
unreconstructable attack (`attackBonus: 99`): no breakdown, no guess.

**Damage itemisation only appears when a rider fired.** With one damage part,
`9 damage` and `9 piercing (Rapier)` are the same sentence twice.

### The thing I changed my mind about

I first gated the fold open **during** a fight and left solo play with no
rail at all (B1's rule). Both were wrong, and the panel made it obvious once
I could see it:

- **Open during a fight** is the worst time on a phone — the rail already
  carries two open folds and your card is on screen *right now* anyway. It
  now opens when there is **no** fight, which is when the rail is nearly
  empty and when a forgotten skill check is what you are hunting for.
- **Solo play got nothing.** The roll history needs no server and no table,
  and solo is the commonest way this app is used — so the gate would have
  made the majority case the one that loses the feature. `railPanels()` now
  owns the decision and omits only the *table* panels when there is no
  table. A fold labelled "The fight" with nothing behind it is still worse
  than no fold; that part of B1's rule stands.

**Measured** at 390×844 with the widest realistic card on screen (advantage,
two damage parts, a long rider name): no sideways scroll on `main` or the
document (390 ≤ 391), first input still exactly 16px, card 280px wide ending
at x=376, and the breakdown **wrapping to two lines rather than truncating**
— a breakdown you cannot read is not a breakdown. Frozen strings re-checked
after the rail changed: `Adjust HP` present, first `main input[type=number]`
still `hp-amount`, `HP 44 of 44` still adjacent, tab labels unchanged, rail
still the second child and last in the document.

Also verified directly: history caps at 10 and hands out a defensive copy, a
listener that throws does not stop the roll, unsubscribe works, and a card
with no breakdown grows no empty element.

## B5 — Agency at the fight

The rail was read-only. You could watch the initiative order and then had to
scroll back into the sheet to actually do anything — on a phone that is the
whole screen twice, mid-turn, with four people waiting.

**The act bar.** On your turn, above every fold and deliberately *not* folded
— a turn you have to open a disclosure to take is the friction this was built
to remove. It carries:

- **Your attacks, with the bonus on the button** (`Rapier +8`). The number
  you are about to roll should be readable before you commit to rolling it.
- **The spells you could actually cast right now.** Cantrips always; a
  levelled spell only while a slot *it could use* remains — asked per spell,
  using the same upcast search `castSpell` performs.
- **End turn.**

Every button is a shortcut to a control that already exists — the same
`rollAttack` and `castSpell` the sheet calls — so there is one implementation
of an attack and one of a cast, and the bar cannot drift from the sheet.

**End turn does not advance the fight, and that is the point.** The server
refuses a player's write to the shared encounter; this stage does not touch
that, and the fog-of-war work stays intact. Instead it logs a `turn_done`
event — which is the honest shape of what happens at a real table: you say
you are done, and the DM moves the fight on.

**The other half, which makes it worth logging.** A "Called their turn" strip
shows who has said they are done, mounted on *both* the player's rail and the
DM's Stage. Without a screen showing it, End turn would be a button that
writes to a file nobody opens. The round is an **argument** to that strip
rather than read from module state, because only the player side fetches the
encounter — the DM's Stage holds the authoritative fight in `runner.js`, and
a shared component reading one side's private state is one that silently
shows nothing on the other.

It is scoped to the **current round** on purpose. The event log is
append-only and outlives the session, so an unscoped read would show everyone
as done from the moment round two began — the same trap that had the dice
rail showing last session's dice.

### One thing I got wrong, twice, and what it turned into

The first slot filter asked "is *any* slot free" rather than "is a slot this
spell could use free". Measured with a Fireball and only a level 1 slot
remaining: it was offered, and tapping it would have answered *"no slot high
enough is left"* — a button whose whole job is to say no. Now per spell:
with L2+L3 free both Fireball and Magic Missile appear (Magic Missile
upcasting); with only L1 free, Fireball is gone; with nothing free, the
cantrip stands alone.

Fixing it left me with the upcast rule written **twice** — once in the act
bar asking "may I offer this", once in `castSpell` asking "which slot do I
spend" — which is precisely the drift I had just claimed the bar avoided by
reusing the sheet's handlers. So it moved into `core/engine.js` as
`slotForSpell()`, beside `useSlot` and `highestAvailableSlot`, and both call
sites now ask the same function.

That made it **gradeable for the first time**, so it is now a gym scenario
(`combat/castable_now`): upcasting when a spell's own slots are gone, refusal
when only lower slots remain, refusal when nothing is left, and the three
degenerate inputs — a cantrip, a non-caster, and a caster with no slot table
— answering `null` rather than throwing. A rule this fiddly living only in a
render function was going to regress eventually.

**Measured against a real table**, not a stub — module bindings cannot be
stubbed from outside, and the first attempt proved it by silently doing
nothing. So: a table opened, a player joined and claimed a character through
the real join flow, and the DM published a running fight. Then End turn:
`turn_done` reaches the **server** (not just a local cache), payload
`{who: "Vex", round: 2}`, summary *"Vex is done (round 2)"*, category
`combat`. The round-2 strip shows `Vex ✓`; the round-3 strip correctly shows
nobody. **The permission boundary is unchanged** — the same player forging a
`clock_advanced` still gets **403**, while `turn_done` gets 200.

At 390×844 on your turn: `turn-first` puts the bar at the top of the screen
while it stays second in the document, all six buttons clear 32px, End turn
runs the full width, no sideways scroll, inputs still 16px, `Adjust HP` and
`hp-amount` untouched.

---

## The thing I found that is bigger than any of this

**BOOT-1 — a returning player arriving at your table gets a dead screen
instead of the join gate.** Written up in full in `SOAK-REPORT.md`; the short
version is that it is the couch scenario this whole epic exists for, and it
is broken.

Your friend played solo last week, so their browser holds a character. You
open a table. They open the app and get *"Toon Anvil could not start"*, with
no way forward — the thing that would let them join is the thing that failed
to render.

`boot()` calls `selectCharacter()` → `migrateHp()`, which quietly **writes**
a normalised HP record back to the server. With a table open and no join
code the server correctly answers 401, nothing catches it, and the boot
handler paints a failure panel. A read-only visitor is killed by a write
they never asked for, for a cosmetic migration. The app decides to write at
`app.js:806`, six lines *before* `session.refresh()` at `:812` tells it who
it is.

This is also the entire residual of **HARNESS-1** — the gym failure I have
been calling a cold-instance flake for four runs. It was never a timing
problem: the 25s budget was spent waiting for an element the app had already
decided not to render. It looked warm/cold-dependent because whether
`reconcileHp` finds anything to migrate depends on what earlier flows left
in the data dir. One defect, wearing a flake's clothes.

Proved pre-existing, not something the cockpit work introduced: same probe,
same instance, seconds apart, with the four changed files reverted to `HEAD`
and restored — byte-identical failure, 25036ms vs 25042ms.

**I have not fixed it, deliberately.** The mechanical part is obvious (a
refused migration must not be fatal) but *what happens to the migration* is
a real decision — swallow it, defer and replay it after joining, or stop
writing during boot at all. The three options with their trade-offs are in
`SOAK-REPORT.md`. The deferred-replay option in particular is a fog-of-war
question, not plumbing: a queue of writes made before you knew who you were.
It is the first thing I would do next.

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

8. **Should the act bar carry more than attacks and spells?** Dash, Dodge,
   Disengage, Hide and Help are the other things a turn is spent on, and none
   of them are on it. They are also the five the app models least — putting
   them there means either a button that only logs a word, or modelling the
   conditions they create. Same shape of question as `useFeatureAction` in
   (2).

9. **Should "Called their turn" clear itself when the DM advances?** Right
   now it is scoped to the round, so it clears when the round does — which is
   correct but coarse. If Kim ends her turn and the DM then moves to the
   goblin and back to Kim in the same round, her ✓ is stale. The fix is to
   scope to `(round, turn)` rather than `round`, which is small; I left it
   because I am not certain the tighter scope is what a table wants — the ✓
   arguably means "Kim has finished acting this round", not "this instant".

10. **Where does `Party` mode go now?** Raised in (4) and now sharper: with
    the fight, the dice, the world *and* an act bar all in the sheet's rail,
    `Party` is the map plus the party vitals table plus a third copy of the
    fight.

---

## Where this leaves things

Five stages, five commits, each independently green:

| | | |
|---|---|---|
| B1 | `0062fc1` | The sheet and the table became one screen |
| B2+B3 | `8079121` | Everything the character is · pre-roll clarity · two roll bugs |
| B4 | `f4cb9ac` | What the total was made of, and a rail that remembers |
| — | `03b141f` | **BOOT-1** root-caused (no fix — see above) |
| B5 | `1c2fe4d` | Agency at the fight |

**Gym at the end: 132/132 scenarios, 1614/1614 checks, 115 features** — up
from 131/1605/114, which is exactly the one scenario B5 added. The single
failing flow is `ui/join_gate`, and it is BOOT-1 rather than any of this
work: proved by reverting the changed files to `HEAD` on the same instance
and getting a byte-identical failure.

**Live data on :7801 verified untouched at every checkpoint** — 2 characters,
2 campaigns, 2 maps, 3 homebrew, no profiles, table closed. Everything above
was built and measured on the throwaway instance on :7903.

One process note worth keeping: I contaminated that throwaway instance
mid-session by leaving a probe character behind (its `DELETE` had failed
while the table was open and I did not check the status). The run on top of
it wedged. The numbers reported here are from a **re-run after cleaning**,
against an instance verified back to its starting shape — not from the
contaminated one.
