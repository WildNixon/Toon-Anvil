/**
 * STORY - what has happened, as it happens.
 *
 * The whole party's event log in one live feed: every roll, purchase,
 * promise and journal line any player records, with the character's name on
 * each row. Plus the open threads - the promises unkept and secrets unused -
 * because "what did we leave dangling" is the question a DM asks between
 * sessions.
 *
 * Read-only by design. The story is what the table did; the DM shapes the
 * next scene on Stage and in World, not by editing the record.
 */

import { getState, el } from '../../core/store.js';
import {
  query, openThreads, summarise, CATEGORIES, EVENT_TYPES,
} from '../../core/events.js';

let box = null;
const filter = { cat: null, notableOnly: false };

export async function render(root) {
  box = root;
  await draw();
}

async function draw() {
  if (!box) return;
  const events = await query({ limit: 1000 });
  box.innerHTML = '';
  box.append(headlinePanel(events));
  box.append(threadsPanel(events));
  box.append(feedPanel(events));
}

/* ------------------------------------------------------------------ */

const names = () => new Map((getState().characters || [])
  .map((c) => [c.id, c.name || 'Unnamed']));

function headlinePanel(events) {
  const s = summarise(events);
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Story'));
  panel.append(el('h3', {}, s.total
    ? `${s.total} moments on the record`
    : 'Nothing on the record yet'));
  if (!s.total) {
    panel.append(el('p', { class: 'muted', style: 'font-size:14px;margin:0' },
      'Everything the party does - rolls, purchases, promises, journal '
      + 'lines - lands here with their name on it, live.'));
    return panel;
  }
  const stats = el('div', { class: 'grid stats' });
  const add = (k, v) => {
    const c = el('div', { class: 'stat' });
    c.append(el('div', { class: 'k' }, k));
    c.append(el('div', { class: 'v' }, String(v)));
    stats.append(c);
  };
  add('Moments', s.total);
  add('Kills', s.kills);
  add('Crits', s.crits);
  add('Spells', s.spellsCast);
  add('Dmg dealt', s.damageDealt);
  add('NPCs met', s.npcsMet);
  panel.append(stats);
  return panel;
}

function threadsPanel(events) {
  const threads = openThreads(events);
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Open threads'));
  if (!threads.length) {
    panel.append(el('p', { class: 'muted', style: 'margin:0' },
      'No dangling promises or unused secrets.'));
    return panel;
  }
  for (const t of threads.slice(0, 12)) {
    const row = el('div', {
      style: 'display:flex;gap:10px;align-items:baseline;padding:5px 0;'
        + 'border-bottom:1px solid var(--etch)',
    });
    row.append(el('span', { class: 'chip' }, t.kind));
    row.append(el('span', { style: 'flex:1' }, t.summary || t.key || ''));
    panel.append(row);
  }
  return panel;
}

function feedPanel(events) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'The feed'));

  // Category chips + the notable toggle, same grammar as the Chronicle.
  const chips = el('div', { class: 'btnrow', style: 'margin-bottom:10px' });
  chips.append(el('button', {
    class: `act ${filter.cat === null ? '' : 'ghost'} small`,
    onClick: () => { filter.cat = null; draw(); },
  }, 'All'));
  for (const [cat, label] of Object.entries(CATEGORIES)) {
    chips.append(el('button', {
      class: `act ${filter.cat === cat ? '' : 'ghost'} small`,
      onClick: () => { filter.cat = cat; draw(); },
    }, label));
  }
  chips.append(el('button', {
    class: `act ${filter.notableOnly ? '' : 'ghost'} small`,
    onClick: () => { filter.notableOnly = !filter.notableOnly; draw(); },
  }, 'Notable only'));
  panel.append(chips);

  const who = names();
  let list = events;
  if (filter.cat) list = list.filter((ev) => ev.cat === filter.cat);
  if (filter.notableOnly) {
    list = list.filter((ev) => EVENT_TYPES[ev.type]?.notable);
  }
  list = list.slice(-200).reverse();

  if (!list.length) {
    panel.append(el('div', { class: 'empty' }, 'Nothing matches this filter.'));
    return panel;
  }
  for (const ev of list) {
    const row = el('div', {
      style: 'display:flex;gap:10px;align-items:baseline;padding:4px 0;'
        + 'border-bottom:1px solid var(--etch);font-size:14px',
    });
    row.append(el('span', { class: 'mono muted', style: 'font-size:11px;width:52px' },
      String(ev.ts || '').slice(11, 16) || '--:--'));
    row.append(el('span', {
      class: 'mono', style: 'font-size:11px;min-width:80px',
    }, ev.characterId ? (who.get(ev.characterId) || '—') : '—'));
    row.append(el('span', { class: 'chip' }, ev.cat || '?'));
    row.append(el('span', { style: 'flex:1' },
      ev.summary || EVENT_TYPES[ev.type]?.label || ev.type));
    panel.append(row);
  }
  return panel;
}
