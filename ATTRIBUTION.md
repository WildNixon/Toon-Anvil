# Attribution & licensing

**[LICENSE](LICENSE) (MIT) covers the Toon Anvil SOURCE CODE only.** The game
content and typefaces bundled with it are separately licensed, and this file is
the authoritative statement of what is covered by what:

| What | Where | Licence |
|---|---|---|
| Source code | everything except the rows below | MIT |
| Rules content | `app/data/compendium/` | CC-BY-4.0 (SRD 5.2.1) |
| Typefaces | `app/data/fonts/` | SIL Open Font License 1.1 |
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
