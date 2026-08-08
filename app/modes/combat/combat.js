/**
 * Combat mode - full encounter tracker.
 *
 * Tracks the whole initiative order (PCs, allies, enemies), not just your turn.
 * Concentration prompts automatically on damage, death saves are tracked, and
 * homebrew triggers fire here - a natural 1 on any roll made through this
 * screen runs the ingested Fool's Fortune table without anyone remembering to.
 */

import { getState, setState, el, esc, sign, toast, md } from '../../core/store.js';
import { db, compendium } from '../../core/db.js';
import { log } from '../../core/events.js';
import { d20, fmt } from '../../core/dice.js';
import {
  resolveAttack, fireTriggers, rollOnTable, applyDamage, deathSave,
} from '../../core/engine.js';
import { CONDITIONS } from '../../core/rules2024.js';
import { saveCharacter, go } from '../../app.js';

export const title = 'Combat';

let container = null;
let monsters = null;

export async function render(root) {
  container = root;
  draw();
}

const enc = () => getState().encounter;

function newEncounter() {
  return {
    id: `enc-${Date.now().toString(36)}`,
    name: 'Encounter',
    round: 0,
    turn: 0,
    started: false,
    combatants: [],
  };
}

function draw() {
  container.innerHTML = '';
  container.append(controlPanel());
  if (enc()?.combatants.length) container.append(trackerPanel());
  container.append(addPanel());
  const { derived } = getState();
  if (derived) container.append(quickPanel(derived));
}

/* ------------------------------------------------------------------ */

function controlPanel() {
  const e = enc();
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' },
    e?.started ? `Round ${e.round}` : 'Encounter'));
  panel.append(el('h3', {}, e?.name || 'No encounter running'));

  const row = el('div', { class: 'btnrow' });
  if (!e) {
    row.append(el('button', {
      class: 'act', onClick: () => { setState({ encounter: newEncounter() }); draw(); },
    }, 'New encounter'));
  } else {
    if (!e.started) {
      row.append(el('button', {
        class: 'act', disabled: !e.combatants.length, onClick: startEncounter,
      }, 'Roll initiative & start'));
    } else {
      row.append(el('button', { class: 'act', onClick: nextTurn }, 'Next turn'));
    }
    row.append(el('button', { class: 'act ghost', onClick: endEncounter }, 'End encounter'));
  }
  panel.append(row);

  if (e?.started) {
    const active = e.combatants[e.turn];
    panel.append(el('p', { class: 'mono', style: 'margin-top:12px;font-size:15px' },
      `Now: ${active?.name || '-'}`));
  }
  return panel;
}

async function startEncounter() {
  const e = { ...enc() };
  for (const c of e.combatants) {
    if (c.initiative === null || c.initiative === undefined) {
      const r = d20({ mod: c.initiativeMod || 0 });
      c.initiative = r.total;
    }
  }
  e.combatants.sort((a, b) => b.initiative - a.initiative);
  e.started = true;
  e.round = 1;
  e.turn = 0;
  setState({ encounter: e });
  await log('encounter_start', {
    name: e.name, combatants: e.combatants.map((c) => c.name),
  });
  toast(`Initiative: ${e.combatants.map((c) => `${c.name} ${c.initiative}`).join(', ')}`);
  draw();
}

async function nextTurn() {
  const e = { ...enc() };
  e.turn += 1;
  if (e.turn >= e.combatants.length) { e.turn = 0; e.round += 1; }
  // Tick down timed conditions at the top of each combatant's turn.
  const active = e.combatants[e.turn];
  if (active?.conditions?.length) {
    active.conditions = active.conditions
      .map((c) => (typeof c === 'string' ? { name: c, rounds: null } : c))
      .map((c) => (c.rounds ? { ...c, rounds: c.rounds - 1 } : c))
      .filter((c) => c.rounds === null || c.rounds > 0);
  }
  setState({ encounter: e });
  draw();
}

async function endEncounter() {
  const e = enc();
  await log('encounter_end', {
    name: e.name, rounds: e.round,
    survivors: e.combatants.filter((c) => c.hp > 0).map((c) => c.name),
  });
  setState({ encounter: null });
  toast('Encounter ended and logged', 'ok');
  draw();
}

/* ------------------------------------------------------------------ */

function trackerPanel() {
  const e = enc();
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Initiative'));

  for (const [i, c] of e.combatants.entries()) {
    const isActive = e.started && i === e.turn;
    const row = el('div', {
      style: 'display:flex;gap:10px;align-items:center;padding:9px 8px;'
        + 'border-bottom:1px solid var(--etch);'
        + (isActive ? 'background:var(--etch);border-left:4px solid var(--accent)' : ''),
    });

    row.append(el('span', {
      class: 'mono', style: 'width:34px;font-weight:600;text-align:center',
    }, c.initiative ?? '-'));

    const info = el('div', { style: 'flex:1;min-width:120px' });
    const nameLine = el('div');
    nameLine.append(el('strong', {
      style: c.hp <= 0 ? 'text-decoration:line-through;opacity:.55' : '',
    }, c.name));
    if (c.side === 'pc') nameLine.append(el('span', { class: 'chip ok', style: 'margin-left:6px' }, 'PC'));
    if (c.concentrating) {
      nameLine.append(el('span', { class: 'chip accent', style: 'margin-left:6px' },
        `conc: ${c.concentrating}`));
    }
    info.append(nameLine);
    if (c.conditions?.length) {
      const chips = el('div', { style: 'margin-top:3px' });
      for (const cond of c.conditions) {
        const name = typeof cond === 'string' ? cond : cond.name;
        const rounds = typeof cond === 'string' ? null : cond.rounds;
        chips.append(el('span', { class: 'chip bad', style: 'margin-right:4px' },
          rounds ? `${name} ${rounds}r` : name));
      }
      info.append(chips);
    }
    row.append(info);

    row.append(el('span', { class: 'mono', style: 'width:76px;text-align:right' },
      `${c.hp}/${c.hpMax}${c.temp ? ` +${c.temp}` : ''}`));
    row.append(el('span', { class: 'mono muted', style: 'width:52px;text-align:right' },
      `AC ${c.ac}`));

    const amount = el('input', {
      type: 'number', value: '', placeholder: '0',
      style: 'width:62px;padding:5px',
    });
    row.append(amount);
    row.append(el('button', {
      class: 'act small', onClick: () => damageCombatant(i, -Math.abs(+amount.value || 0)),
    }, 'Hit'));
    row.append(el('button', {
      class: 'act ghost small', onClick: () => damageCombatant(i, Math.abs(+amount.value || 0)),
    }, 'Heal'));
    row.append(el('button', {
      class: 'act ghost small', onClick: () => editCombatant(i),
    }, '...'));
    panel.append(row);
  }
  return panel;
}

async function damageCombatant(index, delta) {
  if (!delta) return;
  const e = { ...enc() };
  const c = { ...e.combatants[index] };

  const res = applyDamage(c, delta, { name: c.name });
  c.hp = res.hp;
  c.temp = res.temp;
  e.combatants[index] = c;
  setState({ encounter: e });

  if (delta < 0) {
    // An enemy losing HP is damage WE dealt; a PC losing HP is damage taken.
    await log(c.side === 'pc' ? 'damage_taken' : 'damage_dealt',
      { target: c.name, amount: -delta });
    if (res.concentrationDc) {
      toast(`${c.name} must make a DC ${res.concentrationDc} Constitution save `
        + `or lose ${c.concentrating}`, 'warn');
    }
    if (res.downed) {
      if (c.side === 'pc') await log('downed', { name: c.name });
      else await log('kill', { target: c.name });
      toast(`${c.name} is down`, c.side === 'pc' ? 'bad' : 'ok');
    }
  } else {
    await log('healed', { target: c.name, amount: delta });
  }

  // Keep a PC combatant and the real character sheet in sync.
  if (c.characterId) {
    const { character } = getState();
    if (character?.id === c.characterId) {
      await saveCharacter((ch) => {
        ch.hp = { ...ch.hp, current: c.hp, temp: c.temp || 0 };
        return ch;
      });
    }
  }
  draw();
}

function editCombatant(index) {
  const e = { ...enc() };
  const c = e.combatants[index];
  const choice = prompt(
    `${c.name}\n\n`
    + '1 = add condition\n2 = clear conditions\n3 = set concentration\n'
    + '4 = death save\n5 = remove from encounter',
    '1',
  );
  if (choice === '1') {
    const name = prompt(`Condition (${CONDITIONS.join(', ')})`, 'Prone');
    if (!name) return;
    const rounds = parseInt(prompt('Lasts how many rounds? (blank = until removed)', ''), 10);
    c.conditions = [...(c.conditions || []),
      { name, rounds: Number.isFinite(rounds) ? rounds : null }];
    log('condition_gained', { target: c.name, condition: name });
  } else if (choice === '2') {
    c.conditions = [];
  } else if (choice === '3') {
    c.concentrating = prompt('Concentrating on what? (blank to clear)', c.concentrating || '') || null;
  } else if (choice === '4') {
    const res = deathSave();
    for (const ev of res.events) log(ev.type, { ...ev.payload, name: c.name });
    toast(`${c.name} death save: ${res.roll.nat} - ${res.outcome}`,
      res.successes ? 'ok' : 'bad');
  } else if (choice === '5') {
    e.combatants.splice(index, 1);
    if (e.turn >= e.combatants.length) e.turn = 0;
  }
  setState({ encounter: e });
  draw();
}

/* ------------------------------------------------------------------ */

function addPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Add'));
  panel.append(el('h3', {}, 'Add combatants'));

  const row = el('div', { class: 'btnrow' });
  const { character, derived } = getState();
  if (derived) {
    row.append(el('button', {
      class: 'act', onClick: () => addCombatant({
        name: character.name, side: 'pc', ac: derived.ac,
        hp: derived.hp.current, hpMax: derived.hp.max, temp: derived.hp.temp,
        initiativeMod: derived.initiative, characterId: character.id,
      }),
    }, `Add ${character.name}`));
  }
  row.append(el('button', { class: 'act ghost', onClick: addCustom }, 'Custom combatant'));
  row.append(el('button', { class: 'act ghost', onClick: addFromMonsters }, 'From SRD monsters'));
  panel.append(row);

  const search = el('input', {
    type: 'text', placeholder: 'Search 330 SRD monsters, then press Enter',
    style: 'margin-top:12px',
  });
  search.addEventListener('keydown', async (ev) => {
    if (ev.key !== 'Enter') return;
    monsters = monsters || await compendium('monsters');
    const q = search.value.trim().toLowerCase();
    const hits = monsters.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 8);
    if (!hits.length) return toast('No monster matched', 'bad');
    const list = el('div', { class: 'btnrow', style: 'margin-top:8px' });
    for (const m of hits) {
      list.append(el('button', {
        class: 'act ghost small',
        onClick: () => addCombatant({
          name: m.name, side: 'enemy', ac: m.ac || 10,
          hp: m.hp || 10, hpMax: m.hp || 10,
          initiativeMod: m.initiative ?? (m.abilities?.dex?.mod || 0),
          monsterId: m.id,
        }),
      }, `${m.name} (CR ${m.crText || m.cr}, AC ${m.ac}, ${m.hp} HP)`));
    }
    const old = panel.querySelector('.hits');
    if (old) old.remove();
    list.className = 'btnrow hits';
    panel.append(list);
  });
  panel.append(search);
  return panel;
}

async function addFromMonsters() {
  monsters = monsters || await compendium('monsters');
  toast(`${monsters.length} SRD monsters loaded - search below`);
}

function addCustom() {
  const name = prompt('Name?', 'Bandit');
  if (!name) return;
  const hp = parseInt(prompt('Hit points?', '11'), 10) || 1;
  const ac = parseInt(prompt('AC?', '12'), 10) || 10;
  addCombatant({ name, side: 'enemy', ac, hp, hpMax: hp, initiativeMod: 0 });
}

function addCombatant(spec) {
  const e = enc() || newEncounter();
  e.combatants = [...e.combatants, {
    id: `c-${Date.now().toString(36)}-${e.combatants.length}`,
    initiative: null, conditions: [], concentrating: null, temp: 0, ...spec,
  }];
  setState({ encounter: { ...e } });
  draw();
}

/* ------------------------------------------------------------------ */

/** Your character's own options, rolled from inside combat so they log. */
function quickPanel(d) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Your turn'));
  panel.append(el('h3', {}, d.name));

  const atk = el('div', { class: 'btnrow', style: 'margin-bottom:12px' });
  for (const a of d.attacks) {
    atk.append(el('button', {
      class: 'act ghost small', onClick: () => rollAttack(a, d),
    }, `${a.name} ${sign(a.attackBonus)}`));
  }
  panel.append(atk);

  if (d.actions.length) {
    panel.append(el('div', { class: 'eyebrow', style: 'margin:10px 0 6px' },
      'Feature actions'));
    const acts = el('div', { class: 'btnrow' });
    for (const a of d.actions) {
      const label = `${a.name}${a.cost ? ` (${a.cost.amount} ${a.cost.resource})` : ''}`;
      acts.append(el('button', {
        class: 'act ghost small', title: a.text || '',
        onClick: () => useAction(a, d),
      }, label));
    }
    panel.append(acts);
  }

  if (d.toggles.length) {
    panel.append(el('div', { class: 'eyebrow', style: 'margin:12px 0 6px' }, 'Stances'));
    const togs = el('div', { class: 'btnrow' });
    for (const t of d.toggles) {
      const active = d.toggleState[t.key] ?? t.default;
      for (const o of t.options || []) {
        togs.append(el('button', {
          class: `act ${active === o.key ? '' : 'ghost'} small`,
          onClick: async () => {
            await saveCharacter((c) => {
              c.toggles = { ...(c.toggles || {}), [t.key]: o.key };
              return c;
            });
            toast(`${t.name}: ${o.label}`);
            draw();
          },
        }, `${t.name}: ${o.label}`));
      }
    }
    panel.append(togs);
  }

  if (d.rollTables.length) {
    panel.append(el('div', { class: 'eyebrow', style: 'margin:12px 0 6px' },
      'Homebrew tables'));
    const tabs = el('div', { class: 'btnrow' });
    for (const t of d.rollTables) {
      tabs.append(el('button', {
        class: 'act ghost small', onClick: () => rollTable(t),
      }, `Roll ${t.name} (${t.die})`));
    }
    panel.append(tabs);
  }
  return panel;
}

async function rollAttack(a, d) {
  const res = resolveAttack(a, { attackerName: d.name });
  for (const ev of res.events) await log(ev.type, ev.payload);
  toast(`${a.name}: ${fmt(res.roll)} to hit · ${res.total} damage`
    + `${res.crit ? ' (CRIT)' : ''}`, res.crit ? 'ok' : 'info');
  if (res.fumble) await runTriggers(d, res.roll.nat);
}

/** Fire any homebrew nat-roll trigger that matches, and surface the results. */
export async function runTriggers(d, nat) {
  const { fired, events } = fireTriggers(d, nat);
  for (const ev of events) await log(ev.type, ev.payload);
  for (const f of fired) {
    if (f.unmapped) { toast(`${f.trigger.from} triggered (no table mapped)`, 'warn'); continue; }
    toast(`${f.table.name} (${f.n}): ${f.entry?.text}`, 'ok');
  }
  return fired;
}

async function rollTable(table, from = null) {
  const res = rollOnTable({ ...table, from: from || table.from });
  for (const ev of res.events) await log(ev.type, ev.payload);
  toast(`${table.name} (${res.n}): ${res.entry?.text}`, 'ok');
}

async function useAction(a, d) {
  if (a.cost?.resource) {
    const res = d.resources.find((r) => r.name === a.cost.resource);
    if (res && res.current < a.cost.amount) {
      return toast(`Not enough ${a.cost.resource}`, 'bad');
    }
    if (res) {
      await saveCharacter((c) => {
        const state = { ...(c.resourceState || {}) };
        state[res.name] = (state[res.name] ?? res.max) - a.cost.amount;
        c.resourceState = state;
        return c;
      });
      await log('resource_spent', { resource: a.cost.resource, amount: a.cost.amount });
    }
  }
  await log('homebrew_trigger', { feature: a.name, result: 'used' });
  toast(`${a.name} used${a.save ? ` - ${a.save.ability.toUpperCase()} save vs DC ${d.spellcasting?.saveDc ?? '?'}` : ''}`);
  draw();
  return null;
}
