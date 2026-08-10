/**
 * The join gate - a table is open and this browser has no seat at it.
 *
 * Two steps: join with the code the DM reads aloud, then claim a character -
 * pick an unclaimed one, make a new one (only while the forge is open), or
 * just watch. "Not now" backs out entirely; watching a table you have not
 * joined is allowed, it is only writing that needs a seat.
 *
 * Mounted on <body>, never inside <main> - the tests read <main> to decide
 * what a mode shows, and an overlay is not part of any mode. Same rule as
 * the seat welcome, and this gate outranks it: an open table decides the
 * seat, so asking "player or DM?" underneath would be noise.
 */

import { getState, el } from '../core/store.js';
import * as session from '../core/session.js';

let overlay = null;

export function mounted() { return Boolean(overlay); }

export function mount({ onDone, prefillCode = null }) {
  if (overlay) return;
  overlay = el('div', {
    class: 'welcome', role: 'dialog', 'aria-modal': 'true',
    'aria-label': 'Join the table',
  });
  document.body.append(overlay);
  drawJoin(onDone, prefillCode);
}

export function unmount() {
  overlay?.remove();
  overlay = null;
}

/* ------------------------------------------------------------------ */

function card() {
  const c = el('div', { class: 'welcome-card', role: 'document' });
  overlay.innerHTML = '';
  overlay.append(c);
  return c;
}

function drawJoin(onDone, prefillCode = null) {
  const c = card();
  c.append(el('h2', {}, 'A table is open.'));
  c.append(el('p', {},
    prefillCode
      ? 'The link brought the code with it - just say who you are.'
      : 'The DM has a short code - ask for it and take your seat.'));

  const code = el('input', {
    type: 'text', placeholder: 'ANVIL-....', 'aria-label': 'Join code',
    value: prefillCode || false,
    style: 'text-align:center;font-family:var(--mono);letter-spacing:.14em',
  });
  const name = el('input', {
    type: 'text', placeholder: 'Your name', 'aria-label': 'Your name',
    style: 'text-align:center;margin-top:8px',
  });
  const err = el('p', {
    class: 'mono', style: 'color:var(--bad-text);font-size:12px;min-height:18px;margin:8px 0 0',
  });
  c.append(code, name, err);

  const row = el('div', { class: 'welcome-choices' });
  row.append(el('button', {
    onClick: async () => {
      err.textContent = '';
      const out = await session.join({
        code: code.value.trim(), name: name.value.trim() || 'Player',
      });
      if (!out.ok) {
        err.textContent = out.error || 'That did not work.';
        return;
      }
      drawClaim(onDone);
    },
  }, 'Join'));
  c.append(row);

  c.append(el('button', {
    class: 'act ghost small',
    onClick: () => { unmount(); onDone?.(); },
  }, 'Not now'));
  c.append(el('p', { class: 'welcome-fine', style: 'margin-top:10px' },
    'You can watch without joining. Joining is what lets you write - and '
    + 'the server holds everyone to their seat.'));
  // A deep link already answered the code question - the name is all
  // that is left to type.
  (prefillCode ? name : code).focus();
}

function drawClaim(onDone) {
  const c = card();
  const me = session.me();
  c.append(el('h2', {}, `Welcome, ${me?.name || 'traveller'}.`));

  const status = session.current() || {};
  const claimed = new Set((status.profiles || [])
    .flatMap((p) => p.characterIds || []));
  const unclaimed = (getState().characters || [])
    .filter((ch) => !claimed.has(ch.id));

  if (unclaimed.length) {
    c.append(el('p', {}, 'Whose story is yours?'));
    const list = el('div', { class: 'welcome-choices', style: 'flex-direction:column' });
    for (const ch of unclaimed.slice(0, 6)) {
      list.append(el('button', {
        onClick: async () => {
          await session.claim(ch.id);
          unmount();
          onDone?.(ch.id);
        },
      }, `Play as ${ch.name || 'Unnamed'}`));
    }
    c.append(list);
  } else {
    c.append(el('p', { class: 'muted' },
      'No unclaimed characters are waiting.'));
  }

  const row = el('div', { class: 'btnrow', style: 'justify-content:center;margin-top:6px' });
  if (session.forgeOpen()) {
    row.append(el('button', {
      class: 'act small',
      onClick: () => { unmount(); onDone?.('new'); },
    }, 'Make a new character'));
  } else {
    c.append(el('p', { class: 'welcome-fine' },
      'The forge is closed, so new characters wait for the DM to open it.'));
  }
  row.append(el('button', {
    class: 'act ghost small',
    onClick: () => { unmount(); onDone?.(); },
  }, 'Just watch'));
  c.append(row);
}
