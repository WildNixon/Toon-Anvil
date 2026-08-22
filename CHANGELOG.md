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

## [2.2.0] - 2026-08-21

The DM's voice changer, saved per NPC and monster.

### Added
- **A voice changer for the DM.** A hold-to-speak button on the Stage runs
  the microphone through an original pitch/character engine (an AudioWorklet
  written for the app) out of the DM's own speakers - eight presets from
  Ogre to Ghost, a live pitch slider, and a double-tap latch for a
  monologue. Save a voice to a monster or an NPC and it comes back with the
  turn. It runs entirely on the DM's machine, sends nothing anywhere, and a
  device without a microphone (a player's phone) is told so in words.
- The offline shell now precaches the runtime modules it had grown to need,
  so a reload with no network keeps every screen.

## [2.1.0] - 2026-08-21

The gamified table: sound, moments, ceremony, deeds.

### Added
- **Sound, off until you ask.** A vendored pack of seventeen short CC0
  recordings (Kenney.nl) for the moments of play, one audio core that owns
  the context and the unlock, and a speaker in the ribbon, in Settings and
  on the Stage. Off by default, one tap on, remembered per device; a framed
  copy of the app is silent by construction.
- **Roll and vitals juice.** The dice tumble on the roll card, a crit flares
  twice, a hit washes the ribbon red and a heal green, the bar slides,
  bloodied and down are states the ribbon keeps, a death-save pip grows in,
  and zero hit points is a moment in its own layer.
- **Table-wide cues.** The session beginning reaches every seat, your turn
  pings and pulses (and names the tab), a round turning is a beat, the table
  closing has a tone, and somebody else's natural twenty echoes on the rail.
- **The fight's ceremony.** The runner marks the active row with a sweep,
  flashes a combatant crossing into bloodied and alarms one going down,
  warms the chrome while a fight runs, ticks and strikes the Deck's clocks,
  and offers the bed that fits today's sky.
- **Progression and deeds.** Level-up features rise one by one with a
  fanfare, a long rest is a chapter break, and the Chronicle lists deeds
  earned only from the record - dated in words, never teased.
- **Versions.** VERSION at the root, mirrored into the app, the server and
  the service-worker cache name, with run.py --check and the gym refusing
  drift.


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

[Unreleased]: https://github.com/WildNixon/Toon-Anvil/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/WildNixon/Toon-Anvil/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/WildNixon/Toon-Anvil/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/WildNixon/Toon-Anvil/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/WildNixon/Toon-Anvil/releases/tag/v1.0.0
