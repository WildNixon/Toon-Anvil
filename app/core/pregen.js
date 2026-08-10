/**
 * Quick party - ready heroes forged from the SRD.
 *
 * Fifteen taps per phone to build a character is the couch's death. This
 * module forges table-grade level-1 characters in one tap: recipes are DATA
 * (class, species, background, ability priority, skill picks, kit, spells,
 * names), and forgeParty() turns them into records that are born complete -
 * species, background and ability bonuses populated - because those fields
 * FREEZE the moment a player claims a seat and the server will refuse to
 * fill them in later.
 *
 * Deterministic on purpose: same seed, same party, byte for byte. The gym
 * relies on it, and "reroll the party" is just a new seed.
 *
 * Deliberately NOT modelled: origin feats (the background names one; tables
 * that use them can add them in Build before the claim) and levels above 1.
 * Every id below is validated against the loaded compendium at forge time -
 * a renamed SRD item drops out of the kit rather than shipping a ghost.
 */

import { seededRng } from './rng.js';

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];

const abilityMod = (score) => Math.floor((score - 10) / 2);

/**
 * Eight archetypes. `skills` are the CLASS choices (the background adds its
 * own two on top); `bonuses` come from the background's three listed
 * abilities, 2024-style (+2/+1). Names are authored here - original, short,
 * shoutable across a couch.
 */
export const RECIPES = [
  {
    id: 'vanguard', label: 'Vanguard', classId: 'fighter',
    speciesId: 'human', backgroundId: 'soldier',
    priority: ['str', 'con', 'dex', 'wis', 'cha', 'int'],
    bonuses: { str: 2, con: 1 },
    skills: ['Perception', 'Insight'],
    kit: { weapon: 'Greatsword', armor: 'Chain Mail' },
    spells: null,
    names: ['Berrick', 'Maren', 'Aldous', 'Petra', 'Corvin', 'Sable', 'Odo', 'Wren'],
  },
  {
    id: 'arcanist', label: 'Arcanist', classId: 'wizard',
    speciesId: 'elf', backgroundId: 'sage',
    priority: ['int', 'con', 'dex', 'wis', 'cha', 'str'],
    bonuses: { int: 2, con: 1 },
    skills: ['Investigation', 'Insight'],
    kit: { weapon: 'Quarterstaff' },
    spells: {
      prepared: ['magic-missile', 'shield', 'sleep'],
      known: ['fire-bolt', 'light', 'mage-hand'],
    },
    names: ['Illyra', 'Thessaly', 'Vael', 'Quenneth', 'Sorel', 'Ariq', 'Nyx', 'Fenwick'],
  },
  {
    id: 'warpriest', label: 'Warpriest', classId: 'cleric',
    speciesId: 'dwarf', backgroundId: 'acolyte',
    priority: ['wis', 'con', 'str', 'dex', 'cha', 'int'],
    bonuses: { wis: 2, cha: 1 },
    skills: ['Medicine', 'Persuasion'],
    kit: { weapon: 'Mace', armor: 'Chain Shirt', shield: true },
    spells: {
      prepared: ['cure-wounds', 'bless', 'guiding-bolt'],
      known: ['sacred-flame', 'guidance', 'thaumaturgy'],
    },
    names: ['Brunna', 'Kordan', 'Eska', 'Tormund', 'Hildy', 'Varga', 'Ozren', 'Mabel'],
  },
  {
    id: 'shadow', label: 'Shadow', classId: 'rogue',
    speciesId: 'halfling', backgroundId: 'criminal',
    priority: ['dex', 'con', 'int', 'wis', 'cha', 'str'],
    bonuses: { dex: 2, con: 1 },
    skills: ['Acrobatics', 'Perception', 'Deception', 'Investigation'],
    kit: { weapon: 'Shortsword', armor: 'Leather Armor' },
    spells: null,
    names: ['Pip', 'Marlow', 'Tansy', 'Quill', 'Nim', 'Cricket', 'Dodge', 'Vesper'],
  },
  {
    id: 'berserker', label: 'Berserker', classId: 'barbarian',
    speciesId: 'goliath', backgroundId: 'soldier',
    priority: ['str', 'con', 'dex', 'wis', 'cha', 'int'],
    bonuses: { str: 2, con: 1 },
    skills: ['Perception', 'Survival'],
    kit: { weapon: 'Greataxe' },
    spells: null,
    names: ['Kavva', 'Ruun', 'Thokk', 'Ilga', 'Bront', 'Ymber', 'Skala', 'Dorn'],
  },
  {
    id: 'skald', label: 'Skald', classId: 'bard',
    speciesId: 'tiefling', backgroundId: 'acolyte',
    priority: ['cha', 'dex', 'con', 'wis', 'int', 'str'],
    bonuses: { cha: 2, wis: 1 },
    skills: ['Persuasion', 'Performance', 'Deception'],
    kit: { weapon: 'Rapier', armor: 'Leather Armor' },
    spells: {
      prepared: ['healing-word', 'charm-person', 'heroism'],
      known: ['vicious-mockery', 'minor-illusion'],
    },
    names: ['Lyric', 'Damaia', 'Orin', 'Calliope', 'Zevran', 'Melody', 'Aris', 'Faye'],
  },
  {
    id: 'warden', label: 'Warden', classId: 'ranger',
    speciesId: 'orc', backgroundId: 'soldier',
    priority: ['dex', 'wis', 'con', 'str', 'int', 'cha'],
    bonuses: { dex: 2, con: 1 },
    skills: ['Perception', 'Stealth', 'Survival'],
    kit: { weapon: 'Longbow', armor: 'Leather Armor' },
    spells: { prepared: ['hunter-s-mark', 'cure-wounds'], known: [] },
    names: ['Karga', 'Fenn', 'Ashvale', 'Rook', 'Senna', 'Grosh', 'Talia', 'Vorn'],
  },
  {
    id: 'crusader', label: 'Crusader', classId: 'paladin',
    speciesId: 'dragonborn', backgroundId: 'soldier',
    priority: ['str', 'cha', 'con', 'wis', 'dex', 'int'],
    bonuses: { str: 2, con: 1 },
    skills: ['Persuasion', 'Insight'],
    kit: { weapon: 'Longsword', armor: 'Chain Mail', shield: true },
    spells: { prepared: ['cure-wounds', 'shield-of-faith'], known: [] },
    names: ['Balasar', 'Seraphine', 'Kriv', 'Aurel', 'Donaar', 'Ivory', 'Rhogar', 'Casta'],
  },
];

/** "Insight and Religion" -> ['Insight', 'Religion'] */
function backgroundSkills(bg) {
  return String(bg?.skillProficiencies || '')
    .split(/\s+and\s+|,/i).map((s) => s.trim()).filter(Boolean);
}

function kitItems(kit, equipment) {
  const items = [];
  const find = (list, name) => (list || []).find((x) => x.name === name);
  if (kit?.weapon) {
    const w = find(equipment?.weapons, kit.weapon);
    if (w) {
      items.push({
        id: `w-${w.id}`, name: w.name, kind: 'weapon', qty: 1, equipped: true,
        damage: w.damage, properties: w.properties, mastery: w.mastery,
        category: w.category, weight: w.weight,
      });
    }
  }
  if (kit?.armor) {
    const a = find(equipment?.armor, kit.armor);
    if (a) {
      items.push({
        id: `a-${a.id}`, name: a.name, kind: 'armor', qty: 1, equipped: true,
        ac: a.ac, category: a.category, weight: a.weight,
      });
    }
  }
  if (kit?.shield) {
    const s = find(equipment?.armor, 'Shield');
    if (s) {
      items.push({
        id: `a-${s.id}`, name: s.name, kind: 'armor', qty: 1, equipped: true,
        ac: s.ac, category: s.category, weight: s.weight,
      });
    }
  }
  return items;
}

function forgeOne(recipe, sources, rng, seed, i) {
  const abilities = {};
  recipe.priority.forEach((ab, idx) => { abilities[ab] = STANDARD_ARRAY[idx]; });

  const cls = (sources.classes || []).find((c) => c.id === recipe.classId);
  const bg = (sources.backgrounds || []).find((b) => b.id === recipe.backgroundId);
  const hitDie = cls?.hitDie || 8;
  const conTotal = abilities.con + (recipe.bonuses.con || 0);
  const maxHp = hitDie + abilityMod(conTotal);

  const spellIds = new Set((sources.spells || []).map((s) => s.id));
  const keepReal = (ids) => (ids || []).filter((id) => spellIds.has(id));

  return {
    id: `pg-${seed}-${i + 1}`,
    name: rng.pick(recipe.names),
    ruleset: '2024',
    pregen: recipe.id,
    species: recipe.speciesId,
    background: recipe.backgroundId,
    classes: [{ class: recipe.classId, subclass: null, level: 1 }],
    abilities,
    abilityBonuses: { ...recipe.bonuses },
    abilityMethod: 'array',
    skills: [...new Set([...recipe.skills, ...backgroundSkills(bg)])],
    expertise: [],
    feats: [],
    hp: { max: maxHp, current: maxHp, temp: 0 },
    hitDice: { die: hitDie, remaining: 1 },
    inventory: kitItems(recipe.kit, sources.equipment),
    currency: { gp: 15 },
    spells: recipe.spells
      ? { prepared: keepReal(recipe.spells.prepared),
          known: keepReal(recipe.spells.known) }
      : { prepared: [], known: [] },
    slotState: {},
    resourceState: {},
    toggles: {},
    conditions: [],
    exhaustion: 0,
    deathSaves: { successes: 0, failures: 0 },
    // No ownerId - not even null. Absent means unclaimed, and the claim
    // flow is what binds a hero to a seat. No createdAt either: the forge
    // is deterministic and a timestamp would break byte-identity.
  };
}

/**
 * Forge n ready heroes (1..8). Deterministic per seed; the starting recipe
 * rotates so a party of three is not always the same three.
 */
export function forgeParty(n, sources, seed = 1) {
  const rng = seededRng(seed).stream('pregen');
  const count = Math.max(1, Math.min(RECIPES.length, Math.floor(n) || 1));
  const start = rng.int(RECIPES.length);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const recipe = RECIPES[(start + i) % RECIPES.length];
    out.push(forgeOne(recipe, sources, rng, seed, i));
  }
  return out;
}
