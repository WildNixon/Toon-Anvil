/**
 * STAGE - the live now.
 *
 * One screen for the moment of play: who is at the table, the fight, and the
 * party's vitals. The strip at the top is also where the DM's levers live -
 * the forge, the level-up grants, assigning characters - because granting a
 * level is something you do while looking at the party, not in a settings
 * page.
 *
 * QUIET RULE: no text or number inputs in the table strip. The gym's runner
 * flow grabs `main input[type=number]` for the damage field and the monster
 * search by position; a stray input above the runner would hijack both.
 * Buttons and selects only.
 */

import { getState, el, toast } from '../../core/store.js';
import * as session from '../../core/session.js';
import { runnerPanel, publish } from './runner.js';
import { partyPanel } from './party.js';

let box = null;
let ctx = null;

export function render(root, context) {
  box = root;
  ctx = context;
  draw();
}

function draw() {
  box.innerHTML = '';

  box.append(tableStrip());

  // Every mutation in the runner ends in a redraw, so publishing here covers
  // all of them without each button having to remember. publish() skips a
  // write that would change nothing, and does nothing at all with no table
  // open - a solo DM never touches the network.
  publish();
  box.append(runnerPanel({
    characters: getState().characters || [],
    sources: ctx.sources(), monsters: ctx.monsters, redraw: draw,
  }));

  box.append(partyPanel(getState().characters || [], ctx.sources()));
}

/* ------------------------------------------------------------------ */

/** Total level from the raw record - the strip has no derive() context. */
const totalLevel = (ch) => Math.max(1, (ch?.classes || [])
  .reduce((n, c) => n + (Number(c.level) || 0), 0));

function tableStrip() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'At the table'));

  if (!session.isOpen()) {
    panel.append(el('h3', {}, 'No table open'));
    panel.append(el('p', { class: 'muted', style: 'font-size:14px;margin:0' },
      'Solo prep works exactly as always. To bring players in, open a '
      + 'table in Setup.'));
    panel.append(el('div', { class: 'btnrow', style: 'margin-top:10px' },
      el('button', {
        class: 'act ghost small', onClick: () => ctx.goToLens('setup'),
      }, 'Go to Setup')));
    return panel;
  }

  const status = session.current() || {};
  const grants = session.grants();
  const characters = getState().characters || [];
  const byId = new Map(characters.map((c) => [c.id, c]));
  const claimed = new Set((status.profiles || [])
    .flatMap((p) => p.characterIds || []));

  // Forge line ---------------------------------------------------------
  const forge = session.forgeOpen();
  const forgeRow = el('div', {
    style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px',
  });
  forgeRow.append(el('span', { class: `chip ${forge ? 'warn' : ''}` },
    forge ? 'Forge: open' : 'Forge: closed'));
  forgeRow.append(el('span', { class: 'muted', style: 'font-size:13px;flex:1' },
    forge ? 'Players can create and rebuild characters. Close it when the '
      + 'campaign starts.'
      : 'Character sheets are sealed. Level-ups go through grants below.'));
  forgeRow.append(el('button', {
    class: 'act ghost small',
    onClick: async () => {
      const out = await session.setForge(!forge);
      if (out.status === 403) toast(out.error || 'Only the DM does that', 'bad');
      ctx.redraw();
    },
  }, forge ? 'Close the forge' : 'Open the forge'));
  panel.append(forgeRow);

  // One row per profile ------------------------------------------------
  for (const prof of status.profiles || []) {
    const row = el('div', {
      style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;'
        + 'padding:7px 0;border-bottom:1px solid var(--etch)',
    });
    row.append(el('span', { class: 'chip' }, prof.role === 'dm' ? 'DM' : 'player'));
    row.append(el('strong', {}, prof.name));

    const owned = (prof.characterIds || [])
      .map((id) => byId.get(id)).filter(Boolean);
    if (!owned.length && prof.role !== 'dm') {
      row.append(el('span', { class: 'muted', style: 'font-size:13px' },
        'no character yet'));
    }
    for (const ch of owned) {
      const lvl = totalLevel(ch);
      const cap = grants[ch.id];
      row.append(el('span', { class: 'mono', style: 'font-size:12px' },
        `${ch.name || 'Unnamed'} · L${lvl}`));
      if (cap !== undefined) {
        row.append(el('span', { class: 'chip accent' }, `granted → L${cap}`));
        row.append(el('button', {
          class: 'act ghost small',
          onClick: async () => {
            await session.grant({ characterId: ch.id, revoke: true });
            ctx.redraw();
          },
        }, 'Revoke'));
      } else {
        row.append(el('button', {
          class: 'act ghost small',
          title: 'Let this character advance one level',
          onClick: async () => {
            const out = await session.grant({ characterId: ch.id });
            if (out.granted && Object.keys(out.granted).length) {
              toast(`${ch.name || 'They'} may reach level ${out.granted[ch.id]}`, 'ok');
            }
            ctx.redraw();
          },
        }, `Grant level ${lvl + 1}`));
      }
    }
    panel.append(row);
  }

  // Unclaimed characters: assign them to somebody -----------------------
  const unclaimed = characters.filter((c) => !claimed.has(c.id));
  const players = (status.profiles || []).filter((p) => p.role === 'player');
  if (unclaimed.length && players.length) {
    const row = el('div', {
      style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:7px 0',
    });
    row.append(el('span', { class: 'eyebrow' }, 'Unclaimed'));
    for (const ch of unclaimed) {
      const sel = el('select', {
        'aria-label': `Assign ${ch.name || 'Unnamed'}`,
        style: 'width:auto',
      });
      sel.append(el('option', { value: '' }, `${ch.name || 'Unnamed'} → ...`));
      for (const p of players) {
        sel.append(el('option', { value: p.id }, p.name));
      }
      sel.addEventListener('change', async () => {
        if (!sel.value) return;
        await session.claim(ch.id, sel.value);
        toast(`${ch.name || 'Unnamed'} assigned`, 'ok');
        ctx.redraw();
      });
      row.append(sel);
    }
    panel.append(row);
  }

  // Party-wide grant ----------------------------------------------------
  const anyClaimed = (status.profiles || [])
    .some((p) => p.role === 'player' && (p.characterIds || []).length);
  if (anyClaimed) {
    panel.append(el('div', { class: 'btnrow', style: 'margin-top:10px' },
      el('button', {
        class: 'act small',
        title: "Every player's character may advance one level",
        onClick: async () => {
          const out = await session.grant({ characterId: 'party' });
          const n = Object.keys(out.granted || {}).length;
          toast(n ? `Level-up granted to ${n} character${n === 1 ? '' : 's'}`
            : 'Nothing to grant', n ? 'ok' : 'warn');
          ctx.redraw();
        },
      }, 'Grant the party a level')));
  }
  return panel;
}
