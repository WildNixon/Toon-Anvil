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
  // The beat form sits directly under the buttons that opened it, rather than
  // over the page as a modal, so you can still read what you have already
  // recorded while typing the next thing.
  if (openForm) container.append(formPanel(openForm));
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

/* ------------------------------------------------------------------ */
/* the beat form                                                       */
/* ------------------------------------------------------------------ */

/**
 * Recording a beat opens a small inline form.
 *
 * This used to be a chain of native prompt() dialogs. They worked, but they
 * are modal, unstyled, one question at a time with no way back, and blocked
 * outright in embedded contexts - which includes the Chrome side panel this
 * app is meant to dock into, and any automated test. A form you can see all
 * of, correct before committing, and cancel is better on every count.
 *
 * `openForm` is the only place a beat collects input, so every beat gets the
 * same behaviour: Escape cancels, Enter submits, the first field is focused,
 * and required fields are enforced before anything is written.
 */
let openForm = null;

function beatForm(spec) {
  openForm = spec;
  draw();
}

function closeForm() {
  openForm = null;
  draw();
}

function formPanel(spec) {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, spec.title));
  if (spec.hint) panel.append(el('p', { class: 'muted', style: 'font-size:14px' }, spec.hint));

  const values = {};
  const inputs = [];
  const form = el('form', { style: 'display:grid;gap:10px;margin-top:8px' });

  for (const f of spec.fields) {
    const wrap = el('label', { style: 'display:grid;gap:4px' });
    wrap.append(el('span', { class: 'eyebrow' },
      f.label + (f.required ? '' : ' (optional)')));
    let input;
    if (f.type === 'select') {
      input = el('select', {});
      for (const o of f.options) {
        input.append(el('option', { value: o.value }, o.label));
      }
    } else {
      input = el('input', { type: 'text', placeholder: f.placeholder || '' });
    }
    input.addEventListener('input', () => { values[f.key] = input.value; });
    values[f.key] = f.value || (f.type === 'select' ? f.options?.[0]?.value : '');
    if (f.value) input.value = f.value;
    wrap.append(input);
    form.append(wrap);
    inputs.push({ f, input });
  }

  const err = el('p', { class: 'mono', style: 'color:var(--bad,#a3301a);font-size:12px' });
  form.append(err);

  const row = el('div', { class: 'btnrow' });
  const submit = el('button', { type: 'submit', class: 'act' }, spec.submit || 'Record');
  row.append(submit);
  row.append(el('button', {
    type: 'button', class: 'act ghost', onClick: closeForm,
  }, 'Cancel'));
  form.append(row);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const missing = inputs.filter(({ f, input }) => f.required && !input.value.trim());
    if (missing.length) {
      err.textContent = `${missing[0].f.label} is needed.`;
      missing[0].input.focus();
      return;
    }
    const out = {};
    for (const { f, input } of inputs) out[f.key] = input.value.trim() || null;
    openForm = null;
    await spec.onSubmit(out);
  });

  // Escape cancels, the way every other dialog on earth behaves.
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeForm(); });

  panel.append(form);
  // Focus the first field so you can just start typing.
  setTimeout(() => inputs[0]?.input?.focus(), 0);
  return panel;
}

/* ------------------------------------------------------------------ */
/* beats                                                               */
/* ------------------------------------------------------------------ */

function metSomeone() {
  beatForm({
    title: 'Met someone',
    hint: 'Recorded as an NPC, so they can come back later.',
    submit: 'Record the meeting',
    fields: [
      { key: 'name', label: 'Who did you meet?', required: true,
        placeholder: 'Dockmaster Ilse' },
      { key: 'where', label: 'Where?', placeholder: 'The winch house' },
      { key: 'want', label: 'What do they want?', placeholder: 'A favour owed' },
    ],
    async onSubmit({ name, where, want }) {
      // The EVENT is the beat and always lands - /api/events is ungated.
      // The npcs RECORD is the world's ledger, which at a table belongs to
      // the DM (a shared kind, so the server refuses players). Best-effort:
      // solo and DM writes succeed; a player's beat still shows in People
      // because that panel also reads the events.
      await log('npc_met', { name, where, want, threadKey: name });
      try {
        await db.put('npcs', {
          id: `npc-${name.toLowerCase().replace(/\W+/g, '-')}`,
          name, where, want, disposition: 0,
          firstMet: new Date().toISOString(), notes: [],
        });
      } catch { /* a player at a table: the event carries the beat */ }
      toast(`Met ${name}`, 'ok');
      await reload();
    },
  });
}

function madePromise() {
  beatForm({
    title: 'Made a promise',
    hint: 'This stays on your open threads until you close it.',
    submit: 'Record the promise',
    fields: [
      { key: 'to', label: 'Promised to whom?', required: true,
        placeholder: 'Dockmaster Ilse' },
      { key: 'what', label: 'Promised what?', required: true,
        placeholder: 'To return the ledger before the tide' },
    ],
    async onSubmit({ to, what }) {
      await log('promise_made', { to, what, threadKey: `${to}:${what}` });
      toast('Promise recorded - it will show as an open thread', 'ok');
      await reload();
    },
  });
}

function keptPromise() {
  const open = openThreads(events).filter((t) => t.kind === 'promise');
  if (!open.length) return toast('No open promises', 'warn');
  // Choosing from a list beats "type the number of the promise you mean",
  // which is what the prompt() version asked for.
  beatForm({
    title: 'Close a promise',
    submit: 'Close it',
    fields: [
      { key: 'which', label: 'Which promise?', type: 'select',
        options: open.map((t, i) => ({ value: String(i), label: t.summary || t.key })) },
      { key: 'outcome', label: 'How did it end?', type: 'select',
        options: [{ value: 'kept', label: 'Kept it' },
          { value: 'broken', label: 'Broke it' }] },
    ],
    async onSubmit({ which, outcome }) {
      const chosen = open[Number(which)];
      if (!chosen) return;
      const kept = outcome === 'kept';
      await log(kept ? 'promise_kept' : 'promise_broken', {
        to: chosen.payload?.to, what: chosen.payload?.what, threadKey: chosen.key,
      });
      toast(kept ? 'Promise closed' : 'Marked as broken', kept ? 'ok' : 'bad');
      await reload();
    },
  });
  return null;
}

function learnedSecret() {
  beatForm({
    title: 'Learned a secret',
    hint: 'Secrets stay open until you use them for something.',
    submit: 'Record the secret',
    fields: [
      { key: 'what', label: 'What did you learn?', required: true,
        placeholder: 'The harbourmaster is being blackmailed' },
      { key: 'from', label: 'From whom?', placeholder: 'A drunk pilot' },
    ],
    async onSubmit({ what, from }) {
      await log('secret_learned', { what, from, threadKey: what });
      toast('Secret recorded', 'ok');
      await reload();
    },
  });
}

function madeChoice() {
  beatForm({
    title: 'Made a choice',
    submit: 'Record the choice',
    fields: [
      { key: 'what', label: 'What did you decide?', required: true,
        placeholder: 'Let the smuggler go rather than turn her in' },
    ],
    async onSubmit({ what }) {
      await log('choice_made', { what });
      toast('Choice recorded', 'ok');
      await reload();
    },
  });
}

function visited() {
  beatForm({
    title: 'Visited somewhere',
    submit: 'Record the place',
    fields: [
      { key: 'name', label: 'Where did you go?', required: true,
        placeholder: 'The drowned quarter' },
    ],
    async onSubmit({ name }) {
      await log('location_visited', { name });
      toast(`Logged ${name}`, 'ok');
      await reload();
    },
  });
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
  await log('npc_relationship', {
    name: npc.name, delta, disposition: next.disposition, threadKey: npc.name,
  });
  try {
    await db.put('npcs', next);
  } catch { /* a player at a table: the event carries the shift */ }
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
