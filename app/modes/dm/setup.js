/**
 * SETUP - before the campaign, and the levers that frame it.
 *
 * The table itself (open it, read the code aloud, close it), the forge
 * (whether players can build), and the homebrew workshop - which lives here
 * because homebrew is added and accepted by the DM before the start, and
 * stays a DM-only tool after.
 *
 * The join code renders only for the trusted seat - the machine running the
 * server, or whoever holds the DM token: the server itself withholds it from
 * everyone else, so this screen cannot leak what it was never given.
 */

import { el, toast, getState, setState } from '../../core/store.js';
import { db } from '../../core/db.js';
import * as session from '../../core/session.js';
import { refreshChrome } from '../../app.js';
import { qrSvg } from '../../ui/qr.js';
import { forgeParty, RECIPES } from '../../core/pregen.js';

let box = null;
let ctx = null;
let opening = false;

export async function render(root, context) {
  box = root;
  ctx = context;
  box.innerHTML = '';
  box.append(tablePanel());
  if (session.isOpen()) {
    box.append(quickPartyPanel());
    box.append(forgePanel());
  }
  box.append(await workshopPanel());
}

/* ------------------------------------------------------------------ */

function tablePanel() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'The table'));

  if (!session.isOpen()) {
    panel.append(el('h3', {}, 'No table open'));
    panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
      'Open a table and players on this network join with a short code. '
      + 'A join code keeps a stranger from wandering in by accident - it is '
      + 'not authentication, so use this on a network you trust.'));
    const name = el('input', {
      type: 'text', value: 'DM', 'aria-label': 'Your name at the table',
      style: 'max-width:220px',
    });
    const row = el('div', { class: 'btnrow', style: 'margin-top:8px' });
    row.append(name);
    row.append(el('button', {
      class: 'act',
      onClick: async () => {
        if (opening) return;
        opening = true;
        const out = await session.openTable(name.value.trim() || 'DM');
        opening = false;
        if (out.status === 403 || out.error) {
          toast(out.error || 'The server said no', 'bad');
        } else {
          toast('The table is open', 'ok');
          await refreshChrome();
        }
        ctx.redraw();
      },
    }, 'Open the table'));
    panel.append(row);
    return panel;
  }

  const status = session.current() || {};
  panel.append(el('h3', {}, 'The table is open'));
  if (status.code) {
    panel.append(el('p', { class: 'muted', style: 'font-size:13px;margin:0 0 4px' },
      'Read this aloud. Players open this address and type it in:'));
    panel.append(el('div', {
      class: 'mono',
      style: 'font-size:clamp(26px,6vw,40px);font-weight:700;letter-spacing:.12em;'
        + 'color:var(--accent-text);margin:4px 0 10px',
    }, status.code));

    // The server reports where it is actually reachable, computed from the
    // socket it bound - port drift and all. The link carries the CODE, which
    // is shoutable by design; the join TOKEN never rides in a URL.
    const lanAddr = (status.addresses || [])
      .find((a) => !a.includes('127.0.0.1'));
    if (status.lanHint && lanAddr) {
      const joinUrl = `${lanAddr}/?code=${status.code}`;
      panel.append(el('p', { class: 'muted', style: 'font-size:13px;margin:8px 0 2px' },
        'Or hand them this link - a phone camera reads the square:'));
      const urlBox = el('input', {
        type: 'text', readonly: true, value: joinUrl, class: 'mono',
        'aria-label': 'Join link',
        style: 'width:100%;max-width:420px;font-size:13px;margin:2px 0 6px',
        onFocus: (e) => e.target.select(),
      });
      panel.append(urlBox);
      if (navigator.clipboard && window.isSecureContext) {
        // Clipboard API needs a secure context (localhost qualifies; plain
        // http over the LAN does not) - elsewhere the selectable box above
        // IS the copy story.
        panel.append(el('div', { class: 'btnrow' }, el('button', {
          class: 'act ghost small',
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(joinUrl);
              toast('Link copied', 'ok');
            } catch { urlBox.focus(); }
          },
        }, 'Copy link')));
      }
      panel.append(el('div', {
        class: 'qr', html: qrSvg(joinUrl),
        style: 'width:min(46vw,190px);margin:10px 0 2px;line-height:0',
      }));
    } else if (status.lanHint === false) {
      panel.append(el('p', { class: 'muted', style: 'font-size:12px' },
        'Only this machine can reach the table right now. Restart with '
        + 'python run.py --lan to invite phones.'));
    }
  } else {
    panel.append(el('p', { class: 'muted', style: 'font-size:13px' },
      "The code shows only to the DM's seat."));
  }

  const players = (status.profiles || []).filter((p) => p.role === 'player');
  panel.append(el('p', { class: 'mono muted', style: 'font-size:12px' },
    players.length
      ? `${players.length} player${players.length === 1 ? '' : 's'}: `
        + players.map((p) => p.name).join(', ')
      : 'Nobody has joined yet.'));

  panel.append(el('div', { class: 'btnrow', style: 'margin-top:8px' },
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
