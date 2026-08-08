/**
 * Build mode - create and level characters.
 *
 * Homebrew subclasses appear in the same picker as SRD ones. Once ingested,
 * a subclass is just another source; nothing here special-cases it.
 */

import { getState, setState, esc, el, sign, toast } from '../../core/store.js';
import { db } from '../../core/db.js';
import { log } from '../../core/events.js';
import {
  ABILITIES, ABILITY_NAMES, SKILLS, abilityMod, proficiencyBonus,
} from '../../core/rules2024.js';
import { rollAbilityScores } from '../../core/dice.js';
import { saveCharacter, selectCharacter, recompute, go } from '../../app.js';

export const title = 'Build';

const POINT_BUY_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
const POINT_BUY_BUDGET = 27;

let container = null;

export async function render(root) {
  container = root;
  draw();
}

function draw() {
  const { characters, character, compendium, homebrew } = getState();
  container.innerHTML = '';

  container.append(rosterPanel(characters, character));
  if (!character) {
    container.append(el('div', { class: 'empty' },
      'Create a character above, or import one, to start building.'));
    return;
  }
  container.append(identityPanel(character, compendium, homebrew));
  container.append(abilitiesPanel(character));
  container.append(skillsPanel(character, compendium));
  container.append(featuresPanel());
}

/* ------------------------------------------------------------------ */
/* roster                                                              */
/* ------------------------------------------------------------------ */

function rosterPanel(characters, active) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Roster'));

  const row = el('div', { class: 'btnrow', style: 'margin-bottom:14px' });
  row.append(el('button', { class: 'act', onClick: createCharacter }, 'New character'));
  row.append(el('button', { class: 'act ghost', onClick: importCharacter }, 'Import JSON'));
  if (active) {
    row.append(el('button', { class: 'act ghost', onClick: exportCharacter }, 'Export'));
    row.append(el('button', {
      class: 'act ghost',
      onClick: () => deleteCharacter(active),
    }, 'Delete'));
  }
  panel.append(row);

  if (!characters.length) {
    panel.append(el('p', { class: 'muted' }, 'No characters yet.'));
    return panel;
  }

  const list = el('div', { class: 'grid three' });
  for (const c of characters) {
    const card = el('div', {
      class: `stat clickable${c.id === active?.id ? ' active' : ''}`,
      style: c.id === active?.id ? 'border-top-color:var(--accent)' : '',
      onClick: async () => { await selectCharacter(c.id); draw(); },
    });
    card.append(el('div', { class: 'k' }, classLine(c)));
    card.append(el('div', { class: 'v', style: 'font-size:17px' }, c.name || 'Unnamed'));
    card.append(el('div', { class: 'sub' }, `Level ${totalLevel(c)}`));
    list.append(card);
  }
  panel.append(list);
  return panel;
}

const totalLevel = (c) => (c.classes || []).reduce((n, x) => n + (x.level || 0), 0) || 1;
const cap = (s) => String(s || '').replace(/^./, (m) => m.toUpperCase());
const classLine = (c) => (c.classes || [])
  .map((x) => `${cap(x.class)} ${x.level}`).join(' / ') || 'Unclassed';

async function createCharacter() {
  const id = `ch-${Date.now().toString(36)}`;
  const character = {
    id,
    name: 'New Character',
    ruleset: '2024',
    species: null,
    background: null,
    classes: [{ class: 'fighter', subclass: null, level: 1 }],
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    abilityMethod: 'pointbuy',
    skills: [], expertise: [], feats: [],
    hp: { max: 10, current: 10, temp: 0 },
    inventory: [], currency: { gp: 15 },
    spells: { prepared: [], known: [] },
    slotState: {}, resourceState: {}, toggles: {},
    conditions: [], exhaustion: 0,
    deathSaves: { successes: 0, failures: 0 },
    createdAt: new Date().toISOString(),
  };
  await db.put('characters', character);
  setState({ characters: await db.list('characters') });
  await selectCharacter(id);
  await log('journal', { text: `Created ${character.name}` }, { characterId: id });
  draw();
}

async function deleteCharacter(c) {
  if (!confirm(`Delete "${c.name}"? This cannot be undone.`)) return;
  await db.del('characters', c.id);
  const characters = await db.list('characters');
  setState({ characters });
  await selectCharacter(characters[0]?.id || null);
  toast(`Deleted ${c.name}`);
  draw();
}

function exportCharacter() {
  const { character } = getState();
  const blob = new Blob([JSON.stringify(character, null, 2)], { type: 'application/json' });
  const a = el('a', {
    href: URL.createObjectURL(blob),
    download: `${(character.name || 'character').replace(/\W+/g, '-').toLowerCase()}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported character JSON');
}

function importCharacter() {
  const input = el('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      data.id = data.id || `ch-${Date.now().toString(36)}`;
      await db.put('characters', data);
      setState({ characters: await db.list('characters') });
      await selectCharacter(data.id);
      toast(`Imported ${data.name || 'character'}`, 'ok');
      draw();
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'bad');
    }
  });
  input.click();
}

/* ------------------------------------------------------------------ */
/* identity                                                            */
/* ------------------------------------------------------------------ */

function identityPanel(ch, compendium, homebrew) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Identity'));
  panel.append(el('h3', {}, 'Who they are'));

  const grid = el('div', { class: 'grid two' });

  grid.append(field('Name', el('input', {
    type: 'text', value: ch.name || '',
    onChange: (e) => update({ name: e.target.value }),
  })));

  grid.append(field('Species', picker(
    compendium.species || [], ch.species,
    (v) => update({ species: v }),
  )));

  grid.append(field('Background', picker(
    compendium.backgrounds || [], ch.background,
    (v) => update({ background: v }),
  )));

  const src = getState().dataSource;
  grid.append(field('Campaign', el('input', {
    type: 'text', value: ch.campaignId || '', placeholder: 'e.g. curse-of-strahd',
    onChange: (e) => update({ campaignId: e.target.value || null }),
  })));

  panel.append(grid);
  panel.append(el('div', { class: 'rule' }));

  // --- classes
  panel.append(el('div', { class: 'eyebrow', style: 'margin-bottom:8px' }, 'Classes'));
  for (const [i, entry] of (ch.classes || []).entries()) {
    panel.append(classRow(entry, i, compendium, homebrew));
  }
  panel.append(el('button', {
    class: 'act ghost small', style: 'margin-top:8px',
    onClick: () => update((c) => {
      c.classes.push({ class: 'fighter', subclass: null, level: 1 });
      return c;
    }),
  }, '+ Multiclass'));

  return panel;
}

function classRow(entry, index, compendium, homebrew) {
  const row = el('div', {
    style: 'display:grid;grid-template-columns:1fr 1fr 90px auto;gap:8px;'
         + 'align-items:end;margin-bottom:8px',
  });

  const classes = compendium.classes || [];
  row.append(field('Class', picker(classes, String(entry.class).toLowerCase(),
    (v) => update((c) => { c.classes[index].class = v; c.classes[index].subclass = null; return c; }))));

  // SRD subclasses for this class, plus any ingested homebrew that targets it.
  const cls = classes.find((c) => c.id === String(entry.class).toLowerCase());
  const srdSubs = (cls?.subclasses || []).map((s) => ({ id: s.id, name: s.name }));
  const brewSubs = (homebrew || [])
    .filter((h) => h.kind === 'subclass'
      && String(h.class || '').toLowerCase() === String(entry.class).toLowerCase())
    .map((h) => ({ id: h.id, name: `${h.name} (homebrew)` }));
  const subs = [...srdSubs, ...brewSubs];

  row.append(field('Subclass', picker(subs, entry.subclass,
    (v) => update((c) => { c.classes[index].subclass = v || null; return c; }),
    subs.length ? 'Choose...' : 'None available')));

  row.append(field('Level', el('input', {
    type: 'number', min: '1', max: '20', value: String(entry.level || 1),
    onChange: (e) => {
      const level = Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1));
      const before = totalLevel(getState().character);
      update((c) => { c.classes[index].level = level; return c; }).then((next) => {
        const after = totalLevel(next);
        if (after > before) {
          log('level_up', { level: after, class: entry.class });
        }
      });
    },
  })));

  row.append(el('button', {
    class: 'act ghost small',
    disabled: (getState().character.classes || []).length < 2,
    onClick: () => update((c) => { c.classes.splice(index, 1); return c; }),
  }, 'Remove'));

  return row;
}

/* ------------------------------------------------------------------ */
/* abilities                                                           */
/* ------------------------------------------------------------------ */

function abilitiesPanel(ch) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Abilities'));
  panel.append(el('h3', {}, 'Ability scores'));

  const method = ch.abilityMethod || 'pointbuy';
  const methods = el('div', { class: 'btnrow', style: 'margin-bottom:14px' });
  for (const [key, label] of Object.entries({
    pointbuy: 'Point buy', array: 'Standard array', roll: 'Roll 4d6', manual: 'Manual',
  })) {
    methods.append(el('button', {
      class: `act ${method === key ? '' : 'ghost'} small`,
      onClick: () => update({ abilityMethod: key }),
    }, label));
  }
  panel.append(methods);

  if (method === 'pointbuy') {
    const spent = ABILITIES.reduce(
      (n, a) => n + (POINT_BUY_COST[ch.abilities?.[a]] ?? 0), 0,
    );
    const over = spent > POINT_BUY_BUDGET;
    panel.append(el('p', { class: 'mono', style: `color:${over ? 'var(--bad)' : 'var(--muted)'}` },
      `${spent} / ${POINT_BUY_BUDGET} points spent${over ? ' - over budget' : ''}`));
  }

  if (method === 'array') {
    panel.append(el('p', { class: 'muted' },
      `Assign ${STANDARD_ARRAY.join(', ')} across the six abilities.`));
  }

  if (method === 'roll') {
    panel.append(el('button', {
      class: 'act ghost small', style: 'margin-bottom:12px',
      onClick: () => {
        const rolls = rollAbilityScores();
        toast(`Rolled: ${rolls.map((r) => r.total).join(', ')}`);
        update((c) => {
          ABILITIES.forEach((a, i) => { c.abilities[a] = rolls[i].total; });
          return c;
        });
      },
    }, 'Roll 4d6 drop lowest'));
  }

  const grid = el('div', { class: 'grid stats' });
  for (const ab of ABILITIES) {
    const score = ch.abilities?.[ab] ?? 10;
    const bonus = ch.abilityBonuses?.[ab] ?? 0;
    const total = score + bonus;
    const cell = el('div', { class: 'stat' });
    cell.append(el('div', { class: 'k' }, ABILITY_NAMES[ab]));
    cell.append(el('input', {
      type: 'number', min: '1', max: '30', value: String(score),
      style: 'font-family:var(--display);font-size:22px;text-align:center;padding:4px',
      onChange: (e) => {
        const v = Math.max(1, Math.min(30, parseInt(e.target.value, 10) || 10));
        update((c) => { c.abilities[ab] = v; return c; });
      },
    }));
    cell.append(el('div', { class: 'sub' },
      `${sign(abilityMod(total))}${bonus ? ` (${sign(bonus)} bonus)` : ''}`));
    grid.append(cell);
  }
  panel.append(grid);

  // Species/background ASI go here rather than being baked into the score.
  panel.append(el('label', { class: 'field' }, 'Bonuses from origin (comma list, e.g. dex+2, con+1)'));
  panel.append(el('input', {
    type: 'text',
    value: Object.entries(ch.abilityBonuses || {})
      .filter(([, v]) => v).map(([k, v]) => `${k}+${v}`).join(', '),
    placeholder: 'dex+2, con+1',
    onChange: (e) => {
      const bonuses = {};
      for (const part of e.target.value.split(/[,;]/)) {
        const m = /([a-z]{3})\s*\+?\s*(-?\d+)/i.exec(part.trim());
        if (m && ABILITIES.includes(m[1].toLowerCase())) {
          bonuses[m[1].toLowerCase()] = parseInt(m[2], 10);
        }
      }
      update({ abilityBonuses: bonuses });
    },
  }));

  return panel;
}

/* ------------------------------------------------------------------ */
/* skills                                                              */
/* ------------------------------------------------------------------ */

function skillsPanel(ch, compendium) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Proficiencies'));
  panel.append(el('h3', {}, 'Skills'));

  const cls = (compendium.classes || [])
    .find((c) => c.id === String(ch.classes?.[0]?.class).toLowerCase());
  if (cls?.skillChoices) {
    panel.append(el('p', { class: 'muted' }, cls.skillChoices));
  }

  const pb = proficiencyBonus(totalLevel(ch));
  const chosen = new Set((ch.skills || []).map((s) => s.toLowerCase()));
  const expert = new Set((ch.expertise || []).map((s) => s.toLowerCase()));

  const grid = el('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:4px',
  });
  for (const [skill, ab] of Object.entries(SKILLS)) {
    const prof = chosen.has(skill);
    const exp = expert.has(skill);
    const mod = abilityMod((ch.abilities?.[ab] || 10) + (ch.abilityBonuses?.[ab] || 0))
      + (exp ? pb * 2 : prof ? pb : 0);
    const row = el('label', {
      style: 'display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer',
    });
    row.append(el('input', {
      type: 'checkbox', checked: prof, style: 'width:auto;margin:0',
      onChange: () => update((c) => {
        const set = new Set((c.skills || []).map((s) => s.toLowerCase()));
        if (set.has(skill)) set.delete(skill); else set.add(skill);
        c.skills = [...set];
        return c;
      }),
    }));
    row.append(el('span', { style: 'flex:1;font-size:14px' }, cap(skill)));
    row.append(el('span', { class: 'mono muted', style: 'font-size:11px' },
      `${ab.toUpperCase()} ${sign(mod)}`));
    if (prof) {
      row.append(el('button', {
        class: 'act ghost small', style: 'padding:2px 6px;font-size:9px',
        title: 'Toggle expertise',
        onClick: (e) => {
          e.preventDefault();
          update((c) => {
            const set = new Set((c.expertise || []).map((s) => s.toLowerCase()));
            if (set.has(skill)) set.delete(skill); else set.add(skill);
            c.expertise = [...set];
            return c;
          });
        },
      }, exp ? 'EXP' : '+'));
    }
    grid.append(row);
  }
  panel.append(grid);
  return panel;
}

/* ------------------------------------------------------------------ */
/* features preview                                                    */
/* ------------------------------------------------------------------ */

function featuresPanel() {
  const { derived } = getState();
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Resolved'));
  panel.append(el('h3', {}, 'What this build actually gives you'));

  if (!derived) {
    panel.append(el('p', { class: 'muted' }, 'Nothing derived yet.'));
    return panel;
  }

  const stats = el('div', { class: 'grid stats' });
  const add = (k, v, sub) => {
    const s = el('div', { class: 'stat' });
    s.append(el('div', { class: 'k' }, k));
    s.append(el('div', { class: 'v' }, String(v)));
    if (sub) s.append(el('div', { class: 'sub' }, sub));
    stats.append(s);
  };
  add('AC', derived.ac, derived.acSource);
  add('Initiative', sign(derived.initiative));
  add('Prof', sign(derived.proficiencyBonus));
  add('Passive Perc', derived.passivePerception);
  if (derived.spellcasting) {
    add('Spell DC', derived.spellcasting.saveDc,
      derived.spellcasting.ability.toUpperCase());
  }
  add('Speed', `${derived.speeds.walk} ft`);
  panel.append(stats);

  if (derived.features.length) {
    panel.append(el('div', { class: 'rule' }));
    const list = el('div', { class: 'scroll-x' });
    const table = el('table');
    table.innerHTML = '<tr><th>Level</th><th>Feature</th><th>From</th><th>Mechanics</th></tr>';
    for (const f of derived.features.slice(0, 60)) {
      const mapped = (f.effects || []).filter((e) => e.type !== 'narrative_only').length;
      const tr = el('tr');
      tr.append(el('td', { class: 'mono' }, String(f.level)));
      tr.append(el('td', {}, f.name));
      tr.append(el('td', { class: 'muted', style: 'font-size:13px' }, f.origin));
      tr.append(el('td', {}, mapped
        ? el('span', { class: 'chip ok' }, `${mapped} live`)
        : el('span', { class: 'chip' }, 'text')));
      table.append(tr);
    }
    list.append(table);
    panel.append(list);
  }

  panel.append(el('div', { class: 'btnrow' },
    el('button', { class: 'act', onClick: () => go('sheet') }, 'Open the sheet')));
  return panel;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function field(label, control) {
  const wrap = el('div');
  wrap.append(el('label', { class: 'field' }, label));
  wrap.append(control);
  return wrap;
}

function picker(items, value, onChange, placeholder = 'None') {
  const sel = el('select', { onChange: (e) => onChange(e.target.value || null) });
  sel.append(el('option', { value: '' }, placeholder));
  for (const it of items) {
    sel.append(el('option', {
      value: it.id, selected: it.id === value,
    }, it.name));
  }
  return sel;
}

async function update(patch) {
  const next = await saveCharacter(patch);
  draw();
  return next;
}
