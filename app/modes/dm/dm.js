/**
 * DM mode - everything to run a session, offline.
 *
 * Seven tools behind one row of tabs: a live encounter runner, the party's
 * numbers at a glance, treasure, improvisation, the encounter budgeter, the
 * bestiary and the rules reference.
 *
 * All of it works with no network. That is the point: the screen a DM keeps
 * open at the table must not depend on anything being reachable.
 */

import { getState, setState, el, esc, md, sign, toast } from '../../core/store.js';
import { compendium, compendiumWithCustom, dataFile, db } from '../../core/db.js';
import {
  encounterBudget, CR_XP, XP_BUDGET, ABILITIES,
} from '../../core/rules2024.js';
import { go, saveCharacter } from '../../app.js';
import { runnerPanel } from './runner.js';
import { partyPanel } from './party.js';
import { lootPanel, improvPanel } from './panels.js';
import { addMonsters } from './runner.js';

export const title = 'DM';

let container = null;
let monsters = [];
let glossary = [];
let magicItems = [];
let tables = null;
let tab = 'runner';
let build = { partyLevels: [3, 3, 3, 3], difficulty: 'moderate', picks: [] };
let search = '';
// Loot and generator state: scratch, kept across tab switches so a DM does not
// lose a hoard they liked by glancing at the bestiary.
let loot = { cr: 5, seed: 1, individual: false, result: null };
let improv = { seed: 1, level: 3, terrain: 'forest', result: null };

export async function render(root) {
  container = root;
  if (!monsters.length) {
    // Custom content is appended, so a DM's own monsters show up in the
    // bestiary, the encounter runner and the random tables alongside the SRD.
    [monsters, glossary, magicItems] = await Promise.all([
      compendiumWithCustom('monsters'), compendium('glossary'),
      compendiumWithCustom('magic-items'),
    ]);
  }
  if (!tables) tables = await dataFile('dm-tables.json', null);
  draw();
}

/** Sources for derive(), assembled the same way the shell does it. */
function sources() {
  const { compendium: c, homebrew } = getState();
  return {
    classes: c.classes || [], species: c.species || [],
    backgrounds: c.backgrounds || [], feats: c.feats || [],
    srdEffects: c.srdEffects || {}, equipment: c.equipment,
    homebrew: homebrew || [],
  };
}

function draw() {
  container.innerHTML = '';
  container.append(tabsPanel());
  if (tab === 'runner') {
    container.append(runnerPanel({
      characters: getState().characters || [],
      sources: sources(), monsters, redraw: draw,
    }));
  } else if (tab === 'party') {
    container.append(partyPanel(getState().characters || [], sources()));
  } else if (tab === 'loot') {
    container.append(lootPanel({
      tables, magicItems, loot, redraw: draw, saveCharacter,
    }));
  } else if (tab === 'improv') {
    container.append(improvPanel({
      tables, monsters, improv, redraw: draw,
      sendToFight: (entry) => {
        const m = monsters.find((x) => x.id === entry.id);
        if (!m) return;
        addMonsters(m, entry.count);
        tab = 'runner';
        draw();
        toast(`${entry.count} x ${m.name} added to the fight`, 'ok');
      },
    }));
  } else if (tab === 'encounter') {
    container.append(budgetPanel());
    container.append(pickerPanel());
  } else if (tab === 'bestiary') {
    container.append(bestiaryPanel());
  } else {
    container.append(referencePanel());
  }
}

function tabsPanel() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Dungeon Master'));
  panel.append(el('h3', {}, `${monsters.length} monsters · ${glossary.length} rules entries`));
  const row = el('div', { class: 'btnrow' });
  for (const [k, label] of Object.entries({
    runner: 'Run a fight', party: 'Party', loot: 'Treasure', improv: 'Improvise',
    encounter: 'Encounter builder', bestiary: 'Bestiary', reference: 'Rules reference',
  })) {
    row.append(el('button', {
      class: `act ${tab === k ? '' : 'ghost'} small`,
      onClick: () => { tab = k; draw(); },
    }, label));
  }
  panel.append(row);
  return panel;
}

/* ------------------------------------------------------------------ */

function budgetPanel() {
  const budget = encounterBudget(build.partyLevels, build.difficulty);
  const spent = build.picks.reduce(
    (n, p) => n + (CR_XP[p.cr] || p.xp || 0) * p.count, 0,
  );
  const ratio = budget ? spent / budget : 0;

  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Budget'));

  const row = el('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px',
  });
  const party = el('input', {
    type: 'text', value: build.partyLevels.join(', '),
    onChange: (e) => {
      build.partyLevels = e.target.value.split(/[, ]+/)
        .map((n) => parseInt(n, 10)).filter(Number.isFinite);
      draw();
    },
  });
  const diff = el('select', {
    onChange: (e) => { build.difficulty = e.target.value; draw(); },
  });
  for (const d of ['low', 'moderate', 'high']) {
    diff.append(el('option', { value: d, selected: d === build.difficulty },
      d[0].toUpperCase() + d.slice(1)));
  }
  row.append(field('Party levels', party), field('Difficulty', diff));
  panel.append(row);

  const stats = el('div', { class: 'grid stats', style: 'margin-top:14px' });
  const add = (k, v, sub) => {
    const c = el('div', { class: 'stat' });
    c.append(el('div', { class: 'k' }, k));
    c.append(el('div', { class: 'v' }, String(v)));
    if (sub) c.append(el('div', { class: 'sub' }, sub));
    stats.append(c);
  };
  add('Budget XP', budget.toLocaleString());
  add('Used XP', spent.toLocaleString(),
    `${Math.round(ratio * 100)}% of budget`);
  add('Monsters', build.picks.reduce((n, p) => n + p.count, 0));
  add('Party', build.partyLevels.length, `avg level ${
    Math.round(build.partyLevels.reduce((a, b) => a + b, 0) / (build.partyLevels.length || 1))
  }`);
  panel.append(stats);

  const bar = el('div', {
    style: 'height:14px;background:var(--etch);border-radius:2px;overflow:hidden;margin-top:12px',
  });
  bar.append(el('div', {
    style: `height:100%;width:${Math.min(100, ratio * 100)}%;`
      + `background:${ratio > 1.15 ? 'var(--bad)' : ratio > 0.9 ? 'var(--warn)' : 'var(--ok)'};`
      + 'transition:width .3s',
  }));
  panel.append(bar);
  panel.append(el('p', { class: 'mono muted', style: 'margin-top:6px;font-size:12px' },
    ratio > 1.15 ? 'Over budget - this will hurt.'
      : ratio > 0.9 ? 'Right at the line.'
      : ratio > 0 ? 'Within budget.' : 'Add monsters below.'));

  if (build.picks.length) {
    panel.append(el('div', { class: 'rule' }));
    for (const [i, p] of build.picks.entries()) {
      const line = el('div', {
        style: 'display:flex;gap:10px;align-items:center;padding:5px 0',
      });
      line.append(el('span', { style: 'flex:1' }, p.name));
      line.append(el('span', { class: 'mono muted' },
        `CR ${p.crText} · ${(CR_XP[p.cr] || 0).toLocaleString()} XP`));
      line.append(el('button', {
        class: 'act ghost small', onClick: () => { p.count -= 1; if (p.count <= 0) build.picks.splice(i, 1); draw(); },
      }, '-'));
      line.append(el('span', { class: 'mono', style: 'width:26px;text-align:center' },
        String(p.count)));
      line.append(el('button', {
        class: 'act ghost small', onClick: () => { p.count += 1; draw(); },
      }, '+'));
      panel.append(line);
    }
    panel.append(el('div', { class: 'btnrow', style: 'margin-top:12px' },
      el('button', { class: 'act', onClick: pushToCombat }, 'Send to Combat tracker'),
      el('button', {
        class: 'act ghost', onClick: () => { build.picks = []; draw(); },
      }, 'Clear')));
  }
  return panel;
}

function pushToCombat() {
  const combatants = [];
  for (const p of build.picks) {
    const m = monsters.find((x) => x.id === p.id);
    for (let i = 0; i < p.count; i += 1) {
      combatants.push({
        id: `c-${p.id}-${i}`,
        name: p.count > 1 ? `${p.name} ${i + 1}` : p.name,
        side: 'enemy', ac: m?.ac || 10, hp: m?.hp || 10, hpMax: m?.hp || 10,
        temp: 0, initiative: null, conditions: [], concentrating: null,
        initiativeMod: m?.initiative ?? (m?.abilities?.dex?.mod || 0),
        monsterId: p.id,
      });
    }
  }
  setState({
    encounter: {
      id: `enc-${Date.now().toString(36)}`,
      name: `Encounter (${combatants.length})`,
      round: 0, turn: 0, started: false, combatants,
    },
  });
  toast(`${combatants.length} combatants sent to Combat`, 'ok');
  go('combat');
}

/* ------------------------------------------------------------------ */

function pickerPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Add monsters'));

  const box = el('input', {
    type: 'text', value: search, placeholder: 'Search by name, type, or CR (e.g. "dragon", "cr 5")',
    onInput: (e) => { search = e.target.value; renderHits(); },
  });
  panel.append(box);
  const hits = el('div', { style: 'margin-top:12px' });
  panel.append(hits);

  function renderHits() {
    hits.innerHTML = '';
    const q = search.trim().toLowerCase();
    if (q.length < 2) {
      hits.append(el('p', { class: 'muted' }, 'Type at least two characters.'));
      return;
    }
    const crMatch = /^cr\s*([\d/.]+)$/.exec(q);
    let list;
    if (crMatch) {
      const want = crMatch[1].includes('/')
        ? eval(crMatch[1]) : parseFloat(crMatch[1]); // eslint-disable-line no-eval
      list = monsters.filter((m) => m.cr === want);
    } else {
      list = monsters.filter((m) => m.name.toLowerCase().includes(q)
        || (m.type || '').includes(q));
    }
    if (!list.length) {
      hits.append(el('p', { class: 'muted' }, 'No match.'));
      return;
    }
    for (const m of list.slice(0, 25)) {
      const row = el('div', {
        style: 'display:flex;gap:10px;align-items:center;padding:5px 0;'
          + 'border-bottom:1px solid var(--etch)',
      });
      row.append(el('span', { style: 'flex:1' }, m.name));
      row.append(el('span', { class: 'mono muted', style: 'font-size:12px' },
        `${m.size} ${m.type} · CR ${m.crText} · AC ${m.ac} · ${m.hp} HP`));
      row.append(el('button', {
        class: 'act small',
        onClick: () => {
          const existing = build.picks.find((p) => p.id === m.id);
          if (existing) existing.count += 1;
          else {
            build.picks.push({
              id: m.id, name: m.name, cr: m.cr, crText: m.crText,
              xp: m.xp, count: 1,
            });
          }
          draw();
        },
      }, 'Add'));
      hits.append(row);
    }
  }
  renderHits();
  return panel;
}

/* ------------------------------------------------------------------ */

function bestiaryPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Bestiary'));
  const box = el('input', {
    type: 'text', placeholder: 'Look up a monster...', value: search,
    onInput: (e) => { search = e.target.value; render(); },
  });
  panel.append(box);
  const out = el('div', { style: 'margin-top:14px' });
  panel.append(out);

  function render() {
    out.innerHTML = '';
    const q = search.trim().toLowerCase();
    if (q.length < 2) return;
    const m = monsters.find((x) => x.name.toLowerCase() === q)
      || monsters.find((x) => x.name.toLowerCase().includes(q));
    if (!m) { out.append(el('p', { class: 'muted' }, 'No match.')); return; }
    out.append(statBlock(m));
  }
  render();
  return panel;
}

function statBlock(m) {
  const box = el('div', {
    style: 'background:var(--paper);padding:18px;border-top:4px solid var(--accent);'
      + 'border-radius:2px',
  });
  const heading = el('div', {
    style: 'display:flex;gap:8px;align-items:baseline;margin-bottom:2px',
  });
  heading.append(el('h3', { style: 'margin:0' }, m.name));
  // A DM must always be able to tell their own content from the SRD's.
  if (m.custom) {
    heading.append(el('span', {
      class: 'chip', style: 'background:rgba(154,106,18,.25)',
      title: m.source?.document
        ? `Ingested from ${m.source.document}`
        : 'Added by you, not from the SRD',
    }, 'custom'));
  }
  box.append(heading);
  box.append(el('div', { class: 'muted', style: 'font-style:italic;margin-bottom:10px' },
    `${m.size} ${m.type}${m.alignment ? `, ${m.alignment}` : ''}`));

  box.append(el('div', { class: 'mono', style: 'margin-bottom:10px' },
    `AC ${m.ac} · HP ${m.hp}${m.hitDice ? ` (${m.hitDice})` : ''} · `
    + `Speed ${m.speed || '30 ft.'} · CR ${m.crText} (${(m.xp || 0).toLocaleString()} XP)`));

  const grid = el('div', { class: 'grid stats' });
  for (const ab of ABILITIES) {
    const a = m.abilities?.[ab];
    if (!a) continue;
    const c = el('div', { class: 'stat' });
    c.append(el('div', { class: 'k' }, ab.toUpperCase()));
    c.append(el('div', { class: 'v' }, String(a.score)));
    c.append(el('div', { class: 'sub' }, `${sign(a.mod)} / save ${sign(a.save)}`));
    grid.append(c);
  }
  box.append(grid);

  for (const [label, value] of [
    ['Skills', m.skills], ['Senses', m.senses], ['Languages', m.languages],
    ['Resistances', m.resistances], ['Immunities', m.immunities], ['Gear', m.gear],
  ]) {
    if (value) {
      box.append(el('p', { style: 'margin:6px 0;font-size:14px' },
        el('strong', {}, `${label}: `), value));
    }
  }

  for (const [label, list] of [
    ['Traits', m.traits], ['Actions', m.actions], ['Bonus Actions', m.bonusActions],
    ['Reactions', m.reactions], ['Legendary Actions', m.legendaryActions],
  ]) {
    if (!list?.length) continue;
    box.append(el('div', { class: 'rule' }));
    box.append(el('div', { class: 'eyebrow', style: 'margin-bottom:8px' }, label));
    for (const entry of list) {
      const p = el('p', { style: 'font-size:14px;margin:0 0 8px' });
      p.append(el('strong', { class: 'term' }, `${entry.name}. `));
      p.append(document.createTextNode(entry.text));
      box.append(p);
    }
  }
  if (m.abilitiesPatched) {
    box.append(el('p', { class: 'mono muted', style: 'font-size:11px;margin-top:12px' },
      'Ability scores hand-verified: this stat block is malformed upstream in the SRD.'));
  }
  return box;
}

/* ------------------------------------------------------------------ */

function referencePanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Reference'));
  const box = el('input', {
    type: 'text', placeholder: 'Search conditions, actions, rules terms...',
    value: search, onInput: (e) => { search = e.target.value; render(); },
  });
  panel.append(box);
  const out = el('div', { style: 'margin-top:14px' });
  panel.append(out);

  function render() {
    out.innerHTML = '';
    const q = search.trim().toLowerCase();
    const list = q.length >= 2
      ? glossary.filter((g) => g.name.toLowerCase().includes(q))
      : glossary.filter((g) => g.tag === 'Condition');
    if (!list.length) { out.append(el('p', { class: 'muted' }, 'No match.')); return; }
    for (const g of list.slice(0, 30)) {
      const d = el('details', { style: 'border-bottom:1px solid var(--etch);padding:7px 0' });
      const s = el('summary', { style: 'cursor:pointer' });
      s.append(el('strong', {}, g.name));
      if (g.tag) s.append(el('span', { class: 'chip', style: 'margin-left:8px' }, g.tag));
      d.append(s);
      d.append(el('div', { html: md(g.text), style: 'font-size:14px;padding-top:6px' }));
      out.append(d);
    }
  }
  render();
  return panel;
}

function field(label, control) {
  const d = el('div');
  d.append(el('label', { class: 'field' }, label));
  d.append(control);
  return d;
}
