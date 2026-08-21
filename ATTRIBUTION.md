# Attribution & licensing

**[LICENSE](LICENSE) (MIT) covers the Toon Anvil SOURCE CODE only.** The game
content and typefaces bundled with it are separately licensed, and this file is
the authoritative statement of what is covered by what:

| What | Where | Licence |
|---|---|---|
| Source code | everything except the rows below | MIT |
| Rules content | `app/data/compendium/` | CC-BY-4.0 (SRD 5.2.1) |
| Typefaces | `app/data/fonts/` | SIL Open Font License 1.1 |
| QR encoder | `app/ui/vendor/qrcodegen.js` | MIT (Project Nayuki) |
| Sound effects | `app/assets/sfx/` | CC0-1.0 (Kenney.nl) - see "Sound effects" |
| Comparison index | `library/_vectors.json` | measurements only — see below |

Homebrew you create or import remains yours. Toon Anvil stores it locally and
transmits it nowhere.

*Dungeons & Dragons* and *D&D* are trademarks of Wizards of the Coast LLC. Toon
Anvil is unaffiliated with and unendorsed by Wizards of the Coast.

## SRD 5.2.1 content

Toon Anvil bundles rules content from the **System Reference Document 5.2.1**.

> This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1")
> by Wizards of the Coast LLC, available at <https://www.dndbeyond.com/srd>.
> The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0
> International License, available at
> <https://creativecommons.org/licenses/by/4.0/legalcode>.

This notice is required by CC-BY-4.0 and is also shown in-app under **Credits**.

The markdown corpus was retrieved from
<https://github.com/downfallx/dnd-5e-srd-markdown> (a verbatim CC-BY
republication of the SRD in markdown) and converted to JSON by
`tools/srd_convert.py`. The conversion is mechanical: no rules text was
rewritten, and no content outside the SRD was added.

### What is bundled

| Category | Count |
|---|---|
| Spells | 339 (27 cantrips + 312 levelled) |
| Monsters | 330 |
| Classes | 12 (each with its 1 SRD subclass) |
| Magic items | 258 |
| Adventuring gear | 80 |
| Weapons / armor | 38 / 13 |
| Weapon mastery properties | 8 |
| Feats | 17 |
| Species | 9 |
| Backgrounds | 4 |
| Conditions | 15 |
| Glossary entries | 155 |

Spell coverage is cross-checked against the raw markdown at build time
(339 parsed / 339 present in source). Build-time validation output lives in
`app/data/compendium/_meta.json`.

### Hand-patched entries

Three monster stat blocks — **Ancient Red Dragon**, **Remorhaz**, and
**Will-o'-Wisp** — have corrupt HTML tables in the upstream markdown (misaligned
cell boundaries such as `<td>+10 +10</td>` and `<td>CON 29</td>`). Their ability
scores were read from the raw table text and are stored in
`tools/monster_overrides.json`. The converter re-derives `mod` from `score` for
every override and fails the build on any inconsistency. Patched monsters are
flagged with `"abilitiesPatched": true` in `monsters.json` and listed in
`_meta.json`.

## What is deliberately NOT included

- No content from D&D Beyond, and nothing scraped from it.
- No non-SRD published material (no non-SRD subclasses, spells, monsters,
  settings, or adventures).
- No Wizards of the Coast trademarks in Toon Anvil's branding. *Dungeons &
  Dragons*, *D&D*, and related marks are property of Wizards of the Coast LLC.
  Toon Anvil is unaffiliated with and unendorsed by Wizards of the Coast.

## The comparison index (`library/_vectors.json`)

"Plays most like" positions your subclass against 94 measured open-licensed
subclasses. The file that ships with this repo holds, for each one: its name,
its class, the document it came from, and four numbers this tool measured by
simulating it. **It contains no rules text, no descriptions and no mechanics** —
it is an index of measurements, not a copy of the works measured.

Those works come from [Open5e](https://open5e.com) under the terms at
<http://open5e.com/legal>, and are:

| Source | Subclasses |
|---|---|
| *Tome of Heroes* — Kobold Press | 76 |
| Open5e Original Content | 15 |
| 5e Core Rules (SRD) | 12 |
| *Critical Role: Tal'Dorei Campaign Setting* | 4 |

The corpus text itself is **not** redistributed here. `tools/fetch_open5e.py`
downloads it if you want to rebuild the index yourself.

## Your homebrew

Content you author or import stays yours. Toon Anvil stores it locally and never
transmits it anywhere. Exported homebrew carries no Toon Anvil licence terms.

## Typefaces

Cinzel (Natanael Gama), Alegreya (Juan Pablo del Peral / Huerta Tipográfica)
and IBM Plex Mono (IBM) are bundled locally as woff2 under the
**SIL Open Font License 1.1**. They are self-hosted rather than loaded from a
CDN so the app works fully offline.

## Vendored code

`app/ui/vendor/qrcodegen.js` is the **QR Code generator library** by Project
Nayuki (<https://www.nayuki.io/page/qr-code-generator-library>), MIT licensed,
vendored verbatim (compiled build) with its licence header intact plus a
marked ES-module export shim at the end. It renders the join-a-table QR code
on the DM's Setup screen. Vendored rather than fetched so the app stays fully
offline.

## Sound effects

The short sounds the app plays at moments - a die landing, a crit, a clock
striking - are recordings from **Kenney Vleugels (Kenney.nl)**, released under
**Creative Commons Zero (CC0-1.0)**: <https://creativecommons.org/publicdomain/zero/1.0/>.
Credit is not required by that licence; it is given here because it is true.
The packs drawn from are [Casino Audio](https://kenney.nl/assets/casino-audio),
[Impact Sounds](https://kenney.nl/assets/impact-sounds),
[Interface Sounds](https://kenney.nl/assets/interface-sounds),
[Music Jingles](https://kenney.nl/assets/music-jingles) and
[RPG Audio](https://kenney.nl/assets/rpg-audio).

Vendored rather than fetched so the app stays fully offline. Each clip was
trimmed, had its leading silence removed, was loudness-normalised to -16 LUFS,
given a 60 ms fade, and encoded as mono 44.1 kHz MP3 at 64 kbps by
`tools/fetch_sfx.py`; `app/assets/sfx/manifest.json` carries the same list,
and the gym refuses a sting whose file is not in it. 17 files,
110,854 bytes together.

| File | From | Length | Size |
|---|---|---|---|
| `dice.mp3` | casino-audio / `dice-throw-1.ogg` | 0.60s | 5,267 B |
| `crit.mp3` | impact-sounds / `impactBell_heavy_000.ogg` | 1.48s | 12,372 B |
| `fumble.mp3` | impact-sounds / `impactSoft_heavy_001.ogg` | 0.57s | 5,058 B |
| `hit.mp3` | impact-sounds / `impactPunch_heavy_001.ogg` | 0.54s | 4,849 B |
| `heal.mp3` | interface-sounds / `confirmation_004.ogg` | 0.49s | 4,431 B |
| `downed.mp3` | impact-sounds / `impactPlate_heavy_002.ogg` | 0.49s | 4,431 B |
| `death-tick.mp3` | impact-sounds / `impactSoft_heavy_000.ogg` | 0.53s | 4,849 B |
| `revive.mp3` | music-jingles / `jingles_PIZZI12.ogg` | 0.98s | 8,402 B |
| `your-turn.mp3` | interface-sounds / `question_001.ogg` | 0.49s | 4,431 B |
| `round.mp3` | rpg-audio / `metalPot1.ogg` | 1.38s | 11,536 B |
| `session-start.mp3` | music-jingles / `jingles_PIZZI03.ogg` | 1.14s | 9,656 B |
| `table-closed.mp3` | interface-sounds / `minimize_004.ogg` | 0.42s | 3,804 B |
| `level-up.mp3` | music-jingles / `jingles_PIZZI07.ogg` | 1.32s | 11,118 B |
| `clock-tick.mp3` | rpg-audio / `metalLatch.ogg` | 0.25s | 2,550 B |
| `clock-strike.mp3` | impact-sounds / `impactBell_heavy_002.ogg` | 0.70s | 6,103 B |
| `spell-cast.mp3` | interface-sounds / `glass_004.ogg` | 0.69s | 6,103 B |
| `rest-long.mp3` | rpg-audio / `doorClose_1.ogg` | 0.67s | 5,894 B |
