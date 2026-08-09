/**
 * WORLD - the prep lens.
 *
 * Everything the DM reaches for between scenes: the bestiary, the encounter
 * budgeter, treasure, the improvisation generators and the rules reference,
 * behind one row of sub-tabs. Nothing here is live state; it is the workshop,
 * so the shell never redraws it off the change feed - a half-typed monster
 * search surviving a player's die roll matters more than freshness.
 *
 * Each searchable panel owns its own search string. They used to share one,
 * which meant typing "dragon" in the bestiary silently pre-filtered the
 * encounter picker.
 */

import { getState, setState, el, md, sign, toast } from '../../core/store.js';
import { encounterBudget, CR_XP, ABILITIES } from '../../core/rules2024.js';
import { go, saveCharacter } from '../../app.js';
import { tabs, field } from '../../ui/kit.js';
import { addMonsters } from './runner.js';
import { lootPanel, improvPanel } from './panels.js';
import * as session from '../../core/session.js';

let sub = 'bestiary';
let build = { partyLevels: [3, 3, 3, 3], difficulty: 'moderate', picks: [] };
const searches = { picker: '', bestiary: '', reference: '' };
// Loot and generator state: scratch, kept across tab switches so a DM does
// not lose a hoard they liked by glancing at the bestiary.
const loot = { cr: 5, seed: 1, individual: false, result: null };
const improv = { seed: 1, level: 3, terrain: 'forest', result: null };

let box = null;
let ctx = null;

export function render(root, context) {
  box = root;
  ctx = context;
  draw();
}

function draw() {
  box.innerHTML = '';
  const bar = el('div', { class: 'panel rivets' });
  bar.append(el('span', { class: 'lvl' }, 'World'));
  bar.append(el('p', { class: 'mono muted', style: 'font-size:11px;margin:0 0 6px' },
    `${ctx.monsters.length} monsters · ${ctx.glossary.length} rules entries · `
    + 'all offline'));
  bar.append(tabs({
    items: Object.entries({
      bestiary: 'Bestiary', encounter: 'Encounter builder', loot: 'Treasure',
      improv: 'Improvise', reference: 'Rules reference',
    }).map(([id, label]) => ({ id, label })),
    active: sub,
    onSelect: (id) => { sub = id; draw(); },
  }));
  box.append(bar);

  if (sub === 'bestiary') {
    box.append(bestiaryPanel());
  } else if (sub === 'encounter') {
    box.append(budgetPanel());
    box.append(pickerPanel());
  } else if (sub === 'loot') {
    box.append(lootPanel({
      tables: ctx.tables, magicItems: ctx.magicItems, loot,
      redraw: draw, saveCharacter,
    }));
  } else if (sub === 'improv') {
    box.append(improvPanel({
      tables: ctx.tables, monsters: ctx.monsters, improv, redraw: draw,
      sendToFight: (entry) => {
        const m = ctx.monsters.find((x) => x.id === entry.id);
        if (!m) return;
        addMonsters(m, entry.count);
        toast(`${entry.count} x ${m.name} added to the fight`, 'ok');
        ctx.goToLens('stage');
      },
    }));
  } else {
    box.append(referencePanel());
  }
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
  const add = (k, v, sub_) => {
    const c = el('div', { class: 'stat' });
    c.append(el('div', { class: 'k' }, k));
    c.append(el('div', { class: 'v' }, String(v)));
    if (sub_) c.append(el('div', { class: 'sub' }, sub_));
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
    // At a table the shared runner IS the fight, so the picks go there and
    // the lens flips to Stage. Solo keeps the old bridge to the Combat mode,
    // which still exists solo.
    const send = session.isOpen()
      ? el('button', {
        class: 'act',
        onClick: () => {
          let sent = 0;
          for (const p of build.picks) {
            const m = ctx.monsters.find((x) => x.id === p.id);
            if (m) { addMonsters(m, p.count); sent += p.count; }
          }
          build.picks = [];
          toast(`${sent} combatants added to the fight`, 'ok');
          ctx.goToLens('stage');
        },
      }, 'Send to the fight')
      : el('button', { class: 'act', onClick: pushToCombat }, 'Send to Combat tracker');
    panel.append(el('div', { class: 'btnrow', style: 'margin-top:12px' },
      send,
      el('button', {
        class: 'act ghost', onClick: () => { build.picks = []; draw(); },
      }, 'Clear')));
  }
  return panel;
}

function pushToCombat() {
  const combatants = [];
  for (const p of build.picks) {
    const m = ctx.monsters.find((x) => x.id === p.id);
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

  const box_ = el('input', {
    type: 'text', value: searches.picker,
    placeholder: 'Search by name, type, or CR (e.g. "dragon", "cr 5")',
    onInput: (e) => { searches.picker = e.target.value; renderHits(); },
  });
  panel.append(box_);
  const hits = el('div', { style: 'margin-top:12px' });
  panel.append(hits);

  function renderHits() {
    hits.innerHTML = '';
    const q = searches.picker.trim().toLowerCase();
    if (q.length < 2) {
      hits.append(el('p', { class: 'muted' }, 'Type at least two characters.'));
      return;
    }
    const crMatch = /^cr\s*([\d/.]+)$/.exec(q);
    let list;
    if (crMatch) {
      const [a, b] = crMatch[1].split('/');
      const want = b ? Number(a) / Number(b) : parseFloat(crMatch[1]);
      list = ctx.monsters.filter((m) => m.cr === want);
    } else {
      list = ctx.monsters.filter((m) => m.name.toLowerCase().includes(q)
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
  const box_ = el('input', {
    type: 'text', placeholder: 'Look up a monster...', value: searches.bestiary,
    onInput: (e) => { searches.bestiary = e.target.value; renderOut(); },
  });
  panel.append(box_);
  const out = el('div', { style: 'margin-top:14px' });
  panel.append(out);

  function renderOut() {
    out.innerHTML = '';
    const q = searches.bestiary.trim().toLowerCase();
    if (q.length < 2) return;
    const m = ctx.monsters.find((x) => x.name.toLowerCase() === q)
      || ctx.monsters.find((x) => x.name.toLowerCase().includes(q));
    if (!m) { out.append(el('p', { class: 'muted' }, 'No match.')); return; }
    out.append(statBlock(m));
  }
  renderOut();
  return panel;
}

function statBlock(m) {
  const card = el('div', {
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
  card.append(heading);
  card.append(el('div', { class: 'muted', style: 'font-style:italic;margin-bottom:10px' },
    `${m.size} ${m.type}${m.alignment ? `, ${m.alignment}` : ''}`));

  card.append(el('div', { class: 'mono', style: 'margin-bottom:10px' },
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
  card.append(grid);

  for (const [label, value] of [
    ['Skills', m.skills], ['Senses', m.senses], ['Languages', m.languages],
    ['Resistances', m.resistances], ['Immunities', m.immunities], ['Gear', m.gear],
  ]) {
    if (value) {
      card.append(el('p', { style: 'margin:6px 0;font-size:14px' },
        el('strong', {}, `${label}: `), value));
    }
  }

  for (const [label, list] of [
    ['Traits', m.traits], ['Actions', m.actions], ['Bonus Actions', m.bonusActions],
    ['Reactions', m.reactions], ['Legendary Actions', m.legendaryActions],
  ]) {
    if (!list?.length) continue;
    card.append(el('div', { class: 'rule' }));
    card.append(el('div', { class: 'eyebrow', style: 'margin-bottom:8px' }, label));
    for (const entry of list) {
      const p = el('p', { style: 'font-size:14px;margin:0 0 8px' });
      p.append(el('strong', { class: 'term' }, `${entry.name}. `));
      p.append(document.createTextNode(entry.text));
      card.append(p);
    }
  }
  if (m.abilitiesPatched) {
    card.append(el('p', { class: 'mono muted', style: 'font-size:11px;margin-top:12px' },
      'Ability scores hand-verified: this stat block is malformed upstream in the SRD.'));
  }
  return card;
}

/* ------------------------------------------------------------------ */

function referencePanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Reference'));
  const box_ = el('input', {
    type: 'text', placeholder: 'Search conditions, actions, rules terms...',
    value: searches.reference,
    onInput: (e) => { searches.reference = e.target.value; renderOut(); },
  });
  panel.append(box_);
  const out = el('div', { style: 'margin-top:14px' });
  panel.append(out);

  function renderOut() {
    out.innerHTML = '';
    const q = searches.reference.trim().toLowerCase();
    const list = q.length >= 2
      ? ctx.glossary.filter((g) => g.name.toLowerCase().includes(q))
      : ctx.glossary.filter((g) => g.tag === 'Condition');
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
  renderOut();
  return panel;
}

/** Getter for the gym: is anything staged in the builder? */
export function stagedPicks() { return build.picks.length; }
