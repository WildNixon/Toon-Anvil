/**
 * Play mode - the live character sheet.
 *
 * Everything clickable rolls, and every roll logs. That is the point: the
 * Chronicle is only rich because the sheet is honest about what happened.
 */

import { getState, setState, esc, el, sign, md, toast } from '../../core/store.js';
import { log } from '../../core/events.js';
import { d20, fmt } from '../../core/dice.js';
import {
  resolveAttack, fireTriggers, applyDamage as engineApplyDamage,
  shortRest as engineShortRest, longRest as engineLongRest,
  useSlot as engineUseSlot,
} from '../../core/engine.js';
import {
  ABILITIES, ABILITY_NAMES, SKILLS, fromCopper, CONDITIONS,
} from '../../core/rules2024.js';
import { dataFile } from '../../core/db.js';
import { saveCharacter, adjustHp as shellAdjustHp, go } from '../../app.js';
import * as session from '../../core/session.js';
import { tabs } from '../../ui/kit.js';
import { cardModel, pushRollCard } from '../../ui/components/rollcard.js';

export const title = 'Play';

let container = null;
// Which tab is open. Module-level so switching to Combat and back does not
// lose your place; a reload starts at Overview, which is also what the UI
// tests rely on (every frozen string lives there).
let tab = 'overview';

// Armed for the NEXT roll, then spent. Module-level so a redraw mid-fight
// does not disarm what the player just pressed.
let rollMode = null; // null | 'adv' | 'dis'

function syncRollModeBar() {
  const bar = container?.querySelector('#rollmode');
  if (!bar) return;
  for (const b of bar.querySelectorAll('button')) {
    const on = (b.dataset.mode || null) === (rollMode || '') || (!rollMode && !b.dataset.mode);
    b.className = `act small${on ? '' : ' ghost'}`;
    b.setAttribute('aria-pressed', String(on));
  }
}

/** Consume the armed mode - one roll spends it, back to normal. */
function takeRollMode() {
  const armed = rollMode;
  rollMode = null;
  syncRollModeBar();
  return { advantage: armed === 'adv', disadvantage: armed === 'dis' };
}

function rollModeBar() {
  const bar = el('div', {
    id: 'rollmode', role: 'group', 'aria-label': 'Roll mode',
    class: 'btnrow', style: 'gap:6px;margin:0 0 10px',
  });
  const mk = (mode, label) => {
    const on = (rollMode || '') === (mode || '');
    return el('button', {
      class: `act small${on ? '' : ' ghost'}`,
      'aria-pressed': String(on),
      dataset: mode ? { mode } : {},
      onClick: () => {
        // Tapping the armed one disarms it.
        rollMode = (rollMode === mode) ? null : mode;
        syncRollModeBar();
      },
    }, label);
  };
  bar.append(mk(null, 'Normal'), mk('adv', 'Advantage'), mk('dis', 'Disadvantage'));
  return bar;
}

export async function render(root) {
  container = root;
  draw();
}

function draw() {
  const { character, derived } = getState();
  container.innerHTML = '';
  if (!character || !derived) {
    container.append(el('div', { class: 'empty' },
      'No character selected. Build one first.'));
    container.append(el('div', { class: 'btnrow' },
      el('button', { class: 'act', onClick: () => go('build') }, 'Go to Build')));
    return;
  }

  // One long page became four short ones. Overview keeps everything a turn
  // needs - vitals, abilities, skills, attacks - so mid-fight play never
  // crosses a tab.
  container.append(tabs({
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'spells', label: 'Spells' },
      { id: 'features', label: 'Features' },
      { id: 'inventory', label: 'Inventory' },
    ],
    active: tab,
    onSelect: (id) => { tab = id; draw(); },
  }));

  if (tab === 'overview') {
    // A waiting grant is the one piece of DM state a player must not miss.
    const cap = session.isOpen() && !session.isDm()
      ? session.myGrant(character.id) : null;
    if (cap !== null) {
      const banner = el('div', { class: 'panel accent rivets' });
      banner.append(el('span', { class: 'lvl accent' }, 'Level up'));
      banner.append(el('p', { style: 'margin:0 0 8px;font-size:14px' },
        `The DM has granted a level-up - you can reach level ${cap}.`));
      banner.append(el('button', {
        class: 'act', onClick: () => go('build'),
      }, 'To the forge'));
      container.append(banner);
    }
    container.append(rollModeBar());
    container.append(vitalsPanel(derived));
    container.append(el('div', { class: 'grid two' },
      abilitiesPanel(derived), skillsPanel(derived)));
    container.append(attacksPanel(derived));
  } else if (tab === 'spells') {
    if (derived.resources.length || derived.toggles.length) {
      container.append(resourcesPanel(derived));
    }
    if (derived.spellcasting) container.append(spellPanel(derived));
    if (!derived.spellcasting && !derived.resources.length && !derived.toggles.length) {
      container.append(el('div', { class: 'empty' },
        'No spells or limited-use features yet.'));
    }
  } else if (tab === 'features') {
    container.append(featuresPanel(derived));
  } else {
    container.append(inventoryPanel(derived));
  }
}

/* ------------------------------------------------------------------ */

function vitalsPanel(d) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, `Level ${d.level}`));
  panel.append(el('h3', {}, d.name || 'Unnamed'));

  const stats = el('div', { class: 'grid stats' });
  const add = (k, v, sub, onClick) => {
    const s = el('div', { class: `stat${onClick ? ' clickable' : ''}` }, );
    if (onClick) s.addEventListener('click', onClick);
    s.append(el('div', { class: 'k' }, k));
    s.append(el('div', { class: 'v' }, String(v)));
    if (sub) s.append(el('div', { class: 'sub' }, sub));
    stats.append(s);
  };

  add('AC', d.ac, d.acSource);
  add('HP', `${d.hp.current}${d.hp.temp ? `+${d.hp.temp}` : ''}`, `of ${d.hp.max}`);
  if (!d.hp.derived) {
    // The maximum in force is a table's rolled number, not the rules' -
    // said out loud, since every other figure on this screen is derived.
    const last = stats.lastElementChild;
    last?.append(el('span', { class: 'chip accent', style: 'margin-top:4px' },
      'rolled'));
  }
  add('Initiative', sign(d.initiative), 'click to roll', () => {
    const r = d20({ mod: d.initiative, ...takeRollMode() });
    log('initiative', { total: r.total, nat: r.nat });
    pushRollCard(cardModel({ label: 'Initiative', roll: r }));
  });
  add('Speed', `${d.speeds.walk}`, 'feet');
  add('Prof', sign(d.proficiencyBonus));
  add('Passive', d.passivePerception, 'perception');
  panel.append(stats);

  // HP controls
  const hpRow = el('div', { class: 'btnrow', style: 'margin-top:14px;align-items:center' });
  const amount = el('input', {
    type: 'number', value: '5', style: 'width:70px', id: 'hp-amount',
  });
  hpRow.append(el('span', { class: 'eyebrow' }, 'Adjust HP'));
  hpRow.append(amount);
  hpRow.append(el('button', {
    class: 'act', onClick: () => adjustHp(-Math.abs(+amount.value || 0)),
  }, 'Damage'));
  hpRow.append(el('button', {
    class: 'act ghost', onClick: () => adjustHp(Math.abs(+amount.value || 0)),
  }, 'Heal'));
  hpRow.append(el('button', {
    class: 'act ghost', onClick: () => rest('short'),
  }, 'Short rest'));
  hpRow.append(el('button', {
    class: 'act dark', onClick: () => rest('long'),
  }, 'Long rest'));
  panel.append(hpRow);

  // Rolled maximums. hp.override wins inside derive when set; clearing it
  // hands the maximum back to the 2024 fixed-value rule. This row sits
  // BELOW Adjust HP on purpose: the gym (and muscle memory) reach for the
  // first number input on this screen as the damage amount.
  const maxRow = el('div', {
    class: 'btnrow', style: 'margin-top:8px;align-items:center',
  });
  maxRow.append(el('span', { class: 'eyebrow' }, 'Max HP'));
  const maxIn = el('input', {
    type: 'number', min: '1', placeholder: String(d.hp.max),
    'aria-label': 'Max HP override', style: 'width:70px',
  });
  maxRow.append(maxIn);
  maxRow.append(el('button', {
    class: 'act ghost',
    title: 'Your table rolled hit points - use that number as the maximum',
    onClick: async () => {
      const v = Math.max(1, Math.floor(Number(maxIn.value)));
      if (!Number.isFinite(v) || !maxIn.value) {
        return toast('Type the rolled maximum first', 'warn');
      }
      await saveCharacter((c) => {
        c.hp = { ...(c.hp || {}), override: v };
        return c;
      });
      toast(`Maximum HP is ${v} now - the rules step aside`, 'ok');
      draw();
      return null;
    },
  }, 'Use rolled maximum'));
  if (!d.hp.derived) {
    maxRow.append(el('button', {
      class: 'act ghost',
      title: 'Drop the override; the fixed-value rule derives the maximum again',
      onClick: async () => {
        await saveCharacter((c) => {
          if (c.hp) delete c.hp.override;
          return c;
        });
        toast('Back to the rules - maximum HP derives again', 'ok');
        draw();
      },
    }, 'Back to the rules'));
  }
  panel.append(maxRow);

  // Conditions
  const condRow = el('div', { style: 'margin-top:14px' });
  condRow.append(el('div', { class: 'eyebrow', style: 'margin-bottom:6px' }, 'Conditions'));
  const chips = el('div', { class: 'btnrow' });
  for (const c of CONDITIONS) {
    const on = (d.conditions || []).includes(c);
    chips.append(el('button', {
      class: `chip${on ? ' bad' : ''}`,
      style: 'cursor:pointer;border:0',
      onClick: () => toggleCondition(c),
    }, c));
  }
  condRow.append(chips);
  panel.append(condRow);

  if (d.exhaustion > 0) {
    panel.append(el('p', { class: 'mono', style: 'color:var(--bad-text);margin-top:10px' },
      `Exhaustion ${d.exhaustion} - ${d.d20Penalty} on every d20 test`));
  }
  if (d.concentration) {
    panel.append(el('p', { class: 'mono', style: 'color:var(--accent-2);margin-top:6px' },
      `Concentrating on ${d.concentration}`));
  }
  return panel;
}

// One HP rule for the whole app: the sheet and the hero ribbon call the
// same shell function, so they cannot disagree about what 7 damage does.
async function adjustHp(delta) {
  await shellAdjustHp(delta);
  draw();
}

async function rest(kind) {
  const { character, derived } = getState();
  const res = kind === 'long'
    ? engineLongRest(character, derived)
    : engineShortRest(character, derived);
  await saveCharacter((c) => Object.assign(c, res.patch));
  for (const ev of res.events) await log(ev.type, ev.payload);
  toast(`${kind === 'long' ? 'Long' : 'Short'} rest taken`, 'ok');
  draw();
}

async function toggleCondition(cond) {
  await saveCharacter((c) => {
    const set = new Set(c.conditions || []);
    if (set.has(cond)) { set.delete(cond); log('condition_cleared', { condition: cond }); }
    else { set.add(cond); log('condition_gained', { condition: cond }); }
    c.conditions = [...set];
    return c;
  });
  draw();
}

/* ------------------------------------------------------------------ */

function abilitiesPanel(d) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Abilities'));
  const grid = el('div', { class: 'grid stats' });
  for (const ab of ABILITIES) {
    const save = d.saves[ab];
    const cell = el('div', { class: 'stat clickable' });
    cell.addEventListener('click', () => {
      const r = d20({ mod: d.mods[ab], ...takeRollMode() });
      log('journal', { text: `${ABILITY_NAMES[ab]} check: ${fmt(r)}` });
      pushRollCard(cardModel({ label: `${ABILITY_NAMES[ab]} check`, roll: r }));
    });
    cell.append(el('div', { class: 'k' }, ab.toUpperCase()));
    cell.append(el('div', { class: 'v' }, String(d.abilities[ab])));
    cell.append(el('div', { class: 'sub' }, `${sign(d.mods[ab])} / save ${sign(save.mod)}`));
    grid.append(cell);
  }
  panel.append(grid);

  // Saving throws get their own taps - "roll a WIS save" is said at every
  // table more often than any check, and it had no button.
  panel.append(el('div', { class: 'eyebrow', style: 'margin-top:12px' },
    'Saving throws'));
  const saves = el('div', {
    style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px',
  });
  for (const ab of ABILITIES) {
    saves.append(el('button', {
      class: `act small${d.saves[ab].proficient ? '' : ' ghost'}`,
      'aria-label': `${ABILITY_NAMES[ab]} saving throw`,
      onClick: () => {
        const r = d20({ mod: d.saves[ab].mod, ...takeRollMode() });
        log('journal', { text: `${ABILITY_NAMES[ab]} save: ${fmt(r)}` });
        pushRollCard(cardModel({ label: `${ab.toUpperCase()} save`, roll: r }));
      },
    }, `${ab.toUpperCase()} ${sign(d.saves[ab].mod)}`));
  }
  panel.append(saves);

  if (Object.keys(d.substitutions).length) {
    panel.append(el('p', { class: 'mono', style: 'margin-top:10px;color:var(--accent-2)' },
      Object.entries(d.substitutions)
        .map(([scope, s]) => `${s.with.toUpperCase()} replaces ${s.replace.toUpperCase()} for ${scope}`)
        .join(' · ')));
  }
  return panel;
}

function skillsPanel(d) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Skills'));
  const list = el('div', { style: 'max-height:340px;overflow-y:auto' });
  for (const [skill, info] of Object.entries(d.skills)) {
    const row = el('div', {
      style: 'display:flex;gap:8px;align-items:center;padding:3px 4px;cursor:pointer',
      onClick: () => {
        const r = d20({ mod: info.mod, ...takeRollMode() });
        log('journal', { text: `${cap(skill)}: ${fmt(r)}` });
        pushRollCard(cardModel({ label: cap(skill), roll: r }));
      },
    });
    row.append(el('span', {
      class: `chip${info.expertise ? ' expert' : info.proficient ? ' prof' : ''}`,
    }, info.expertise ? 'E' : info.proficient ? 'P' : '-'));
    row.append(el('span', { style: 'flex:1;font-size:14px' }, cap(skill)));
    row.append(el('span', { class: 'mono' }, sign(info.mod)));
    list.append(row);
  }
  panel.append(list);
  return panel;
}

/* ------------------------------------------------------------------ */

function attacksPanel(d) {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Attacks'));
  panel.append(el('h3', {}, 'Attacks & strikes'));

  const wrap = el('div', { class: 'scroll-x' });
  const table = el('table');
  table.innerHTML = '<tr><th>Attack</th><th>Bonus</th><th>Damage</th>'
    + '<th>Mastery</th><th>Source</th><th></th></tr>';
  for (const atk of d.attacks) {
    const tr = el('tr');
    tr.append(el('td', {}, atk.name + (atk.magical ? ' ✦' : '')));
    tr.append(el('td', { class: 'mono' }, sign(atk.attackBonus)));
    tr.append(el('td', { class: 'mono' },
      `${atk.damage}${atk.damageBonus ? sign(atk.damageBonus) : ''} `
      + `${atk.damageTypes.join('/')}`));
    tr.append(el('td', { class: 'mono muted' }, atk.mastery || '-'));
    tr.append(el('td', { class: 'muted', style: 'font-size:13px' }, atk.source));
    const cell = el('td');
    cell.append(el('button', {
      class: 'act small', onClick: () => rollAttack(atk, d),
    }, 'Roll'));
    tr.append(cell);
    table.append(tr);
  }
  wrap.append(table);
  panel.append(wrap);
  return panel;
}

/**
 * Both play surfaces resolve attacks through core/engine.js. They used to have
 * private copies that had drifted apart - this one picked roll-table entries
 * with Math.random() over the entry count instead of rolling the die.
 */
async function rollAttack(atk, d) {
  const res = resolveAttack(atk, { attackerName: d.name, ...takeRollMode() });
  for (const ev of res.events) await log(ev.type, ev.payload);
  pushRollCard(cardModel({
    label: `${atk.name} to hit`,
    roll: res.roll,
    extra: `${res.total} damage`,
  }));
  if (res.fumble) await fireNatTriggers(d, res.roll.nat);
}

/**
 * Homebrew nat-roll triggers. This is the hook that makes an ingested feature
 * like Fumble Into Fortune actually fire during play rather than sit in prose.
 */
export async function fireNatTriggers(d, nat) {
  const { fired, events } = fireTriggers(d, nat);
  for (const ev of events) await log(ev.type, ev.payload);
  for (const f of fired) {
    if (f.unmapped) { toast(`${f.trigger.from} triggered (no table mapped)`, 'warn'); continue; }
    toast(`${f.table.name} (${f.n}): ${f.entry?.text}`, 'ok');
  }
}

/* ------------------------------------------------------------------ */

function resourcesPanel(d) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Resources'));

  for (const r of d.resources) {
    const row = el('div', {
      style: 'display:flex;gap:10px;align-items:center;margin-bottom:8px',
    });
    row.append(el('span', { style: 'flex:1' }, r.name));
    row.append(el('span', { class: 'mono' }, `${r.current} / ${r.max}`));
    row.append(el('button', {
      class: 'act ghost small', disabled: r.current <= 0,
      onClick: () => spendResource(r, 1),
    }, 'Spend 1'));
    row.append(el('button', {
      class: 'act ghost small', disabled: r.current >= r.max,
      onClick: () => spendResource(r, -1),
    }, '+1'));
    panel.append(row);
  }

  for (const t of d.toggles) {
    const row = el('div', { style: 'margin-top:12px' });
    row.append(el('div', { class: 'eyebrow', style: 'margin-bottom:6px' },
      `${t.name} · ${t.from}`));
    const opts = el('div', { class: 'btnrow' });
    const active = d.toggleState[t.key] ?? t.default;
    for (const o of t.options || []) {
      opts.append(el('button', {
        class: `act ${active === o.key ? '' : 'ghost'} small`,
        onClick: () => setToggle(t.key, o.key),
      }, o.label));
    }
    row.append(opts);
    panel.append(row);
  }
  return panel;
}

async function spendResource(r, amount) {
  await saveCharacter((c) => {
    const state = { ...(c.resourceState || {}) };
    const cur = state[r.name] ?? r.max;
    state[r.name] = Math.max(0, Math.min(r.max, cur - amount));
    c.resourceState = state;
    return c;
  });
  if (amount > 0) await log('resource_spent', { resource: r.name, amount });
  draw();
}

async function setToggle(key, value) {
  await saveCharacter((c) => {
    c.toggles = { ...(c.toggles || {}), [key]: value };
    return c;
  });
  toast(`${key}: ${value}`);
  draw();
}

/* ------------------------------------------------------------------ */

// spell-mechanics.json, fetched once for the "resolves in the simulator"
// badge. Display only - nothing here feeds a simulated number.
let mechanics = null;
function ensureMechanics() {
  if (mechanics !== null) return;
  mechanics = {};
  dataFile('spell-mechanics.json', { mechanics: {} })
    .then((f) => { mechanics = f.mechanics || {}; draw(); })
    .catch(() => {});
}

function spellPanel(d) {
  const sc = d.spellcasting;
  const { compendium } = getState();
  const byId = new Map((compendium?.spells || []).map((s) => [s.id, s]));
  ensureMechanics();

  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Spellcasting'));
  panel.append(el('h3', {}, `${sc.ability.toUpperCase()} · DC ${sc.saveDc} · ${sign(sc.attackBonus)} to hit`));

  if (sc.slots.length) {
    const slots = el('div', { class: 'grid stats' });
    sc.slots.forEach((max, i) => {
      const lvl = i + 1;
      const used = sc.slotState[lvl] || 0;
      const cell = el('div', { class: 'stat clickable' });
      cell.addEventListener('click', () => spendSlot(lvl));
      cell.append(el('div', { class: 'k' }, `Level ${lvl}`));
      cell.append(el('div', { class: 'v' }, `${max - used}`));
      cell.append(el('div', { class: 'sub' }, `of ${max}`));
      slots.append(cell);
    });
    panel.append(slots);
  }
  if (sc.pact && !sc.slots.length) {
    panel.append(el('p', { class: 'mono muted', style: 'font-size:12px' },
      `Pact Magic (${sc.pact.n} × level ${sc.pact.lvl}) is not modelled `
      + 'yet - casting below will say so rather than fake it.'));
  }

  const spellChips = (s) => {
    const bits = [];
    if (s.concentration) bits.push(el('span', { class: 'chip warn', title: 'Concentration' }, 'C'));
    if (s.ritual) bits.push(el('span', { class: 'chip', title: 'Ritual' }, 'R'));
    if (mechanics?.[s.id]?.executable) {
      bits.push(el('span', { class: 'chip accent',
        title: 'This spell resolves in the campaign simulator' }, 'sim'));
    }
    return bits;
  };

  const section = (label, ids, castable) => {
    const list = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!list.length) return;
    panel.append(el('div', { class: 'rule' }));
    panel.append(el('div', { class: 'eyebrow', style: 'margin-bottom:6px' }, label));
    for (const s of list) {
      const row = el('div', {
        style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;'
          + 'padding:4px 0;border-bottom:1px solid var(--etch)',
      });
      row.append(el('span', { style: 'flex:1;min-width:140px' }, s.name));
      row.append(el('span', { class: 'mono muted', style: 'font-size:11px' },
        s.level === 0 ? 'cantrip' : `L${s.level} · ${s.school}`));
      for (const chip of spellChips(s)) row.append(chip);
      if (castable) {
        row.append(el('button', {
          class: 'act ghost small', onClick: () => castSpell(s),
        }, 'Cast'));
      }
      panel.append(row);
    }
  };
  section('Cantrips', sc.known, true);
  section('Prepared', sc.prepared, true);
  if (!sc.known.length && !sc.prepared.length) {
    panel.append(el('p', { class: 'muted', style: 'font-size:13px;margin-top:8px' },
      'No spells chosen yet - pick them in Build, under Spellbook.'));
  }

  if (sc.alwaysPrepared.length) {
    panel.append(el('div', { class: 'rule' }));
    panel.append(el('div', { class: 'eyebrow', style: 'margin-bottom:6px' },
      'Always prepared'));
    const chips = el('div', { class: 'btnrow' });
    for (const s of sc.alwaysPrepared) {
      chips.append(el('span', { class: 'chip accent', title: `from ${s.from}` }, s.name));
    }
    panel.append(chips);
  }
  return panel;
}

/** A bare slot tile click: the slot is spent on something unnamed. */
async function spendSlot(level) {
  const { character, derived } = getState();
  const res = engineUseSlot(character, derived, level);
  if (res.error) return toast(res.error, 'bad');
  await saveCharacter((c) => { c.slotState = res.slotState; return c; });
  await log('spell_cast', { level, slotUsed: true });
  draw();
  return null;
}

/** Cast a CHOSEN spell: consumes the lowest slot that fits, names the
 *  spell in the chronicle (which used to read "Cast undefined"), and
 *  takes up concentration when the spell asks for it. */
async function castSpell(spell) {
  const { character, derived } = getState();
  const sc = derived.spellcasting;
  if (spell.level === 0) {
    await log('spell_cast', { spell: spell.name, level: 0 });
    toast(`${spell.name} cast`, 'ok');
    draw();
    return;
  }
  let lvl = null;
  for (let i = spell.level; i <= sc.slots.length; i += 1) {
    if ((sc.slots[i - 1] || 0) - (sc.slotState[i] || 0) > 0) { lvl = i; break; }
  }
  if (lvl === null) {
    toast(sc.pact
      ? 'Pact Magic is not modelled yet - spend it narratively'
      : 'No slot high enough is left', 'warn');
    return;
  }
  const res = engineUseSlot(character, derived, lvl);
  if (res.error) return toast(res.error, 'bad');
  await saveCharacter((c) => {
    c.slotState = res.slotState;
    if (spell.concentration) c.concentration = spell.name;
    return c;
  });
  await log('spell_cast', { spell: spell.name, level: lvl });
  toast(`${spell.name} cast at level ${lvl}`, 'ok');
  draw();
  return null;
}

/* ------------------------------------------------------------------ */

function featuresPanel(d) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Features'));
  panel.append(el('h3', {}, 'Features & traits'));
  if (d.unmappedFeatures) {
    panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
      `${d.unmappedFeatures} of ${d.features.length} features are text-only. `
      + 'They still play - map them in Homebrew to automate them.'));
  }
  for (const f of d.features) {
    const box = el('details', {
      style: 'border-bottom:1px solid var(--etch);padding:8px 0',
    });
    const sum = el('summary', { style: 'cursor:pointer;font-weight:600' });
    sum.append(el('span', { class: 'lvl ghost', style: 'margin:0 8px 0 0' },
      `L${f.level}`));
    sum.append(document.createTextNode(f.name));
    const live = (f.effects || []).filter((e) => e.type !== 'narrative_only').length;
    if (live) sum.append(el('span', { class: 'chip ok', style: 'margin-left:8px' },
      `${live} live`));
    box.append(sum);
    box.append(el('div', { html: md(f.text || ''), style: 'padding-top:8px' }));
    panel.append(box);
  }
  return panel;
}

function inventoryPanel(d) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Inventory'));
  panel.append(el('h3', {}, fromCopper(d.copper)));
  panel.append(el('p', { class: 'mono muted' },
    `${d.carried} / ${d.capacity} lb · ${d.encumbrance} · `
    + `attuned ${d.attuned}/${d.attunementLimit}`));

  if (!d.inventory.length) {
    panel.append(el('p', { class: 'muted' }, 'Nothing carried. Visit the Market.'));
    return panel;
  }
  const wrap = el('div', { class: 'scroll-x' });
  const table = el('table');
  table.innerHTML = '<tr><th>Item</th><th>Qty</th><th>Weight</th><th>Equipped</th></tr>';
  for (const it of d.inventory) {
    const tr = el('tr');
    tr.append(el('td', {}, it.name));
    tr.append(el('td', { class: 'mono' }, String(it.qty || 1)));
    tr.append(el('td', { class: 'mono muted' }, it.weight || '-'));
    const cell = el('td');
    cell.append(el('input', {
      type: 'checkbox', checked: Boolean(it.equipped), style: 'width:auto',
      onChange: async () => {
        await saveCharacter((c) => {
          const target = c.inventory.find((x) => x.id === it.id);
          if (target) target.equipped = !target.equipped;
          return c;
        });
        draw();
      },
    }));
    tr.append(cell);
    table.append(tr);
  }
  wrap.append(table);
  panel.append(wrap);
  return panel;
}

const cap = (s) => String(s || '').replace(/^./, (m) => m.toUpperCase());
