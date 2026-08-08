/**
 * The live encounter runner.
 *
 * One initiative list holding the party and the monsters together, with HP,
 * conditions, round and turn tracking. This is the screen a DM keeps open
 * during a fight, so it is built for speed of use rather than completeness:
 * every common action is one click, and nothing needs a confirmation.
 *
 * Damage goes through applyDamage() in engine.js, the same function the
 * simulator and the player's sheet use. The DM's arithmetic and the game's
 * arithmetic are therefore the same arithmetic - including resistances, which
 * a hand-run fight usually forgets.
 *
 * State lives here rather than in the database on purpose: an encounter is
 * scratch. It survives switching tabs, and is deliberately lost on reload,
 * which is the same promise the sandbox makes and for the same reason - a
 * half-finished fight silently resurrecting a week later helps nobody.
 */

import { el, esc, toast } from '../../core/store.js';
import { derive } from '../../core/derive.js';
import { applyDamage } from '../../core/engine.js';
import { d20 } from '../../core/dice.js';
import { instantiate } from '../../sim/encounter.js';
import { cryptoRng } from '../../core/rng.js';
import { log } from '../../core/events.js';
import { CONDITIONS } from '../../core/rules2024.js';

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

export const state = {
  combatants: [],
  round: 0,
  turn: 0,
  started: false,
};

let seq = 0;
const nextId = () => `c${(seq += 1)}`;

export function reset() {
  state.combatants = [];
  state.round = 0;
  state.turn = 0;
  state.started = false;
}

/** Add a player character, deriving its real numbers. */
export function addCharacter(character, sources) {
  const d = derive(character, sources);
  state.combatants.push({
    id: nextId(),
    kind: 'pc',
    characterId: character.id,
    name: character.name || 'Unnamed',
    ac: d.ac,
    hp: d.hp.current,
    hpMax: d.hp.max,
    temp: d.hp.temp || 0,
    initMod: d.initiative,
    init: null,
    conditions: [...(d.conditions || [])],
    // Carried so applyDamage() can honour them - the thing a DM running a
    // fight by hand most often forgets.
    resistances: d.resistances || [],
    immunities: d.immunities || [],
    notes: '',
  });
}

/**
 * Monster defences are prose, not arrays.
 *
 * The compendium stores them as written: "Bludgeoning, Lightning, Piercing,
 * Slashing" for resistances, and for immunities a semicolon separates damage
 * types from CONDITION immunities - "Poison, Thunder; Exhaustion, Grappled".
 * mitigate() wants damage types only, so the tail is dropped here rather than
 * being passed along to be silently ignored.
 */
export function parseDefences(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((s) => String(s).toLowerCase());
  return String(value)
    .split(';')[0]
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Add monsters. Several of the same kind become separate combatants with
 * their own HP, because "goblin 3 is bloodied" is the whole point.
 */
export function addMonsters(monster, count = 1) {
  const rng = cryptoRng('runner');
  for (let i = 0; i < count; i += 1) {
    const m = instantiate(monster, i, rng);
    state.combatants.push({
      id: nextId(),
      kind: 'monster',
      monsterId: monster.id,
      // Number from the BASE name. instantiate() already appends an index for
      // everything past the first, so reusing its name gave "Goblin Warrior 3 3"
      // - and left the first one unnumbered while its siblings were numbered.
      name: count > 1 ? `${monster.name} ${i + 1}` : monster.name,
      ac: m.ac,
      hp: m.hp,
      hpMax: m.hpMax ?? m.hp,
      temp: 0,
      initMod: m.initiativeMod ?? 0,
      init: null,
      conditions: [],
      // Read from the STATBLOCK, not the instantiated combatant - instantiate()
      // does not carry defences through, so taking them from `m` silently gave
      // every monster no resistances at all.
      resistances: parseDefences(monster.resistances),
      immunities: parseDefences(monster.immunities),
      stat: monster,
      notes: '',
    });
  }
}

export function addCustom({ name, ac = 12, hp = 10, initMod = 0 }) {
  state.combatants.push({
    id: nextId(), kind: 'custom', name: name || 'Combatant',
    ac: Number(ac) || 10, hp: Number(hp) || 1, hpMax: Number(hp) || 1, temp: 0,
    initMod: Number(initMod) || 0, init: null,
    conditions: [], resistances: [], immunities: [], notes: '',
  });
}

export function remove(id) {
  state.combatants = state.combatants.filter((c) => c.id !== id);
  if (state.turn >= state.combatants.length) state.turn = 0;
}

/**
 * Roll initiative and sort.
 *
 * Ties break on the modifier, then on name, so the order is stable rather than
 * depending on insertion. A DM who re-sorts mid-fight and gets a different
 * order has lost their place.
 */
export function rollInitiative() {
  const rng = cryptoRng('init');
  for (const c of state.combatants) {
    if (c.init === null) c.init = d20({ mod: c.initMod, rng }).total;
  }
  sort();
  state.round = 1;
  state.turn = 0;
  state.started = true;
}

export function sort() {
  state.combatants.sort((a, b) => (b.init ?? -99) - (a.init ?? -99)
    || (b.initMod - a.initMod)
    || a.name.localeCompare(b.name));
}

export function nextTurn() {
  if (!state.combatants.length) return;
  state.turn += 1;
  if (state.turn >= state.combatants.length) {
    state.turn = 0;
    state.round += 1;
  }
}

export function prevTurn() {
  if (!state.combatants.length) return;
  state.turn -= 1;
  if (state.turn < 0) {
    state.turn = state.combatants.length - 1;
    state.round = Math.max(1, state.round - 1);
  }
}

/**
 * Apply damage (negative) or healing (positive) to one combatant.
 *
 * Routed through the engine so temporary HP is spent first and resistance is
 * halved - by hand, both are routinely missed.
 */
export function applyTo(id, delta, damageType = null) {
  const c = state.combatants.find((x) => x.id === id);
  if (!c) return null;
  const res = applyDamage(
    { hp: { current: c.hp }, hpMax: c.hpMax, temp: c.temp },
    delta,
    { name: c.name, damageType,
      resistances: c.resistances, immunities: c.immunities },
  );
  c.hp = res.hp;
  c.temp = res.temp;
  const landed = res.events.find((e) => e.type === 'damage_taken');
  return {
    landed: landed ? landed.payload.amount : Math.abs(delta),
    mitigation: landed?.payload.mitigation || null,
    downed: res.downed,
  };
}

export function toggleCondition(id, condition) {
  const c = state.combatants.find((x) => x.id === id);
  if (!c) return;
  c.conditions = c.conditions.includes(condition)
    ? c.conditions.filter((x) => x !== condition)
    : [...c.conditions, condition];
}

/** A short line per combatant, for pasting into notes or the chronicle. */
export function summary() {
  return state.combatants
    .map((c) => `${c.name} ${c.hp}/${c.hpMax}`
      + (c.conditions.length ? ` [${c.conditions.join(', ')}]` : ''))
    .join(' · ');
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

const sign = (n) => `${n >= 0 ? '+' : ''}${n}`;

export function runnerPanel({ characters, sources, monsters, redraw }) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Encounter'));

  // --- controls --------------------------------------------------------
  const controls = el('div', { class: 'btnrow' });
  if (!state.started) {
    controls.append(el('button', {
      class: 'act',
      onClick: () => {
        if (!state.combatants.length) return toast('Add somebody first', 'warn');
        rollInitiative();
        log('encounter_start', { combatants: state.combatants.length });
        redraw();
        return null;
      },
    }, 'Roll initiative & start'));
  } else {
    controls.append(el('button', {
      class: 'act', onClick: () => { nextTurn(); redraw(); },
    }, 'Next turn'));
    controls.append(el('button', {
      class: 'act ghost', onClick: () => { prevTurn(); redraw(); },
    }, 'Back'));
  }
  controls.append(el('button', {
    class: 'act ghost',
    onClick: () => {
      if (state.started && !window.confirm('End the encounter and clear everyone?')) return;
      reset(); redraw();
    },
  }, 'Clear'));
  panel.append(controls);

  if (state.started) {
    const current = state.combatants[state.turn];
    panel.append(el('h3', {},
      `Round ${state.round}${current ? ` — ${current.name}'s turn` : ''}`));
  } else {
    panel.append(el('h3', {}, `${state.combatants.length} in the fight`));
    panel.append(el('p', { class: 'muted', style: 'font-size:13px' },
      'Add the party and the monsters, then roll initiative. Damage goes '
      + 'through the same engine as everything else, so resistances are '
      + 'applied for you.'));
  }

  // --- the list --------------------------------------------------------
  for (const [i, c] of state.combatants.entries()) {
    panel.append(combatantRow(c, i, redraw));
  }

  if (!state.combatants.length) {
    panel.append(el('div', { class: 'empty' }, 'Nobody in the fight yet.'));
  }

  // --- adding ----------------------------------------------------------
  panel.append(el('h3', { style: 'margin-top:18px' }, 'Add'));

  const addRow = el('div', { class: 'btnrow' });
  for (const ch of characters) {
    if (state.combatants.some((c) => c.characterId === ch.id)) continue;
    addRow.append(el('button', {
      class: 'act ghost small',
      onClick: () => { addCharacter(ch, sources); redraw(); },
    }, `+ ${ch.name || 'Unnamed'}`));
  }
  if (characters.length && characters.every(
    (ch) => state.combatants.some((c) => c.characterId === ch.id))) {
    addRow.append(el('span', { class: 'muted', style: 'font-size:12px' },
      'every character is already in'));
  }
  panel.append(addRow);

  // Monster search: type, pick, choose how many.
  const search = el('input', { type: 'text', placeholder: 'Add a monster by name...' });
  const results = el('div', { style: 'margin:6px 0' });
  const countInput = el('input', {
    type: 'number', min: '1', max: '20', value: '1', style: 'width:70px',
  });

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    results.innerHTML = '';
    if (q.length < 2) return;
    const hits = monsters
      .filter((m) => m.name.toLowerCase().includes(q))
      .slice(0, 8);
    for (const m of hits) {
      results.append(el('button', {
        class: 'act ghost small', style: 'margin:2px',
        onClick: () => {
          addMonsters(m, Math.max(1, Math.min(20, Number(countInput.value) || 1)));
          search.value = ''; results.innerHTML = '';
          redraw();
        },
      }, `${m.name} (CR ${m.cr})`));
    }
    if (!hits.length) results.append(el('span', { class: 'muted' }, 'nothing matches'));
  });

  const monsterRow = el('div', {
    style: 'display:flex;gap:8px;align-items:center;margin-top:8px',
  });
  monsterRow.append(el('span', { class: 'eyebrow' }, 'How many'));
  monsterRow.append(countInput);
  monsterRow.append(search);
  panel.append(monsterRow);
  panel.append(results);

  // Custom combatant, for the thing that is not in any book.
  const cName = el('input', { type: 'text', placeholder: 'Name' });
  const cAc = el('input', { type: 'number', value: '12', style: 'width:70px' });
  const cHp = el('input', { type: 'number', value: '15', style: 'width:80px' });
  const custom = el('div', {
    style: 'display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap',
  });
  custom.append(el('span', { class: 'eyebrow' }, 'Custom'));
  custom.append(cName);
  custom.append(el('span', { class: 'eyebrow' }, 'AC'));
  custom.append(cAc);
  custom.append(el('span', { class: 'eyebrow' }, 'HP'));
  custom.append(cHp);
  custom.append(el('button', {
    class: 'act ghost small',
    onClick: () => {
      if (!cName.value.trim()) return toast('Give it a name', 'warn');
      addCustom({ name: cName.value.trim(), ac: cAc.value, hp: cHp.value });
      cName.value = '';
      redraw();
      return null;
    },
  }, 'Add'));
  panel.append(custom);

  return panel;
}

function combatantRow(c, index, redraw) {
  const active = state.started && index === state.turn;
  const down = c.hp <= 0;
  const row = el('div', {
    style: 'border-bottom:1px solid var(--etch);padding:8px 0;'
      + (active ? 'background:rgba(184,74,22,.12);' : '')
      + (down ? 'opacity:.55;' : ''),
  });

  const top = el('div', {
    style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap',
  });
  top.append(el('span', {
    class: 'mono', style: 'width:34px;font-weight:700',
  }, c.init === null ? '--' : String(c.init)));
  top.append(el('span', { class: 'chip' }, c.kind === 'pc' ? 'PC' : c.kind));
  top.append(el('strong', { style: 'flex:1;min-width:140px' },
    `${c.name}${down ? ' (down)' : ''}`));
  top.append(el('span', { class: 'mono', style: 'font-size:12px' }, `AC ${c.ac}`));

  // HP, coloured, with temp shown separately so it is not mistaken for real.
  const frac = c.hpMax ? c.hp / c.hpMax : 1;
  top.append(el('span', {
    class: 'mono',
    style: `font-weight:700;${down ? 'color:var(--bad)'
      : frac <= 0.5 ? 'color:var(--warn)' : ''}`,
  }, `${c.hp}/${c.hpMax}${c.temp ? ` (+${c.temp})` : ''}`));

  // One field, two buttons: the fastest form of "the ogre hits for 13".
  const amount = el('input', {
    type: 'number', value: '', placeholder: '0', style: 'width:66px',
  });
  const apply = (mult) => {
    const n = Number(amount.value);
    if (!n) return;
    const res = applyTo(c.id, mult * Math.abs(n));
    amount.value = '';
    if (res?.mitigation) {
      toast(`${c.name} is ${res.mitigation} — took ${res.landed}`, 'ok');
    }
    if (res?.downed) toast(`${c.name} is down`, 'bad');
    log(mult < 0 ? 'damage_dealt' : 'healed',
      { target: c.name, amount: Math.abs(n) });
    redraw();
  };
  top.append(amount);
  top.append(el('button', { class: 'act small', onClick: () => apply(-1) }, 'Hit'));
  top.append(el('button', { class: 'act ghost small', onClick: () => apply(+1) }, 'Heal'));
  top.append(el('button', {
    class: 'act ghost small', onClick: () => { remove(c.id); redraw(); },
  }, '×'));
  row.append(top);

  // Conditions: the six a fight actually uses, then the rest behind a toggle.
  const COMMON = ['Prone', 'Grappled', 'Restrained', 'Frightened',
    'Poisoned', 'Stunned'];
  const conds = el('div', { style: 'margin-top:5px;display:flex;gap:4px;flex-wrap:wrap' });
  const names = (CONDITIONS || []).map((x) => (typeof x === 'string' ? x : x.name));
  const list = names.length ? names : COMMON;
  for (const name of list.filter((n) => COMMON.includes(n) || c.conditions.includes(n))) {
    const on = c.conditions.includes(name);
    conds.append(el('button', {
      class: `act ${on ? '' : 'ghost'} small`,
      style: 'font-size:10px;padding:2px 7px',
      onClick: () => { toggleCondition(c.id, name); redraw(); },
    }, name));
  }
  row.append(conds);

  if (c.conditions.length) {
    row.append(el('div', { class: 'muted', style: 'font-size:11px;margin-top:3px' },
      `Conditions: ${esc(c.conditions.join(', '))}`));
  }
  return row;
}
