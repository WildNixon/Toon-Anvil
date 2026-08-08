/**
 * Improvisation, for the moment a player asks something you had not planned.
 *
 * Every generator is seeded, so a result you like can be written down and
 * recovered, and every result carries its `source`:
 *
 *   srd       drawn from bundled SRD data (monsters, spells, items)
 *   authored  written for this tool - names, traits, rumours, terrain weights
 *
 * That distinction is not pedantry. A DM repeating one of these at a table is
 * entitled to know whether they are quoting the rules or quoting me.
 */

import { seededRng } from '../../core/rng.js';
import { roll } from '../../core/dice.js';

/**
 * A named, reproducible stream.
 *
 * seededRng(seed, label) does NOT mix the label into the stream - the label is
 * only there for debugging. Passing a different label with the same seed
 * therefore gives the IDENTICAL sequence, which is how every terrain came back
 * with the same encounter distance and the same "wants to talk first". stream()
 * hashes seed and name together, which is what was wanted all along.
 */
const streamFor = (seed, name) => seededRng(seed).stream(name);

/* ------------------------------------------------------------------ */
/* people and places                                                   */
/* ------------------------------------------------------------------ */

export function npc(tables, seed = 1) {
  const rng = streamFor(seed, 'npc');
  const t = tables.npc;
  return {
    kind: 'npc',
    source: 'authored',
    seed,
    name: `${rng.pick(t.given)} ${rng.pick(t.family)}`,
    trait: rng.pick(t.trait),
    want: rng.pick(t.want),
    secret: rng.pick(t.secret),
  };
}

export function tavern(tables, seed = 1) {
  const rng = streamFor(seed, 'tavern');
  const t = tables.tavern;
  return {
    kind: 'tavern',
    source: 'authored',
    seed,
    name: `${rng.pick(t.first)} ${rng.pick(t.second)}`,
    detail: rng.pick(t.detail),
    keeper: npc(tables, `${seed}-keeper`).name,
  };
}

export function rumour(tables, seed = 1) {
  const rng = streamFor(seed, 'rumour');
  const text = rng.pick(tables.rumour.entries);
  // Half of what a town believes is wrong, and a DM needs to decide which
  // half. Saying so up front is more useful than a bare line of gossip.
  return {
    kind: 'rumour', source: 'authored', seed, text,
    true: rng.float() < 0.5,
  };
}

/* ------------------------------------------------------------------ */
/* traps                                                               */
/* ------------------------------------------------------------------ */

/** Save DC and damage scale by tier, which is what makes a trap reusable. */
const TIERS = [
  { max: 4, dc: 12, damage: '2d10', label: 'tier 1' },
  { max: 10, dc: 14, damage: '4d10', label: 'tier 2' },
  { max: 16, dc: 16, damage: '10d10', label: 'tier 3' },
  { max: 20, dc: 18, damage: '18d10', label: 'tier 4' },
];

export function trap(tables, { seed = 1, level = 5 } = {}) {
  const rng = streamFor(seed, 'trap');
  const t = rng.pick(tables.trap.entries);
  const tier = TIERS.find((x) => level <= x.max) || TIERS[TIERS.length - 1];
  return {
    kind: 'trap',
    source: 'authored',
    seed,
    name: t.name,
    trigger: t.trigger,
    effect: t.effect,
    save: t.save,
    dc: tier.dc,
    damage: t.damage ? `${tier.damage} ${t.damage}` : null,
    tier: tier.label,
  };
}

/* ------------------------------------------------------------------ */
/* random encounters                                                   */
/* ------------------------------------------------------------------ */

export const TERRAINS = ['forest', 'mountain', 'swamp', 'coast', 'underdark',
  'urban', 'desert', 'arctic', 'grave', 'planar'];

/**
 * A random encounter for a terrain and party level.
 *
 * The compendium has no environment field, so terrain is applied as a weighting
 * over creature TYPE from an authored table. This is the honest ceiling of the
 * bundled data: a beast in a forest is a good guess, not a citation, and the
 * result says `terrainSource: 'authored'` so the UI can say so too.
 */
export function encounter(tables, monsters, { seed = 1, terrain = 'forest', level = 3 } = {}) {
  const rng = streamFor(seed, `enc:${terrain}`);
  const weights = tables.terrain[terrain] || {};

  // Keep the CR sane for the party: roughly level/4 up to level.
  const maxCr = Math.max(1, level);
  const minCr = level <= 2 ? 0 : Math.max(0, Math.floor(level / 4));
  // Type weighting alone is not enough: "beast" is plausible in the arctic and
  // a giant crocodile is not. An authored per-terrain exclusion list on name
  // fragments is crude, but it is the difference between a tool a DM trusts
  // and one they stop using after the first absurd result.
  const excluded = (tables.terrain._exclude?.[terrain] || [])
    .map((s) => s.toLowerCase());
  const banned = (name) => excluded.some((frag) => name.toLowerCase().includes(frag));

  const candidates = monsters.filter((m) => {
    const cr = Number(m.cr);
    if (!Number.isFinite(cr) || cr < minCr || cr > maxCr) return false;
    if (!(weights[m.type] || 0)) return false;
    return !banned(m.name || '');
  });

  if (!candidates.length) {
    return {
      kind: 'encounter', source: 'srd', terrainSource: 'authored', seed, terrain, level,
      monsters: [],
      note: `Nothing in the bestiary matches ${terrain} between CR ${minCr} and `
        + `${maxCr}. Widen the level, or add creature types to the terrain table.`,
    };
  }

  // Weighted draw by type.
  const pool = [];
  for (const m of candidates) {
    for (let i = 0; i < (weights[m.type] || 0); i += 1) pool.push(m);
  }
  const chosen = rng.pick(pool);
  const cr = Number(chosen.cr) || 1;
  // More of the weak things, fewer of the strong ones.
  const count = cr >= level ? 1
    : Math.max(1, Math.min(8, Math.round((level / Math.max(0.25, cr)) * 0.6)));

  return {
    kind: 'encounter',
    source: 'srd',
    terrainSource: 'authored',
    seed, terrain, level,
    monsters: [{ id: chosen.id, name: chosen.name, cr: chosen.cr,
      type: chosen.type, count }],
    distance: `${roll('2d6', { rng }).total * 10} feet`,
    doing: rng.pick([
      'has not noticed you yet', 'is already hurt and wary',
      'is eating', 'is being hunted by something else',
      'wants to talk first', 'is guarding something it will not leave',
      'is lost and frightened', 'is waiting for you specifically',
    ]),
  };
}

/* ------------------------------------------------------------------ */

/** Every generator behind one call, for the UI's "roll everything" button. */
export function rollAll(tables, monsters, { seed = 1, level = 3, terrain = 'forest' } = {}) {
  // One seed for the whole set: each generator draws from its own named
  // stream, so they no longer need to be nudged apart by hand.
  return {
    npc: npc(tables, seed),
    tavern: tavern(tables, seed),
    rumour: rumour(tables, seed),
    trap: trap(tables, { seed, level }),
    encounter: encounter(tables, monsters, { seed, terrain, level }),
  };
}
