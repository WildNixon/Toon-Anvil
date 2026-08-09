/**
 * Tactical policy.
 *
 * ONE policy, used by every class. That is a deliberate constraint, not
 * laziness: a hand-tuned per-class policy would embed my opinion about how each
 * class should be played, and cross-class comparisons would then be measuring
 * my tactics rather than the classes.
 *
 * Because the policy is identical and the seeds are paired, it CANCELS in
 * ablation - comparing a character to itself with one feature toggled is
 * unaffected by how good or bad the policy is. That is why ablation is the
 * primary instrument and cross-class rankings carry a caveat.
 *
 * The policy is greedy on expected damage, with three overrides: heal when
 * someone is about to die, spend resources when the fight is going badly, and
 * never waste a high slot on a nearly-dead target.
 */

import { expectedDamage, highestAvailableSlot, canAfford } from '../core/engine.js';
import { average } from '../core/dice.js';
import { reactionVerdict } from './executable.js';

/** Fraction of max HP below which we consider a combatant in danger. */
export const DANGER_HP = 0.35;
/** Enemy HP remaining above which the fight counts as "serious". */
export const SERIOUS_FIGHT = 0.5;

/**
 * Choose this turn's action.
 *
 * @returns {{kind:'attack'|'spell'|'feature'|'dodge', ...}}
 */
export function chooseAction(ctx) {
  const {
    character, derived, enemies, party, spells, mechanics, rng,
  } = ctx;

  const living = enemies.filter((e) => e.hp > 0);
  if (!living.length) return { kind: 'none' };

  const worstAlly = party.filter((p) => p.hp > 0)
    .reduce((a, b) => (b.hp / b.hpMax < a.hp / a.hpMax ? b : a), party[0]);
  const inDanger = worstAlly && worstAlly.hp / worstAlly.hpMax < DANGER_HP;

  const enemyHpLeft = living.reduce((n, e) => n + e.hp, 0)
    / Math.max(1, enemies.reduce((n, e) => n + e.hpMax, 0));
  const serious = enemyHpLeft > SERIOUS_FIGHT;

  // A bonus-action feature is ADDITIVE - it rides along with whatever the main
  // action turns out to be. Treating it as a competing candidate would make a
  // free bonus-action ability cost the character its entire Attack action,
  // which is the opposite of how the action economy works.
  const bonus = bestFeatureAction(ctx, serious, 'bonus');

  // --- 1. emergency healing outranks damage
  if (inDanger && derived.spellcasting) {
    const heal = bestHealingSpell(ctx);
    if (heal) {
      return { kind: 'spell', ...heal, target: worstAlly, reason: 'triage', bonus };
    }
  }

  // --- 2. best damaging option
  const target = pickTarget(living);
  const candidates = [];

  for (const atk of derived.attacks) {
    candidates.push({
      kind: 'attack', attack: atk, target,
      score: expectedDamage(atk, target.ac, riderDice(derived)),
    });
  }

  if (derived.spellcasting) {
    const spell = bestDamageSpell(ctx, target, living, serious);
    if (spell) candidates.push(spell);
  }

  // Only main-action features compete with attacking for the action.
  const feature = bestFeatureAction(ctx, serious, 'action');
  if (feature) candidates.push(feature);

  if (!candidates.length) return { kind: 'dodge', bonus };
  candidates.sort((a, b) => b.score - a.score);
  return { ...candidates[0], bonus };
}

/** Focus fire: the enemy we can most plausibly finish. */
function pickTarget(living) {
  return living.reduce((a, b) => (b.hp < a.hp ? b : a));
}

/** Damage riders that always apply (e.g. Apotheosis while active). */
function riderDice(derived) {
  return (derived.damageRiders || [])
    .filter((r) => r.trigger === 'unarmed_hit' || r.trigger === 'on_hit')
    .map((r) => ({ dice: r.dice, type: r.damageType, source: r._from?.name }));
}

/**
 * Best damaging spell we can pay for.
 *
 * Slot choice is deliberately conservative: never burn a slot bigger than the
 * fight warrants, and never cast an area spell at a lone target when a cantrip
 * would do. Otherwise a simulated caster empties its book on the first goblin.
 */
function bestDamageSpell(ctx, target, living, serious) {
  const { character, derived, spells, mechanics } = ctx;
  const sc = derived.spellcasting;
  const known = preparedList(ctx);
  let best = null;

  for (const entry of known) {
    const spell = spells.find((s) => s.name === entry.name);
    if (!spell) continue;
    const mech = mechanics[spell.id];
    if (!mech?.executable || !(mech.damage || mech.rider)) continue;

    // Cantrips are free; levelled spells need a slot.
    let slotLevel = null;
    if (spell.level > 0) {
      if (!serious) continue;
      slotLevel = highestAvailableSlot(character, derived);
      if (slotLevel === null || slotLevel < spell.level) continue;
      // Do not overcast: cap the slot at 2 above the base level.
      slotLevel = Math.min(slotLevel, spell.level + 2);
    }

    const targetsHit = mech.area ? Math.min(living.length, 4) : 1;
    const dice = mech.damage || mech.rider?.dice || '0';
    let score = average(dice) * targetsHit;
    if (mech.projectiles) score = average(dice) * mech.projectiles;
    if (mech.save) score *= mech.halfOnSave ? 0.75 : 0.55;
    if (mech.attackRoll) score *= 0.65;
    // Slots are scarce; discount by how deep into the reserve we are digging.
    if (slotLevel) score *= 1 - 0.06 * slotLevel;

    if (!best || score > best.score) {
      best = { kind: 'spell', spell, mech, slotLevel, target, score };
    }
  }
  return best;
}

function bestHealingSpell(ctx) {
  const { character, derived, spells, mechanics } = ctx;
  const known = preparedList(ctx);
  let best = null;
  for (const entry of known) {
    const spell = spells.find((s) => s.name === entry.name);
    if (!spell) continue;
    const mech = mechanics[spell.id];
    if (!mech?.executable || !mech.healing) continue;
    if (spell.level > 0) {
      const slot = highestAvailableSlot(character, derived);
      if (slot === null || slot < spell.level) continue;
      const score = average(String(mech.healing));
      if (!best || score > best.score) {
        best = { spell, mech, slotLevel: Math.min(slot, spell.level + 1), score };
      }
    }
  }
  return best;
}

/**
 * The spells this character would have prepared.
 *
 * The app does not force a prepared list during simulation, so approximate it:
 * always-prepared spells from features (homebrew grants these), plus the
 * highest-value options from the class list at or below the castable level.
 */
function preparedList(ctx) {
  const { derived, classLevel, classDef } = ctx;
  const out = [...(derived.spellcasting?.alwaysPrepared || [])];
  const maxLevel = (derived.spellcasting?.slots || []).length;
  const list = classDef?.spellList || [];
  for (const s of list) {
    if (s.level === null || s.level > maxLevel) continue;
    out.push(s);
  }
  return out;
}

/**
 * The best feature action for one slot of the action economy.
 *
 * `economy` is 'action' or 'bonus'; they are chosen independently because a
 * character gets one of each per turn.
 *
 * A COSTED option is held back for a serious fight, so the sim does not spend
 * Sorcery Points on a single rat and then report the class as resource-starved.
 * A FREE option has nothing to conserve and fires whenever it is available -
 * an earlier version skipped every costless action outright, which silently
 * excluded 158 of the 159 action options in the corpus from ever executing.
 */
function bestFeatureAction(ctx, serious, economy) {
  const { derived } = ctx;
  for (const action of derived.actions || []) {
    if ((action.action || 'action') !== economy) continue;
    if (action.cost && !serious) continue;
    if (!canAfford(derived, action.cost)) continue;
    // Feature actions have no directly comparable damage number, so score them
    // just under a plain attack: a main action uses them when attacks are not
    // better. (Bonus actions are additive and never scored against anything.)
    return {
      kind: 'feature', action,
      score: bestAttackScore(derived) * 0.9,
    };
  }
  return null;
}

function bestAttackScore(derived) {
  return Math.max(
    0, ...derived.attacks.map((a) => expectedDamage(a, 14)),
  );
}

/* ------------------------------------------------------------------ */
/* rest and recovery decisions                                         */
/* ------------------------------------------------------------------ */

/** Should the party short rest now? */
/**
 * The first affordable, executable reaction matching this event - the same
 * first-match posture as bestFeatureAction, because reactions have no
 * comparable score either. `event` is {bucket, hit}; the verdict comes from
 * executable.js so the registry's honesty and the sim's behaviour cannot
 * disagree. derived.reactions has existed since derive first shipped and
 * was read by NOTHING until this function.
 */
export function chooseReaction(derived, event) {
  for (const r of derived.reactions || []) {
    if (r.trigger !== event.bucket) continue;
    if (!reactionVerdict(r).executable) continue;
    if (r.damageTypes?.length && !r.damageTypes.includes(event.hit.type)) continue;
    // Nearly no corpus reaction parses a cost, so most ride free - the real
    // limiter is the once-per-round reaction budget in the campaign loop.
    if (!canAfford(derived, r.cost)) continue;
    return r;
  }
  return null;
}

export function shouldShortRest(derived, encountersSinceRest) {
  const hpFrac = derived.hp.current / Math.max(1, derived.hp.max);
  const shortResources = derived.resources.filter((r) => r.recharge === 'short');
  const depleted = shortResources.some((r) => r.current / Math.max(1, r.max) < 0.34);
  return hpFrac < 0.6 || depleted || encountersSinceRest >= 3;
}

/** How many hit dice to spend on a short rest. */
export function hitDiceToSpend(derived) {
  const missing = derived.hp.max - derived.hp.current;
  if (missing <= 0) return 0;
  const perDie = 4.5 + (derived.mods?.con || 0);
  return Math.max(0, Math.min(
    Math.ceil(missing / Math.max(1, perDie)),
    derived.level,
  ));
}
