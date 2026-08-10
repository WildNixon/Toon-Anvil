/**
 * The rules engine: combat resolution, rests, resources.
 *
 * This module exists because attack resolution was written twice - once in
 * sheet.js and once in combat.js - and the two copies had already drifted
 * apart. sheet.js selected roll-table entries with `Math.random() * length`
 * while combat.js rolled the actual die, so the same homebrew trigger behaved
 * differently depending on which screen you were looking at. Two copies of a
 * rule is one copy too many.
 *
 * Everything here is PURE: functions take state and an RNG, and return results
 * plus a list of events for the caller to log. No DOM, no storage, no toasts.
 * That is what lets the campaign emulator run the real engine headlessly
 * instead of grading a reimplementation of it.
 */

import { d20, roll, average } from './dice.js';
import { defaultRng } from './rng.js';

/* ------------------------------------------------------------------ */
/* attacks                                                             */
/* ------------------------------------------------------------------ */

/**
 * Resolve one attack.
 *
 * @param {object} attack   an entry from derived.attacks
 * @param {object} opts     {rng, target, advantage, disadvantage, critRange,
 *                           extraDamage:[{dice,type}], attackerName}
 * @returns {{roll, damage, hit, crit, fumble, total, events}}
 */
export function resolveAttack(attack, opts = {}) {
  const {
    rng = defaultRng, target = null, advantage = false, disadvantage = false,
    critRange = 20, extraDamage = [], attackerName = null,
  } = opts;

  const hitRoll = d20({
    mod: attack.attackBonus, advantage, disadvantage, critRange, rng,
  });

  // A natural 20 always hits and a natural 1 always misses, regardless of AC.
  const targetAc = target?.ac ?? null;
  const hit = hitRoll.isCrit ? true
    : hitRoll.isFumble ? false
    : targetAc === null ? null
    : hitRoll.total >= targetAc;

  let damage = null;
  const damageParts = [];
  if (hit !== false) {
    const expr = `${attack.damage}${attack.damageBonus
      ? (attack.damageBonus >= 0 ? '+' : '') + attack.damageBonus : ''}`;
    damage = roll(expr, { crit: hitRoll.isCrit, rng });
    damageParts.push({
      source: attack.name,
      amount: damage.total,
      type: attack.damageTypes?.[0] || 'bludgeoning',
    });
    for (const extra of extraDamage) {
      const r = roll(extra.dice, { crit: hitRoll.isCrit, rng });
      damageParts.push({ source: extra.source || 'rider', amount: r.total, type: extra.type });
    }
  }

  const total = damageParts.reduce((n, p) => n + p.amount, 0);

  const events = [{
    type: 'attack',
    payload: {
      weapon: attack.name, attacker: attackerName, target: target?.name || null,
      total: hitRoll.total, nat: hitRoll.nat, ac: targetAc, hit,
      damage: total, damageType: attack.damageTypes?.[0] || null,
      crit: hitRoll.isCrit, advantage: hitRoll.advantage,
      disadvantage: hitRoll.disadvantage,
    },
  }];
  if (hitRoll.isCrit && hit) {
    events.push({ type: 'crit', payload: { weapon: attack.name, target: target?.name || null, damage: total } });
  }
  if (hitRoll.isFumble) {
    events.push({ type: 'fumble', payload: { on: attack.name } });
  }

  return {
    roll: hitRoll, damage, damageParts, total,
    hit, crit: hitRoll.isCrit, fumble: hitRoll.isFumble, events,
  };
}

/** Expected damage of an attack against a given AC - used by the sim's policy. */
export function expectedDamage(attack, targetAc = 13, extraDamage = []) {
  const base = average(`${attack.damage}${attack.damageBonus
    ? (attack.damageBonus >= 0 ? '+' : '') + attack.damageBonus : ''}`);
  const extra = extraDamage.reduce((n, e) => n + average(e.dice), 0);
  const need = targetAc - attack.attackBonus;
  // P(hit) with a nat-20 auto-hit floor and nat-1 auto-miss ceiling.
  const pHit = Math.min(0.95, Math.max(0.05, (21 - need) / 20));
  const pCrit = 0.05;
  const dice = average(String(attack.damage));
  return (base + extra) * pHit + dice * pCrit;
}

/* ------------------------------------------------------------------ */
/* spells                                                              */
/* ------------------------------------------------------------------ */

/**
 * Resolve a spell from its extracted mechanics.
 *
 * @param {object} spell     compendium entry
 * @param {object} mech      entry from spell-mechanics.json
 * @param {object} opts      {rng, caster:{saveDc,attackBonus}, targets:[], slotLevel}
 */
export function resolveSpell(spell, mech, opts = {}) {
  const {
    rng = defaultRng, caster = {}, targets = [], slotLevel = null,
  } = opts;

  if (!mech || !mech.executable) {
    return {
      executable: false, total: 0, results: [],
      events: [{ type: 'spell_cast', payload: { spell: spell.name, level: slotLevel, simulated: false } }],
    };
  }

  const steps = (slotLevel && slotLevel > spell.level) ? slotLevel - spell.level : 0;

  // Upcast scaling: extra dice, or extra projectiles, per slot level above base.
  let dice = mech.damage || null;
  let healDice = mech.healing || null;
  let projectiles = mech.projectiles || 1;

  if (steps && mech.upcast) {
    const bump = (base, per) => {
      const m = /^(\d+)d(\d+)$/.exec(per);
      const b = /^(\d+)d(\d+)$/.exec(base);
      if (m && b && m[2] === b[2]) {
        return `${parseInt(b[1], 10) + parseInt(m[1], 10) * steps}d${b[2]}`;
      }
      return base;
    };
    if (mech.upcast.kind === 'damage' && dice) dice = bump(dice, mech.upcast.perLevel);
    if (mech.upcast.kind === 'healing' && healDice) {
      healDice = bump(healDice, mech.upcast.perLevel);
    }
    if (mech.upcast.kind === 'projectiles') {
      projectiles += (Number(mech.upcast.perLevel) || 1) * steps;
    }
  }

  /* ---- healing and temp HP resolve per target, no rolls to hit ---- */
  if (healDice || mech.tempHp) {
    const results = [];
    let total = 0;
    for (const target of (targets.length ? targets : [null])) {
      const src = healDice || mech.tempHp;
      const amount = src === 'mod'
        ? (caster.mod || 0)
        : roll(String(src), { rng }).total + (mech.healingAddsMod ? (caster.mod || 0) : 0);
      results.push({
        target: target?.name || null, landed: true,
        [mech.tempHp && !healDice ? 'tempHp' : 'healing']: amount,
      });
      total += amount;
    }
    return {
      executable: true, total, results, kind: mech.tempHp && !healDice ? 'tempHp' : 'healing',
      events: [{
        type: 'spell_cast',
        payload: {
          spell: spell.name, level: slotLevel ?? spell.level, simulated: true,
          damage: 0, healing: total, targets: results.length,
        },
      }],
    };
  }

  /* ---- damage / conditions ---- */
  const results = [];
  let total = 0;

  // Two different shapes, and conflating them silently understates area spells.
  //
  //   projectiles > 1  N discrete instances spread over the targets - Magic
  //                    Missile's darts, Scorching Ray's rays, each rolling
  //                    separately.
  //   otherwise        one instance PER TARGET - a Fireball in a room with six
  //                    creatures resolves six times, not once.
  const targetList = targets.length ? targets : [null];
  const instances = [];
  if (projectiles > 1) {
    for (let i = 0; i < projectiles; i += 1) {
      instances.push(targetList[i % targetList.length]);
    }
  } else {
    instances.push(...targetList);
  }

  for (const target of instances) {
    let amount = 0;
    let landed = true;
    let saveRoll = null;
    let attackRoll = null;

    if (mech.attackRoll) {
      attackRoll = d20({ mod: caster.attackBonus || 0, rng });
      landed = attackRoll.isCrit ? true
        : attackRoll.isFumble ? false
        : target?.ac == null ? true
        : attackRoll.total >= target.ac;
      if (landed && dice) {
        amount = roll(dice, { crit: attackRoll.isCrit, rng }).total
          + (mech.damageFlat || 0);
      }
    } else if (mech.save) {
      const saveMod = target?.abilities?.[mech.save.ability]?.save ?? 0;
      saveRoll = d20({ mod: saveMod, rng });
      const saved = saveRoll.total >= (caster.saveDc || 10);
      if (dice) {
        const full = roll(dice, { rng }).total + (mech.damageFlat || 0);
        amount = saved ? (mech.halfOnSave ? Math.floor(full / 2) : 0) : full;
      }
      landed = !saved;
    } else if (dice) {
      // No attack, no save - automatic (Magic Missile).
      amount = roll(dice, { rng }).total + (mech.damageFlat || 0);
    }

    results.push({
      target: target?.name || null, amount, landed,
      condition: (!landed || !mech.save) ? null : (mech.condition || null),
      saveRoll: saveRoll?.total ?? null, attackRoll: attackRoll?.total ?? null,
      crit: Boolean(attackRoll?.isCrit),
    });
    total += amount;
  }

  return {
    executable: true, total, results, dice, projectiles,
    events: [{
      type: 'spell_cast',
      payload: {
        spell: spell.name, level: slotLevel ?? spell.level, simulated: true,
        damage: total, healing: 0, targets: results.length,
      },
    }],
  };
}

/* ------------------------------------------------------------------ */
/* damage, concentration, death                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolve resistance / immunity / vulnerability for one damage instance.
 *
 * Order matters and is the 2024 rule: immunity wins outright, then
 * vulnerability doubles, then resistance halves, rounding down. Applying
 * resistance before vulnerability would give a different answer on a hit that
 * is both.
 *
 * Untyped damage (damageType null) is never mitigated - the simulator would
 * otherwise halve every attack for a character resistant to anything, which
 * is far worse than not modelling it at all.
 */
/**
 * The thirteen damage types, in the order a list is scanned.
 *
 * Kept here beside mitigate(), the thing that consumes them, so a screen
 * offering a choice and the engine resolving it cannot drift apart on
 * spelling. Matching is case-insensitive but not fuzzy: "Fire " or "fire
 * damage" would silently never match a resistance, and silently is the
 * whole problem this list exists to avoid.
 */
export const DAMAGE_TYPES = [
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
  'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder',
];

export function mitigate(amount, damageType, opts = {}) {
  const { resistances = [], immunities = [], vulnerabilities = [] } = opts;
  if (!damageType) return { amount, applied: null };
  const t = String(damageType).toLowerCase();
  const has = (list) => list.some((x) => String(x).toLowerCase() === t);

  if (has(immunities)) return { amount: 0, applied: 'immune' };
  let out = amount;
  let applied = null;
  if (has(vulnerabilities)) { out *= 2; applied = 'vulnerable'; }
  if (has(resistances)) {
    out = Math.floor(out / 2);
    applied = applied ? 'vulnerable+resistant' : 'resistant';
  }
  return { amount: out, applied };
}

/**
 * Apply damage or healing to a combatant-shaped object.
 * Returns a NEW state plus events - never mutates.
 */
export function applyDamage(state, delta, opts = {}) {
  const {
    source = null, damageType = null, name = null,
    resistances = [], immunities = [], vulnerabilities = [],
  } = opts;
  const max = Number(state.hpMax ?? state.hp?.max ?? 0);
  let hp = Number(state.hp?.current ?? state.hp ?? 0);
  let temp = Number(state.temp ?? state.hp?.temp ?? 0);
  const before = hp;
  const events = [];

  if (delta < 0) {
    // Resistance and immunity are applied HERE rather than by each caller.
    // derive() has always computed these lists, but nothing consumed them, so
    // every mapped resistance was inert - a homebrew could grant Resistance to
    // all damage and measure identically to one that granted nothing.
    const mitigation = mitigate(-delta, damageType, {
      resistances, immunities, vulnerabilities,
    });
    const incoming = mitigation.amount;
    const absorbed = Math.min(temp, incoming);
    temp -= absorbed;
    hp = Math.max(0, hp - incoming + absorbed);
    events.push({
      type: 'damage_taken',
      payload: {
        target: name, amount: incoming, raw: -delta, absorbed, damageType,
        from: source, mitigation: mitigation.applied,
      },
    });
    if (before > 0 && hp === 0) events.push({ type: 'downed', payload: { name } });
  } else if (delta > 0) {
    hp = Math.min(max, hp + delta);
    events.push({ type: 'healed', payload: { target: name, amount: delta } });
  }

  const result = { hp, temp, downed: hp === 0 && before > 0, events };

  // Concentration is checked by the caller with the pre-absorption amount,
  // because temp HP does not spare you the save.
  if (delta < 0 && state.concentrating) {
    result.concentrationDc = Math.max(10, Math.floor(-delta / 2));
  }
  return result;
}

/** Concentration save: DC 10 or half the damage, whichever is higher. */
export function concentrationSave(conSaveMod, damage, rng = defaultRng) {
  const dc = Math.max(10, Math.floor(damage / 2));
  const r = d20({ mod: conSaveMod, rng });
  const held = r.total >= dc;
  return {
    dc, roll: r, held,
    events: held ? [] : [{ type: 'concentration_broken', payload: { dc, roll: r.total } }],
  };
}

/**
 * One death saving throw.
 * Returns the deltas to apply to {successes, failures} plus the outcome.
 */
export function deathSave(rng = defaultRng) {
  const r = d20({ rng });
  let successes = 0;
  let failures = 0;
  let outcome;
  if (r.nat === 20) { outcome = 'revive'; }
  else if (r.nat === 1) { failures = 2; outcome = 'critical failure'; }
  else if (r.total >= 10) { successes = 1; outcome = 'success'; }
  else { failures = 1; outcome = 'failure'; }
  return {
    roll: r, successes, failures, outcome,
    events: [{ type: 'death_save', payload: { roll: r.nat, result: outcome } }],
  };
}

/* ------------------------------------------------------------------ */
/* roll tables and triggers                                            */
/* ------------------------------------------------------------------ */

/**
 * Roll on a homebrew table.
 *
 * Rolls the DIE, not an index. This is the divergence that motivated the
 * module: picking `entries[floor(random()*length)]` is not the same thing as
 * rolling the die the table is written for, and it silently stops being
 * equivalent the moment a table has fewer entries than faces.
 */
export function rollOnTable(table, rng = defaultRng) {
  const faces = parseInt(String(table.die || '').replace(/^d/i, ''), 10)
    || table.entries.length;
  const n = rng.die(faces);
  const idx = Math.min(n, table.entries.length) - 1;
  const entry = table.entries[idx] || null;
  return {
    n, faces, entry,
    // A table with fewer entries than faces is a data problem worth surfacing
    // rather than silently clamping forever.
    short: table.entries.length < faces,
    events: [{
      type: 'homebrew_trigger',
      payload: {
        table: table.name, feature: table.from || table.name,
        rolled: n, result: entry?.text || null,
      },
    }],
  };
}

/**
 * Fire any homebrew nat-roll trigger matching this face.
 * This is what makes Fumble Into Fortune actually happen during play.
 */
export function fireTriggers(derived, nat, rng = defaultRng, { on = 'nat_roll' } = {}) {
  const fired = [];
  const events = [];
  for (const trig of derived.triggers || []) {
    if (trig.on !== on) continue;
    if (on === 'nat_roll' && !(trig.natRange || [1]).includes(nat)) continue;
    const table = (derived.rollTables || []).find((t) => t.name === trig.rollTable)
      || (derived.rollTables || [])[0];
    if (!table) {
      fired.push({ trigger: trig, table: null, result: null, unmapped: true });
      continue;
    }
    const rolled = rollOnTable({ ...table, from: trig.from }, rng);
    fired.push({ trigger: trig, table, ...rolled });
    events.push(...rolled.events);
  }
  return { fired, events };
}

/* ------------------------------------------------------------------ */
/* resources and rests                                                 */
/* ------------------------------------------------------------------ */

/** Can this cost be paid? Pure predicate, no mutation. */
export function canAfford(derived, cost) {
  if (!cost?.resource) return true;
  const res = (derived.resources || []).find((r) => r.name === cost.resource);
  if (!res) return false;
  return res.current >= (cost.amount || 0);
}

/** Spend from a pool. Returns {resourceState, events} or {error}. */
export function spendResource(character, derived, name, amount = 1) {
  const res = (derived.resources || []).find((r) => r.name === name);
  if (!res) return { error: `no resource "${name}"` };
  const current = character.resourceState?.[name] ?? res.max;
  if (current < amount) return { error: `not enough ${name}` };
  return {
    resourceState: { ...(character.resourceState || {}), [name]: current - amount },
    events: [{ type: 'resource_spent', payload: { resource: name, amount } }],
  };
}

/** Consume a spell slot. Returns {slotState, events} or {error}. */
export function useSlot(character, derived, level) {
  const slots = derived.spellcasting?.slots || [];
  const max = slots[level - 1] || 0;
  const used = character.slotState?.[level] || 0;
  if (used >= max) return { error: `no level ${level} slots left` };
  return {
    slotState: { ...(character.slotState || {}), [level]: used + 1 },
    events: [],
  };
}

/** The highest slot level with a slot still available, or null. */
export function highestAvailableSlot(character, derived) {
  const slots = derived.spellcasting?.slots || [];
  for (let lvl = slots.length; lvl >= 1; lvl -= 1) {
    if ((character.slotState?.[lvl] || 0) < slots[lvl - 1]) return lvl;
  }
  return null;
}

/**
 * Short rest: refresh short-recharge resources only, optionally spend hit dice.
 * Returns a character patch.
 */
export function shortRest(character, derived, { spendHitDice = 0, rng = defaultRng } = {}) {
  const resourceState = { ...(character.resourceState || {}) };
  for (const r of derived.resources || []) {
    if (r.recharge === 'short') delete resourceState[r.name];
  }

  let hp = derived.hp.current;
  let healed = 0;
  const hitDiceLeft = character.hitDice?.remaining ?? derived.level;
  const spend = Math.min(spendHitDice, hitDiceLeft);
  const die = character.hitDice?.die || 8;
  for (let i = 0; i < spend; i += 1) {
    const gain = rng.die(die) + (derived.mods?.con || 0);
    healed += Math.max(1, gain);
  }
  hp = Math.min(derived.hp.max, hp + healed);

  return {
    patch: {
      resourceState,
      hp: { ...character.hp, current: hp },
      hitDice: { ...(character.hitDice || {}), die, remaining: hitDiceLeft - spend },
    },
    healed,
    events: [{ type: 'rest_short', payload: { healed, hitDiceSpent: spend } }],
  };
}

/** Long rest: full HP, all slots and resources back, half hit dice, -1 exhaustion. */
export function longRest(character, derived) {
  const maxHd = derived.level;
  const remaining = character.hitDice?.remaining ?? maxHd;
  return {
    patch: {
      hp: { ...character.hp, current: derived.hp.max, temp: 0 },
      slotState: {},
      resourceState: {},
      exhaustion: Math.max(0, (character.exhaustion || 0) - 1),
      deathSaves: { successes: 0, failures: 0 },
      conditions: [],
      concentration: null,
      hitDice: {
        ...(character.hitDice || {}),
        remaining: Math.min(maxHd, remaining + Math.max(1, Math.floor(maxHd / 2))),
      },
    },
    events: [{ type: 'rest_long', payload: {} }],
  };
}
