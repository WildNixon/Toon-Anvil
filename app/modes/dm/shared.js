/**
 * Shared spine of the DM shell.
 *
 * The five DM modes (Stage, Deck, World, Story, Setup) are top-level modes
 * now - the DM's whole app, not tabs inside one. What they still share lives
 * here: the compendium data loaded once, the sources() bundle for derive(),
 * and the ctx factory the old lens system passed around - kept with the same
 * field names so the lens modules themselves did not change when the shell
 * split.
 */

import { getState } from '../../core/store.js';
import { compendium, compendiumWithCustom, dataFile } from '../../core/db.js';
import { go } from '../../app.js';

let monsters = [];
let glossary = [];
let magicItems = [];
let tables = null;

/** Load the DM's reference data once per session. */
export async function dmData() {
  if (!monsters.length) {
    // Custom content is appended, so a DM's own monsters show up in the
    // bestiary, the encounter runner and the random tables alongside the SRD.
    [monsters, glossary, magicItems] = await Promise.all([
      compendiumWithCustom('monsters'), compendium('glossary'),
      compendiumWithCustom('magic-items'),
    ]);
  }
  if (!tables) tables = await dataFile('dm-tables.json', null);
  return { monsters, glossary, magicItems, tables };
}

/** Sources for derive(), assembled the same way the shell does it. */
export function sources() {
  const { compendium: c, homebrew } = getState();
  return {
    classes: c.classes || [], species: c.species || [],
    backgrounds: c.backgrounds || [], feats: c.feats || [],
    srdEffects: c.srdEffects || {}, equipment: c.equipment,
    homebrew: homebrew || [],
  };
}

/**
 * The context the lens modules were written against. `goToLens` now hops
 * top-level modes, so its three existing call sites work unchanged.
 */
export function makeCtx({ redraw }) {
  return {
    monsters, glossary, magicItems, tables,
    sources,
    redraw,
    goToLens: (id) => go(`dm-${id}`),
  };
}
