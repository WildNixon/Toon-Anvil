/**
 * SETUP - before the campaign, and the levers that frame it.
 *
 * The forge (whether players can build), a quick party, and the homebrew
 * workshop - which lives here because homebrew is added and accepted by the
 * DM before the start, and stays a DM-only tool after.
 *
 * Hosting itself lives in the LOBBY. This screen used to carry a complete
 * second copy of the host flow - open form, code, join link, QR - and two
 * ways to do one thing is how neither gets learned. What remains here is a
 * status strip that says whether a table is open and points at the one room
 * where it happens, plus Close for disaster recovery beside the forge.
 */

import { el, toast, getState, setState } from '../../core/store.js';
import { db } from '../../core/db.js';
import * as session from '../../core/session.js';
import { go, refreshChrome } from '../../app.js';
import { forgeParty, RECIPES } from '../../core/pregen.js';

let box = null;
let ctx = null;

export async function render(root, context) {
  box = root;
  ctx = context;
  box.innerHTML = '';
  box.append(tableStrip());
  if (session.isOpen()) {
    box.append(quickPartyPanel());
    box.append(forgePanel());
  }
  box.append(await workshopPanel());
}

/* ------------------------------------------------------------------ */

/**
 * Status, not a second host flow. The code, the link and the QR live in the
 * Lobby - the one room where hosting happens. Close stays: when the network
 * is on fire the DM should not have to change rooms to pull the plug.
 */
function tableStrip() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'The table'));

  if (!session.isOpen()) {
    panel.append(el('h3', {}, 'No table open'));
    panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
      'Host from the Lobby: set the campaign, open the table, and read the '
      + 'code out while you watch everyone arrive.'));
    panel.append(el('div', { class: 'btnrow' }, el('button', {
      class: 'act', onClick: () => go('lobby'),
    }, 'Open the Lobby')));
    return panel;
  }

  const status = session.current() || {};
  panel.append(el('h3', {}, 'The table is open'));
  const players = (status.profiles || []).filter((p) => p.role === 'player');
  panel.append(el('p', { class: 'mono muted', style: 'font-size:12px' },
    players.length
      ? `${players.length} player${players.length === 1 ? '' : 's'}: `
        + players.map((p) => p.name).join(', ')
      : 'Nobody has joined yet.'));
  panel.append(el('p', { class: 'muted', style: 'font-size:13px' },
    'The code, the join link and the QR square are in the Lobby, with the '
    + 'queue of who has arrived.'));

  panel.append(el('div', { class: 'btnrow', style: 'margin-top:8px' },
    el('button', {
      class: 'act', onClick: () => go('lobby'),
    }, 'Open the Lobby'),
    el('button', {
      class: 'act ghost',
      onClick: async () => {
        if (!window.confirm('Close the table? Every player is disconnected '
          + 'and every join token stops working.')) return;
        await session.closeTable();
        toast('The table is closed', 'ok');
        await refreshChrome();
        ctx.redraw();
      },
    }, 'Close the table')));
  return panel;
}

/* ------------------------------------------------------------------ */

function quickPartyPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Quick party'));
  panel.append(el('h3', {}, 'Ready heroes, one tap'));
  panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
    'Forge complete level-1 heroes from the SRD - abilities, skills, kit '
    + 'and spells all set. They wait unclaimed at the join gate, so a phone '
    + 'that scanned the code picks a hero and plays. Nobody builds unless '
    + 'they want to.'));

  const count = el('input', {
    type: 'number', min: '1', max: String(RECIPES.length), value: '4',
    'aria-label': 'Party size', style: 'width:72px',
  });
  const forgeBtn = el('button', { class: 'act' }, 'Forge 4 ready heroes');
  count.addEventListener('input', () => {
    const n = Math.max(1, Math.min(RECIPES.length, Number(count.value) || 1));
    forgeBtn.textContent = `Forge ${n} ready heroes`;
  });
  forgeBtn.addEventListener('click', async () => {
    const n = Math.max(1, Math.min(RECIPES.length, Number(count.value) || 1));
    const { compendium } = getState();
    const heroes = forgeParty(n, {
      classes: compendium.classes,
      species: compendium.species,
      backgrounds: compendium.backgrounds,
      spells: compendium.spells,
      equipment: compendium.equipment,
    }, Date.now() >>> 0);
    // A stop mid-loop must never strand a half party silently - name the
    // count and the reason, because "I clicked Forge and got two heroes"
    // is a mystery nobody at a couch can debug.
    let landed = 0;
    try {
      for (const hero of heroes) {
        await db.put('characters', hero);
        landed += 1;
      }
    } catch (err) {
      toast(`Forged only ${landed} of ${heroes.length} - ${err.message}`, 'bad');
      setState({ characters: await db.list('characters') });
      ctx.redraw();
      return;
    }
    setState({ characters: await db.list('characters') });
    toast(`${heroes.length} heroes wait at the join gate`, 'ok');
    ctx.redraw();
  });

  panel.append(el('div', { class: 'btnrow', style: 'margin-top:8px' },
    count, forgeBtn));
  return panel;
}

/* ------------------------------------------------------------------ */

function forgePanel() {
  const forge = session.forgeOpen();
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'The forge'));
  panel.append(el('h3', {}, forge ? 'Open - session zero' : 'Closed - campaign running'));
  panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
    forge
      ? 'While the forge is open, players create and rebuild their own '
        + 'characters freely. Close it when the campaign starts: sheets seal, '
        + 'and levelling goes through your grants on the Stage.'
      : 'Sheets are sealed. Players play; identity changes and level-ups '
        + 'need you - grant them from the Stage, or reopen the forge for a '
        + 'rebuild session.'));
  panel.append(el('button', {
    class: `act${forge ? '' : ' ghost'}`,
    onClick: async () => {
      await session.setForge(!forge);
      toast(forge ? 'The forge is closed. The campaign is on.'
        : 'The forge is open - players may build.', 'ok');
      await refreshChrome();
      ctx.redraw();
    },
  }, forge ? 'Close the forge and start the campaign' : 'Reopen the forge'));
  return panel;
}

/* ------------------------------------------------------------------ */

async function workshopPanel() {
  const wrap = el('div', {});
  const head = el('div', { class: 'panel rivets' });
  head.append(el('span', { class: 'lvl' }, 'The workshop'));
  head.append(el('h3', {}, 'Homebrew, accepted before it reaches the table'));
  head.append(el('p', { class: 'muted', style: 'font-size:14px;margin:0' },
    'Ingest a homebrew page, PDF or file; measure it; accept what earns a '
    + 'place. Content you accept here is yours to use across every DM '
    + 'screen - players never see this bench, only what comes off it.'));
  wrap.append(head);

  // The whole homebrew workshop mounts beneath, owning its own child div.
  const bench = el('div', {});
  wrap.append(bench);
  const hb = await import('../../homebrew/homebrew-ui.js');
  await hb.render(bench);
  return wrap;
}
