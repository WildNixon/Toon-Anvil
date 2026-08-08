/**
 * Toon Anvil shell: boot, mode routing, chrome.
 *
 * Modes are lazily imported so opening the app doesn't parse the DM screen or
 * the shop generator. Each mode module exports `render(container)` and may
 * export `title`.
 */

import { initDb, db, compendia, getDataSource, setDataSource, openRealStore }
  from './core/db.js';
import { getState, setState, subscribe, watch, esc, $ } from './core/store.js';
import { setContext } from './core/events.js';
import { derive } from './core/derive.js';

const MODES = [
  { id: 'build',     label: 'Build',     load: () => import('./modes/build/build.js') },
  { id: 'sheet',     label: 'Play',      load: () => import('./modes/sheet/sheet.js') },
  { id: 'combat',    label: 'Combat',    load: () => import('./modes/combat/combat.js') },
  { id: 'shop',      label: 'Shop',      load: () => import('./modes/shop/shop.js') },
  { id: 'rp',        label: 'Roleplay',  load: () => import('./modes/rp/rp.js') },
  { id: 'chronicle', label: 'Chronicle', load: () => import('./modes/chronicle/chronicle.js') },
  { id: 'dm',        label: 'DM',        load: () => import('./modes/dm/dm.js') },
  { id: 'homebrew',  label: 'Homebrew',  load: () => import('./homebrew/homebrew-ui.js') },
  { id: 'settings',  label: 'Settings',  load: () => import('./modes/settings/settings.js') },
];

/* ------------------------------------------------------------------ */
/* derived character - recomputed whenever the character changes       */
/* ------------------------------------------------------------------ */

export function recompute() {
  const { character, compendium, homebrew } = getState();
  if (!character) return setState({ derived: null });
  const derived = derive(character, {
    classes: compendium.classes || [],
    species: compendium.species || [],
    backgrounds: compendium.backgrounds || [],
    feats: compendium.feats || [],
    srdEffects: compendium.srdEffects || {},
    homebrew: homebrew || [],
  });
  return setState({ derived });
}

/** Persist the active character and refresh its derived sheet. */
export async function saveCharacter(patch) {
  const { character } = getState();
  if (!character) return null;
  const edited = typeof patch === 'function'
    ? patch(structuredClone(character))
    : { ...character, ...patch };
  // Reconcile on every save, not just on load. Levelling up in Build is an
  // edit, and without this the character keeps its old current HP against its
  // new maximum - a level 5 fighter reading 10 of 34 and looking wounded when
  // it has never been hit.
  const next = reconcileHp(edited);
  await db.put('characters', next);
  setState({ character: next });
  recompute();
  const list = await db.list('characters');
  setState({ characters: list });
  return next;
}

/**
 * Bring a character's stored HP into line with its derived maximum.
 *
 * Max HP is derived from class, level and Constitution, but `current` is play
 * state and stays stored. Whenever the maximum MOVES - levelling up, taking a
 * Constitution boost, respeccing - the stored pair goes stale and has to be
 * reconciled:
 *
 *   at full before  -> at full after. Levelling from 1 to 5 must read 34 of
 *                      34, not 10 of 34. Anything else means every character
 *                      looks wounded the moment it levels, which is exactly
 *                      what happened before this ran on save as well as load.
 *   wounded before  -> still wounded. You do not heal by gaining a level.
 *
 * Deliberately NOT inside derive(): this is a write, and the same test there
 * would compare against a stale stored max, so a damaged character would read
 * as full and heal itself on every render.
 */
function reconcileHp(character, state = getState()) {
  const { compendium, homebrew } = state;
  if (!character?.classes?.length || !compendium?.classes) return character;
  const storedMax = Number(character.hp?.max || 0);
  const d = derive(character, {
    classes: compendium.classes || [], species: compendium.species || [],
    backgrounds: compendium.backgrounds || [], feats: compendium.feats || [],
    srdEffects: compendium.srdEffects || {}, homebrew: homebrew || [],
  });
  if (storedMax === d.hp.max) return character;

  const wasFull = character.hp?.current === undefined
    || Number(character.hp.current) >= storedMax;
  return {
    ...character,
    hp: {
      ...character.hp,
      max: d.hp.max,
      current: wasFull ? d.hp.max : Math.min(Number(character.hp.current), d.hp.max),
    },
  };
}

async function migrateHp(character) {
  const next = reconcileHp(character);
  if (next !== character) await db.put('characters', next);
  return next;
}

export async function selectCharacter(id) {
  if (!id) {
    setContext({ characterId: null });
    return setState({ characterId: null, character: null, derived: null });
  }
  const character = await migrateHp(await db.get('characters', id));
  setContext({ characterId: id, campaignId: character?.campaignId || null });
  setState({ characterId: id, character, campaignId: character?.campaignId || null });
  recompute();
  localStorage.setItem('toonanvil.lastCharacter', id);
  return character;
}

/* ------------------------------------------------------------------ */
/* routing                                                             */
/* ------------------------------------------------------------------ */

let currentMode = null;

async function renderMode() {
  const { mode } = getState();
  const view = $('#view');
  const entry = MODES.find((m) => m.id === mode) || MODES[0];
  if (currentMode === entry.id && view.dataset.rendered === entry.id) {
    // Already mounted; modes re-render themselves via their own subscriptions.
  }
  currentMode = entry.id;
  view.dataset.rendered = entry.id;
  view.innerHTML = '<div class="empty">Loading&hellip;</div>';
  try {
    const mod = await entry.load();
    view.innerHTML = '';
    await mod.render(view);
  } catch (err) {
    console.error(`[app] mode "${entry.id}" failed`, err);
    view.innerHTML = `<div class="panel accent rivets">
      <span class="lvl accent">Error</span>
      <h3>${esc(entry.label)} failed to load</h3>
      <p class="mono">${esc(err.message)}</p>
      <p class="muted">The rest of the app still works - switch modes above.</p>
    </div>`;
  }
  renderNav();
}

export function go(mode) {
  if (getState().mode === mode) return;
  setState({ mode });
  location.hash = `#${mode}`;
}

function renderNav() {
  const nav = $('#modes');
  const { mode } = getState();
  nav.innerHTML = '';
  for (const m of MODES) {
    const b = document.createElement('button');
    b.textContent = m.label;
    b.setAttribute('aria-current', String(m.id === mode));
    b.addEventListener('click', () => go(m.id));
    nav.append(b);
  }
}

function renderWho() {
  const { character, derived, dataSource, ephemeral } = getState();
  const src = ephemeral ? 'sandbox'
    : dataSource === 'server' ? 'shared' : 'this device';
  const who = $('#who');
  who.innerHTML = character
    ? `<strong>${esc(character.name || 'Unnamed')}</strong>`
      + `${esc(describeClasses(character))} &middot; AC ${derived?.ac ?? '--'}`
      + ` &middot; ${esc(src)}`
    : `<strong>No character</strong>Storage: ${esc(src)}`;

  // Offer the sandbox here rather than only as a URL you have to know about.
  // Hidden while you are already in one - the bar at the bottom owns that
  // state, and two controls for the same thing in two places is how people
  // end up unsure which session they are in.
  if (!ephemeral) {
    const btn = document.createElement('button');
    btn.className = 'try';
    btn.textContent = 'Try a sandbox';
    btn.title = 'Open a throwaway session. Nothing you do in it is saved, and '
      + 'your real characters are untouched.';
    btn.addEventListener('click', startSandbox);
    who.append(btn);
  }
}

function describeClasses(ch) {
  const parts = (ch.classes || []).map((c) => `${cap(c.class)} ${c.level}`);
  return parts.length ? parts.join(' / ') : 'Level 0';
}

const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());

/* ------------------------------------------------------------------ */
/* sandbox - a session that keeps nothing                              */
/* ------------------------------------------------------------------ */

/**
 * Try things without saving them.
 *
 * The whole app runs against an in-memory store: characters, homebrew, NPCs
 * and the event log all live for exactly as long as the tab does. It exists so
 * you can take a subclass apart, roll a dozen characters, or hand the app to
 * somebody else without any of it reaching your real library.
 *
 * Two things make it safe rather than a trap:
 *   - the bar is always visible and says plainly that nothing is being saved;
 *   - there is a way OUT that does not silently throw the work away. "Keep
 *     what I made" downloads everything as JSON, which Build's Import JSON
 *     reads straight back. A sandbox you can only lose things in would be
 *     worse than no sandbox.
 */
export function startSandbox() {
  const url = new URL(location.href);
  url.searchParams.set('storage', 'memory');
  location.href = url.toString();
}

function leaveSandbox(count) {
  if (count > 0) {
    const ok = window.confirm(
      `Leaving the sandbox discards ${count} unsaved item${count === 1 ? '' : 's'}.\n\n`
      + 'Use "Keep what I made" first if you want to bring any of it with you.\n\n'
      + 'Leave anyway?',
    );
    if (!ok) return;
  }
  const url = new URL(location.href);
  url.searchParams.delete('storage');
  // Skip the beforeunload guard: the user has just answered this exact
  // question, and asking twice teaches people to click through warnings.
  sandboxLeaving = true;
  location.href = url.toString();
}

const SANDBOX_KINDS = ['characters', 'homebrew', 'npcs', 'shops', 'campaigns'];

/** Everything made in this session, by kind. */
async function sandboxContents() {
  const out = {};
  let total = 0;
  for (const kind of SANDBOX_KINDS) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await db.list(kind).catch(() => []);
    if (rows.length) { out[kind] = rows; total += rows.length; }
  }
  return { out, total };
}

/**
 * Write this session's work into the real library.
 *
 * Two things this must never do, because the whole point of a sandbox is that
 * it cannot hurt what you already have:
 *
 *   - overwrite an existing record. Sandbox ids are generated the same way
 *     real ones are, so a collision is possible; anything that clashes gets a
 *     fresh id and is written ALONGSIDE the original rather than over it.
 *   - happen without being asked. It is a write to real data initiated from a
 *     session whose entire promise was that it writes nothing, so it confirms
 *     first and says exactly what is about to land.
 */
async function keepSandbox() {
  const { out, total } = await sandboxContents();
  if (!total) return setState({ toast: { message: 'Nothing made yet', kind: 'warn' } });

  const summary = Object.entries(out)
    .map(([kind, rows]) => `${rows.length} ${kind}`).join(', ');
  const ok = window.confirm(
    `Save to your library?\n\n${summary}\n\n`
    + 'These are copied into your real saved data. Nothing already there is '
    + 'replaced - anything with a clashing id is saved as a copy.',
  );
  if (!ok) return null;

  let real;
  try {
    real = await openRealStore();
  } catch (err) {
    return setState({
      toast: { message: `Could not reach your library: ${err.message}`, kind: 'bad' },
    });
  }

  let written = 0;
  let renamed = 0;
  for (const [kind, rows] of Object.entries(out)) {
    // eslint-disable-next-line no-await-in-loop
    const existing = new Set((await real.list(kind).catch(() => [])).map((r) => r.id));
    for (const row of rows) {
      const record = { ...row };
      if (existing.has(record.id)) {
        record.id = `${record.id}-copy-${Math.random().toString(36).slice(2, 7)}`;
        record.name = `${record.name || 'Untitled'} (copy)`;
        renamed += 1;
      }
      existing.add(record.id);
      // eslint-disable-next-line no-await-in-loop
      await real.put(kind, record);
      written += 1;
    }
  }

  sandboxKept = true;
  await refreshSandboxBar();
  return setState({
    toast: {
      message: `Saved ${written} item(s) to your library`
        + (renamed ? ` (${renamed} kept as a copy to avoid overwriting)` : ''),
      kind: 'ok',
    },
  });
}

/** The same work as a file, for moving it to another machine. */
async function downloadSandbox() {
  const { out, total } = await sandboxContents();
  if (!total) return setState({ toast: { message: 'Nothing made yet', kind: 'warn' } });
  const bundle = {
    kind: 'toon-anvil-sandbox', exported: new Date().toISOString(), ...out,
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `toon-anvil-sandbox-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  sandboxKept = true;
  await refreshSandboxBar();
  return setState({
    toast: { message: `Downloaded ${total} item(s)`, kind: 'ok' },
  });
}

let sandboxKept = false;
let sandboxLeaving = false;

/** How much would be lost right now. */
async function sandboxCount() {
  let n = 0;
  for (const kind of ['characters', 'homebrew', 'npcs', 'shops', 'campaigns']) {
    // eslint-disable-next-line no-await-in-loop
    n += (await db.list(kind).catch(() => [])).length;
  }
  return n;
}

async function refreshSandboxBar() {
  const bar = $('#sandbox-bar');
  if (!bar) return;
  const n = await sandboxCount();
  bar.querySelector('.detail').textContent = n
    ? `${n} item${n === 1 ? '' : 's'} made here. Nothing is written to disk — `
      + 'it all disappears when you close or reload this tab.'
    : 'Nothing is written to disk. Build, break and throw away as much as you like.';
  bar.querySelector('.keep').disabled = n === 0;
  bar.querySelector('.keep').textContent = sandboxKept && n
    ? 'Save again' : 'Save to my library';
  const dl = bar.querySelector('.download');
  if (dl) dl.disabled = n === 0;
  bar.dataset.count = String(n);
}

function mountSandboxBar() {
  document.body.classList.add('sandbox');
  const bar = document.createElement('div');
  bar.id = 'sandbox-bar';
  bar.className = 'sandbox-bar';
  bar.innerHTML = '<span class="label">Sandbox</span>'
    + '<span class="detail"></span>';

  const keep = document.createElement('button');
  keep.className = 'keep';
  keep.textContent = 'Save to my library';
  keep.addEventListener('click', keepSandbox);

  // Kept alongside the direct save because a file is still the only way to
  // move work to another machine, and removing a working capability to add
  // one is not an upgrade.
  const dl = document.createElement('button');
  dl.className = 'download';
  dl.textContent = 'Download';
  dl.title = 'Save as a JSON file instead - Build\'s Import JSON reads it back';
  dl.addEventListener('click', downloadSandbox);

  const leave = document.createElement('button');
  leave.textContent = 'Leave sandbox';
  leave.addEventListener('click',
    () => leaveSandbox(Number(bar.dataset.count || 0)));

  bar.append(keep, dl, leave);
  document.body.append(bar);

  // Keep the count honest as things are made, without polling hard.
  subscribe(() => { refreshSandboxBar(); });
  refreshSandboxBar();

  // Closing the tab is the other way to lose everything, and the browser will
  // not let us explain why - but it will ask.
  window.addEventListener('beforeunload', (e) => {
    if (sandboxLeaving || sandboxKept) return;
    if (Number(bar.dataset.count || 0) === 0) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

/* ------------------------------------------------------------------ */
/* toast                                                               */
/* ------------------------------------------------------------------ */

watch('toast', (state) => {
  const node = $('#toast');
  if (!state.toast) { node.hidden = true; return; }
  node.hidden = false;
  node.className = state.toast.kind;
  node.textContent = state.toast.message;
});

watch('character', renderWho);
watch('derived', renderWho);
watch('mode', renderMode);

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  // ?storage=memory boots an ephemeral session: nothing is written to disk or
  // to the server, and everything is gone on reload. The UI test tier uses it
  // so that driving the real app cannot touch real characters or append to a
  // real chronicle. It is per-load and never stored as a preference.
  const params = new URLSearchParams(location.search);
  const prefer = params.get('storage') === 'memory' ? 'memory' : undefined;
  const adapter = await initDb({ prefer });
  setState({ dataSource: adapter.mode, ephemeral: prefer === 'memory' });

  if (prefer === 'memory') mountSandboxBar();

  const compendium = await compendia(
    'classes', 'species', 'backgrounds', 'feats', 'spells',
    'equipment', 'conditions', '_meta',
  );
  // The mechanical overlay for SRD class features lives outside compendium/,
  // which srd_convert.py owns and overwrites on every run.
  compendium.srdEffects = await fetch('./data/srd-effects.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  setState({ compendium });

  const [characters, homebrew] = await Promise.all([
    db.list('characters'), db.list('homebrew'),
  ]);
  setState({ characters, homebrew, ready: true });

  const hash = location.hash.replace('#', '');
  const mode = MODES.some((m) => m.id === hash) ? hash : 'build';

  const last = localStorage.getItem('toonanvil.lastCharacter');
  if (last && characters.some((c) => c.id === last)) await selectCharacter(last);
  else if (characters.length) await selectCharacter(characters[0].id);

  setState({ mode });
  renderNav();
  renderWho();
  await renderMode();

  // Register the service worker last so a failure here never blocks boot.
  // file:// and the extension's own origin do not support it; that is fine,
  // they have other offline stories.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => console.info('[toon-anvil] offline cache ready', reg.scope))
      .catch((err) => console.warn('[toon-anvil] service worker not registered', err));
  }

  console.info(
    `[toon-anvil] ready - storage: ${adapter.mode} (${adapter.label}), `
    + `${characters.length} characters, SRD ${compendium._meta?.srdVersion}`,
  );
}

window.addEventListener('hashchange', () => {
  const hash = location.hash.replace('#', '');
  if (MODES.some((m) => m.id === hash)) setState({ mode: hash });
});

// Surface real failures instead of a blank page.
window.addEventListener('error', (e) => console.error('[toon-anvil]', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[toon-anvil]', e.reason));

boot().catch((err) => {
  console.error('[toon-anvil] boot failed', err);
  $('#view').innerHTML = `<div class="panel accent rivets">
    <span class="lvl accent">Boot failure</span>
    <h3>Toon Anvil could not start</h3>
    <p class="mono">${esc(err.message)}</p>
    <p class="muted">If the compendium is missing, run
      <code>python tools/srd_convert.py</code>.</p>
  </div>`;
});

export { MODES };
