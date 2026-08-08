/**
 * Roleplay mode - people, promises, and the things you know.
 *
 * The typed events here (npc_met, promise_made, secret_learned) are what let
 * the Chronicle compute open threads. Logging a promise as a PROMISE rather
 * than as free text is the whole reason the DM export is useful.
 */

import { getState, el, esc, toast } from '../../core/store.js';
import { db } from '../../core/db.js';
import { log, query, openThreads } from '../../core/events.js';

export const title = 'Roleplay';

let container = null;
let npcs = [];
let events = [];

export async function render(root) {
  container = root;
  await reload();
}

async function reload() {
  const { characterId } = getState();
  [npcs, events] = await Promise.all([
    db.list('npcs'),
    query(characterId ? { characterId } : {}),
  ]);
  draw();
}

function draw() {
  container.innerHTML = '';
  container.append(actionsPanel());
  container.append(npcPanel());
  container.append(threadPanel());
  container.append(beatsPanel());
}

/* ------------------------------------------------------------------ */

function actionsPanel() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Record'));
  panel.append(el('h3', {}, 'What just happened'));
  panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
    'Recording these as typed beats - rather than as notes - is what lets the '
    + 'DM export work out which threads are still open.'));

  const row = el('div', { class: 'btnrow' });
  row.append(el('button', { class: 'act', onClick: metSomeone }, 'Met someone'));
  row.append(el('button', { class: 'act ghost', onClick: madePromise }, 'Made a promise'));
  row.append(el('button', { class: 'act ghost', onClick: keptPromise }, 'Kept a promise'));
  row.append(el('button', { class: 'act ghost', onClick: learnedSecret }, 'Learned a secret'));
  row.append(el('button', { class: 'act ghost', onClick: madeChoice }, 'Made a choice'));
  row.append(el('button', { class: 'act ghost', onClick: visited }, 'Visited somewhere'));
  panel.append(row);
  return panel;
}

async function metSomeone() {
  const name = prompt('Who did you meet?');
  if (!name) return;
  const where = prompt('Where?', '') || null;
  const want = prompt('What do they want? (optional)', '') || null;
  const record = {
    id: `npc-${name.toLowerCase().replace(/\W+/g, '-')}`,
    name, where, want, disposition: 0,
    firstMet: new Date().toISOString(), notes: [],
  };
  await db.put('npcs', record);
  await log('npc_met', { name, where, want, threadKey: name });
  toast(`Met ${name}`, 'ok');
  await reload();
}

async function madePromise() {
  const to = prompt('Promised to whom?');
  if (!to) return;
  const what = prompt('Promised what?');
  if (!what) return;
  await log('promise_made', { to, what, threadKey: `${to}:${what}` });
  toast('Promise recorded - it will show as an open thread', 'ok');
  await reload();
}

async function keptPromise() {
  const open = openThreads(events).filter((t) => t.kind === 'promise');
  if (!open.length) return toast('No open promises', 'warn');
  const list = open.map((t, i) => `${i + 1}. ${t.summary}`).join('\n');
  const pick = parseInt(prompt(`Which promise?\n\n${list}`, '1'), 10);
  const chosen = open[pick - 1];
  if (!chosen) return;
  const broken = confirm('OK = kept it. Cancel = broke it.');
  await log(broken ? 'promise_kept' : 'promise_broken', {
    to: chosen.payload?.to, what: chosen.payload?.what, threadKey: chosen.key,
  });
  toast(broken ? 'Promise closed' : 'Marked as broken', broken ? 'ok' : 'bad');
  await reload();
  return null;
}

async function learnedSecret() {
  const what = prompt('What did you learn?');
  if (!what) return;
  const from = prompt('From whom? (optional)', '') || null;
  await log('secret_learned', { what, from, threadKey: what });
  toast('Secret recorded', 'ok');
  await reload();
}

async function madeChoice() {
  const what = prompt('What did you decide?');
  if (!what) return;
  await log('choice_made', { what });
  toast('Choice recorded', 'ok');
  await reload();
}

async function visited() {
  const name = prompt('Where did you go?');
  if (!name) return;
  await log('location_visited', { name });
  toast(`Logged ${name}`, 'ok');
  await reload();
}

/* ------------------------------------------------------------------ */

function npcPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'People'));
  panel.append(el('h3', {}, `${npcs.length} known`));

  if (!npcs.length) {
    panel.append(el('div', { class: 'empty' }, 'Nobody recorded yet.'));
    return panel;
  }

  const mentions = {};
  for (const ev of events) {
    const n = ev.payload?.name || ev.payload?.npc || ev.payload?.to;
    if (n) mentions[n] = (mentions[n] || 0) + 1;
  }

  const grid = el('div', { class: 'grid two' });
  for (const npc of npcs) {
    const card = el('div', {
      style: 'background:var(--paper);padding:14px;border-radius:2px;'
        + 'border-left:4px solid var(--accent-2)',
    });
    const head = el('div', {
      style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px',
    });
    head.append(el('strong', {}, npc.name));
    head.append(el('span', { class: 'chip' }, `${mentions[npc.name] || 0} mentions`));
    card.append(head);
    if (npc.where) card.append(el('div', { class: 'muted', style: 'font-size:13px' }, npc.where));
    if (npc.want) card.append(el('p', { style: 'font-size:14px;margin:6px 0' }, `Wants: ${npc.want}`));

    const disp = el('div', { class: 'btnrow', style: 'margin-top:8px' });
    disp.append(el('span', {
      class: `chip ${npc.disposition > 0 ? 'ok' : npc.disposition < 0 ? 'bad' : ''}`,
    }, npc.disposition > 0 ? `friendly ${npc.disposition}`
      : npc.disposition < 0 ? `hostile ${npc.disposition}` : 'neutral'));
    disp.append(el('button', {
      class: 'act ghost small', onClick: () => shift(npc, 1),
    }, '+'));
    disp.append(el('button', {
      class: 'act ghost small', onClick: () => shift(npc, -1),
    }, '-'));
    disp.append(el('button', {
      class: 'act ghost small', onClick: () => talkTo(npc),
    }, 'Talked to them'));
    card.append(disp);
    grid.append(card);
  }
  panel.append(grid);
  return panel;
}

async function shift(npc, delta) {
  const next = { ...npc, disposition: (npc.disposition || 0) + delta };
  await db.put('npcs', next);
  await log('npc_relationship', {
    name: npc.name, delta, disposition: next.disposition, threadKey: npc.name,
  });
  await reload();
}

async function talkTo(npc) {
  const what = prompt(`What did you and ${npc.name} talk about?`);
  if (!what) return;
  await log('dialogue_beat', { name: npc.name, npc: npc.name, what, threadKey: npc.name });
  toast('Beat recorded', 'ok');
  await reload();
}

/* ------------------------------------------------------------------ */

function threadPanel() {
  const threads = openThreads(events);
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Unfinished'));
  panel.append(el('h3', {}, `${threads.length} open threads`));
  if (!threads.length) {
    panel.append(el('div', { class: 'empty' }, 'Nothing hanging.'));
    return panel;
  }
  for (const t of threads) {
    const row = el('div', {
      style: 'display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--etch)',
    });
    row.append(el('span', {
      class: `chip ${t.kind === 'promise' ? 'warn' : t.kind === 'secret' ? 'accent' : ''}`,
    }, t.kind));
    row.append(el('span', { style: 'flex:1' }, t.summary));
    panel.append(row);
  }
  return panel;
}

function beatsPanel() {
  const rp = events.filter((e) => e.cat === 'rp').slice(-40).reverse();
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Recent'));
  if (!rp.length) {
    panel.append(el('div', { class: 'empty' }, 'No roleplay beats recorded yet.'));
    return panel;
  }
  for (const ev of rp) {
    const row = el('div', {
      style: 'display:flex;gap:10px;padding:5px 0;border-bottom:1px solid var(--etch)',
    });
    row.append(el('span', { class: 'mono muted', style: 'font-size:11px;width:100px' },
      new Date(ev.ts).toLocaleDateString()));
    row.append(el('span', { style: 'flex:1' }, ev.summary));
    panel.append(row);
  }
  return panel;
}
