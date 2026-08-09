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
import * as session from './core/session.js';
import * as live from './core/live.js';
import * as theme from './ui/theme.js';

/**
 * `dmOnly` hides a mode from players at a table; `tableOnly` shows one only
 * when there IS a table. Solo play sees everything except the table view,
 * because with nobody else at the table there is nothing to show.
 *
 * This is navigation, not security. A player who types the hash reaches the
 * mode; what stops them changing anything is the server refusing the write.
 * Hiding these is about giving a player a screen that is about their game
 * rather than one with the DM's tools greyed out in it.
 */
const MODES = [
  { id: 'sheet',     label: 'Play',      group: 'Your Hero', ribbon: true,
    load: () => import('./modes/sheet/sheet.js') },
  { id: 'build',     label: 'Build',     group: 'Your Hero', ribbon: true,
    load: () => import('./modes/build/build.js') },
  { id: 'combat',    label: 'Combat',    group: 'Adventure', ribbon: true,
    // The solo tracker. At a table the DM's runner IS the fight; a second,
    // unsynced initiative list is clutter that disagrees with the real one.
    soloOnly: true,
    load: () => import('./modes/combat/combat.js') },
  { id: 'rp',        label: 'Roleplay',  group: 'Adventure', ribbon: true,
    load: () => import('./modes/rp/rp.js') },
  { id: 'shop',      label: 'Market',    group: 'Adventure', ribbon: true,
    load: () => import('./modes/shop/shop.js') },
  { id: 'chronicle', label: 'Chronicle', group: 'Adventure', ribbon: true,
    load: () => import('./modes/chronicle/chronicle.js') },
  { id: 'table',     label: 'Party',     group: 'Adventure', tableOnly: true, ribbon: true,
    load: () => import('./modes/table/table.js') },
  { id: 'dm',        label: 'DM',        group: 'Dungeon Master', dmOnly: true,
    load: () => import('./modes/dm/dm.js') },
  // No group: rendered as the gear pinned to the right.
  { id: 'settings',  label: 'Settings',  gear: true,
    load: () => import('./modes/settings/settings.js') },
];

/** Which modes belong in the nav for whoever is using this browser. */
function visibleModes() {
  return session.navFor({
    tableOpen: session.isOpen(),
    seat: session.isDm() ? 'dm' : 'player',
    forgeOpen: session.forgeOpen(),
    hasGrant: session.hasAnyGrant(),
  }, MODES);
}

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

/**
 * Damage or heal the active character. Negative is damage.
 *
 * Shell-level on purpose: the sheet's Damage button and the hero ribbon's
 * quick adjust both call THIS, so there is exactly one rule for what 7 damage
 * does - temp HP spent first, the floor at 0, concentration prompted. It runs
 * through the same engine the simulator uses.
 */
export async function adjustHp(delta) {
  const { derived } = getState();
  if (!delta || !derived) return null;
  const { applyDamage } = await import('./core/engine.js');
  const res = applyDamage(
    { hp: derived.hp, hpMax: derived.hp.max, temp: derived.hp.temp,
      concentrating: derived.concentration },
    delta, { name: derived.name },
  );
  await saveCharacter((c) => {
    c.hp = { ...c.hp, current: res.hp, temp: res.temp };
    return c;
  });
  const { log } = await import('./core/events.js');
  for (const ev of res.events) await log(ev.type, ev.payload);
  if (res.concentrationDc) {
    const { toast } = await import('./core/store.js');
    toast(`Concentration save: DC ${res.concentrationDc}`, 'warn');
  }
  return res;
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
  try {
    await db.put('characters', next);
  } catch (err) {
    // The server said no - the level gate, a frozen field, somebody else's
    // sheet. Its reason is written for a person; show it and keep the
    // stored state untouched rather than pretending the save happened.
    const { toast } = await import('./core/store.js');
    toast(String(err.message || err), 'bad');
    return character;
  }
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
  // A hash can point at a mode this browser should not be on - a player who
  // joined while sitting on the DM screen, or one who typed #dm. Fall back to
  // the first mode they DO have rather than rendering a screen full of
  // controls the server will refuse.
  const allowed = visibleModes();
  let entry = allowed.find((m) => m.id === mode);
  if (!entry) {
    entry = allowed[0] || MODES[0];
    setState({ mode: entry.id });
    if (location.hash.replace('#', '') !== entry.id) location.hash = `#${entry.id}`;
  }
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

/**
 * Rebuild everything above <main> after something changed which modes exist -
 * a seat flip in Settings, joining a table. If the mode on screen just
 * stopped existing for this browser, renderMode's own guard bounces to one
 * that does.
 */
export async function refreshChrome() {
  renderNav();
  renderWho();
  if (!visibleModes().some((m) => m.id === getState().mode)) await renderMode();
}

// A cog, drawn inline so it inherits currentColor and ships no asset.
const GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/>'
  + '<path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1'
  + 'M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>';

function renderNav() {
  const nav = $('#modes');
  const { mode } = getState();
  nav.innerHTML = '';

  const makeButton = (m) => {
    const b = document.createElement('button');
    if (m.gear) {
      b.className = 'gearbtn';
      // The word stays in textContent (visually hidden) so the button still
      // answers to "Settings" - for screen readers and for the UI tests,
      // which find buttons by their text.
      b.innerHTML = `${GEAR_SVG}<span class="vh">Settings</span>`;
      b.title = 'Settings';
    } else {
      b.textContent = m.label;
    }
    b.setAttribute('aria-current', String(m.id === mode));
    b.addEventListener('click', () => go(m.id));
    return b;
  };

  // Group labels are spans, never buttons - they must not be clickable and
  // must never collide with a button-by-label lookup.
  let currentGroup = null;
  let groupBox = null;
  for (const m of visibleModes()) {
    if (m.gear) continue;
    if (m.group !== currentGroup) {
      currentGroup = m.group;
      groupBox = document.createElement('div');
      groupBox.className = 'navgroup';
      const label = document.createElement('span');
      label.className = 'navgroup-label';
      label.textContent = m.group;
      groupBox.append(label);
      nav.append(groupBox);
    }
    groupBox.append(makeButton(m));
  }
  const gear = MODES.find((m) => m.gear);
  if (gear) nav.append(makeButton(gear));
}

// The corner readout became the hero ribbon (ui/ribbon.js), mounted at boot.
// This stays as the one call site the rest of the shell knows about.
let ribbonModule = null;

function renderWho() { ribbonModule?.refresh(); }

async function mountRibbon() {
  ribbonModule = await import('./ui/ribbon.js');
  ribbonModule.mount($('#ribbon'), {
    ribbonModes: MODES.filter((m) => m.ribbon).map((m) => m.id),
    describeClasses,
    adjustHp,
    selectCharacter,
    go,
    startSandbox,
    // A ribbon heal repaints only the modes that display vitals; anything
    // else keeps its half-typed state.
    rerenderVitals: () => {
      if (['sheet', 'combat', 'table'].includes(getState().mode)) renderMode();
    },
    rerenderMode: () => renderMode(),
  });
}

function describeClasses(ch) {
  const parts = (ch.classes || []).map((c) => `${cap(c.class)} ${c.level}`);
  return parts.length ? parts.join(' / ') : 'Level 0';
}

const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());

/* ------------------------------------------------------------------ */
/* live updates                                                        */
/* ------------------------------------------------------------------ */

/**
 * Re-read what somebody else changed.
 *
 * The stream says only WHAT changed, so this re-fetches from the store rather
 * than trusting a pushed copy - one source of truth, and no chance of the
 * screen disagreeing with the file on disk.
 *
 * Modes render once and do not watch the store, so refreshing state alone
 * changes nothing on screen - the sheet went on showing the old hit points.
 * The screen is therefore re-rendered explicitly, but ONLY when the change
 * touches the character being looked at. A full re-render on every change
 * would throw away half-typed input elsewhere.
 *
 * Our own writes never reach here: live.js drops them by client id, so typing
 * in Build does not re-render Build underneath the cursor.
 */
async function watchTheTable() {
  await live.start();

  live.subscribe(['characters', 'table'], async ({ changes, gap }) => {
    const mine = getState().characterId;
    const touchedMe = gap || changes.some(
      (c) => c.kind === 'characters' && c.id === mine,
    );
    const tableChanged = gap || changes.some((c) => c.kind === 'table');

    // The roster changes when anybody's character does.
    setState({ characters: await db.list('characters') });

    if (tableChanged) {
      // Joining or leaving changes which modes exist, so the nav is rebuilt
      // and the current mode re-checked - a player who joined while on the DM
      // screen should not be left sitting on it.
      await session.refresh();
      renderNav();
      if (!visibleModes().some((m) => m.id === getState().mode)) await renderMode();
      // A table change can be a grant or the forge - the sheet's banner and
      // Build's locks read them, so the visible mode repaints. Rare events;
      // nothing worth protecting is typed on those screens.
      else if (['sheet', 'build'].includes(getState().mode)) await renderMode();
    }

    if (touchedMe && mine) {
      const fresh = await db.get('characters', mine);
      if (fresh) {
        setState({ character: fresh });
        recompute();
        await renderMode();
      }
    }
    renderWho();
  });
}

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

// The ribbon watches the store itself; nothing else needs these hooks now.
watch('mode', renderMode);

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  // Theme first: everything below renders under it.
  theme.init();

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
  const mode = visibleModes().some((m) => m.id === hash) ? hash : 'build';

  const last = localStorage.getItem('toonanvil.lastCharacter');
  if (last && characters.some((c) => c.id === last)) await selectCharacter(last);
  else if (characters.length) await selectCharacter(characters[0].id);

  setState({ mode });
  // Who am I at this table? With none open the answer is "the only person
  // here", which is what solo play already assumed.
  await session.refresh();

  renderNav();
  await mountRibbon();
  await renderMode();

  // First run on this device, no table to answer for us: ask who is holding
  // it. Everything above already rendered under the calmer player default,
  // so choosing DM only has to refresh the chrome.
  if (session.needsSeat()) {
    const welcome = await import('./ui/welcome.js');
    welcome.mount({ onChoose: () => refreshChrome() });
  }

  watchTheTable();

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
  if (visibleModes().some((m) => m.id === hash)) setState({ mode: hash });
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
