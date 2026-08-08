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

**Ingest.** Drop a subclass into `inbox/` — PDF, Markdown, HTML, JSON, or plain
text. PDFs are split automatically into subclasses, spells, items and feats, one
folder per document. The parser classifies blocks by what they *say*, not by
where they sit in the file, so it survives homebrew that doesn't follow a
template.

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

The emulator lives at `/sim/sim.html` when the server is running.
