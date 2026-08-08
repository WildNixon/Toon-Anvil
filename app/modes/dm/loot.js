/**
 * Treasure.
 *
 * Pure functions over the bundled tables and the 258 magic items already in
 * the compendium - no network, no invention. Rolling is seeded so a hoard can
 * be reproduced: a DM who rolls something they like before the session can
 * write down the seed and get it back at the table.
 *
 * Everything returned says where it came from. Coin bands and gem values
 * follow the SRD; art objects and flavour are authored for this tool, and the
 * UI labels them differently. A generator that presents its own inventions as
 * official is the kind of thing that gets repeated at a table as fact.
 */

import { seededRng } from '../../core/rng.js';
import { roll } from '../../core/dice.js';

/** Coin totals are written as dice expressions with a multiplier: "6d6*100". */
export function rollCoinExpr(expr, rng) {
  const [dice, mult] = String(expr).split('*');
  const n = roll(dice.trim(), { rng }).total;
  return Math.max(0, n * (mult ? Number(mult) : 1));
}

export function bandFor(tables, cr) {
  const bands = tables.treasure.bands;
  return bands.find((b) => cr >= b.minCr && cr <= b.maxCr) || bands[bands.length - 1];
}

/**
 * Roll a hoard.
 *
 * `cr` is the challenge rating of the encounter the hoard belongs to, not of
 * any single monster - a pack of CR 1/4 kobolds guarding a dragon's floor is
 * still the dragon's floor.
 */
export function rollHoard({ tables, magicItems, cr = 5, seed = 1, individual = false }) {
  const rng = seededRng(seed, `hoard:${cr}`);
  const band = bandFor(tables, cr);

  const coins = [];
  for (const [unit, expr] of Object.entries(band.coins)) {
    let amount = rollCoinExpr(expr, rng);
    // An individual creature carries roughly a twentieth of a hoard. Rounding
    // up keeps a lone goblin from being worth literally nothing.
    if (individual) amount = Math.max(1, Math.round(amount / 20));
    if (amount > 0) coins.push({ unit, amount });
  }

  const valuables = [];
  if (!individual) {
    // Gems and art are the bulk of a hoard's value in the SRD's own bands, so
    // a hoard that is only coins and a wand reads as oddly thin.
    //
    // Both a FLOOR and a ceiling. Filtering only by "no more than" let a
    // 317,000gp dragon hoard contain a 25gp set of bone dice - technically
    // legal, and instantly wrong to anyone reading it out. The floor rises
    // with the band so the small stuff drops away as the stakes climb.
    const ceiling = Math.max(100, cr * 700);
    const floor = cr >= 17 ? 750 : cr >= 11 ? 100 : cr >= 5 ? 25 : 0;
    const inBand = (list) => {
      const hit = list.filter((x) => x.gp >= floor && x.gp <= ceiling);
      // Never return empty just because a band is narrow - fall back to the
      // cheapest thing above the floor, or the single most valuable below it.
      return hit.length ? hit : list.filter((x) => x.gp <= ceiling).slice(-1);
    };

    const gemCount = Math.max(0, roll('1d4-1', { rng }).total);
    for (let i = 0; i < gemCount; i += 1) {
      const g = rng.pick(inBand(tables.treasure.gems.entries));
      if (g) valuables.push({ ...g, kind: 'gem', source: 'srd' });
    }

    // Art objects are individual pieces, so two of the same one in a single
    // hoard reads as a bug. Gems are not - a pouch of four garnets is fine -
    // so only art is drawn without replacement.
    const artCount = cr >= 5 ? Math.max(0, roll('1d3-1', { rng }).total) : 0;
    const artTaken = new Set();
    for (let i = 0; i < artCount; i += 1) {
      const pool = inBand(tables.treasure.art.entries)
        .filter((x) => !artTaken.has(x.name));
      if (!pool.length) break;
      const a = rng.pick(pool);
      artTaken.add(a.name);
      valuables.push({ ...a, kind: 'art', source: 'authored' });
    }
  }

  const items = [];
  if (!individual) {
    const want = Math.max(0, roll(band.magicItems.count, { rng }).total);
    const pool = magicItems.filter(
      (m) => band.magicItems.rarities.includes(m.rarity),
    );
    // Draw without replacement: a hoard of three identical wands is a bug
    // report waiting to happen.
    const taken = new Set();
    for (let i = 0; i < want && taken.size < pool.length; i += 1) {
      let pick = rng.pick(pool);
      let guard = 0;
      while (pick && taken.has(pick.id) && guard < 40) { pick = rng.pick(pool); guard += 1; }
      if (pick && !taken.has(pick.id)) {
        taken.add(pick.id);
        items.push({
          id: pick.id, name: pick.name, rarity: pick.rarity,
          kind: pick.kind, attunement: pick.attunement, source: 'srd',
        });
      }
    }
  }

  return {
    cr, seed, band: band.id, individual,
    coins, valuables, items,
    totalGp: totalGp(coins, valuables),
  };
}

const RATE = { cp: 0.01, sp: 0.1, ep: 0.5, gp: 1, pp: 10 };

export function totalGp(coins, valuables = []) {
  const c = coins.reduce((n, x) => n + x.amount * (RATE[x.unit] || 0), 0);
  const v = valuables.reduce((n, x) => n + (x.gp || 0), 0);
  return Math.round((c + v) * 100) / 100;
}

/** Fold a hoard into a character's currency and inventory. */
export function applyToCharacter(character, hoard) {
  const currency = { ...(character.currency || {}) };
  for (const c of hoard.coins) currency[c.unit] = (currency[c.unit] || 0) + c.amount;

  const inventory = [...(character.inventory || [])];
  for (const item of hoard.items) {
    inventory.push({
      id: item.id, name: item.name, qty: 1, equipped: false,
      magical: true, rarity: item.rarity, attunement: item.attunement,
    });
  }
  for (const v of hoard.valuables) {
    inventory.push({
      id: `${v.kind}-${v.name.replace(/\W+/g, '-')}`, name: v.name,
      qty: 1, equipped: false, valueGp: v.gp, kind: v.kind,
    });
  }
  return { ...character, currency, inventory };
}
