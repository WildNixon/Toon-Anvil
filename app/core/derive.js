/**
 * The derivation engine.
 *
 * ONE pure function: (character, sources) -> derived sheet.
 *
 * Nothing computed is ever stored on the character. AC, attack bonuses, save
 * DCs, resource maxima, speeds and resistances are all recalculated from the
 * contributing sources on every read. That is what lets a homebrew feature
 * legitimately override AC or swap the ability behind your save DC without the
 * engine special-casing it - the feature simply contributes an effect, and the
 * effect competes with every other source on equal terms.
 *
 * Store a computed number instead and homebrew can never be more than
 * decoration.
 */

import {
  ABILITIES, SKILLS, abilityMod, proficiencyBonus, spellSlotsFor,
  PACT_SLOTS, toCopper, carryCapacity, encumbrance, exhaustionPenalty,
  ATTUNEMENT_LIMIT, classFormula, spellBudget,
} from './rules2024.js';
import { isActive, resolveFormula } from '../homebrew/effects.js';

/**
 * @param {object} character
 * @param {object} sources  {classes, species, backgrounds, feats, homebrew,
 *                           equipment} - compendium slices plus homebrew defs
 */
export function derive(character, sources = {}) {
  const ch = character || {};
  const toggles = ch.toggles || {};
  const totalLevel = (ch.classes || []).reduce((n, c) => n + (Number(c.level) || 0), 0) || 1;
  const pb = proficiencyBonus(totalLevel);

  /* ---- 1. gather every contributing feature ------------------------ */
  const features = collectFeatures(ch, sources);
  const ctx0 = { level: totalLevel, proficiencyBonus: pb, abilities: ch.abilities, toggles };
  const effects = features
    .flatMap((f) => (f.effects || []).map((e) => ({ ...e, _from: f })))
    .filter((e) => isActive(e, ctx0));

  const byType = (t) => effects.filter((e) => e.type === t);

  /* ---- 2. abilities ------------------------------------------------ */
  const scores = {};
  for (const ab of ABILITIES) {
    scores[ab] = Number(ch.abilities?.[ab] ?? 10)
      + Number(ch.abilityBonuses?.[ab] ?? 0);
  }
  const mods = Object.fromEntries(ABILITIES.map((a) => [a, abilityMod(scores[a])]));

  // Substitutions are resolved before anything consumes a modifier, because
  // "use Con in place of Wis" has to reach AC, save DC and everything after.
  const subs = {};
  for (const e of byType('ability_substitution')) {
    for (const scope of e.scope || ['all']) {
      subs[scope] = { replace: e.replace, with: e.with };
    }
  }
  const modFor = (ability, scope) => {
    const s = subs[scope] || subs.all;
    if (s && s.replace === ability) return mods[s.with] ?? 0;
    return mods[ability] ?? 0;
  };

  const ctx = { level: totalLevel, proficiencyBonus: pb, abilities: scores, toggles };
  const exhaustion = Number(ch.exhaustion || 0);
  const d20Penalty = exhaustionPenalty(exhaustion);

  /* ---- 3. armour class --------------------------------------------- */
  const shieldWorn = (ch.inventory || []).some(
    (i) => i.equipped && /shield/i.test(i.name || ''),
  );
  // A shield shares kind:'armor' with body armour in the equipment list,
  // but it is NOT body armour: picking it here fed armorAc('+2') a base of
  // 2 and produced AC 4 for a hero holding nothing but a shield. The +2
  // arrives once, through shieldWorn above.
  const armorWorn = (ch.inventory || []).find(
    (i) => i.equipped && i.kind === 'armor' && !/shield/i.test(i.name || ''),
  );

  const acOptions = [];
  if (armorWorn) {
    acOptions.push({
      label: armorWorn.name,
      value: armorAc(armorWorn, mods.dex),
      shield: true,
    });
  } else {
    acOptions.push({ label: 'Unarmored', value: 10 + mods.dex, shield: true });
  }
  for (const e of byType('ac_formula')) {
    // An unarmored formula only applies when no armour is worn - the usual
    // "while you aren't wearing armor" clause.
    if (armorWorn && e.requiresNoArmor !== false) continue;
    let v = Number(e.base || 10) + modFor(e.ability || 'dex', 'unarmored_defense');
    if (e.secondAbility) v += modFor(e.secondAbility, 'unarmored_defense');
    acOptions.push({ label: e._from?.name || 'Feature', value: v,
                     shield: e.allowShield !== false });
  }
  const best = acOptions.reduce((a, b) => (b.value > a.value ? b : a));
  const ac = best.value + (shieldWorn && best.shield ? 2 : 0)
    + Number(ch.acBonus || 0);

  /* ---- 4. hit points, speed, senses -------------------------------- */
  const speeds = { walk: Number(ch.speed || sources.speciesSpeed || 30) };
  for (const e of byType('speed_grant')) {
    speeds[e.mode] = e.value === 'equal' ? speeds.walk : Number(e.value) || 0;
  }

  /* ---- 5. saves and skills ----------------------------------------- */
  const saveProfs = new Set(ch.savingThrows || classSaves(ch, sources));
  const saves = Object.fromEntries(ABILITIES.map((ab) => {
    const prof = saveProfs.has(ab);
    return [ab, {
      proficient: prof,
      mod: modFor(ab, 'save') + (prof ? pb : 0) + d20Penalty,
    }];
  }));

  const skillProfs = new Set((ch.skills || []).map((s) => s.toLowerCase()));
  const expertise = new Set((ch.expertise || []).map((s) => s.toLowerCase()));
  for (const e of byType('proficiency')) {
    if (e.kind === 'skill') for (const v of e.values || []) skillProfs.add(v.toLowerCase());
  }
  const skills = Object.fromEntries(Object.entries(SKILLS).map(([skill, ab]) => {
    const prof = skillProfs.has(skill);
    const exp = expertise.has(skill);
    return [skill, {
      ability: ab,
      proficient: prof,
      expertise: exp,
      mod: mods[ab] + (exp ? pb * 2 : prof ? pb : 0) + d20Penalty,
    }];
  }));

  const passivePerception = 10 + skills.perception.mod;

  /* ---- 6. attacks --------------------------------------------------- */
  // Last writer wins, and collectFeatures emits class features before subclass
  // ones - so an ingested subclass's strike correctly supersedes Martial Arts.
  // Expanded crit range (Champion's Improved Critical). Lowest wins, since
  // effects that widen the range stack downward rather than replace.
  const critRange = byType('crit_range')
    .reduce((lo, e) => Math.min(lo, Number(e.range) || 20), 20);

  const unarmedOverride = byType('unarmed_strike').at(-1);
  const unarmedAbility = unarmedOverride?.ability || 'str';
  const unarmedDie = unarmedOverride
    ? (classFormula(unarmedOverride.die, unarmedOverride._from?.classLevel ?? totalLevel)
       ?? unarmedOverride.die)
    : '1';
  const attacks = [{
    name: 'Unarmed Strike',
    kind: 'unarmed',
    ability: unarmedAbility,
    attackBonus: modFor(unarmedAbility, 'attack') + pb + d20Penalty,
    damage: unarmedDie,
    damageBonus: modFor(unarmedAbility, 'attack'),
    damageTypes: unarmedOverride?.types || ['bludgeoning'],
    magical: Boolean(unarmedOverride?.magical),
    source: unarmedOverride?._from?.name || 'Base rules',
  }];

  for (const item of (ch.inventory || [])) {
    if (!item.equipped || item.kind !== 'weapon') continue;
    const finesse = /finesse/i.test(item.properties || '');
    const ranged = /ammunition|thrown/i.test(item.properties || '')
      && /ranged/i.test(item.category || '');
    const ab = ranged ? 'dex' : finesse && mods.dex > mods.str ? 'dex' : 'str';
    attacks.push({
      name: item.name,
      kind: 'weapon',
      ability: ab,
      attackBonus: modFor(ab, 'attack') + pb + d20Penalty,
      damage: (item.damage || '').replace(/\s*[A-Za-z]+$/, '') || '1d4',
      damageBonus: modFor(ab, 'attack'),
      damageTypes: [(item.damage || '').match(/[A-Za-z]+$/)?.[0]?.toLowerCase() || 'bludgeoning'],
      properties: item.properties,
      mastery: item.mastery,
      source: item.name,
    });
  }

  // Rider dice may be a named class progression (Sneak Attack scales 1d6 ->
  // 10d6), so resolve them here rather than leaving "sneakAttackDice" to reach
  // the dice parser as a literal and silently roll nothing.
  const riders = byType('damage_rider').map((e) => ({
    ...e,
    dice: classFormula(e.dice, e._from?.classLevel ?? totalLevel) ?? e.dice,
    source: e._from?.name || null,
  }));

  // Extra Attack is a plain class feature with no effect attached, but it is
  // worth 2-4x a martial's entire damage output. Reading it off the feature
  // list keeps it in one place rather than special-cased in the simulator.
  let attacksPerAction = 1;
  for (const f of features) {
    if (/^Extra Attack/i.test(f.name)) {
      const m = /(twice|three times|four times)/i.exec(f.text || '');
      const n = m ? ({ twice: 2, 'three times': 3, 'four times': 4 })[m[1].toLowerCase()] : 2;
      attacksPerAction = Math.max(attacksPerAction, n);
    }
  }

  /* ---- 7. spellcasting ---------------------------------------------- */
  const castingAbility = ch.spellcastingAbility
    || classCastingAbility(ch, sources);
  const castMod = castingAbility ? modFor(castingAbility, 'save_dc') : 0;
  const spellSaveDc = castingAbility ? 8 + pb + castMod : null;
  const spellAttack = castingAbility ? pb + modFor(castingAbility, 'spell_attack') : null;

  const slots = spellSlotsFor(ch.classes || []);
  const warlockLevel = (ch.classes || [])
    .filter((c) => String(c.class).toLowerCase() === 'warlock')
    .reduce((n, c) => n + c.level, 0);
  const pact = warlockLevel ? PACT_SLOTS[Math.min(20, warlockLevel)] : null;

  const alwaysPrepared = [];
  for (const e of byType('always_prepared_spells')) {
    for (const [lvl, names] of Object.entries(e.byLevel || {})) {
      if (totalLevel >= Number(lvl)) {
        for (const n of names) {
          alwaysPrepared.push({ name: n, from: e._from?.name, atLevel: Number(lvl) });
        }
      }
    }
  }

  /* ---- 8. resources -------------------------------------------------- */
  const resources = [];
  for (const e of byType('resource')) {
    // Class resources scale with THAT class's level, not the character's total.
    const lvl = e._from?.classLevel ?? totalLevel;
    const max = classFormula(e.max, lvl)
      ?? resolveFormula(e.max, { ...ctx, level: lvl });
    const current = ch.resourceState?.[e.name];
    resources.push({
      name: e.name,
      max,
      current: current === undefined ? max : Math.min(current, max),
      recharge: e.recharge || 'long',
      source: e._from?.name,
    });
  }

  /* ---- 9. defences --------------------------------------------------- */
  const resistances = dedupe(byType('resistance').flatMap((e) => e.types || []));
  const immunities = dedupe(byType('immunity').flatMap((e) => e.types || []));
  const conditionImmunities = dedupe(
    byType('condition_immunity').flatMap((e) => e.conditions || []),
  );

  /* ---- 10. things the combat screen can act on ------------------------ */
  const actions = byType('action_option').map((e) => ({ ...e, from: e._from?.name }));
  const reactions = byType('reaction_option').map((e) => ({ ...e, from: e._from?.name }));
  const rollTables = byType('roll_table').map((e) => ({ ...e, from: e._from?.name }));
  const triggers = byType('trigger').map((e) => ({ ...e, from: e._from?.name }));
  const advantages = byType('advantage_rule').map((e) => ({ ...e, from: e._from?.name }));
  // Toggles are read from ALL features, not just active ones: a toggle gated on
  // itself could never be switched on.
  const toggleDefs = features
    .flatMap((f) => (f.effects || []).filter((e) => e.type === 'toggle')
      .map((e) => ({ ...e, from: f.name })));

  /* ---- 11. inventory ------------------------------------------------- */
  const carried = (ch.inventory || []).reduce(
    (n, i) => n + (parseFloat(i.weight) || 0) * (i.qty || 1), 0,
  );
  const attuned = (ch.inventory || []).filter((i) => i.attuned);

  return {
    id: ch.id,
    name: ch.name,
    level: totalLevel,
    proficiencyBonus: pb,
    classes: ch.classes || [],
    abilities: scores,
    mods,
    substitutions: subs,
    exhaustion,
    d20Penalty,

    ac,
    acOptions,
    acSource: best.label,
    shieldWorn,
    initiative: modFor('dex', 'initiative') + Number(ch.initiativeBonus || 0) + d20Penalty,
    speeds,
    hp: hitPoints(ch, sources, modFor('con')),
    hitDice: ch.hitDice || {},
    deathSaves: ch.deathSaves || { successes: 0, failures: 0 },

    saves,
    skills,
    passivePerception,

    attacks,
    attacksPerAction,
    critRange,
    damageRiders: riders,

    spellcasting: castingAbility ? {
      ability: castingAbility,
      mod: castMod,
      saveDc: spellSaveDc,
      attackBonus: spellAttack,
      slots,
      slotState: ch.slotState || {},
      pact,
      alwaysPrepared,
      prepared: ch.spells?.prepared || [],
      known: ch.spells?.known || [],
      budget: spellBudgetFor(ch, sources),
    } : null,

    resources,
    resistances,
    immunities,
    conditionImmunities,
    conditions: ch.conditions || [],
    concentration: ch.concentration || null,

    actions,
    reactions,
    rollTables,
    triggers,
    advantages,
    toggles: toggleDefs,
    toggleState: toggles,

    features,
    inventory: ch.inventory || [],
    currency: ch.currency || {},
    copper: toCopper(ch.currency || {}),
    carried: Math.round(carried * 10) / 10,
    capacity: carryCapacity(scores.str),
    encumbrance: encumbrance(scores.str, carried),
    attuned: attuned.length,
    attunementLimit: ATTUNEMENT_LIMIT,

    // Anything the ingest could not map still reaches the sheet as prose.
    unmappedFeatures: features.filter(
      (f) => !(f.effects || []).some((e) => e.type !== 'narrative_only'),
    ).length,
  };
}

/* ------------------------------------------------------------------ */
/* sources                                                             */
/* ------------------------------------------------------------------ */

function collectFeatures(ch, sources) {
  const out = [];
  const overlay = sources.srdEffects || {};
  const push = (f, origin, level, extra = {}) => {
    if (!f) return;
    out.push({
      name: f.name, text: f.text || f.description || '',
      level: level ?? f.level ?? 1, origin,
      effects: f.effects || [], id: f.id || `${origin}:${f.name}`,
      ...extra,
    });
  };

  const species = (sources.species || []).find((s) => s.id === ch.species);
  if (species) {
    for (const t of species.traits || []) push(t, `Species (${species.name})`, 1);
  }

  const bg = (sources.backgrounds || []).find((b) => b.id === ch.background);
  if (bg) push({ name: bg.name, text: bg.text }, 'Background', 1);

  for (const entry of ch.classes || []) {
    const cls = (sources.classes || []).find(
      (c) => c.id === String(entry.class).toLowerCase(),
    );
    if (cls) {
      const classEffects = overlay[cls.id] || {};
      for (const f of cls.features || []) {
        if (f.level > entry.level) continue;
        // SRD features carry no effects of their own; the overlay supplies the
        // mechanically load-bearing ones (resource pools, unarmored defense).
        push({ ...f, effects: classEffects[f.name] || [] },
          `${cls.name} ${f.level}`, f.level, { classLevel: entry.level });
      }
      // Subclass: homebrew FIRST, then bundled. On an id collision the
      // ingested version wins - the user (or the corpus harness) put it
      // there deliberately, and the bundled SRD copy carries thinner
      // mechanics. The old SRD-first order silently shadowed every corpus
      // brew whose id matched a bundled subclass, so the simulator measured
      // the compendium's empty effect lists while claiming to measure the
      // mapper's output.
      const sub = (sources.homebrew || []).find((h) => h.id === entry.subclass)
        || (cls.subclasses || []).find((s) => s.id === entry.subclass);
      if (sub) {
        for (const f of sub.features || []) {
          if (f.level > entry.level) continue;
          // SRD SUBCLASS features need the overlay too. Applying it only to
          // class features left every SRD subclass mechanically inert - the
          // Open Hand monk had literally zero control, which made it useless
          // as a comparison baseline. Homebrew subclasses carry their own
          // effects from ingest, so this only fills in bundled content.
          push(
            { ...f, effects: (f.effects || []).length ? f.effects : (classEffects[f.name] || []) },
            `${sub.name} ${f.level}`, f.level, { classLevel: entry.level },
          );
        }
      }
    }
  }

  for (const featId of ch.feats || []) {
    const feat = (sources.feats || []).find((f) => f.id === featId);
    if (feat) push(feat, 'Feat', 1);
  }

  for (const f of ch.customFeatures || []) push(f, 'Custom', f.level);
  return out;
}

/**
 * Maximum hit points, derived rather than stored.
 *
 * This used to read ch.hp.max straight back out, which was set to 10 when the
 * character was created and never recalculated. Every character in the app had
 * 10 HP at every level, and no screen let you edit it - while the simulator
 * computed HP properly, so the two engines disagreed about the single most
 * important number on the sheet.
 *
 * Uses the 2024 fixed-value rule and the SAME arithmetic as the simulator's
 * makeCharacter(): maximum die at first level, the die's average (die/2 + 1)
 * for every level after, Constitution modifier on every level. Multiclassing
 * only gets the maximum-die bonus once, for the very first level taken.
 *
 * `ch.hp.override` wins if set, so a table that rolls for HP - or a DM handing
 * out a flat total - is not fought with. current/temp stay stored, because
 * those are play state and deriving them would undo every point of damage on
 * the next render.
 */
export function hitPoints(ch, sources, conMod = 0) {
  const stored = {
    current: Number(ch.hp?.current ?? 0),
    temp: Number(ch.hp?.temp || 0),
  };
  const override = Number(ch.hp?.override || 0);

  let max = 0;
  let first = true;
  for (const entry of ch.classes || []) {
    const level = Number(entry.level) || 0;
    if (level <= 0) continue;
    const die = (sources.classes || []).find((c) => c.id === entry.class)?.hitDie || 8;
    const avg = Math.floor(die / 2) + 1;
    // First level of the FIRST class takes the whole die; everything else takes
    // the average. Con applies to every level, including levels from a second
    // class, which is why this is summed per entry rather than per character.
    max += (first ? die : avg) + conMod;
    max += (level - 1) * (avg + conMod);
    first = false;
  }
  // A negative Con on a low-level character must not produce 0 or less.
  max = Math.max(1, override || max || Number(ch.hp?.max || 0));

  // Current HP is play state, so it is taken as-is and only clamped to the
  // maximum. Nothing clever here on purpose: an earlier version tried to infer
  // "this character was at full health under its old maximum" by comparing
  // current against the STORED max, which is stale the moment HP becomes
  // derived - so a character on 27 of a stale max of 10 read as full and
  // healed itself on every render. Damage could never stick.
  //
  // Migrating a character whose stored maximum is out of date is a WRITE, and
  // writes belong in app.js where saving is allowed, not in a pure function.
  return {
    max,
    current: ch.hp?.current === undefined
      ? max
      : Math.max(0, Math.min(stored.current, max)),
    temp: stored.temp,
    derived: !override,
  };
}

function classSaves(ch, sources) {
  const first = (ch.classes || [])[0];
  if (!first) return [];
  const cls = (sources.classes || []).find(
    (c) => c.id === String(first.class).toLowerCase(),
  );
  return cls?.savingThrows || [];
}

const CASTING_ABILITY = {
  bard: 'cha', cleric: 'wis', druid: 'wis', paladin: 'cha', ranger: 'wis',
  sorcerer: 'cha', warlock: 'cha', wizard: 'int',
};

function classCastingAbility(ch) {
  for (const c of ch.classes || []) {
    const ab = CASTING_ABILITY[String(c.class).toLowerCase()];
    if (ab) return ab;
  }
  return null;
}

/** Cantrip/prepared allowances summed across casting classes, or null. */
function spellBudgetFor(ch, sources) {
  let budget = null;
  for (const entry of ch.classes || []) {
    const def = (sources.classes || []).find(
      (x) => x.id === String(entry.class).toLowerCase());
    const b = def ? spellBudget(def, entry.level) : null;
    if (!b) continue;
    budget = budget || { cantrips: 0, prepared: 0 };
    budget.cantrips += b.cantrips;
    budget.prepared += b.prepared;
  }
  return budget;
}

function armorAc(item, dexMod) {
  const spec = String(item.ac || item.armorClass || '10');
  const base = parseInt(spec, 10) || 10;
  if (/\+\s*dex/i.test(spec)) {
    const cap = /max\s*(\d+)/i.exec(spec);
    const capped = cap ? Math.min(dexMod, parseInt(cap[1], 10)) : dexMod;
    return base + (/\(max 2\)/i.test(spec) ? Math.min(dexMod, 2) : capped);
  }
  return base;
}

function dedupe(list) {
  return [...new Set(list.map((s) => String(s).toLowerCase()))];
}
