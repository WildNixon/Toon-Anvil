/**
 * The campaign driver: one character, levels 1 to 20.
 *
 * Structure follows the 2024 adventuring day - 6-8 encounters between long
 * rests with a couple of short rests - because resource-recovery cadence is
 * most of what separates a Warlock from a Wizard. Simulating isolated fights
 * would flatter short-rest classes and starve long-rest ones.
 *
 * Everything the grader needs is collected here: invariant violations,
 * coverage (what actually fired, and by omission what never did), and the
 * per-level metrics that feed the balance analysis.
 */

import { derive } from '../core/derive.js';
import { seededRng } from '../core/rng.js';
import { d20 } from '../core/dice.js';
import {
  resolveAttack, resolveSpell, applyDamage, deathSave, fireTriggers,
  shortRest, longRest, spendResource, useSlot,
} from '../core/engine.js';
import { abilityMod, proficiencyBonus } from '../core/rules2024.js';
import { buildEncounter, monsterTurn } from './encounter.js';
import { chooseAction, shouldShortRest, hitDiceToSpend } from './policy.js';
import { checkAll } from './invariants.js';

/** Ability priority per class, used to assign the standard array. */
const PRIORITY = {
  barbarian: ['str', 'con', 'dex', 'wis', 'cha', 'int'],
  bard: ['cha', 'dex', 'con', 'wis', 'int', 'str'],
  cleric: ['wis', 'con', 'str', 'dex', 'cha', 'int'],
  druid: ['wis', 'con', 'dex', 'int', 'cha', 'str'],
  fighter: ['str', 'con', 'dex', 'wis', 'cha', 'int'],
  monk: ['dex', 'wis', 'con', 'str', 'cha', 'int'],
  paladin: ['str', 'cha', 'con', 'wis', 'dex', 'int'],
  ranger: ['dex', 'wis', 'con', 'str', 'int', 'cha'],
  rogue: ['dex', 'con', 'int', 'wis', 'cha', 'str'],
  sorcerer: ['cha', 'con', 'dex', 'wis', 'int', 'str'],
  warlock: ['cha', 'con', 'dex', 'wis', 'int', 'str'],
  wizard: ['int', 'con', 'dex', 'wis', 'cha', 'str'],
};
const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];

/**
 * Adventuring-day pacing by tier.
 *
 * Uniform pacing (3 days x 7 encounters at every level) puts 21 fights at
 * level 1, where characters have ~10 HP. Every run then dies in tier 1 and the
 * sweep produces no data above level 2 - which says nothing about the classes
 * and everything about the schedule. Real campaigns pass through levels 1-2 in
 * a session or two, so the pacing follows that.
 */
function pacing(level) {
  if (level <= 2) return { days: 1, encounters: 3 };
  if (level <= 4) return { days: 2, encounters: 5 };
  if (level <= 10) return { days: 3, encounters: 7 };
  return { days: 3, encounters: 8 };
}

const MAX_ROUNDS = 30;          // reported when hit, never silent

/* ------------------------------------------------------------------ */
/* character construction                                              */
/* ------------------------------------------------------------------ */

/**
 * Starting kit by class.
 *
 * Without this every martial fights bare-handed for 1 damage and dies at level
 * 1, while casters cantrip along fine - which would read as "martials are
 * terrible" when it actually means "the simulator forgot to arm them".
 *
 * Monks and Barbarians are deliberately left unarmoured so their Unarmored
 * Defense actually applies, which is the whole point of those features.
 */
const KIT = {
  barbarian: { weapon: 'Greataxe', armor: null },
  bard:      { weapon: 'Rapier', armor: 'Leather Armor' },
  cleric:    { weapon: 'Mace', armor: 'Chain Shirt' },
  druid:     { weapon: 'Quarterstaff', armor: 'Leather Armor' },
  fighter:   { weapon: 'Greatsword', armor: 'Chain Mail' },
  monk:      { weapon: null, armor: null },
  paladin:   { weapon: 'Longsword', armor: 'Chain Mail' },
  ranger:    { weapon: 'Longbow', armor: 'Studded Leather Armor' },
  rogue:     { weapon: 'Shortsword', armor: 'Leather Armor' },
  sorcerer:  { weapon: 'Dagger', armor: null },
  warlock:   { weapon: 'Dagger', armor: 'Leather Armor' },
  wizard:    { weapon: 'Dagger', armor: null },
};

function startingInventory(classId, equipment) {
  const kit = KIT[classId] || KIT.fighter;
  const items = [];
  const find = (list, name) => (list || []).find((x) => x.name === name);

  if (kit.weapon) {
    const w = find(equipment?.weapons, kit.weapon);
    if (w) {
      items.push({
        id: `w-${w.id}`, name: w.name, kind: 'weapon', qty: 1, equipped: true,
        damage: w.damage, properties: w.properties, mastery: w.mastery,
        category: w.category, weight: w.weight,
      });
    }
  }
  if (kit.armor) {
    const a = find(equipment?.armor, kit.armor);
    if (a) {
      items.push({
        id: `a-${a.id}`, name: a.name, kind: 'armor', qty: 1, equipped: true,
        ac: a.ac, category: a.category, weight: a.weight,
      });
    }
  }
  return items;
}

export function makeCharacter(classId, subclassId, level, sources, opts = {}) {
  const priority = PRIORITY[classId] || PRIORITY.fighter;
  const abilities = {};
  priority.forEach((ab, i) => { abilities[ab] = STANDARD_ARRAY[i]; });

  const cls = (sources.classes || []).find((c) => c.id === classId);
  const hitDie = cls?.hitDie || 8;
  const con = abilityMod(abilities.con);
  // Fixed HP progression (average roll), which is what most tables use and
  // removes a large source of variance that would otherwise swamp the signal.
  const perLevel = Math.floor(hitDie / 2) + 1 + con;
  const maxHp = hitDie + con + perLevel * (level - 1);

  return {
    id: `sim-${classId}-${subclassId || 'none'}-${level}`,
    name: `${classId}/${subclassId || 'base'}`,
    ruleset: '2024',
    classes: [{ class: classId, subclass: subclassId, level }],
    abilities,
    skills: (cls?.savingThrows || []).slice(0, 2),
    feats: [],
    hp: { max: maxHp, current: maxHp, temp: 0 },
    hitDice: { die: hitDie, remaining: level },
    inventory: opts.inventory || startingInventory(classId, sources.equipment),
    currency: { gp: 10 + level * 50 },
    spells: { prepared: [], known: [] },
    slotState: {},
    resourceState: {},
    toggles: {},
    conditions: [],
    exhaustion: 0,
    deathSaves: { successes: 0, failures: 0 },
    campaignId: 'sim',
  };
}

/* ------------------------------------------------------------------ */
/* coverage tracking                                                   */
/* ------------------------------------------------------------------ */

function newCoverage() {
  return {
    effectTypes: {},     // effect type -> times it influenced a result
    features: {},        // feature name -> times used
    spells: {},          // spell name -> times cast
    eventTypes: {},      // event type -> count
    triggers: {},        // homebrew trigger -> times fired
    rollTables: {},      // table -> times rolled
  };
}

const bump = (obj, key, n = 1) => {
  if (!key) return;
  obj[key] = (obj[key] || 0) + n;
};

/* ------------------------------------------------------------------ */
/* one combat                                                          */
/* ------------------------------------------------------------------ */

/**
 * Three abstract allies stand beside the simulated character.
 *
 * This is not decoration. D&D is balanced around a party of four: encounter
 * budgets assume four bodies to spread damage across, four action economies,
 * and somebody who can pick you up. A solo character absorbs 100% of every
 * attack and dies at level 1 forever - which produces no data above level 1
 * and systematically misreports survivability.
 *
 * The allies are deliberately GENERIC and identical for every run, so they
 * contribute the same baseline to every class and cancel in comparison. They
 * are a fixed backdrop, not characters.
 */
export function makeAllies(level) {
  return [0, 1, 2].map((i) => ({
    name: `Ally ${i + 1}`,
    side: 'ally',
    ac: 14 + Math.floor(level / 5),
    hp: 8 + 6 * level,
    hpMax: 8 + 6 * level,
    temp: 0,
    // Calibrated to a real player character's output, because the encounter
    // budget assumes four of those. Allies that are too weak make every fight
    // a grind that kills the party by attrition in tier 1; too strong and they
    // end fights before the character acts. Measuring the character's damage
    // per ACTION TAKEN (not per round) is what makes this safe to calibrate
    // honestly rather than tuning it to flatter someone.
    dpr: 3 + level * 2.2,
    saves: {},
    healsLeft: i === 0 ? 2 : 0,   // one designated healer, twice per fight
  }));
}

function runCombat(state, encounter, rng, cov, violations, where, allies) {
  const { character, derived } = state;
  const pc = {
    name: derived.name, side: 'pc', ac: derived.ac,
    hp: derived.hp.current, hpMax: derived.hp.max, temp: derived.hp.temp,
    saves: derived.saves,
  };
  const enemies = encounter.monsters.map((m) => ({ ...m }));
  // Allies are owned by the adventuring DAY, not the fight. Rebuilding them at
  // full health every encounter meant they never carried attrition, so the
  // simulated character was permanently the most wounded body in the party.
  const party = [pc, ...allies];

  let round = 0;
  let damageDealt = 0;
  let damageTaken = 0;
  let hitRoundCap = false;
  // Rounds in which the character actually had a living target and acted.
  // Dividing damage by total rounds instead would credit the character with
  // zero output for rounds where the fight was already over - which measures
  // the allies' kill speed, not the character.
  let pcActions = 0;
  let singleTargetDealt = 0;
  let control = 0;

  // Initiative: PC vs the pack (monsters act as one block for simplicity -
  // individual monster initiative would add variance without changing the
  // resource-attrition question the campaign is asking).
  const pcInit = d20({ mod: derived.initiative, rng }).total;
  const monInit = d20({ mod: enemies[0]?.initiativeMod || 0, rng }).total;
  const pcFirst = pcInit >= monInit;

  while (round < MAX_ROUNDS) {
    round += 1;
    const order = pcFirst ? ['pc', 'monsters'] : ['monsters', 'pc'];

    for (const side of order) {
      if (enemies.every((e) => e.hp <= 0)) break;
      if (pc.hp <= 0 && side === 'pc') continue;

      if (side === 'pc') {
        if (pc.hp > 0 && enemies.some((e) => e.hp > 0)) {
          pcActions += 1;
          const action = chooseAction({
            character, derived: state.derived, enemies, party,
            spells: state.spells, mechanics: state.mechanics,
            classDef: state.classDef, rng,
          });
          // Extra Attack multiplies weapon attacks only - a spell is still one
          // spell, which is exactly the martial/caster tradeoff the game makes.
          const swings = action.kind === 'attack'
            ? (state.derived.attacksPerAction || 1) : 1;
          for (let i = 0; i < swings; i += 1) {
            const living = enemies.filter((e) => e.hp > 0);
            if (!living.length) break;
            // Retarget between swings so overkill spills onto the next enemy.
            const act = action.kind === 'attack'
              ? { ...action, target: living.reduce((a, b) => (b.hp < a.hp ? b : a)) }
              : action;
            const dealt = executePcAction(act, state, enemies, rng, cov,
              { swingIndex: i });
            damageDealt += dealt.total;
            singleTargetDealt += dealt.primary;
            control += dealt.control;
          }
          // The bonus action is a SEPARATE slot of the action economy, so it
          // resolves in addition to the main action rather than instead of it.
          // It does not increment pcActions: the denominator stays "PC turns"
          // so a bonus-action user is not penalised on every per-action metric.
          if (action.bonus && enemies.some((e) => e.hp > 0)) {
            const b = executePcAction(action.bonus, state, enemies, rng, cov, {});
            damageDealt += b.total;
            singleTargetDealt += b.primary;
            control += b.control;
          }
        }
        // Allies act on the party's turn: chip damage, and pick the PC up.
        for (const ally of allies.filter((a) => a.hp > 0)) {
          if (ally.healsLeft > 0 && pc.hp <= 0) {
            pc.hp = Math.max(1, Math.floor(pc.hpMax * 0.25));
            ally.healsLeft -= 1;
            character.deathSaves = { successes: 0, failures: 0 };
            continue;
          }
          const target = enemies.find((e) => e.hp > 0);
          if (target) target.hp = Math.max(0, target.hp - Math.round(ally.dpr));
        }
      } else {
        for (const mon of enemies.filter((e) => e.hp > 0)) {
          const turn = monsterTurn(mon, party, rng);
          for (const hit of turn.hits) {
            // Apply to whoever was actually targeted - allies soak too, which
            // is the entire reason they are here.
            const victim = hit.target;
            // Resistances apply to the simulated character only - the abstract
            // allies have no sheet, so giving them defences would credit the
            // character's survival to teammates it does not really have.
            const res = applyDamage(
              { hp: { current: victim.hp }, hpMax: victim.hpMax, temp: victim.temp || 0 },
              -hit.amount,
              {
                name: victim.name, source: hit.source, damageType: hit.type,
                ...(victim === pc ? {
                  resistances: state.derived.resistances || [],
                  immunities: state.derived.immunities || [],
                  vulnerabilities: state.derived.vulnerabilities || [],
                } : {}),
              },
            );
            victim.hp = res.hp;
            victim.temp = res.temp;
            // Only the simulated character's damage counts toward its metrics,
            // and it counts the amount that ACTUALLY landed - crediting the raw
            // roll would make resistance invisible in dtpr.
            if (victim === pc) {
              const landed = res.events.find((e) => e.type === 'damage_taken');
              damageTaken += landed ? landed.payload.amount : hit.amount;
              for (const ev of res.events) bump(cov.eventTypes, ev.type);
              if (landed?.payload.mitigation) {
                bump(cov.effectTypes, `mitigated:${landed.payload.mitigation}`);
              }
            }
          }
        }
      }
    }

    // Sync the character's HP so invariants see the real state.
    character.hp = { ...character.hp, current: pc.hp, temp: pc.temp };
    state.derived = derive(character, state.sources);
    violations.push(...checkAll(
      { character, derived: state.derived },
      { ...where, round },
    ));

    if (pc.hp <= 0) break;
    if (enemies.every((e) => e.hp <= 0)) break;
  }

  if (round >= MAX_ROUNDS) hitRoundCap = true;

  // Death saves if the fight ended with the character down and nobody left to
  // pick them up. Surviving allies stabilise them between encounters, so death
  // only happens when the whole party went down.
  let died = false;
  if (pc.hp <= 0) {
    const alliesStanding = allies.some((a) => a.hp > 0);
    if (alliesStanding) {
      pc.hp = 1;
      character.deathSaves = { successes: 0, failures: 0 };
    } else {
      const saves = { successes: 0, failures: 0 };
      while (saves.successes < 3 && saves.failures < 3) {
        const ds = deathSave(rng);
        saves.successes += ds.successes;
        saves.failures += ds.failures;
        for (const ev of ds.events) bump(cov.eventTypes, ev.type);
        if (ds.outcome === 'revive') { pc.hp = 1; break; }
      }
      died = saves.failures >= 3;
      character.deathSaves = saves;
    }
  }

  return {
    round, damageDealt, damageTaken, died, pcActions,
    singleTargetDealt, control,
    survivedAtHp: pc.hp, hitRoundCap,
    enemiesDefeated: enemies.filter((e) => e.hp <= 0).length,
    enemyCount: enemies.length,
  };
}

/** Perform the PC's chosen action; returns damage dealt. */
function executePcAction(action, state, enemies, rng, cov, opts = {}) {
  const { character, derived } = state;
  let dealt = 0;
  // Damage to the PRIMARY target only. Total damage rewards area spells for
  // hitting six creatures, which is a real advantage but makes a Fireball look
  // twenty times a Greatsword. Reporting both keeps that visible instead of
  // baked in.
  let primary = 0;
  // Control: conditions imposed and forced movement. This is the axis two
  // subclasses can differ on while scoring identically on damage.
  let control = 0;

  if (action.kind === 'attack') {
    // Damage riders (Sneak Attack, Apotheosis of Iron's +2d8) were being
    // collected by derive() and then never passed to the roll - which is why
    // damage_rider showed as "present but never fired" and why the Rogue's
    // output was a third of what it should be.
    const riders = (derived.damageRiders || []).filter(
      (r) => (r.trigger === 'unarmed_hit'
        ? action.attack.kind === 'unarmed'
        : r.trigger === 'on_hit')
        // once-per-turn riders only apply on the first swing of the turn
        && !(r.oncePerTurn && opts.swingIndex > 0),
    );
    const res = resolveAttack(action.attack, {
      rng, target: action.target, attackerName: derived.name,
      // Honour an expanded crit range, or Improved Critical is a claim with no
      // mechanism behind it.
      critRange: derived.critRange || 20,
      extraDamage: riders.map((r) => ({
        dice: r.dice, type: r.damageType, source: r.source,
      })),
    });
    for (const ev of res.events) bump(cov.eventTypes, ev.type);
    bump(cov.features, action.attack.source);
    if (res.hit !== false) {
      for (const r of riders) {
        bump(cov.effectTypes, 'damage_rider');
        bump(cov.features, r.source);
      }
    }
    if (res.hit) {
      const dmg = applyDamage(
        { hp: { current: action.target.hp }, hpMax: action.target.hpMax,
          temp: action.target.temp || 0 },
        -res.total, { name: action.target.name },
      );
      action.target.hp = dmg.hp;
      dealt = res.total;
      primary = res.total;
    }
    if (res.fumble) {
      const t = fireTriggers(derived, res.roll.nat, rng);
      for (const f of t.fired) {
        bump(cov.triggers, f.trigger?.from);
        if (f.table) bump(cov.rollTables, f.table.name);
      }
      for (const ev of t.events) bump(cov.eventTypes, ev.type);
    }
    if (res.crit) bump(cov.effectTypes, 'crit');
  } else if (action.kind === 'spell') {
    const targets = action.mech?.area
      ? enemies.filter((e) => e.hp > 0).slice(0, 4)
      : [action.target];
    const res = resolveSpell(action.spell, action.mech, {
      rng, caster: {
        saveDc: derived.spellcasting.saveDc,
        attackBonus: derived.spellcasting.attackBonus,
        mod: derived.spellcasting.mod,
      },
      targets, slotLevel: action.slotLevel,
    });
    bump(cov.spells, action.spell.name);
    for (const ev of res.events) bump(cov.eventTypes, ev.type);

    if (action.slotLevel) {
      const slot = useSlot(character, derived, action.slotLevel);
      if (!slot.error) character.slotState = slot.slotState;
    }
    for (const r of res.results) {
      const target = targets.find((t) => t && t.name === r.target);
      if (target && r.amount) {
        const dmg = applyDamage(
          { hp: { current: target.hp }, hpMax: target.hpMax, temp: target.temp || 0 },
          -r.amount, { name: target.name },
        );
        target.hp = dmg.hp;
        dealt += r.amount;
        if (target === action.target) primary += r.amount;
      }
      if (r.condition) { control += 1; bump(cov.effectTypes, 'condition_applied'); }
    }
  } else if (action.kind === 'feature') {
    // Most action options cost nothing - "as a bonus action, you can..." with
    // no pool attached. Those resolve directly; only a costed one has to pay.
    const cost = action.action.cost;
    const spend = cost
      ? spendResource(character, derived, cost.resource, cost.amount)
      : { events: [] };
    if (!spend.error) {
      if (spend.resourceState) character.resourceState = spend.resourceState;
      bump(cov.features, action.action.name);
      bump(cov.effectTypes, 'action_option');
      // Feature actions are overwhelmingly control - pulls, pushes, prone,
      // stance switches - so they are scored on that axis, not on damage.
      control += 1;
      if (action.action.save) control += 1;
      for (const ev of spend.events) bump(cov.eventTypes, ev.type);
    }
  }
  return { total: dealt, primary, control };
}

/* ------------------------------------------------------------------ */
/* the campaign                                                        */
/* ------------------------------------------------------------------ */

/**
 * Run one character from level 1 to `maxLevel`.
 *
 * @param {object} cfg {classId, subclassId, seed, sources, monsters, spells,
 *                      mechanics, maxLevel, ablate}
 */
export function runCampaign(cfg) {
  const {
    classId, subclassId, seed, sources, monsters, spells, mechanics,
    maxLevel = 20, ablate = null,
  } = cfg;

  const rng = seededRng(seed, `${classId}:${subclassId}`);
  const combatRng = rng.stream('combat');
  const encRng = rng.stream('encounter');

  const cov = newCoverage();
  const violations = [];
  const perLevel = [];
  const notes = [];

  let character = makeCharacter(classId, subclassId, 1, sources);
  const classDef = (sources.classes || []).find((c) => c.id === classId);

  // Ablation: strip one effect from the homebrew so the SAME seed can be run
  // with and without it. The comparand is the character itself, never an
  // external baseline.
  const activeSources = ablate
    ? { ...sources, homebrew: ablateEffect(sources.homebrew, ablate) }
    : sources;

  let derived = derive(character, activeSources);
  const state = {
    character, derived, sources: activeSources, spells, mechanics, classDef,
  };

  let died = false;
  let deathLevel = null;
  let totalRounds = 0;
  let wipes = 0;
  const wipeLevels = [];

  for (let level = 1; level <= maxLevel; level += 1) {
    character.classes[0].level = level;
    // Recompute max HP for the new level.
    const hitDie = classDef?.hitDie || 8;
    const con = abilityMod(character.abilities.con);
    const perLvl = Math.floor(hitDie / 2) + 1 + con;
    character.hp.max = hitDie + con + perLvl * (level - 1);
    character.hp.current = character.hp.max;
    character.hitDice = { die: hitDie, remaining: level };
    state.derived = derive(character, activeSources);

    const levelStats = {
      level, encounters: 0, damageDealt: 0, damageTaken: 0,
      rounds: 0, pcActions: 0, singleTargetDealt: 0, control: 0, downed: 0, wipes: 0, shortRests: 0, longRests: 0, roundCaps: 0,
    };

    const { days, encounters: perDay } = pacing(level);
    for (let day = 0; day < days; day += 1) {
      let sinceRest = 0;
      // Fresh party at the start of each adventuring day (they long-rested too).
      const allies = makeAllies(level);
      for (let e = 0; e < perDay; e += 1) {
        // Budget for the full party of four, since four bodies are present.
        const encounter = buildEncounter(
          monsters, [level, level, level, level], encRng,
        );
        if (!encounter.monsters.length) {
          notes.push(`level ${level}: could not build an encounter`);
          continue;
        }

        const result = runCombat(
          state, encounter, combatRng, cov, violations,
          { classId, subclassId, level, day, encounter: e }, allies,
        );

        levelStats.encounters += 1;
        levelStats.damageDealt += result.damageDealt;
        levelStats.damageTaken += result.damageTaken;
        levelStats.rounds += result.round;
        levelStats.pcActions += result.pcActions;
        levelStats.singleTargetDealt += result.singleTargetDealt;
        levelStats.control += result.control;
        totalRounds += result.round;
        if (result.hitRoundCap) levelStats.roundCaps += 1;
        if (result.survivedAtHp <= 0) levelStats.downed += 1;

        // A party wipe is RECORDED, not fatal to the run.
        //
        // A full campaign is ~370 encounters. Ending the run on the first wipe
        // makes "completion" measure whether a rare tail event occurred in 370
        // chances - which is not a property of the class - and destroys every
        // level of data above the wipe, defeating the point of exercising all
        // twenty levels. Survivability is measured properly as WIPE RATE per
        // encounter; the run continues (the party was raised, as parties are).
        if (result.died) {
          levelStats.wipes += 1;
          wipes += 1;
          wipeLevels.push(level);
          // Recover as a real table would: everyone up, resources spent.
          character.hp = { ...character.hp, current: Math.max(1, Math.floor(state.derived.hp.max * 0.5)), temp: 0 };
          character.deathSaves = { successes: 0, failures: 0 };
          character.exhaustion = Math.min(6, (character.exhaustion || 0) + 1);
          for (const ally of allies) ally.hp = Math.round(ally.hpMax * 0.5);
          state.derived = derive(character, activeSources);
        }

        sinceRest += 1;
        if (shouldShortRest(state.derived, sinceRest)) {
          const rest = shortRest(character, state.derived, {
            spendHitDice: hitDiceToSpend(state.derived), rng: combatRng,
          });
          Object.assign(character, rest.patch);
          state.derived = derive(character, activeSources);
          // Allies spend hit dice too, AND downed allies are picked back up.
          // Healing only those still standing meant a downed ally stayed down
          // for the rest of the day; they accumulated until nobody was left to
          // stabilise the character, which is what actually killed every run.
          for (const ally of allies) {
            const floor = ally.hp <= 0 ? Math.round(ally.hpMax * 0.25) : ally.hp;
            ally.hp = Math.min(ally.hpMax, floor + Math.round(ally.hpMax * 0.45));
          }
          levelStats.shortRests += 1;
          sinceRest = 0;
          for (const ev of rest.events) bump(cov.eventTypes, ev.type);
        }
      }

      // End of adventuring day.
      const rest = longRest(character, state.derived);
      Object.assign(character, rest.patch);
      state.derived = derive(character, activeSources);
      levelStats.longRests += 1;
      for (const ev of rest.events) bump(cov.eventTypes, ev.type);
    }

    // Record which of this level's features and effects actually exist, so
    // "never fired" can be distinguished from "never present".
    for (const f of state.derived.features) {
      for (const eff of f.effects || []) {
        if (eff.type !== 'narrative_only') bump(cov.effectTypes, `${eff.type}:present`);
      }
    }

    perLevel.push(levelStats);
  }

  return {
    classId, subclassId, seed, ablate,
    // "Completed" now means the run produced data at every level, which is
    // what the sweep needs. Survivability lives in wipeRate, not here.
    completed: perLevel.length === maxLevel,
    reachedLevel: maxLevel,
    wipes,
    wipeLevels,
    totalRounds,
    perLevel,
    coverage: cov,
    violations,
    notes,
    // Aggregates the grader uses directly.
    metrics: summarise(perLevel),
  };
}

function summarise(perLevel) {
  const sum = (k) => perLevel.reduce((n, l) => n + l[k], 0);
  const encounters = sum('encounters');
  const rounds = sum('rounds');
  const actions = sum('pcActions');
  return {
    encounters,
    rounds,
    damageDealt: sum('damageDealt'),
    damageTaken: sum('damageTaken'),
    downed: sum('downed'),
    shortRests: sum('shortRests'),
    longRests: sum('longRests'),
    roundCaps: sum('roundCaps'),
    pcActions: actions,
    singleTargetDealt: sum('singleTargetDealt'),
    control: sum('control'),
    // Damage per ACTION TAKEN is the headline offence number. Dividing by
    // rounds instead would score a character down for rounds in which the
    // fight was already over - measuring the allies, not the character.
    dpr: actions ? +(sum('damageDealt') / actions).toFixed(3) : 0,
    // Single-target damage per action: comparable across classes without
    // crediting area spells for splash.
    stDpr: actions ? +(sum('singleTargetDealt') / actions).toFixed(3) : 0,
    // Control events per action - the axis on which two subclasses can
    // differ while scoring identically on damage.
    cpa: actions ? +(sum('control') / actions).toFixed(4) : 0,
    dtpr: rounds ? +(sum('damageTaken') / rounds).toFixed(3) : 0,
    downRate: encounters ? +(sum('downed') / encounters).toFixed(4) : 0,
    wipes: sum('wipes'),
    wipeRate: encounters ? +(sum('wipes') / encounters).toFixed(5) : 0,
  };
}

/** Return a homebrew list with one effect removed, for paired ablation. */
function ablateEffect(homebrew, ablate) {
  return (homebrew || []).map((brew) => {
    if (brew.id !== ablate.brewId) return brew;
    return {
      ...brew,
      features: brew.features.map((f) => {
        if (f.id !== ablate.featureId) return f;
        return {
          ...f,
          effects: (f.effects || []).filter(
            (e, i) => !(e.type === ablate.effectType
              && (ablate.effectIndex === undefined || i === ablate.effectIndex)),
          ),
        };
      }),
    };
  });
}
