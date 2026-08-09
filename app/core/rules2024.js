/**
 * D&D 2024 rules constants and small pure helpers.
 *
 * Rules TEXT lives in the SRD compendium; this file holds the tables the app
 * has to compute with - progression, slots, XP budgets, skill mappings.
 */

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

export const ABILITY_NAMES = {
  str: 'Strength', dex: 'Dexterity', con: 'Constitution',
  int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma',
};

export const SKILLS = {
  acrobatics: 'dex', 'animal handling': 'wis', arcana: 'int', athletics: 'str',
  deception: 'cha', history: 'int', insight: 'wis', intimidation: 'cha',
  investigation: 'int', medicine: 'wis', nature: 'int', perception: 'wis',
  performance: 'cha', persuasion: 'cha', religion: 'int',
  'sleight of hand': 'dex', stealth: 'dex', survival: 'wis',
};

export const DAMAGE_TYPES = [
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
  'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder',
];

/** The eight 2024 weapon mastery properties. */
export const MASTERIES = ['Cleave', 'Graze', 'Nick', 'Push', 'Sap', 'Slow', 'Topple', 'Vex'];

export const CONDITIONS = [
  'Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened', 'Grappled',
  'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified', 'Poisoned', 'Prone',
  'Restrained', 'Stunned', 'Unconscious',
];

export const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];

/* ------------------------------------------------------------------ */
/* progression                                                         */
/* ------------------------------------------------------------------ */

export function abilityMod(score) {
  return Math.floor((Number(score) - 10) / 2);
}

export function proficiencyBonus(level) {
  return 2 + Math.floor((Math.max(1, Math.min(20, level)) - 1) / 4);
}

export const XP_BY_LEVEL = [
  0, 0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
  85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000,
];

export function levelFromXp(xp) {
  let lvl = 1;
  for (let i = 2; i <= 20; i += 1) if (xp >= XP_BY_LEVEL[i]) lvl = i;
  return lvl;
}

/** Full-caster spell slots, levels 1-20. Index 0 unused. */
export const FULL_CASTER_SLOTS = [
  null,
  [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2],
  [4, 3, 3, 3, 1], [4, 3, 3, 3, 2], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

/** Warlock Pact Magic: slot count and slot level by warlock level. */
export const PACT_SLOTS = [
  null,
  { n: 1, lvl: 1 }, { n: 2, lvl: 1 }, { n: 2, lvl: 2 }, { n: 2, lvl: 2 },
  { n: 2, lvl: 3 }, { n: 2, lvl: 3 }, { n: 2, lvl: 4 }, { n: 2, lvl: 4 },
  { n: 2, lvl: 5 }, { n: 2, lvl: 5 }, { n: 3, lvl: 5 }, { n: 3, lvl: 5 },
  { n: 3, lvl: 5 }, { n: 3, lvl: 5 }, { n: 3, lvl: 5 }, { n: 3, lvl: 5 },
  { n: 4, lvl: 5 }, { n: 4, lvl: 5 }, { n: 4, lvl: 5 }, { n: 4, lvl: 5 },
];

/** How much a class contributes to multiclass caster level. */
export const CASTER_PROGRESSION = {
  bard: 1, cleric: 1, druid: 1, sorcerer: 1, wizard: 1,
  paladin: 0.5, ranger: 0.5,
  warlock: 0, // Pact Magic is tracked separately
};

/**
 * Multiclass spell slots. Half-casters contribute half their level, ROUNDED
 * DOWN, and a character with only a single half-caster level contributes 0 -
 * which is why this floors the per-class contribution rather than the sum.
 */
export function spellSlotsFor(classes = []) {
  let casterLevel = 0;
  for (const c of classes) {
    const rate = CASTER_PROGRESSION[String(c.class || '').toLowerCase()] ?? 0;
    casterLevel += rate === 1 ? c.level : Math.floor(c.level * rate);
  }
  if (casterLevel <= 0) return [];
  return FULL_CASTER_SLOTS[Math.min(20, casterLevel)] || [];
}

/* ------------------------------------------------------------------ */
/* encounter building                                                  */
/* ------------------------------------------------------------------ */

/** 2024 XP budget per character, by party level and difficulty. */
export const XP_BUDGET = {
  1:  { low: 50,    moderate: 75,    high: 100 },
  2:  { low: 100,   moderate: 150,   high: 200 },
  3:  { low: 150,   moderate: 225,   high: 400 },
  4:  { low: 250,   moderate: 375,   high: 500 },
  5:  { low: 500,   moderate: 750,   high: 1100 },
  6:  { low: 600,   moderate: 1000,  high: 1400 },
  7:  { low: 750,   moderate: 1300,  high: 1700 },
  8:  { low: 1000,  moderate: 1700,  high: 2100 },
  9:  { low: 1300,  moderate: 2000,  high: 2600 },
  10: { low: 1600,  moderate: 2300,  high: 3100 },
  11: { low: 1900,  moderate: 2900,  high: 4100 },
  12: { low: 2200,  moderate: 3700,  high: 4700 },
  13: { low: 2600,  moderate: 4200,  high: 5400 },
  14: { low: 2900,  moderate: 4900,  high: 6200 },
  15: { low: 3300,  moderate: 5400,  high: 7800 },
  16: { low: 3800,  moderate: 6100,  high: 9800 },
  17: { low: 4500,  moderate: 7200,  high: 11700 },
  18: { low: 5000,  moderate: 8700,  high: 14200 },
  19: { low: 5500,  moderate: 10700, high: 17200 },
  20: { low: 6400,  moderate: 13200, high: 22000 },
};

export function encounterBudget(partyLevels = [], difficulty = 'moderate') {
  return partyLevels.reduce(
    (sum, lvl) => sum + (XP_BUDGET[Math.max(1, Math.min(20, lvl))]?.[difficulty] || 0),
    0,
  );
}

export const CR_XP = {
  0: 10, 0.125: 25, 0.25: 50, 0.5: 100, 1: 200, 2: 450, 3: 700, 4: 1100,
  5: 1800, 6: 2300, 7: 2900, 8: 3900, 9: 5000, 10: 5900, 11: 7200, 12: 8400,
  13: 10000, 14: 11500, 15: 13000, 16: 15000, 17: 18000, 18: 20000, 19: 22000,
  20: 25000, 21: 33000, 22: 41000, 23: 50000, 24: 62000, 25: 75000, 26: 90000,
  27: 105000, 28: 120000, 29: 135000, 30: 155000,
};

/* ------------------------------------------------------------------ */
/* money                                                               */
/* ------------------------------------------------------------------ */

export const COIN_CP = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };

export function toCopper(purse = {}) {
  return Object.entries(COIN_CP)
    .reduce((n, [coin, mult]) => n + (Number(purse[coin]) || 0) * mult, 0);
}

/**
 * Render copper as the largest sensible coins: 1234 -> "12 GP, 3 SP, 4 CP".
 *
 * Platinum is only used above 100 GP. It is arithmetically fine to call 5200 cp
 * "5 PP, 2 GP", but players think in gold, and "52 GP" is what they expect to
 * read in a purchase summary.
 */
export function fromCopper(cp) {
  let left = Math.max(0, Math.round(cp));
  const usePlatinum = left >= 10000;
  const parts = [];
  const ladder = usePlatinum
    ? [['pp', 1000], ['gp', 100], ['sp', 10], ['cp', 1]]
    : [['gp', 100], ['sp', 10], ['cp', 1]];
  for (const [coin, mult] of ladder) {
    const n = Math.floor(left / mult);
    if (n > 0) { parts.push(`${n} ${coin.toUpperCase()}`); left -= n * mult; }
  }
  return parts.length ? parts.join(', ') : '0 CP';
}

/** Carrying capacity in pounds. */
export function carryCapacity(strScore) {
  return Number(strScore || 10) * 15;
}

export function encumbrance(strScore, pounds) {
  const str = Number(strScore || 10);
  if (pounds > str * 15) return 'over capacity';
  if (pounds > str * 10) return 'heavily encumbered';
  if (pounds > str * 5) return 'encumbered';
  return 'unencumbered';
}

/** Exhaustion in 2024 is a flat -2 per level on all d20 tests. */
export function exhaustionPenalty(level) {
  return -2 * Math.max(0, Math.min(6, Number(level) || 0));
}

export const ATTUNEMENT_LIMIT = 3;

/* ------------------------------------------------------------------ */
/* class progressions                                                  */
/* ------------------------------------------------------------------ */

/**
 * Step tables for SRD class resources, as [minClassLevel, value] pairs.
 * Used by srd-effects.json formulas so a Sorcerer 5 / Fighter 3 gets five
 * Sorcery Points and two Second Winds, not eight of each.
 */
const STEPS = {
  rageUses:        [[1, 2], [3, 3], [6, 4], [12, 5], [17, 6]],
  channelUses:     [[1, 2], [6, 3], [18, 4]],
  wildShapeUses:   [[1, 2], [6, 3], [17, 4]],
  secondWindUses:  [[1, 2], [4, 3], [10, 4]],
  actionSurgeUses: [[1, 1], [17, 2]],
  favoredEnemy:    [[1, 2], [5, 3], [9, 4], [13, 5], [17, 6]],
};

const MARTIAL_ARTS_DIE = [[1, '1d6'], [5, '1d8'], [11, '1d10'], [17, '1d12']];

function stepValue(table, level) {
  let value = table[0][1];
  for (const [min, v] of table) if (level >= min) value = v;
  return value;
}

/** The Monk's Martial Arts die at a given Monk level. */
export function martialArtsDie(monkLevel) {
  return stepValue(MARTIAL_ARTS_DIE, Math.max(1, monkLevel || 1));
}

/**
 * Resolve a named class-progression formula.
 * @returns {number|string|null} null when `name` is not a known progression.
 */
export function classFormula(name, classLevel = 1) {
  if (name === 'classLevel') return classLevel;
  if (name === 'layOnHands') return classLevel * 5;
  if (name === 'martialArtsDie') return martialArtsDie(classLevel);
  // Sneak Attack: 1d6 at level 1, +1d6 every odd level, to 10d6 at 19.
  if (name === 'sneakAttackDice') {
    return `${Math.max(1, Math.ceil(Math.min(20, classLevel) / 2))}d6`;
  }
  if (STEPS[name]) return stepValue(STEPS[name], classLevel);
  return null;
}

/* ------------------------------------------------------------------ */
/* starting equipment                                                  */
/* ------------------------------------------------------------------ */

/**
 * Parse a class or background starting-equipment sentence into options.
 *
 * The SRD's grammar is stable: `Choose A, B, or C: (A) item, 2 Items,
 * and N GP; (B) ...; or (C) 155 GP` - backgrounds wrap the preamble in
 * italics. Each option becomes {key, label, items, gp}; gold-only options
 * carry items: []. Item names resolve against the equipment compendium
 * (exact, then singularised, then prefix); what cannot be resolved is kept
 * as an unresolved named item rather than dropped - a Monk's instrument is
 * still THEIRS even if the price list has no entry for it.
 *
 * Pure: no I/O, no randomness. Returns null when the prose has no
 * recognisable options.
 */
export function parseStartingEquipment(prose, equipment) {
  if (!prose) return null;
  const text = String(prose).replace(/_/g, '').trim();
  const pool = [
    ...(equipment?.weapons || []),
    ...(equipment?.armor || []),
    ...(equipment?.gear || []),
  ];

  const parts = text.split(/\(([A-C])\)/);
  if (parts.length < 3) return null;

  const options = [];
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i].toLowerCase();
    let body = parts[i + 1] || '';
    body = body.replace(/^\s*/, '').replace(/[;.]?\s*(?:or\s*)?$/i, '');

    let gp = 0;
    const gold = /(?:,?\s*(?:and\s+)?)(\d+)\s*GP\s*$/i.exec(body);
    if (gold) {
      gp = Number(gold[1]);
      body = body.slice(0, gold.index).trim().replace(/[,;]$/, '');
    }

    const items = [];
    for (let token of splitOutsideParens(body)) {
      token = token.replace(/^and\s+/i, '').trim();
      if (!token) continue;
      let qty = 1;
      const q = /^(\d+)\s+(.*)$/.exec(token);
      let name = token;
      if (q) { qty = Number(q[1]); name = q[2]; }
      // "(10 sheets)" style parentheticals also carry a quantity.
      const paren = /\((\d+)\s+[a-z]+\)/i.exec(name);
      if (paren && qty === 1) qty = Number(paren[1]);
      const ref = resolveEquipment(name, pool);
      items.push({ name, qty, resolved: !!ref, ref: ref || null });
    }
    options.push({
      key,
      label: items.length
        ? `${items.map((it) => (it.qty > 1 ? `${it.qty}× ${it.name}` : it.name))
          .join(', ')}${gp ? ` + ${gp} GP` : ''}`
        : `${gp} GP`,
      items,
      gp,
    });
  }
  return options.length ? { options } : null;
}

function splitOutsideParens(body) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const chr of body) {
    if (chr === '(') depth += 1;
    if (chr === ')') depth = Math.max(0, depth - 1);
    if (chr === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += chr;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function resolveEquipment(rawName, pool) {
  // Display keeps the parenthetical ("Book (prayers)"); lookup drops it.
  const name = rawName.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ')
    .trim().toLowerCase();
  if (!name) return null;
  const exact = pool.find((it) => it.name.toLowerCase() === name);
  if (exact) return exact;
  if (name.endsWith('s')) {
    const singular = name.slice(0, -1);
    const hit = pool.find((it) => it.name.toLowerCase() === singular);
    if (hit) return hit;
  }
  return pool.find((it) => it.name.toLowerCase().startsWith(name)) || null;
}
