/**
 * Encounter construction and monster turns.
 *
 * Encounters are built against the 2024 XP budget so a level-3 party meets
 * level-3 problems - otherwise a "campaign" is just a character punching a
 * fixed dummy for twenty levels and the survivability numbers mean nothing.
 */

import { encounterBudget, CR_XP } from '../core/rules2024.js';
import { d20, roll } from '../core/dice.js';
import { applyDamage } from '../core/engine.js';

/** Difficulty mix across an adventuring day. */
export const DIFFICULTY_MIX = [
  { difficulty: 'low', weight: 0.25 },
  { difficulty: 'moderate', weight: 0.60 },
  { difficulty: 'high', weight: 0.15 },
];

export function pickDifficulty(rng) {
  const r = rng.float();
  let acc = 0;
  for (const d of DIFFICULTY_MIX) {
    acc += d.weight;
    if (r <= acc) return d.difficulty;
  }
  return 'moderate';
}

/**
 * Choose monsters to fill an XP budget.
 *
 * Deliberately simple: pick a CR band appropriate to the budget, then add
 * monsters until the budget is met or a cap is reached. The cap is REPORTED
 * rather than silently applied - a budget we could not fill is information
 * about the bestiary, not something to paper over.
 */
/**
 * Monster count is the dominant difficulty lever, far more than CR.
 *
 * Measured across levels 1-20, incoming damage per adventuring day as a
 * multiple of total party HP:
 *
 *     max 2 monsters -> 1.28x   too easy
 *     max 3 monsters -> 1.94x   party must spend resources, survives  <-- chosen
 *     max 4 monsters -> 2.78x
 *     max 5 monsters -> 2.98x   party wipes
 *
 * The XP budget alone cannot express this: it prices eight CR-1 monsters the
 * same as one CR-5, but eight of them bring eight multiattacks. Filling the
 * budget with a swarm produced 6.8x and killed every class.
 */
export const MAX_MONSTERS_DEFAULT = 3;

export function buildEncounter(monsters, partyLevels, rng, opts = {}) {
  const { maxMonsters = MAX_MONSTERS_DEFAULT, difficulty = null } = opts;
  const diff = difficulty || pickDifficulty(rng);
  const budget = encounterBudget(partyLevels, diff);
  const avgLevel = partyLevels.reduce((a, b) => a + b, 0) / partyLevels.length;

  // Keep individual monsters in a sane band.
  //
  // The XP budget alone is not enough: it prices a CR-5 Shambling Mound the
  // same whether it arrives alone or with two friends, but three big monsters
  // bring three multiattacks and roughly triple the incoming damage. Filling a
  // level-5 budget with CR 5 + 3 + 2 produced fights the party lost half the
  // time, which killed every martial in tier 2 - a harness artifact that would
  // have read as "martials are weak".
  //
  // Capping individual CR well below party level yields the shape real
  // encounter design uses: several manageable threats, or one notable one.
  const ceiling = Math.max(1, avgLevel * 0.7);
  const floor = Math.max(0, avgLevel / 6);
  const pool = monsters.filter(
    (m) => m.cr !== null && m.cr <= ceiling && m.cr >= floor
      && m.hp > 0 && (m.actions || []).length > 0,
  );
  if (!pool.length) {
    return { monsters: [], budget, spent: 0, difficulty: diff, unfilled: true };
  }

  const chosen = [];
  let spent = 0;
  let guard = 0;
  while (spent < budget * 0.85 && chosen.length < maxMonsters && guard < 200) {
    guard += 1;
    const remaining = budget - spent;
    const affordable = pool.filter((m) => (CR_XP[m.cr] || 0) <= remaining * 1.15);
    if (!affordable.length) break;
    const pick = rng.pick(affordable);
    chosen.push(pick);
    spent += CR_XP[pick.cr] || 0;
  }

  return {
    monsters: chosen.map((m, i) => instantiate(m, i, rng)),
    budget,
    spent,
    difficulty: diff,
    // True when the bestiary could not fill the budget at this tier.
    unfilled: spent < budget * 0.5,
    capped: chosen.length >= maxMonsters,
  };
}

/** Turn a stat block into a live combatant. */
export function instantiate(monster, index, rng) {
  return {
    id: `${monster.id}-${index}`,
    name: index > 0 ? `${monster.name} ${index + 1}` : monster.name,
    side: 'enemy',
    ac: monster.ac || 12,
    hp: monster.hp || 10,
    hpMax: monster.hp || 10,
    temp: 0,
    cr: monster.cr,
    xp: monster.xp || CR_XP[monster.cr] || 0,
    initiativeMod: monster.initiative ?? (monster.abilities?.dex?.mod || 0),
    abilities: monster.abilities || {},
    actions: monster.actions || [],
    legendaryActions: monster.legendaryActions || [],
    conditions: [],
    concentrating: null,
    stat: monster,
  };
}

/* ------------------------------------------------------------------ */
/* monster turns                                                       */
/* ------------------------------------------------------------------ */

// Stat-block actions are prose. We only need enough to make a monster hit back
// plausibly, so parse the two things that matter: the attack bonus and the
// damage expression. An action we cannot parse simply is not used, and that
// is counted rather than hidden.
const ATTACK_RE = /_(?:Melee|Ranged)\s+Attack Roll:_\s*\+(\d+)/i;
const HIT_RE = /_Hit:_\s*\d+\s*\((\d+d\d+(?:\s*\+\s*\d+)?)\)\s*(\w+)?\s*damage/i;
const SAVE_RE = /_(\w+)\s+Saving Throw:_\s*DC\s*(\d+)/i;
const SAVE_DMG_RE = /_Failure:_\s*\d+\s*\((\d+d\d+(?:\s*\+\s*\d+)?)\)\s*(\w+)?\s*damage/i;

/** Extract usable attacks from a monster's action list. */
export function parseMonsterActions(monster) {
  const usable = [];
  let unparsed = 0;
  for (const action of monster.actions || []) {
    const text = action.text || '';
    if (/Multiattack/i.test(action.name)) continue;

    const atk = ATTACK_RE.exec(text);
    const hit = HIT_RE.exec(text);
    if (atk && hit) {
      usable.push({
        name: action.name,
        kind: 'attack',
        attackBonus: parseInt(atk[1], 10),
        damage: hit[1].replace(/\s+/g, ''),
        damageType: (hit[2] || 'bludgeoning').toLowerCase(),
      });
      continue;
    }
    const save = SAVE_RE.exec(text);
    const sdmg = SAVE_DMG_RE.exec(text);
    if (save && sdmg) {
      usable.push({
        name: action.name,
        kind: 'save',
        saveAbility: save[1].slice(0, 3).toLowerCase(),
        dc: parseInt(save[2], 10),
        damage: sdmg[1].replace(/\s+/g, ''),
        damageType: (sdmg[2] || 'force').toLowerCase(),
        half: /_Success:_\s*Half damage/i.test(text),
      });
      continue;
    }
    unparsed += 1;
  }
  return { usable, unparsed };
}

/** How many attacks a Multiattack grants, if we can read it. */
export function multiattackCount(monster) {
  const ma = (monster.actions || []).find((a) => /Multiattack/i.test(a.name));
  if (!ma) return 1;
  const m = /\b(one|two|three|four|five)\b/i.exec(ma.text || '');
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  return m ? (words[m[1].toLowerCase()] || 1) : 1;
}

/**
 * Resolve one monster's turn against a party.
 * Returns damage applied plus events, never mutating the inputs directly.
 */
export function monsterTurn(monster, party, rng) {
  const { usable } = parseMonsterActions(monster.stat || monster);
  const events = [];
  const hits = [];
  if (!usable.length) return { events, hits, noActions: true };

  const alive = party.filter((p) => p.hp > 0);
  if (!alive.length) return { events, hits, noTargets: true };

  /**
   * Choose a victim.
   *
   * Deterministically picking the lowest-HP character looks "consistent", but
   * it is degenerate: the simulated character is the only party member who
   * carries damage between encounters, so it is ALWAYS the weakest and eats
   * effectively every attack in the adventuring day. That made allies purely
   * decorative and killed every slow-killing class in tier 1-2.
   *
   * Real monsters spread their attention. A mild bias toward the wounded keeps
   * some focus-fire pressure without turning it into an execution.
   */
  const pickVictim = () => {
    if (alive.length === 1) return alive[0];
    if (rng.float() < 0.35) {
      return alive.reduce((a, b) => (b.hp < a.hp ? b : a));
    }
    return rng.pick(alive);
  };

  const count = multiattackCount(monster.stat || monster);
  for (let i = 0; i < count; i += 1) {
    const target = pickVictim();
    const action = rng.pick(usable);

    if (action.kind === 'attack') {
      const r = d20({ mod: action.attackBonus, rng });
      const hit = r.isCrit || (!r.isFumble && r.total >= target.ac);
      if (hit) {
        const dmg = roll(action.damage, { crit: r.isCrit, rng });
        hits.push({ target, amount: dmg.total, type: action.damageType,
                    source: `${monster.name} (${action.name})` });
      }
      events.push({ type: 'attack', payload: {
        attacker: monster.name, weapon: action.name, target: target.name,
        nat: r.nat, total: r.total, hit, damage: hit ? undefined : 0 } });
    } else {
      const saveMod = target.saves?.[action.saveAbility]?.mod ?? 0;
      const r = d20({ mod: saveMod, rng });
      const saved = r.total >= action.dc;
      const full = roll(action.damage, { rng }).total;
      const amount = saved ? (action.half ? Math.floor(full / 2) : 0) : full;
      if (amount > 0) {
        hits.push({ target, amount, type: action.damageType,
                    source: `${monster.name} (${action.name})` });
      }
    }
  }
  return { events, hits };
}
