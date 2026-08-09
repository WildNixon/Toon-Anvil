/**
 * Small shared UI pieces.
 *
 * Three helpers that had each been written four times across the modes,
 * promoted the moment a fourth copy was about to appear. Everything here
 * builds plain DOM through el() and styles itself entirely from design.css
 * classes - no inline layout.
 */

import { el } from '../core/store.js';

/**
 * A row of tabs. Returns the tablist element.
 *
 * Buttons carry role=tab and aria-selected, styled as parchment file-folders
 * (.tabs/.tab in design.css) - deliberately unlike .act buttons, because a
 * tab answers "where am I", not "do something".
 *
 * `items` is [{ id, label }]; `onSelect(id)` is called with the clicked id.
 * The caller owns the state and redraws; this stays stateless.
 */
export function tabs({ items, active, onSelect }) {
  const bar = el('div', { class: 'tabs', role: 'tablist' });
  for (const { id, label } of items) {
    bar.append(el('button', {
      class: 'tab',
      role: 'tab',
      'aria-selected': String(id === active),
      onClick: () => { if (id !== active) onSelect(id); },
    }, label));
  }
  return bar;
}

/** A labelled control: the .field caption above whatever is passed in. */
export function field(label, control) {
  const wrap = el('div', {});
  wrap.append(el('label', { class: 'field' }, label));
  wrap.append(control);
  return wrap;
}

/**
 * One stat tile - the .stat card with its k/v/sub lines.
 * Pass onClick to make it a .clickable tile.
 */
export function statTile(k, v, sub = '', onClick = null) {
  const tile = el('div', {
    class: `stat${onClick ? ' clickable' : ''}`,
    ...(onClick ? { onClick, role: 'button', tabindex: '0' } : {}),
  });
  tile.append(el('div', { class: 'k' }, k));
  tile.append(el('div', { class: 'v' }, String(v)));
  if (sub) tile.append(el('div', { class: 'sub' }, sub));
  return tile;
}

/**
 * dial() - one labelled control row: a caption, a slider, and a number you
 * can type. The slider is the fast hand, the number is the exact one; both
 * drive the same commit.
 *
 * The RANGE input carries `ariaLabel` verbatim - gym selectors target it by
 * that exact string - and the number input carries `${ariaLabel} value`.
 * Sync rules: dragging mirrors into the number live and commits once on
 * release (one saved change per settled drag, not forty); typing clamps to
 * [min, max], writes back to both inputs, and commits on change. Number
 * input VALUES never appear in textContent, so text-reading assertions
 * stay blind to them by construction.
 */
export function dial({ label, value, min, max, step, ariaLabel,
  prefix = '', onCommit }) {
  const row = el('div', {
    style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap',
  });
  const clamp = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return Number(value);
    return Math.min(Number(max), Math.max(Number(min), n));
  };
  const range = el('input', {
    type: 'range', min: String(min), max: String(max), step: String(step),
    value: String(value), 'aria-label': ariaLabel, style: 'width:130px',
  });
  const num = el('input', {
    type: 'number', min: String(min), max: String(max), step: String(step),
    value: String(value), 'aria-label': `${ariaLabel} value`,
    style: 'width:72px',
  });
  range.addEventListener('input', () => { num.value = range.value; });
  range.addEventListener('change', () => onCommit(Number(range.value)));
  num.addEventListener('change', () => {
    const v = clamp(num.value);
    num.value = String(v);
    range.value = String(v);
    onCommit(v);
  });
  row.append(el('label', {
    class: 'field', style: 'margin:0;display:inline-block;flex:none',
  }, label));
  row.append(range);
  if (prefix) {
    row.append(el('span', { class: 'mono', style: 'font-size:12px' }, prefix));
  }
  row.append(num);
  return row;
}
