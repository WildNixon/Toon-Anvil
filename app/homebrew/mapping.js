/**
 * Rule mapping (ingest layer 2).
 *
 * Proposes machine-readable effects for extracted features by pattern-matching
 * the prose. Every suggestion carries a CONFIDENCE and the EVIDENCE that
 * produced it, because these are suggestions for a human to confirm - not
 * conclusions. Regex over natural language is genuinely lossy and pretending
 * otherwise is how you end up with a sheet that quietly computes the wrong AC.
 *
 * Two effect kinds are extracted with certainty rather than guessed, because
 * they come from structure and not prose: always-prepared spells (from a level
 * table) and roll tables (from a numbered 1..N run).
 *
 * Anything unmatched stays narrative_only and still renders on the sheet.
 */

const ABIL = {
  strength: 'str', dexterity: 'dex', constitution: 'con',
  intelligence: 'int', wisdom: 'wis', charisma: 'cha',
};
const ABIL_RE = 'Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma';
const DMG_RE = 'Acid|Bludgeoning|Cold|Fire|Force|Lightning|Necrotic|Piercing|'
  + 'Poison|Psychic|Radiant|Slashing|Thunder';

const ab = (word) => ABIL[String(word || '').toLowerCase()] || null;

/**
 * Parse a markdown pipe table of granted spells into {level: [names]}.
 *
 *     | Druid Level | Circle Spells             |
 *     |-------------|---------------------------|
 *     | 3rd         | hold person, spike growth |
 *
 * Accepts several header spellings ("Druid Level", "Spell Level", "Level") and
 * several level formats ("3rd", "3"). A subclass may carry more than one such
 * table - Circle of the Land has one per terrain - and they are merged, because
 * the character only ever picks one but the analyser wants the full grant.
 */
export function spellTableFrom(text) {
  const byLevel = {};
  const lines = String(text).split('\n');
  let inTable = false;
  let levelCol = 0;
  let spellCol = 1;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|')) { inTable = false; continue; }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;

    // Separator row (|---|---|)
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;

    const lower = cells.map((c) => c.toLowerCase());
    if (lower.some((c) => /level/.test(c)) && lower.some((c) => /spell/.test(c))) {
      levelCol = lower.findIndex((c) => /level/.test(c));
      spellCol = lower.findIndex((c) => /spell/.test(c) && !/level/.test(c));
      if (spellCol < 0) spellCol = levelCol === 0 ? 1 : 0;
      inTable = true;
      continue;
    }
    if (!inTable) continue;

    const lvlRaw = cells[levelCol] || '';
    const m = /^(\d+)(?:st|nd|rd|th)?$/.exec(lvlRaw.replace(/\s+/g, ''));
    if (!m) continue;
    const lvl = parseInt(m[1], 10);
    if (!(lvl >= 1 && lvl <= 20)) continue;

    const names = (cells[spellCol] || '')
      .split(/\s*,\s*/)
      .map((s) => s.replace(/\*/g, '').trim())
      .filter((s) => s && s.length < 48 && /[a-z]/i.test(s))
      // Title-case so they match compendium spell names.
      .map((s) => s.replace(/\b\w/g, (c) => c.toUpperCase()));
    if (!names.length) continue;

    byLevel[lvl] = [...new Set([...(byLevel[lvl] || []), ...names])];
  }
  return byLevel;
}

/** @typedef {{effect:object, confidence:number, evidence:string}} Suggestion */

/**
 * Suggest effects for one feature.
 * @returns {Suggestion[]}
 */
export function suggestForFeature(feature, brew = {}) {
  const text = feature.text || '';
  const out = [];
  const add = (effect, confidence, evidence) => out.push({ effect, confidence, evidence });

  /* ---- AC formula ------------------------------------------------ */
  // "your base AC equals 13 + your Dexterity modifier"
  const acM = new RegExp(
    `AC\\s+equals\\s+(\\d+)\\s*\\+\\s*your\\s+(${ABIL_RE})\\s+modifier`, 'i',
  ).exec(text);
  if (acM) {
    add({
      type: 'ac_formula',
      base: parseInt(acM[1], 10),
      ability: ab(acM[2]),
      allowShield: /can use a shield|use a Shield and still/i.test(text),
      requiresNoArmor: /aren't wearing armor|not wearing armor|while you aren't wearing/i.test(text),
    }, 0.95, acM[0]);
  }

  /* ---- unarmed strike -------------------------------------------- */
  const unarmedDie = /Unarmed Strikes?[^.]*?(\d+d\d+)\s+([^.]*?damage)/i.exec(text);
  if (unarmedDie || /Unarmed Strikes? count as magical/i.test(text)) {
    const types = [...(unarmedDie?.[2] || '').matchAll(new RegExp(DMG_RE, 'gi'))]
      .map((m) => m[0].toLowerCase());
    const abilityM = new RegExp(
      `use\\s+(?:\\*\\*)?(${ABIL_RE})(?:\\*\\*)?\\s+for\\s+the\\s+attack`, 'i',
    ).exec(text);
    add({
      type: 'unarmed_strike',
      die: unarmedDie?.[1] || '1d6',
      types: types.length ? types : ['bludgeoning'],
      ability: abilityM ? ab(abilityM[1]) : 'str',
      magical: /count as magical/i.test(text),
    }, unarmedDie ? 0.9 : 0.55, unarmedDie?.[0] || 'Unarmed Strikes count as magical');
  }

  /* ---- ability substitution --------------------------------------- */
  // "use your Constitution modifier in place of your Wisdom modifier"
  const subM = new RegExp(
    `(${ABIL_RE})\\s+modifier\\s+in\\s+place\\s+of\\s+your\\s+(${ABIL_RE})\\s+modifier`, 'i',
  ).exec(text);
  if (subM) {
    const scope = [];
    if (/unarmored defense/i.test(text)) scope.push('unarmored_defense');
    if (/save dc|saving throw dc/i.test(text)) scope.push('save_dc');
    add({
      type: 'ability_substitution',
      with: ab(subM[1]),
      replace: ab(subM[2]),
      scope: scope.length ? scope : ['unarmored_defense', 'save_dc'],
    }, 0.9, subM[0]);
  }

  /* ---- resistance / immunity -------------------------------------- */
  // Two eras of phrasing. 2024: "Resistance to Poison damage". 2014: "you are
  // resistant to fire damage" / "resistant to the damage type of your dragon".
  // Matching only the first missed every published 2014 subclass.
  const resM = new RegExp(
    `(?:Resistance to|resistant to)\\s+((?:${DMG_RE})(?:[,\\s]+(?:and|or)\\s+)?)+\\s*damage`, 'i',
  ).exec(text);
  if (resM) {
    add({
      type: 'resistance',
      types: [...resM[0].matchAll(new RegExp(DMG_RE, 'gi'))].map((m) => m[0].toLowerCase()),
    }, 0.9, resM[0]);
  } else if (/resistant to the damage type/i.test(text)) {
    // "resistant to the damage type of your chosen dragon" - the type is a
    // player choice, so record the resistance without pretending to know which.
    add({ type: 'resistance', types: ['chosen'] }, 0.7,
      'resistant to the damage type (player choice)');
  }

  const immM = /immune to\s+([^.]*?)\s+damage/i.exec(text);
  if (immM) {
    const types = [...immM[1].matchAll(new RegExp(DMG_RE, 'gi'))].map((m) => m[0].toLowerCase());
    if (types.length) add({ type: 'immunity', types }, 0.85, immM[0]);
  }

  const condM = /immune to the\s+([^.]*?)\s+conditions?/i.exec(text)
    || /you're immune to[^.]*?\band the\s+([^.]*?)\s+conditions?/i.exec(text);
  if (condM) {
    const conds = condM[1].split(/,|\band\b/).map((s) => s.trim())
      .filter((s) => /^[A-Z]/.test(s));
    if (conds.length) add({ type: 'condition_immunity', conditions: conds }, 0.8, condM[0]);
  }

  /* ---- speeds ------------------------------------------------------ */
  for (const m of text.matchAll(/\b(Fly|Climb|Swim|Burrow)\s+Speed\s+equal to your Speed/gi)) {
    add({ type: 'speed_grant', mode: m[1].toLowerCase(), value: 'equal' }, 0.9, m[0]);
  }

  /* ---- proficiency / advantage ------------------------------------- */
  // "gain proficiency IN Acrobatics" (2024) and "gain proficiency WITH three
  // skills of your choice" (2014) are the same mechanic written two ways.
  const profM = /gain(?:s)?\s+proficiency\s+(?:in|with)\s+([^.]+)/i.exec(text);
  if (profM) {
    const named = profM[1].split(/,|\bor\b|\band\b/).map((s) => s.trim())
      .filter((s) => /^[A-Z]/.test(s));
    // "three skills of your choice" names no skills but still grants three.
    const countM = /\b(one|two|three|four|five|\d+)\s+(?:additional\s+)?(skills?|tools?)/i
      .exec(profM[1]);
    if (named.length) {
      add({ type: 'proficiency', kind: 'skill', values: named },
        named.length > 1 ? 0.5 : 0.85, profM[0]);
    } else if (countM) {
      const words = { one: 1, two: 2, three: 3, four: 4, five: 5 };
      const n = words[countM[1].toLowerCase()] ?? parseInt(countM[1], 10) ?? 1;
      add({
        type: 'proficiency', kind: countM[2].startsWith('tool') ? 'tool' : 'skill',
        values: [], choose: n,
      }, 0.7, profM[0]);
    }
  }

  /* ---- expanded critical range ------------------------------------- */
  // Champion's defining feature, and previously unrepresentable: there was no
  // effect type for it, so the archetype mapped to literally nothing.
  const critM = /critical hit on a roll of\s+(\d+)(?:\s*or\s*(\d+))?/i.exec(text);
  if (critM) {
    const low = Math.min(...[critM[1], critM[2]].filter(Boolean).map(Number));
    add({ type: 'crit_range', range: low }, 0.9, critM[0]);
  }

  const advM = /Advantage on\s+([^.]{3,80})/i.exec(text);
  if (advM) {
    add({
      type: 'advantage_rule', mode: 'advantage',
      on: advM[1].replace(/\s+checks?.*$/i, '').trim(), when: '',
    }, 0.6, advM[0]);
  }

  /* ---- actions and reactions ---------------------------------------- */
  // 2024 leads with "As a Bonus Action, ...". 2014 buries it mid-sentence:
  // "you can use a bonus action to make a melee attack", "you can use your
  // reaction to expend one of your uses of Bardic Inspiration".
  const actionM =
    /As an?\s+(Bonus Action|Magic action|Utility action|Action|Reaction)/i.exec(text)
    || /you can use (?:a|an|your)\s+(bonus action|reaction|action)\s+to/i.exec(text)
    || /(?:as|using)\s+(?:a|an|your)\s+(bonus action|reaction|action)[,\s]/i.exec(text);
  if (actionM) {
    const cost = (feature.costs || [])[0];
    const kind = actionM[1].toLowerCase();
    const type = kind.includes('reaction') ? 'reaction_option' : 'action_option';
    const saveM = new RegExp(`(${ABIL_RE})\\s+saving throw`, 'i').exec(text);
    const rangeM = /within\s+(\d+)\s*feet/i.exec(text);
    add({
      type,
      name: feature.name,
      action: kind.includes('bonus') ? 'bonus'
        : kind.includes('magic') ? 'magic'
        : kind.includes('utility') ? 'utility'
        : kind.includes('reaction') ? 'reaction' : 'action',
      cost: cost && cost.amount
        ? { resource: cost.resource, amount: cost.amount, variable: cost.variable }
        : null,
      range: rangeM ? `${rangeM[1]} feet` : null,
      save: saveM ? { ability: ab(saveM[1]), dc: 'spell' } : null,
      text: feature.text?.slice(0, 400) || '',
    }, 0.75, actionM[0]);
  }

  /* ---- damage riders ------------------------------------------------ */
  // Three orderings occur:
  //   "extra 2d8 Force damage"                 dice then type   (2024)
  //   "takes 1d6 extra fire damage"            dice, 'extra' in the middle
  //   "damage equal to 1d8 + your Str modifier" type then dice  (2014)
  const riderM =
    new RegExp(`extra\\s+(\\d+d\\d+)\\s+(${DMG_RE})\\s+damage`, 'i').exec(text)
    || new RegExp(`(\\d+d\\d+)\\s+extra\\s+(${DMG_RE})\\s+damage`, 'i').exec(text)
    || new RegExp(`additional\\s+(\\d+d\\d+)\\s+(${DMG_RE})\\s+damage`, 'i').exec(text);
  if (riderM) {
    add({
      type: 'damage_rider',
      dice: riderM[1],
      damageType: riderM[2].toLowerCase(),
      trigger: /Unarmed Strikes?/i.test(text) ? 'unarmed_hit' : 'on_hit',
    }, 0.75, riderM[0]);
  } else {
    const revM = new RegExp(
      `(${DMG_RE})\\s+damage equal to\\s+(\\d+d\\d+)`, 'i',
    ).exec(text);
    if (revM) {
      add({
        type: 'damage_rider', dice: revM[2], damageType: revM[1].toLowerCase(),
        trigger: 'on_hit',
      }, 0.7, revM[0]);
    }
  }

  /* ---- per-rest uses ------------------------------------------------- */
  // "Once you use this feature, you can't use it again until you finish a long
  // rest" is how 2014 declares a 1/rest resource. Without it, a subclass whose
  // capstone is once-per-rest exposes no resource at all.
  const restM =
    /can't use (?:it|this feature) again until you finish a (short|long) rest/i
      .exec(text);
  if (restM && !(feature.costs || []).length) {
    const twice = /you can use (?:it|this feature) twice/i.test(text);
    add({
      type: 'resource',
      name: feature.name,
      max: twice ? '2' : '1',
      recharge: restM[1].toLowerCase(),
    }, 0.75, restM[0]);
  }

  /* ---- always-prepared spells (2014 phrasing + markdown table) -------- */
  // 2024 subclasses put their granted spells in an HTML table that ingest.js
  // reads. 2014 ones write a markdown pipe table and say "you always have it
  // prepared" in prose, so the whole grant was invisible - which is most of why
  // spell-list subclasses like Circle of the Land mapped at 17%.
  const grantsAlways = /you always have (?:it|them|these spells) prepared/i.test(text)
    || /always have (?:the|these) .{0,30}spells? prepared/i.test(text)
    || /don'?t count against the number of spells you can prepare/i.test(text);

  const byLevel = spellTableFrom(feature.rawText || feature.text || '');
  if (Object.keys(byLevel).length) {
    add({ type: 'always_prepared_spells', byLevel },
      grantsAlways ? 0.9 : 0.7,
      `parsed ${Object.values(byLevel).flat().length} spells from a level table`);
  } else if (grantsAlways) {
    // The grant is real even when the spell names live in a table we could not
    // read - record it at low confidence rather than silently dropping it.
    add({ type: 'always_prepared_spells', byLevel: {}, unresolved: true }, 0.4,
      'grants always-prepared spells, but the list did not parse');
  }

  // "you learn one additional druid cantrip of your choice"
  const cantripM = /learn(?:s)?\s+(one|two|three|\d+)\s+additional\s+(\w+)?\s*cantrip/i
    .exec(text);
  if (cantripM) {
    const words = { one: 1, two: 2, three: 3 };
    add({
      type: 'always_prepared_spells', byLevel: {},
      choose: words[cantripM[1].toLowerCase()] ?? parseInt(cantripM[1], 10) ?? 1,
      cantrips: true,
    }, 0.7, cantripM[0]);
  }

  /* ---- nat-roll triggers -------------------------------------------- */
  // "Whenever you roll a 1 on an attack roll..." / "triggers on a 1 or 2"
  const natM = /roll(?:s)?\s+a\s+(\d+)(?:\s+or\s+(\d+))?\s+on an attack roll/i.exec(text)
    || /now triggers on a\s+(\d+)\s+or\s+(\d+)/i.exec(text)
    || /triggers? on a\s+(\d+)(?:\s+or\s+(\d+))?/i.exec(text);
  if (natM) {
    const range = [parseInt(natM[1], 10)];
    if (natM[2]) range.push(parseInt(natM[2], 10));
    const table = (brew.rollTables || [])[0];
    add({
      type: 'trigger',
      on: 'nat_roll',
      natRange: range,
      action: 'roll_table',
      rollTable: table?.name || null,
    }, table ? 0.85 : 0.5, natM[0]);
  }

  /* ---- toggles ------------------------------------------------------ */
  // "It's set to either Attract or Repel, and you can switch it as a Bonus Action"
  const togM = /set to either\s+([A-Z]\w+)\s+or\s+([A-Z]\w+)/.exec(text);
  if (togM) {
    add({
      type: 'toggle',
      name: feature.name,
      key: feature.id,
      options: [
        { key: togM[1].toLowerCase(), label: togM[1] },
        { key: togM[2].toLowerCase(), label: togM[2] },
      ],
      default: togM[1].toLowerCase(),
    }, 0.85, togM[0]);
  }

  /* ---- explicitly declared pools -------------------------------------- */
  // "You gain a pool of Heat equal to your Proficiency Bonus" is the standard
  // way homebrew introduces its own resource. Without this the pool is never
  // declared, every action that costs it fails canAfford() forever, and the
  // subclass simulates as though its signature mechanic did not exist.
  const poolM = /(?:gain|have)\s+(?:a\s+)?(?:pool|number|reserve)\s+of\s+(?:\*{0,2})([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)(?:\*{0,2})\s*(?:points?\s*)?equal\s+to\s+(?:your\s+)?([^.]{2,60})/
    .exec(text);
  if (poolM) {
    const poolName = poolM[1].trim();
    const formula = poolM[2].toLowerCase();
    let max = 'level';
    if (/proficiency bonus/.test(formula)) max = 'proficiencyBonus';
    else if (/\b(charisma|cha)\b/.test(formula)) max = 'cha';
    else if (/\b(wisdom|wis)\b/.test(formula)) max = 'wis';
    else if (/\b(intelligence|int)\b/.test(formula)) max = 'int';
    else if (/\b(constitution|con)\b/.test(formula)) max = 'con';

    // "You regain all spent Heat when you finish a Short or Long Rest."
    const rechargeM =
      /regain\s+(?:all\s+)?(?:your\s+)?(?:spent|expended)?\s*[\w'-]*\s*(?:points?\s*)?when\s+you\s+finish\s+a\s+(short\s+or\s+long|long\s+or\s+short|short|long)\s+rest/i
        .exec(text);
    const recharge = rechargeM && /short/i.test(rechargeM[1]) ? 'short' : 'long';

    add({ type: 'resource', name: poolName, max, recharge }, 0.85, poolM[0]);
  }

  /* ---- resources from cost spans ------------------------------------- */
  for (const cost of feature.costs || []) {
    if (!cost.resource) continue;
    // Only *declare* a pool for resources the base class doesn't already own.
    if (/sorcery point|focus point|ki point|rage/i.test(cost.resource)) continue;
    if (poolM && cost.resource.toLowerCase() === poolM[1].trim().toLowerCase()) continue;
    add({
      type: 'resource', name: cost.resource, max: 'level', recharge: 'long',
    }, 0.35, cost.raw);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* whole-brew mapping                                                  */
/* ------------------------------------------------------------------ */

/**
 * Attach suggestions across a whole ingested homebrew.
 *
 * Structural effects (spell tables, roll tables) are attached at confidence 1
 * because they were parsed from structure, not guessed from prose.
 */
export function suggestAll(brew) {
  const features = (brew.features || []).map((f) => ({ ...f }));

  for (const f of features) {
    f.suggestions = suggestForFeature(f, brew);
  }

  // Always-prepared spells belong to the feature that owns the table - the one
  // whose name mentions spells, else the earliest feature.
  if (brew.spellTable) {
    const host = features.find((f) => /spells?$/i.test(f.name)) || features[0];
    if (host) {
      host.suggestions.unshift({
        effect: { type: 'always_prepared_spells', byLevel: brew.spellTable.byLevel },
        confidence: 1,
        evidence: 'parsed from the spell table',
      });
    }
  }

  for (const table of brew.rollTables || []) {
    const host = features.find((f) => normalise(f.name) === normalise(table.name))
      || features.find((f) => table.name && normalise(table.name).includes(normalise(f.name)))
      || features[0];
    if (!host) continue;
    host.suggestions.unshift({
      effect: {
        type: 'roll_table', name: table.name, die: table.die, entries: table.entries,
      },
      confidence: 1,
      evidence: `parsed ${table.entries.length} numbered entries`,
    });
  }

  return { ...brew, features };
}

const normalise = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Accept suggestions above a threshold. Returns the brew with `effects`
 * populated, ready for derive.js.
 */
export function acceptSuggestions(brew, { minConfidence = 0.7 } = {}) {
  const features = (brew.features || []).map((f) => {
    const accepted = (f.suggestions || [])
      .filter((s) => s.confidence >= minConfidence)
      .map((s) => s.effect);
    return {
      ...f,
      effects: accepted.length ? accepted : [{ type: 'narrative_only' }],
      mappingStatus: accepted.length ? 'auto' : 'unmapped',
    };
  });
  return { ...brew, features, mapped: true };
}

/** Counts for the ingest report: how much of this brew is actually live. */
export function mappingStats(brew) {
  const features = brew.features || [];
  const live = features.filter(
    (f) => (f.effects || []).some((e) => e.type !== 'narrative_only'),
  );
  const suggested = features.reduce((n, f) => n + (f.suggestions?.length || 0), 0);
  const effects = features.reduce(
    (n, f) => n + (f.effects || []).filter((e) => e.type !== 'narrative_only').length, 0,
  );
  return {
    features: features.length,
    live: live.length,
    unmapped: features.length - live.length,
    suggestions: suggested,
    effects,
  };
}
