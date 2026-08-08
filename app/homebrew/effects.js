/**
 * The effect vocabulary.
 *
 * This is the contract between homebrew PROSE and the rules ENGINE. A feature
 * ingested from an HTML page is, by default, `narrative_only`: it renders as
 * text and does nothing mechanically. Attaching effects from this fixed
 * vocabulary is what makes it fire in combat.
 *
 * The vocabulary is deliberately small and closed. Every entry here is
 * something derive.js knows how to apply. Adding a new effect type means
 * teaching the engine, not just the editor - so unmapped prose stays prose
 * rather than accumulating a pile of half-honoured pseudo-rules.
 *
 * A partially mapped subclass is fully playable. That is the load-bearing
 * concession of the whole ingest design.
 */

import { abilityMod } from '../core/rules2024.js';

/** @typedef {{type:string, [k:string]:any}} Effect */

export const EFFECT_TYPES = {
  ac_formula: {
    label: 'AC formula',
    hint: 'Unarmored/alternate AC, e.g. 13 + Dex modifier',
    fields: { base: 'number', ability: 'ability', allowShield: 'boolean',
              secondAbility: 'ability?' },
    example: { base: 13, ability: 'dex', allowShield: true },
  },
  unarmed_strike: {
    label: 'Unarmed strike',
    hint: 'Changes the damage die, damage types, or attack ability',
    fields: { die: 'dice', types: 'damageTypes', ability: 'ability',
              magical: 'boolean' },
    example: { die: '1d8', types: ['bludgeoning', 'piercing', 'slashing'],
               ability: 'cha', magical: true },
  },
  ability_substitution: {
    label: 'Use one ability in place of another',
    hint: 'e.g. Constitution in place of Wisdom for save DC and Unarmored Defense',
    fields: { replace: 'ability', with: 'ability', scope: 'scopeList' },
    example: { replace: 'wis', with: 'con', scope: ['unarmored_defense', 'save_dc'] },
  },
  resource: {
    label: 'Resource pool',
    hint: 'A spendable pool: Sorcery Points, Focus Points, uses per rest',
    fields: { name: 'string', max: 'formula', recharge: 'recharge' },
    example: { name: 'Sorcery Points', max: 'level', recharge: 'long' },
  },
  action_option: {
    label: 'Action / bonus action / reaction',
    hint: 'Something the character can DO on their turn, with a cost',
    fields: { name: 'string', action: 'actionType', cost: 'cost', range: 'string',
              save: 'save', text: 'text' },
    example: { name: 'Hard Pull', action: 'bonus',
               cost: { resource: 'Sorcery Points', amount: 1 }, range: '60 feet',
               save: { ability: 'str', dc: 'spell' } },
  },
  damage_rider: {
    label: 'Extra damage',
    hint: 'Bonus damage on a trigger, optionally gated behind a toggle',
    fields: { trigger: 'trigger', dice: 'dice', damageType: 'damageType',
              requiresToggle: 'string?' },
    example: { trigger: 'unarmed_hit', dice: '2d8', damageType: 'force',
               requiresToggle: 'apotheosis' },
  },
  crit_range: {
    label: 'Expanded critical range',
    hint: 'Score a critical hit on a lower roll, e.g. 19-20',
    fields: { range: 'number' },
    example: { range: 19 },
  },
  resistance:  { label: 'Damage resistance', fields: { types: 'damageTypes' },
                 example: { types: ['poison'] } },
  immunity:    { label: 'Damage immunity', fields: { types: 'damageTypes' },
                 example: { types: ['poison', 'psychic'] } },
  condition_immunity: {
    label: 'Condition immunity', fields: { conditions: 'conditions' },
    example: { conditions: ['Poisoned'] },
  },
  speed_grant: {
    label: 'Movement speed',
    fields: { mode: 'speedMode', value: 'speedValue' },
    example: { mode: 'fly', value: 'equal' },
  },
  proficiency: {
    label: 'Proficiency',
    fields: { kind: 'profKind', values: 'stringList' },
    example: { kind: 'skill', values: ['Acrobatics'] },
  },
  advantage_rule: {
    label: 'Advantage / disadvantage',
    fields: { mode: 'advMode', on: 'string', when: 'string' },
    example: { mode: 'advantage', on: 'Deception', when: 'to appear harmless' },
  },
  always_prepared_spells: {
    label: 'Always-prepared spells',
    hint: 'Extracted automatically from a level/spells table',
    fields: { byLevel: 'spellTable' },
    example: { byLevel: { 3: ['Magic Missile', 'Shield'] } },
  },
  roll_table: {
    label: 'Roll table',
    hint: 'Extracted automatically from a d8/d20 table',
    fields: { name: 'string', die: 'dice', entries: 'tableEntries' },
    example: { name: "Fool's Fortune", die: 'd20', entries: [] },
  },
  toggle: {
    label: 'Stance / toggle',
    hint: 'A mode the character switches between; other effects can require it',
    fields: { name: 'string', key: 'string', options: 'toggleOptions',
              default: 'string' },
    example: { name: 'Polarity', key: 'polarity',
               options: [{ key: 'attract', label: 'Attract' },
                         { key: 'repel', label: 'Repel' }], default: 'attract' },
  },
  trigger: {
    label: 'Automatic trigger',
    hint: 'Fires on a die result or game event, e.g. on a natural 1',
    fields: { on: 'triggerEvent', natRange: 'numberList', action: 'triggerAction',
              rollTable: 'string?' },
    example: { on: 'nat_roll', natRange: [1], action: 'roll_table',
               rollTable: "Fool's Fortune" },
  },
  reaction_option: {
    label: 'Reaction',
    fields: { name: 'string', trigger: 'string', cost: 'cost', text: 'text' },
    example: { name: 'Duck!', trigger: 'a melee attack misses you',
               cost: { resource: 'Focus Points', amount: 1 } },
  },
  narrative_only: {
    label: 'Text only (no mechanics)',
    hint: 'The default. Renders on the sheet; the engine ignores it.',
    fields: {},
    example: {},
  },
};

export const ACTION_TYPES = {
  action: 'Action', bonus: 'Bonus Action', reaction: 'Reaction',
  magic: 'Magic action', utility: 'Utility action', free: 'No action',
};

export const SUBSTITUTION_SCOPES = {
  unarmored_defense: 'Unarmored Defense',
  save_dc: 'Save DC',
  attack: 'Attack rolls',
  spell_attack: 'Spell attack rolls',
  initiative: 'Initiative',
};

export const TRIGGER_EVENTS = {
  nat_roll: 'A d20 comes up in a range (e.g. natural 1)',
  after_spell: 'Immediately after casting a spell',
  on_hit: 'On hitting with an attack',
  on_miss: 'When an attack misses you',
  turn_start: 'At the start of your turn',
  turn_end: 'At the end of your turn',
  damage_taken: 'When you take damage',
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Resolve a resource max written as a formula: 'level', 'pb', '3', 'level/2'. */
export function resolveFormula(formula, ctx) {
  if (typeof formula === 'number') return formula;
  const src = String(formula || '0').toLowerCase().trim();
  if (/^\d+$/.test(src)) return parseInt(src, 10);
  // Aliases matter more than they look. An unknown token is substituted with
  // 0, so "proficiencyBonus" silently produced a pool of size 0 - a resource
  // that exists, costs nothing to declare, and can never be spent.
  const mods = Object.fromEntries(
    Object.entries(ctx.abilities || {}).map(([k, v]) => [k, abilityMod(v)]),
  );
  const vars = {
    level: ctx.level || 0,
    classlevel: ctx.level || 0,
    pb: ctx.proficiencyBonus || 0,
    prof: ctx.proficiencyBonus || 0,
    proficiencybonus: ctx.proficiencyBonus || 0,
    ...mods,
    strength: mods.str ?? 0,
    dexterity: mods.dex ?? 0,
    constitution: mods.con ?? 0,
    intelligence: mods.int ?? 0,
    wisdom: mods.wis ?? 0,
    charisma: mods.cha ?? 0,
  };
  const expr = src.replace(/[a-z_]+/g, (name) => (name in vars ? vars[name] : '0'));
  if (!/^[\d+\-*/(). ]+$/.test(expr)) return 0;
  try {
    // eslint-disable-next-line no-new-func
    const n = Function(`"use strict";return (${expr})`)();
    return Number.isFinite(n) ? Math.floor(n) : 0;
  } catch { return 0; }
}

/**
 * Is this effect currently live?
 *
 * Effects can be gated on a toggle (Polarity: attract) or on a temporary state
 * (Apotheosis active). A gated effect that isn't satisfied contributes nothing.
 */
export function isActive(effect, ctx = {}) {
  const toggles = ctx.toggles || {};
  if (effect.requiresToggle) {
    const [key, value] = String(effect.requiresToggle).split(':');
    if (value === undefined) return Boolean(toggles[key]);
    if (toggles[key] !== value) return false;
  }
  if (effect.minLevel && (ctx.level || 0) < effect.minLevel) return false;
  return true;
}

/** A one-line human description of an effect, for the mapping editor. */
export function describeEffect(effect) {
  const t = EFFECT_TYPES[effect.type];
  if (!t) return effect.type;
  switch (effect.type) {
    case 'ac_formula':
      return `AC = ${effect.base} + ${(effect.ability || '').toUpperCase()} mod`
        + (effect.allowShield ? ' (shield allowed)' : '');
    case 'unarmed_strike':
      return `Unarmed strike ${effect.die} using ${(effect.ability || '').toUpperCase()}`;
    case 'ability_substitution':
      return `${(effect.with || '').toUpperCase()} in place of `
        + `${(effect.replace || '').toUpperCase()} for `
        + (effect.scope || []).map((s) => SUBSTITUTION_SCOPES[s] || s).join(', ');
    case 'resource':
      return `Resource: ${effect.name} (max ${effect.max}, ${effect.recharge} rest)`;
    case 'action_option':
      return `${ACTION_TYPES[effect.action] || effect.action}: ${effect.name}`
        + (effect.cost ? ` - ${effect.cost.amount} ${effect.cost.resource}` : '');
    case 'damage_rider':
      return `+${effect.dice} ${effect.damageType} on ${effect.trigger}`;
    case 'crit_range':
      return `Critical hit on ${effect.range}-20`;
    case 'resistance':  return `Resistance to ${(effect.types || []).join(', ')}`;
    case 'immunity':    return `Immune to ${(effect.types || []).join(', ')}`;
    case 'condition_immunity':
      return `Immune to ${(effect.conditions || []).join(', ')}`;
    case 'speed_grant':
      return `${effect.mode} speed ${effect.value === 'equal' ? '= walking speed' : effect.value}`;
    case 'proficiency':
      return `Proficiency: ${(effect.values || []).join(', ')}`;
    case 'advantage_rule':
      return `${effect.mode} on ${effect.on}${effect.when ? ` ${effect.when}` : ''}`;
    case 'always_prepared_spells': {
      const n = Object.values(effect.byLevel || {}).flat().length;
      return `${n} always-prepared spells`;
    }
    case 'roll_table':
      return `${effect.die} table "${effect.name}" (${(effect.entries || []).length} entries)`;
    case 'toggle':
      return `Toggle "${effect.name}": ${(effect.options || []).map((o) => o.label).join(' / ')}`;
    case 'trigger':
      return `On ${effect.on}${effect.natRange ? ` [${effect.natRange.join(',')}]` : ''}`
        + ` -> ${effect.action}`;
    case 'reaction_option': return `Reaction: ${effect.name}`;
    case 'narrative_only':  return 'Text only';
    default: return t.label;
  }
}

/** Structural validation. Returns [] when the effect is well-formed. */
export function validateEffect(effect) {
  const spec = EFFECT_TYPES[effect?.type];
  if (!spec) return [`unknown effect type "${effect?.type}"`];
  const errs = [];
  const need = (k) => {
    if (effect[k] === undefined || effect[k] === null || effect[k] === '') {
      errs.push(`${effect.type}: missing "${k}"`);
    }
  };
  switch (effect.type) {
    case 'ac_formula': need('base'); need('ability'); break;
    case 'unarmed_strike': need('die'); break;
    case 'ability_substitution': need('replace'); need('with'); break;
    case 'resource': need('name'); need('max'); break;
    case 'action_option': need('name'); need('action'); break;
    case 'damage_rider': need('dice'); need('trigger'); break;
    case 'toggle': need('key');
      if (!(effect.options || []).length) errs.push('toggle: needs options');
      break;
    case 'trigger': need('on'); break;
    case 'roll_table':
      if (!(effect.entries || []).length) errs.push('roll_table: no entries');
      break;
    default: break;
  }
  return errs;
}
