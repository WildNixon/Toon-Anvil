# Toon Anvil

**Drop in homebrew. Get back a balanced subclass, a character sheet, and a plan
for playing it.**

You wrote a subclass. You don't know if it's broken. Toon Anvil runs it through
a few hundred simulated campaigns from level 1 to 20, tells you which features
actually do anything, proposes a fix for the ones that are too strong, and hands
you a character sheet and a page you can send to your table.

It runs entirely on your machine. No account, no upload, no network after
install.

```bash
python run.py
```

That's the whole setup, after `pip install -r requirements.txt`. It health-checks
itself, starts a local server and opens the app.

---

## What it does

**Ingest.** Drop homebrew into `inbox/` — PDF, Markdown, HTML, JSON, or plain
text. PDFs are split automatically into subclasses, spells, items and feats, one
folder per document. The parser classifies blocks by what they *say*, not by
where they sit in the file, so it survives homebrew that doesn't follow a
template. Subclasses, monsters, magic items and spells are all extracted;
monsters and items you parse are saved alongside the SRD and badged **custom**
everywhere they appear, so you always know what came from the book.

**Map.** Prose becomes mechanics. "you deal an extra 1d6 Fire damage" becomes a
damage rider the engine can execute. Everything it *can't* map is listed rather
than quietly dropped, and every result carries a coverage number so you know how
much of the subclass was actually tested.

**Simulate.** Full campaigns, levels 1–20, with encounters, rests, resource
spending and a shared decision policy so two subclasses are compared on their
mechanics rather than on how well they're piloted. Seeded — the same input gives
the same numbers, every time.

**Grade.** Each feature is measured by *ablation*: the same character, the same
seeds, that one feature removed. The difference is what the feature is worth,
with a bootstrap confidence interval. A feature whose interval crosses zero is
reported as having no detectable effect, which is usually the more interesting
result.

**Balance.** A verdict against a pre-registered band, and a proposed change if
it's outside. Every change is shown as a diff with the measurement that
justified it, and the output page has an original/balanced toggle. The machine's
opinion is visible and rejectable.

**Emit.** A standalone HTML page, a printable character sheet (HTML and PDF),
raw JSON, and a play guide — every line tagged with where it came from:
`measured`, `from the text`, `implication`, or `compared`.

---

## Status: v1.0

Everything below was exercised by hand before release — not "it renders", but
"it does the thing".

**Working**

| Area | What was verified |
|---|---|
| **Homebrew** | Ingests PDF / HTML / Markdown / JSON / text. Balance verdict, auto-balance, play guide, and all four outputs (page, sheet HTML, sheet PDF, JSON). |
| **Emulator** | Campaigns 1→20, seeded and reproducible. Per-feature ablation with bootstrap confidence intervals. "Plays most like" on measured behaviour. |
| **Build** | Roster, identity, class / level / multiclass, four ability methods, proficiencies. |
| **Play** | AC, HP, proficiency, initiative, passive Perception, all 13 conditions, damage / heal, short and long rest, resource pools, attacks, features, inventory. |
| **Combat** | Encounters, initiative order, adding your character, SRD monsters, or custom combatants. |
| **Shop** | Generates stock at SRD prices with per-shop variance. |
| **Roleplay** | Structured beats — promises, secrets, choices, people met — recorded through an in-app form. |
| **Chronicle** | Event log with export to Markdown, printable HTML and raw JSON, plus open-thread tracking. |
| **DM** | Seven tools: live encounter runner, party dashboard, treasure, improv generators, XP budgeter, bestiary, rules reference. All offline. |
| **Sandbox** | Throwaway in-memory session with an export path back out. |
| **Settings** | Storage mode, connector status, and local ambience. |

**Not finished — known and deliberate**

These are limitations, not bugs. Nothing here is hidden at runtime; the app
reports each one where it matters.

1. **No spell selection.** Slots, save DC, attack bonus and always-prepared
   spells all derive correctly, but there is no screen for choosing your
   prepared or known spells. The data model supports it; the UI doesn't yet.
   This is the biggest gap for playing a caster.
2. **Equipment is managed in Play, not Build.** A new character starts with
   nothing, so its AC is 10 until you add armour via Play → Inventory or buy
   some in Shop.
3. **Ability-score methods advise rather than enforce.** Standard array tells
   you the numbers but doesn't assign or validate them; point buy shows your
   spend and turns red over budget rather than blocking it.
4. **Reactions are never simulated.** The mapper understands them, and they are
   the second most common mechanic in the test corpus, but the simulator has no
   trigger model — so a reaction contributes nothing to any measured number.
   `app/sim/executable.js` lists exactly what does and doesn't execute, and the
   play guide says so per subclass.
5. **27% of the reference corpus measures as tied.** The simulator scores every
   feature action identically, because mapped text carries no structured
   payload — "push 15 feet" and "frighten the target" are the same event to it.
   Where this happens, "plays most like" says the subclasses can't be separated
   instead of inventing a resemblance. This is a ceiling of text-mapped
   simulation, not something a bug fix removes.
6. **Hit points can't be rolled in the UI.** Max HP is derived using the 2024
   fixed-value rule. `hp.override` in the character JSON wins if your table
   rolls, but there's no field for it yet.
7. **The bestiary starts empty.** It's search-driven — type a monster name.
   All 330 are there; none are listed until you ask.
8. **Custom monsters, items and spells parse; the classifier is the weak
   link.** The statblock parser round-trips all 330 bundled monsters exactly —
   AC, HP, CR, every ability score, every action. What is unreliable is
   deciding *which blocks of a PDF are statblocks*: on a subclass document it
   finds almost none, and what it does find needs your eye. Every parse
   reports its coverage and names what it could not read, and a block that is
   really a section heading is refused outright rather than parsed
   confidently from the first record inside it.
9. **PDF grouping is only as good as the document.** Where a PDF says "3rd
   level Toymaker feature", features are grouped under *Toymaker* and marked
   **named**. Where it just says "At 3rd level" — which is how Wizards' own
   Unearthed Arcana is written — grouping is inferred from level order and
   marked **guessed**. In the library you can tick several extracted groups
   and combine them into one subclass under a name you choose, because a guess
   you can correct beats a guess you can't. Text extraction also loses layout,
   so every result carries a coverage number. Saving the source page as HTML
   gives markedly better results than a PDF.

**Not planned:** anything that reads D&D Beyond, and any bulk crawl of a
homebrew site.

## Install

Needs Python 3.10+.

```bash
git clone https://github.com/WildNixon/Toon-Anvil.git
cd Toon-Anvil
pip install -r requirements.txt
python run.py
```

The rules data and fonts are committed, so there's nothing to download and
nothing to break when an upstream URL moves. If a dependency is missing,
`python run.py --check` tells you exactly which and what to do.

---

## Running a session

The **DM** screen is built to stay open at the table, and works with no network
at all.

| Tool | What it does |
|---|---|
| **Run a fight** | One initiative list with the party and the monsters together. HP, conditions, rounds and turns. Damage goes through the same engine as everything else, so **resistances are applied for you** — the thing a hand-run fight most often forgets. |
| **Party** | Every character's AC, passive Perception / Investigation / Insight, saves and senses on one screen. Derived, so it can never disagree with a player's own sheet. |
| **Treasure** | Hoards by CR band with coins, gems, art and magic items drawn from the 258 bundled. Seeded — write the seed down and you get the same hoard back. One click hands it to a character. |
| **Improvise** | An NPC with a want and a secret, a tavern, a rumour, a trap scaled to tier, and a random encounter by terrain. Also seeded, and the encounter can be sent straight into the fight. |

**Every generated result says where it came from.** Monsters, coin bands, gems
and magic items are SRD and marked `SRD`. Names, traits, rumours, art objects
and terrain weightings were written for this tool and are marked `authored` —
they are not official content, and a DM reading one aloud deserves to know
which they are quoting.

One honest limitation: the bestiary carries no environment data, so terrain is
an authored weighting over creature *type*, plus a hand-written exclusion list
(no crocodiles in the arctic). It lives in `app/data/dm-tables.json` as data
rather than code, so you can disagree with it and edit it.

## Optional connectors

Toon Anvil works completely offline and nothing below is required. If you want
them, **Settings** lists every connector, whether it is configured, and the
exact variable to set.

| | |
|---|---|
| **Writing** | Ollama (local, no key), Anthropic, or any OpenAI-compatible endpoint. Used for improvisation — NPC dialogue, room description — always as a draft you edit, never as a rules answer. |
| **Pictures** | A local Stable Diffusion endpoint. Hosted image APIs are deliberately *not* wired up: they are the easiest way to spend real money by accident, and this tool otherwise costs nothing to run. |
| **Sound** | Ambient beds synthesised in the browser (no key, no network, nothing to licence), Freesound search with attribution carried through, and ElevenLabs sound-effect generation. |

**The keys are yours.** No key ships with this project, and none can be typed
into the app — a field on a web page is the easiest place in the world to leak
a credential from. Put yours in an environment variable, or in `secrets.json`
in the project folder, which git excludes. **The browser never receives a key:**
the page asks the local server, and the server makes the call. That removes two
standard failure modes at once — a key sitting in `localStorage` where any
injected script can read it, and provider CORS refusing a browser-origin
request.

The cheapest thing to add is a local model: install Ollama, pull a model, and
the writing assistant works with no key and no cost.

## Playing together on one network

Profiles, a join code, permissions the **server** enforces, and screens that
update while you are looking at them.

```bash
python run.py --lan
```

That is the only command that makes Toon Anvil reachable by other machines —
without it nothing changes. It prints the address players type and the warning
below.

Open the DM screen, start a table, and read out the code (`ANVIL-K7WU`).
Players open the address, enter the code, and pick a name. Their browser keeps
a token; a reload does not ask again. Ending the table revokes every token at
once.

| | DM | Player |
|---|---|---|
| Their own character | edit | edit |
| Another player's character | edit | read |
| Homebrew, custom content, campaign | edit | read |
| The encounter | edit | read |

**The fight is shared.** When a table is open, the DM's encounter runner
publishes to the server after every change, and each player gets a **Table**
screen: the initiative order, the round, whose turn it is, and their own line
marked. It is the same renderer the DM uses, in read-only mode — two renderers
for one initiative order is how the two views end up disagreeing about whose
turn it is.

**Enemy hit points are hidden by default**, with a toggle for the DM. Players
see a band — unhurt, hurt, bloodied, down — which is roughly what you can tell
by looking. That hiding happens on the **server**: the number is not sent, not
merely not drawn. Hiding it in the UI would leave it in the payload for anyone
who opens the network tab. Player characters keep their numbers, because
everyone at a real table can see their own sheet.

Players get a nav without the DM screen or the homebrew analyser, and keep
Build and Play — a player owns their character fully. That is navigation, not
security: what stops a player changing the fight is the server refusing the
write.

**Everyone's screen keeps up.** When the DM applies damage, the player looking
at that sheet sees the number change — no reload, no refresh button. The server
keeps a revision counter and clients watch it over a held-open stream, with
polling underneath as the fallback that always works. What travels is only
*what* changed, never the record: each client re-reads from the server, so
there is one source of truth and no chance of two screens disagreeing.

Your own edits never bounce back at you — every write is tagged with the tab
that made it, so typing in Build cannot re-render Build under your cursor.

**Solo play is untouched.** With no table open nothing asks who you are — the
permission checks only run once a table exists — and with no shared server the
live watcher never starts, because nothing else can change your data.

**What a join code is and is not.** It stops somebody on the same wifi
wandering into your game by accident. It is **not authentication**: nothing is
encrypted, and anyone determined who is already on your network can get past
it. Use this on a network you trust — your home, not cafe or hotel wifi. The
app says the same thing where you turn it on rather than burying it here.

Enforcement is server-side without exception, because a player's browser can
ask for anything and a hidden button proves nothing.

## Try things without saving them

Press **Try a sandbox** in the top bar. The whole app runs against an in-memory
store: characters, homebrew, NPCs and the event log live for exactly as long as
the tab does, and your real library is untouched.

Useful for taking a subclass apart, rolling a dozen characters to compare, or
handing the app to somebody at the table without any of it reaching your saved
work.

A bar along the bottom says plainly that nothing is being saved and counts what
you've made. If you decide you want to keep something:

- **Save to my library** copies it straight into your real saved data. It asks
  first and tells you exactly what's about to land. Nothing already there is
  ever replaced — anything whose id happens to clash is saved as a separate
  copy, so a sandbox can add to your library but never damage it.
- **Download** writes the same thing to a JSON file instead, which is how you
  move work to another machine. Build's *Import JSON* reads it back.

So a sandbox is somewhere you can change your mind, not only somewhere you lose
things. Leaving with unsaved work asks first, and so does closing the tab.

You can also go straight there with `?storage=memory`.

## Where files go

```
toon-anvil/
  inbox/          <- YOU PUT FILES HERE. Nothing else writes to it.
  library/
    extracted/    <- what came out of your PDFs, one folder per document
    corpus/       <- optional Open5e reference set
  examples/       <- one subclass to try, shipped with the repo
```

**Just drop the file in `inbox/`** and reload the app. That's the whole flow.

A PDF is split on drop — the app notices a file it hasn't seen (by content
hash), extracts it, and files the results under
`library/extracted/<document name>/`. It won't re-split a file it has already
done. If you want to run it by hand:

```bash
python tools/split_pdf.py
```

Nothing is deleted, moved or edited in `inbox/`. Your originals stay yours.

### What formats work, and how well

| Format | Fidelity | Notes |
|---|---|---|
| JSON (our schema) | high | round-trips exactly |
| Markdown / Homebrewery | high | `### Feature Name` + level phrasing |
| HTML | high | headings and panels are both understood |
| PDF | medium | layout-aware, two-column aware; check the coverage number |
| Plain text | low | works, but expect to fix mappings by hand |

Both level phrasings are handled — `Level 3:` (2024) and `At 3rd level` (2014).

---

## Try it in 30 seconds

```bash
python run.py
```

Open **Homebrew**, drop in `examples/storm-herald-fighter.html`, press
**Analyse**. It's deliberately a little overtuned, so you'll see the balance
verdict actually object to something, propose a change, and show you the
measurement behind it.

---

## What it won't do

**No D&D Beyond.** Nothing here reads, scrapes, or reproduces D&D Beyond
content, and it never will.

**No bulk-crawling homebrew sites.** dandwiki's `robots.txt` disallows automated
agents. If you want a page from there, export it yourself and drop it in
`inbox/` — that path is supported and works.

**It is not a rules referee.** It's a measuring instrument. It will tell you a
feature is worth +4.5 damage per action with a confidence interval; it will not
tell you whether your table will enjoy it. Where a number is uncertain, it says
so instead of rounding the doubt away.

**It won't hide low coverage.** If it only mapped 30% of your subclass, the
verdict says 30%, and you should treat the balance number accordingly.

---

## Licences

**Code: MIT.** See [LICENSE](LICENSE). Do what you like with it.

**Rules content: SRD 5.2.1**, used under
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Attribution is in
[ATTRIBUTION.md](ATTRIBUTION.md) and in the app's credits. Toon Anvil is not
affiliated with or endorsed by Wizards of the Coast.

**Fonts:** Archivo Black and IBM Plex, both SIL Open Font License.

**Your homebrew stays yours.** It's never uploaded anywhere, and `data/` — your
characters, your event log, your subclasses — is gitignored so it can't
accidentally end up in a commit.

**Anything you emit from someone else's content carries that content's licence,
not this one.** The output page embeds source text. If you analysed a PDF you
don't have the rights to redistribute, the page it produces isn't yours to
publish either.

---

## Rebuilding the data

The committed compendium is built from the SRD by scripts that stay in the repo:

```bash
python tools/fetch_srd.py      # download SRD 5.2.1
python tools/srd_convert.py    # parse it into app/data/compendium
python tools/fetch_fonts.py    # fonts, OFL
python tools/fetch_open5e.py   # optional reference corpus
```

You should never need these. They exist so that when the SRD updates, the path
forward is documented rather than archaeological.

---

## Development

No build step, no npm. Vanilla ES modules and a Python stdlib server.

```bash
python run.py --check       # health check only
python run.py --no-browser  # serve without opening a window
python tools/grade.py       # grade a sweep
python tools/charts.py      # render the report
```

Two harnesses run in the browser once the server is up:

| Page | Asks |
|---|---|
| `/sim/sim.html` | **Is this subclass balanced?** Campaigns, ablation, auto-tune. |
| `/sim/gym.html` | **Does the app work?** Graded integration tests across 11 suites. |

### The application gym

Press **Run the gym**. It exercises the real modules against a memory-backed
store with a seeded RNG, then grades the result against bars written down
*before* the run — currently 38 scenarios and 784 assertions across derivation,
storage, the play loop, dice, combat, encounters, spells, the chronicle, the
homebrew pipeline, cross-engine agreement, and integration journeys that span
several features at once.

Two rules keep it honest:

- **A scenario that asserts nothing is a failure, not a pass.** That is the
  oldest way a test suite reports green while testing nothing.
- **The coverage bar rises when the suite grows.** A fixed bar goes green
  forever while the ratio of tested to shipped quietly falls.

**Include UI tier** drives the real app the way a person does — 11 journeys and
65 assertions that click, type, and then check what the *screen* says. It
builds a character, levels it, damages it, rests it off, toggles conditions,
generates a shop and buys something, runs an encounter through initiative,
records a roleplay beat and finds it in the chronicle, exports for a DM,
searches the bestiary, and ingests the shipped example end to end.

It runs against `/?storage=memory` — an ephemeral boot where both the character
store and the event log live in memory and vanish on reload, so driving the app
can't create junk characters or append to a real chronicle. That flag is
available to you as well if you ever want a throwaway session; a banner makes
it obvious that nothing is being saved.

Timing is handled by waiting for a *condition*, never by sleeping a guessed
number of milliseconds — fixed sleeps are how a suite becomes flaky, a flaky
suite gets ignored, and an ignored suite is worse than none.

**Publish result** appends to a local history so the pass rate can be graphed
across runs.

**Mutation check** answers the question a green suite cannot answer about
itself: *would it notice if something broke?* It injects five known defects —
resistance that stops halving, hit points allowed to go negative, resource
pools that never refuse, roll tables that pick an index instead of rolling the
die, encounters that ignore the monster cap — and confirms the board goes red
for each. Currently 5/5 detected. A mutation that survives is a blind spot, and
the response is to write the missing assertion, not to enjoy the green.

The roll-table mutation is not hypothetical: it is a bug this project actually
shipped once, where a d20 table with 8 entries gave its last row 12% of the
time instead of 65%.
