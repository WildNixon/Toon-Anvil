# Changelog

All notable changes to Toon Anvil are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) from 2.0.0 on.

`VERSION` at the repo root is the truth. `app/version.js`, the service-worker
cache name in `app/sw.js`, and the top released entry here mirror it, and both
`python run.py --check` and the gym's `release` suite fail when any of them
disagree. Work lands under **Unreleased**. When an epic ends, the minor is
bumped, the entry is dated, the mirrors move in one commit, and it is tagged
`vX.Y.Z`. A patch bump is a fix shipped between epics; a major is a new app on
the old one, which is what 2.0 was. Commits before `v2.0.0` carry no version
and are left as they are.

## [Unreleased]

## [2.0.0] - 2026-08-21

The table half. Toon Anvil 1.0 measured homebrew; 2.0 also hosts the game.

- **Play together on one network:** a Lobby that leads with the campaign
  (resume one, begin from a book on the shelf, drop a PDF and it files
  itself), a join code with a QR square, seat colours, and a queue every
  phone can see. The server decides who may see and change what.
- **The sheet is the table:** roll cards with the dice faces, a shared dice
  feed, death saves, an act bar with End turn, and a live fight beside the
  character. The hero ribbon follows you.
- **The DM's cockpit:** Stage, Deck, World, Story, Setup - a live encounter
  runner with a party board, clocks, weather, regions, factions, map pins,
  prepared encounters, quick parties forged from the SRD.
- **Books on a shelf:** drop a PDF; it is detected, filed and split into
  monsters, spells, items, feats and prose sections ready to found a campaign.
- **Connectors with a price list:** every optional capability says what it
  adds, what already works free, and roughly what one use costs - before a
  key goes anywhere. Your own writing only ever goes to a local model.
- **A nameplate on every screen**, a phone pass at 390px, and a launcher that
  opens and closes the app as one act.
- **The gym grew from 38 scenarios to 137**, plus an overnight harness that
  measures what each seat can reach as a campaign ages.

## [1.0.0] - 2026-08-08

The workshop: ingest, map, simulate, grade, balance, emit. See the `v1.0.0`
tag and the README's status tables, which are the 1.0 release notes.

[Unreleased]: https://github.com/WildNixon/Toon-Anvil/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/WildNixon/Toon-Anvil/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/WildNixon/Toon-Anvil/releases/tag/v1.0.0
