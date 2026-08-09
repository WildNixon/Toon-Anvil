/**
 * The shelf, client side - upload a PDF and the server detects what it is,
 * files it under library/shelf/<category>/, and extracts it. The browser
 * never parses a PDF; it ships the bytes and gets a verdict back.
 *
 * Auth mirrors the forge: solo needs no token at all, and the moment a table
 * is open the server insists on the DM's. We always SEND the stored token if
 * one exists and let the server judge - deciding client-side would be theatre.
 */

import { serverBase } from './db.js';

const TOKEN_KEY = 'toonanvil.token';

const token = () => {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
};

async function jfetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const t = token();
  if (t) headers['X-Toon-Token'] = t;
  let res;
  try {
    res = await fetch(serverBase() + path, { ...opts, headers });
  } catch {
    return { status: 0, error: 'needs serve.py running' };
  }
  let body = {};
  try { body = await res.json(); } catch { /* no body */ }
  return { status: res.status, ...body };
}

/** POST the raw bytes. Synchronous on the server - a 300-page book takes a
 *  minute or two, so callers show a busy toast before awaiting this. */
export async function uploadPdf(file, category = null) {
  const bytes = await file.arrayBuffer();
  const headers = { 'Content-Type': 'application/pdf', 'X-Filename': file.name };
  const t = token();
  if (t) headers['X-Toon-Token'] = t;
  const q = category ? `?category=${encodeURIComponent(category)}` : '';
  let res;
  try {
    res = await fetch(`${serverBase()}/api/shelf${q}`,
      { method: 'POST', headers, body: bytes });
  } catch {
    return { status: 0, error: 'needs serve.py running' };
  }
  let body = {};
  try { body = await res.json(); } catch { /* no body */ }
  return { status: res.status, ...body };
}

export const listShelf = () => jfetch('/api/shelf');

export const getSections = (slug, all = false) => jfetch(
  `/api/shelf/sections/${encodeURIComponent(slug)}${all ? '?all=1' : ''}`);

export const refileBook = (hash, category) => jfetch('/api/shelf/refile',
  { method: 'POST', body: JSON.stringify({ hash, category }) });

export const removeBook = (hash) => jfetch('/api/shelf/remove',
  { method: 'POST', body: JSON.stringify({ hash }) });

export const CATEGORIES = ['settings', 'adventures', 'options', 'bestiaries',
  'unsorted'];

export const CATEGORY_LABELS = {
  settings: 'Settings', adventures: 'Adventures', options: 'Player options',
  bestiaries: 'Bestiaries', unsorted: 'Unsorted',
};

const KIND_LABELS = {
  monster: 'monsters', spell: 'spells', magic_item: 'items', feat: 'feats',
  species: 'species', equipment: 'equipment', mechanic: 'mechanics',
  subclasses: 'subclasses', unclassified: 'sections',
};

/** One honest sentence about what just happened to the file. */
export function verdictLine(res) {
  if (res.status === 409) {
    return 'That book is already being filed - give it a moment.';
  }
  if (res.status === 401) return 'Join the table first.';
  if (res.status === 403) {
    return res.error || "Filing books needs the DM's token while a table is open.";
  }
  if (!res.status || res.status >= 400) {
    return res.error || 'The shelf refused that file.';
  }
  const label = CATEGORY_LABELS[res.category] || res.category || '?';
  if (res.alreadyKnown) return `Already on the shelf, under ${label}.`;
  const counts = Object.entries(res.written || {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${KIND_LABELS[k] || k}`);
  const detail = counts.length ? ` - ${counts.slice(0, 3).join(', ')}` : '';
  const note = res.error ? ' (text extraction failed - refile or retry)' : '';
  return `Filed under ${label}${detail}${note}.`;
}
