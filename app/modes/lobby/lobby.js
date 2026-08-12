/**
 * The lobby - where a session starts, and where everyone waits together.
 *
 * Before this, hosting a game was buried: DM shell, Setup lens, scroll past
 * the workshop, open the table, then read a code off a panel while five
 * people ask whether it worked. And a player who had joined had nowhere to
 * BE - they were dropped straight onto a character sheet with no sense that
 * anyone else was there.
 *
 * So this is one screen with three faces, chosen by what is actually true:
 *
 *   nobody hosting   -> host a game, or play on your own
 *   hosting, waiting -> the queue: who is here, what they picked, who is ready
 *   started          -> the session is underway; go to your screen
 *
 * The queue is the point. A lobby you can see other people in is the
 * difference between "did it work?" shouted across a room and a screen that
 * simply shows Kim arriving.
 *
 * Nothing here can write another seat's data. Everything a player does is
 * their own join and their own claim, and the DM's controls are the ones the
 * server already gates on a DM token.
 */

import { getState, el, toast } from '../../core/store.js';
import { db } from '../../core/db.js';
import * as session from '../../core/session.js';
import * as live from '../../core/live.js';
import { qrSvg } from '../../ui/qr.js';
import { go, refreshChrome, selectCharacter } from '../../app.js';

export const title = 'Lobby';

let container = null;
let unsubscribe = null;
let busy = false;
// Held across redraws so a half-typed name survives a player arriving.
const draft = { host: 'DM', join: '', code: '', colour: null };

export async function render(root) {
  container = root;
  await session.refresh().catch(() => {});
  draw();

  if (unsubscribe) unsubscribe();
  // The whole screen is other people arriving, so it redraws on the table
  // and on characters - a claim changes a row without changing the table.
  unsubscribe = live.subscribe(['table', 'characters'], async () => {
    if (container?.dataset.rendered !== 'lobby') {
      unsubscribe?.(); unsubscribe = null; return;
    }
    const wasStarted = session.started();
    await session.refresh().catch(() => {});
    await refreshChrome().catch(() => {});

    // The DM said go. Leave the queue on our own rather than waiting to be
    // told - that is the whole point of everyone sitting in one room.
    //
    // Deliberately ONLY from this screen. Yanking somebody out of Build
    // mid-edit because a flag flipped elsewhere would be the same feature
    // behaving like a bug.
    if (!wasStarted && session.started()) {
      toast('The session has started', 'ok');
      return go(session.isDm() ? 'dm-stage' : 'play');
    }
    draw();
  });
}

function draw() {
  if (!container) return;
  container.innerHTML = '';
  const open = session.isOpen();
  const status = session.current() || {};

  if (!open) return drawHost();
  if (session.needsJoin()) return drawJoin();
  return drawQueue(status);
}

/* ------------------------------------------------------------------ */
/* 1. nobody is hosting                                                */
/* ------------------------------------------------------------------ */

function drawHost() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Start a session'));
  panel.append(el('h3', {}, 'Nobody is hosting yet'));
  panel.append(el('p', { class: 'muted', style: 'font-size:14px;max-width:60ch' },
    'Open a table and everyone on this network joins with a short code. '
    + 'They pick a character, you see them arrive, and you start when the '
    + 'room is ready.'));

  const name = el('input', {
    type: 'text', value: draft.host, 'aria-label': 'Your name at the table',
    style: 'max-width:220px',
    onInput: (e) => { draft.host = e.target.value; },
  });
  const row = el('div', { class: 'btnrow', style: 'margin-top:10px' });
  row.append(name);
  row.append(el('button', {
    class: 'act',
    onClick: async () => {
      if (busy) return;
      busy = true;
      let out;
      // finally, not a trailing assignment: anything that throws between
      // here and there would leave busy set and every later press dead.
      try { out = await session.openTable(draft.host.trim() || 'DM'); }
      finally { busy = false; }
      if (out?.error || out?.status === 403) {
        // The server only lets the machine it runs on open a table - a
        // player who could open one could rotate the code and lock the DM out.
        toast(out.error || 'Only the machine running the server can host', 'bad');
        return;
      }
      await session.setLocalRole('dm');
      await refreshChrome().catch(() => {});
      toast('The table is open', 'ok');
      draw();
    },
  }, 'Host a game'));
  panel.append(row);
  container.append(panel);

  const solo = el('div', { class: 'panel rivets' });
  solo.append(el('span', { class: 'lvl' }, 'On your own'));
  solo.append(el('p', { class: 'muted', style: 'font-size:14px;max-width:60ch' },
    'No table, no code, nothing to join. Everything works solo - this is '
    + 'the commonest way the app gets used and it stays one tap away.'));
  const soloRow = el('div', { class: 'btnrow' });
  soloRow.append(el('button', {
    class: 'act ghost',
    onClick: async () => { await session.setLocalRole('player'); go('play'); },
  }, 'Play on my own'));
  soloRow.append(el('button', {
    class: 'act ghost',
    onClick: async () => { await session.setLocalRole('dm'); go('dm-stage'); },
  }, 'Prep as the DM'));
  solo.append(soloRow);
  container.append(solo);
}

/* ------------------------------------------------------------------ */
/* 2. a table is open and this browser has no seat                     */
/* ------------------------------------------------------------------ */

function drawJoin() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Join'));
  panel.append(el('h3', {}, 'A table is open'));
  panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
    'Type the code the DM read out.'));

  const code = el('input', {
    type: 'text', value: draft.code, 'aria-label': 'Join code',
    placeholder: 'ANVIL-XXXX', class: 'mono',
    style: 'max-width:200px;text-transform:uppercase',
    onInput: (e) => { draft.code = e.target.value; },
  });
  const who = el('input', {
    type: 'text', value: draft.join, 'aria-label': 'Your name',
    placeholder: 'Your name', style: 'max-width:200px',
    onInput: (e) => { draft.join = e.target.value; },
  });
  const row = el('div', { class: 'btnrow', style: 'margin-top:10px' });
  row.append(code, who);
  row.append(el('button', {
    class: 'act',
    onClick: async () => {
      if (busy) return;
      const c = draft.code.trim().toUpperCase();
      const n = draft.join.trim();
      if (!c || !n) return toast('Both the code and a name are needed', 'warn');
      busy = true;
      let out;
      try { out = await session.join({ code: c, name: n }); }
      finally { busy = false; }
      if (!out?.ok) return toast(out?.error || 'That code was not accepted', 'bad');
      await refreshChrome().catch(() => {});
      toast('You are at the table', 'ok');
      draw();
    },
  }, 'Join the table'));
  panel.append(row);
  container.append(panel);
}

/* ------------------------------------------------------------------ */
/* 3. seated: the queue                                                */
/* ------------------------------------------------------------------ */

function drawQueue(status) {
  const isDm = session.isDm();
  const started = Boolean(status.started);

  if (started) container.append(startedBanner(isDm));
  if (isDm) container.append(hostCard(status));
  container.append(rosterCard(status, isDm));
  if (!isDm) container.append(pickCard(status));
  if (isDm) container.append(dmControls(status, started));
}

function startedBanner(isDm) {
  const box = el('div', { class: 'panel accent rivets', role: 'status' });
  box.append(el('span', { class: 'lvl accent' }, 'Underway'));
  box.append(el('h3', {}, 'The session has started'));
  box.append(el('div', { class: 'btnrow' }, el('button', {
    class: 'act',
    onClick: () => go(isDm ? 'dm-stage' : 'play'),
  }, isDm ? 'Go to the Stage' : 'Go to my character')));
  return box;
}

/** The code, the link, and the square a phone camera reads. */
function hostCard(status) {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'How they get in'));
  if (status.code) {
    panel.append(el('div', {
      class: 'mono',
      style: 'font-size:clamp(26px,6vw,40px);font-weight:700;'
        + 'letter-spacing:.12em;color:var(--accent-text);margin:2px 0 8px',
    }, status.code));
  }
  // The server reports where it actually bound, port drift and all. The
  // link carries the CODE, which is shoutable by design; the join token
  // never rides in a URL.
  const lan = (status.addresses || []).find((a) => !a.includes('127.0.0.1'));
  if (status.lanHint && lan && status.code) {
    const url = `${lan}/?code=${status.code}`;
    panel.append(el('p', { class: 'muted', style: 'font-size:13px;margin:6px 0 2px' },
      'Phones on this network open this:'));
    panel.append(el('input', {
      type: 'text', readonly: true, value: url, class: 'mono',
      'aria-label': 'Join link',
      style: 'width:100%;max-width:420px;font-size:13px;margin:2px 0 6px',
      onFocus: (e) => e.target.select(),
    }));
    panel.append(el('div', {
      class: 'qr', html: qrSvg(url),
      style: 'width:min(46vw,180px);margin:8px 0 2px;line-height:0',
    }));
  } else if (status.lanHint === false) {
    panel.append(el('p', { class: 'muted', style: 'font-size:13px' },
      'This server is bound to this machine only, so phones cannot reach '
      + 'it yet. Restart with "python run.py --lan" to let them in.'));
  }
  return panel;
}

/** Who is here, what they have picked, and who is still deciding. */
function rosterCard(status, isDm) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'In the lobby'));
  const players = (status.profiles || []).filter((p) => p.role === 'player');
  const chars = getState().characters || [];
  const nameOf = (id) => chars.find((c) => c.id === id)?.name || id;

  panel.append(el('h3', {}, players.length
    ? `${players.length} ${players.length === 1 ? 'player' : 'players'}`
    : 'Waiting for the first player'));

  if (!players.length) {
    panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
      isDm ? 'Read the code out. They appear here as they arrive.'
        : 'Nobody else yet.'));
    return panel;
  }

  const list = el('div', { style: 'margin-top:6px' });
  for (const p of players) {
    const ready = (p.characterIds || []).length > 0;
    const row = el('div', {
      class: 'strip',
      style: `border-left:3px solid ${p.colour || 'var(--etch)'};padding-left:8px`,
    });
    row.append(el('span', { class: 'grow' }, p.name));
    if (ready) {
      row.append(el('span', { class: 'chip ok' },
        (p.characterIds || []).map(nameOf).join(', ')));
    } else {
      // Not a failure - somebody is reading a character sheet. Saying
      // "picking someone" rather than "not ready" matters when it is on
      // a screen the whole room can see.
      row.append(el('span', { class: 'chip' }, 'picking someone'));
    }
    list.append(row);
  }
  panel.append(list);
  return panel;
}

/** A player's own business: which character am I? */
function pickCard(status) {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Your character'));
  const me = session.me() || {};
  const mine = me.characterIds || [];
  const chars = getState().characters || [];

  if (mine.length) {
    const c = chars.find((x) => x.id === mine[0]);
    panel.append(el('h3', {}, c ? c.name : 'Claimed'));
    panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
      'You are ready. The DM starts when the room is.'));
    panel.append(el('div', { class: 'btnrow' }, el('button', {
      class: 'act ghost',
      onClick: async () => { await selectCharacter(mine[0]); go('play'); },
    }, 'Look at my sheet')));
    return panel;
  }

  // Unclaimed only. A character somebody else has taken is not on offer,
  // and the server would refuse the claim anyway - this just avoids
  // offering a button whose whole job is to fail.
  const taken = new Set((status.profiles || [])
    .flatMap((p) => p.characterIds || []));
  const free = chars.filter((c) => !taken.has(c.id));

  if (free.length) {
    panel.append(el('h3', {}, 'Pick someone'));
    const row = el('div', { class: 'btnrow', style: 'margin-top:6px' });
    for (const c of free.slice(0, 12)) {
      row.append(el('button', {
        class: 'act small',
        onClick: async () => {
          if (busy) return;
          busy = true;
          let out;
          try { out = await session.claim(c.id); }
          finally { busy = false; }
          if (!out?.ok) return toast(out?.error || 'Somebody got there first', 'bad');
          await selectCharacter(c.id);
          await refreshChrome().catch(() => {});
          draw();
        },
      }, c.name));
    }
    panel.append(row);
  } else {
    panel.append(el('h3', {}, 'No characters waiting'));
  }

  if (session.forgeOpen()) {
    panel.append(el('p', { class: 'muted', style: 'font-size:13px;margin-top:10px' },
      'The forge is open, so you can make your own instead.'));
    panel.append(el('div', { class: 'btnrow' }, el('button', {
      class: 'act ghost', onClick: () => go('build'),
    }, 'Build a character')));
  } else if (!free.length) {
    panel.append(el('p', { class: 'muted', style: 'font-size:13px' },
      'The forge is shut, so ask the DM to open it or to hand you one.'));
  }
  return panel;
}

function dmControls(status, started) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Your call'));
  const row = el('div', { class: 'btnrow' });

  row.append(el('button', {
    class: 'act ghost',
    onClick: async () => {
      await session.setForge(!session.forgeOpen());
      await refreshChrome().catch(() => {});
      draw();
    },
  }, session.forgeOpen() ? 'Close the forge' : 'Open the forge'));

  row.append(el('button', {
    class: started ? 'act ghost' : 'act',
    onClick: async () => {
      if (busy) return;
      busy = true;
      let out;
      try { out = await session.setStarted(!started); }
      finally { busy = false; }
      if (!out?.ok) return toast(out?.error || 'The server said no', 'bad');
      await session.refresh().catch(() => {});
      // Every other seat is watching the same flag and leaves the queue on
      // its own - nobody has to be told to navigate.
      toast(started ? 'Back to the lobby' : 'Session started', 'ok');
      draw();
      if (!started) go('dm-stage');
    },
  }, started ? 'Back to the lobby' : 'Start the session'));

  row.append(el('button', {
    class: 'act ghost',
    onClick: async () => {
      await session.closeTable();
      await refreshChrome().catch(() => {});
      toast('The table is closed', 'ok');
      draw();
    },
  }, 'Close the table'));

  panel.append(row);
  panel.append(el('p', { class: 'muted', style: 'font-size:13px;margin-top:8px' },
    'Starting takes every seat out of the lobby at once. The forge decides '
    + 'whether players can build their own.'));
  return panel;
}
