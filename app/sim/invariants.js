/**
 * Invariant assertions.
 *
 * These are the objective half of the grade. Every one is a statement about
 * legal game state that must hold at every tick regardless of class, level or
 * dice - "hit points are never above maximum", "you cannot spend a resource you
 * do not have". A violation is a defect in the app, full stop; there is nothing
 * to interpret and no threshold to argue about.
 *
 * Each check records WHERE it fired (class, subclass, level, round) so the
 * report can point at a reproduction rather than a count.
 */

export const INVARIANTS = [
  {
    id: 'hp_within_bounds',
    desc: 'current HP is between 0 and max',
    check: (s) => {
      const { current, max } = s.derived.hp;
      if (current > max) return `hp ${current} > max ${max}`;
      if (current < 0) return `hp ${current} < 0`;
      return null;
    },
  },
  {
    id: 'temp_hp_non_negative',
    desc: 'temporary HP is never negative',
    check: (s) => (s.derived.hp.temp < 0 ? `temp ${s.derived.hp.temp} < 0` : null),
  },
  {
    id: 'resources_within_pool',
    desc: 'every resource is within [0, max]',
    check: (s) => {
      for (const r of s.derived.resources) {
        if (r.current < 0) return `${r.name} ${r.current} < 0`;
        if (r.current > r.max) return `${r.name} ${r.current} > max ${r.max}`;
      }
      return null;
    },
  },
  {
    id: 'slots_within_pool',
    desc: 'spell slots used never exceed slots available',
    check: (s) => {
      const sc = s.derived.spellcasting;
      if (!sc) return null;
      for (const [lvl, used] of Object.entries(s.character.slotState || {})) {
        const max = sc.slots[Number(lvl) - 1] || 0;
        if (used > max) return `level ${lvl}: ${used} used of ${max}`;
        if (used < 0) return `level ${lvl}: negative usage ${used}`;
      }
      return null;
    },
  },
  {
    id: 'prepared_within_budget',
    desc: 'chosen spells never exceed the class tables\' allowance',
    // Null-safe on purpose: the simulator's characters never choose spells
    // (their loadouts are approximated policy-side), so this can only fire
    // for a real character built in the app.
    check: (s) => {
      const sc = s.derived.spellcasting;
      if (!sc || !sc.budget) return null;
      const known = (s.character.spells?.known || []).length;
      const prepared = (s.character.spells?.prepared || []).length;
      if (known > sc.budget.cantrips) {
        return `${known} cantrips of ${sc.budget.cantrips} allowed`;
      }
      if (prepared > sc.budget.prepared) {
        return `${prepared} prepared of ${sc.budget.prepared} allowed`;
      }
      return null;
    },
  },
  {
    id: 'gold_non_negative',
    desc: 'wealth never goes negative',
    check: (s) => (s.derived.copper < 0 ? `copper ${s.derived.copper}` : null),
  },
  {
    id: 'attunement_limit',
    desc: 'at most three attuned items',
    check: (s) => (s.derived.attuned > s.derived.attunementLimit
      ? `${s.derived.attuned} attuned` : null),
  },
  {
    id: 'single_concentration',
    desc: 'at most one concentration effect',
    check: (s) => (Array.isArray(s.character.concentration)
      && s.character.concentration.length > 1
      ? `${s.character.concentration.length} concurrent` : null),
  },
  {
    id: 'exhaustion_range',
    desc: 'exhaustion stays within 0-6',
    check: (s) => {
      const e = s.character.exhaustion || 0;
      return (e < 0 || e > 6) ? `exhaustion ${e}` : null;
    },
  },
  {
    id: 'ac_is_sane',
    desc: 'AC stays within a plausible range',
    check: (s) => {
      const ac = s.derived.ac;
      if (!Number.isFinite(ac)) return `AC is ${ac}`;
      if (ac < 5 || ac > 30) return `AC ${ac} outside 5-30`;
      return null;
    },
  },
  {
    id: 'proficiency_matches_level',
    desc: 'proficiency bonus follows the level table',
    check: (s) => {
      const expected = 2 + Math.floor((Math.min(20, s.derived.level) - 1) / 4);
      return s.derived.proficiencyBonus !== expected
        ? `PB ${s.derived.proficiencyBonus} at level ${s.derived.level}, expected ${expected}`
        : null;
    },
  },
  {
    id: 'death_saves_bounded',
    desc: 'death saves never exceed 3 successes or 3 failures',
    check: (s) => {
      const d = s.character.deathSaves || {};
      if ((d.successes || 0) > 3) return `${d.successes} successes`;
      if ((d.failures || 0) > 3) return `${d.failures} failures`;
      return null;
    },
  },
  {
    id: 'hit_dice_bounded',
    desc: 'hit dice remaining never exceeds character level',
    check: (s) => {
      const hd = s.character.hitDice || {};
      if (hd.remaining === undefined) return null;
      if (hd.remaining < 0) return `${hd.remaining} remaining`;
      if (hd.remaining > s.derived.level) {
        return `${hd.remaining} remaining at level ${s.derived.level}`;
      }
      return null;
    },
  },
  {
    id: 'attacks_have_finite_bonus',
    desc: 'every attack has a finite bonus and damage expression',
    check: (s) => {
      for (const a of s.derived.attacks) {
        if (!Number.isFinite(a.attackBonus)) return `${a.name}: bonus ${a.attackBonus}`;
        if (!a.damage || /NaN|undefined/.test(String(a.damage))) {
          return `${a.name}: damage "${a.damage}"`;
        }
      }
      return null;
    },
  },
  {
    id: 'derived_has_no_nan',
    desc: 'no derived numeric field is NaN',
    check: (s) => {
      for (const key of ['ac', 'initiative', 'passivePerception', 'proficiencyBonus']) {
        if (Number.isNaN(s.derived[key])) return `${key} is NaN`;
      }
      return null;
    },
  },
];

/**
 * Run every invariant against a snapshot.
 * @returns {Array<{id, desc, detail, where}>} violations (empty when clean)
 */
export function checkAll(snapshot, where = {}) {
  const out = [];
  for (const inv of INVARIANTS) {
    let detail;
    try {
      detail = inv.check(snapshot);
    } catch (err) {
      // A check that throws is itself a finding - usually a missing field.
      detail = `check threw: ${err.message}`;
    }
    if (detail) out.push({ id: inv.id, desc: inv.desc, detail, where: { ...where } });
  }
  return out;
}

export const INVARIANT_IDS = INVARIANTS.map((i) => i.id);
