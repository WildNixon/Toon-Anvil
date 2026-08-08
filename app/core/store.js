/**
 * A minimal reactive store.
 *
 * No framework: there is no npm on this machine and the app must run offline
 * from static files. What's actually needed is small - hold state, notify on
 * change, re-render the active view - so this is ~120 lines instead of a
 * bundler and a dependency tree.
 */

const listeners = new Set();
const keyListeners = new Map();

let state = {
  ready: false,
  mode: 'build',
  dataSource: 'auto',
  characterId: null,
  character: null,
  derived: null,
  campaignId: null,
  sessionId: null,
  characters: [],
  homebrew: [],
  compendium: {},
  encounter: null,
  toast: null,
};

export function getState() { return state; }

/** Shallow-merge a patch and notify. Never mutate `state` directly. */
export function setState(patch) {
  const prev = state;
  const next = typeof patch === 'function' ? patch(prev) : patch;
  if (!next) return state;
  state = { ...prev, ...next };

  const changed = Object.keys(next).filter((k) => prev[k] !== state[k]);
  if (!changed.length) return state;

  for (const key of changed) {
    const subs = keyListeners.get(key);
    if (subs) for (const fn of subs) safely(fn, state, prev);
  }
  for (const fn of listeners) safely(fn, state, prev);
  return state;
}

function safely(fn, ...args) {
  try { fn(...args); } catch (err) { console.error('[store] listener threw', err); }
}

/** Subscribe to any change. Returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Subscribe to one key only - avoids re-rendering the sheet on toast changes. */
export function watch(key, fn) {
  if (!keyListeners.has(key)) keyListeners.set(key, new Set());
  keyListeners.get(key).add(fn);
  return () => keyListeners.get(key)?.delete(fn);
}

/* ------------------------------------------------------------------ */
/* tiny DOM helpers                                                    */
/* ------------------------------------------------------------------ */

/** Escape text destined for innerHTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Render a *trusted* markdown-ish subset from the compendium: **bold**,
 * _italic_, paragraphs. Input is escaped first, so ingested homebrew text
 * cannot inject markup.
 */
export function md(text) {
  const safe = esc(text);
  return safe
    .split(/\n{2,}/)
    .map((para) => `<p>${para
      .replace(/\*\*_(.+?)\._\*\*/g, '<strong class="term">$1.</strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/_(.+?)_/g, '<em>$1</em>')
      .replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** `el('div', {class:'x'}, 'text')` - terse element construction. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Signed number for modifiers: 3 -> "+3", -1 -> "-1". */
export const sign = (n) => `${n >= 0 ? '+' : ''}${n}`;

/* ------------------------------------------------------------------ */
/* toast                                                               */
/* ------------------------------------------------------------------ */

let toastTimer = null;

export function toast(message, kind = 'info') {
  setState({ toast: { message, kind, at: Date.now() } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: null }), 4200);
}
