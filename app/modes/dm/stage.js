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
import { db } from '../../core/db.js';
import { go } from '../../app.js';
import * as session from '../../core/session.js';
import {
  runnerPanel, publish, state as fight, addMonsters, setTokenPosition,
} from './runner.js';
import { mapView } from '../../ui/map.js';
import { partyPanel } from './party.js';
import { diceRail } from '../../ui/components/dicerail.js';
import { doneStrip } from '../../ui/components/liveside.js';
import { BEDS, playBed, stopBed, nowPlaying } from '../../core/providers.js';
import { sheetPrompt } from '../../ui/kit.js';

let box = null;
let ctx = null;
let campaign = null;

export function render(root, context, activeCamp = null) {
  box = root;
  ctx = context;
  campaign = activeCamp;
  draw();
}

/**
 * A rail panel the DM can fold away. <details> rather than a button pair:
 * it is the accessible, keyboard-native disclosure, and it adds no new
 * button strings for the UI tests to trip over. Open by default - the
 * cockpit's job is to show everything at once.
 */
function fold(title, panel) {
  const wrap = el('details', { class: 'rail-fold', open: true });
  wrap.append(el('summary', {}, title));
  wrap.append(panel);
  return wrap;
}

function draw() {
  box.innerHTML = '';

  box.append(tableStrip());

  // Every mutation in the runner ends in a redraw, so publishing here covers
  // all of them without each button having to remember. publish() skips a
  // write that would change nothing, and does nothing at all with no table
  // open - a solo DM never touches the network.
  publish();

  // The cockpit: the fight holds the middle, everything a DM glances at
  // sits in one rail beside it. DOM ORDER IS LOAD-BEARING - the runner
  // comes first so the flows (and muscle memory) still find the damage
  // field as the first number input on the screen; the rail is placed to
  // the right by grid, not by document order.
  const cockpit = el('div', { class: 'cockpit' });
  const main = el('div', { class: 'cockpit-main' });
  const rail = el('div', { class: 'cockpit-rail' });

  main.append(runnerPanel({
    characters: getState().characters || [],
    sources: ctx.sources(), monsters: ctx.monsters, redraw: draw,
  }));

  if (campaign?.mapId && fight.combatants.length) {
    rail.append(fold('Board', boardPanel()));
  }
  rail.append(fold('The party',
    partyPanel(getState().characters || [], ctx.sources())));
  // The players' rolls, as they land - the DM sees the nat 20 without
  // anyone shouting the number across the couch. Only at a table: solo,
  // there is nobody else rolling.
  if (session.isOpen()) {
    rail.append(fold('Dice', diceRail(getState().characters || [])));
    // Who has called their turn. A player cannot advance the shared fight -
    // the server refuses that and it stays - so End turn is an event, and
    // this is the screen that makes it worth logging. Without it the button
    // would write to a file nobody opens.
    const done = doneStrip(fight.round || 0);
    if (done) rail.append(fold('Called their turn', done, true));
  }
  if (campaign) rail.append(fold('Prepared', preparedPanel()));
  rail.append(fold('Ambience', ambiencePanel()));

  cockpit.append(main, rail);
  box.append(cockpit);
}

/**
 * The ambush drawer. Templates live ON the campaign record - kinds are
 * read-open to seated players, so a separate "templates" kind would have
 * leaked the DM's prep by default; the campaign redactor strips this field
 * instead. Deploying re-rolls hit points through instantiate(), so the same
 * ambush is never the same fight twice.
 */
function preparedPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Prepared'));
  const templates = campaign.encounterTemplates || [];
  const monsterName = (id) => (ctx.monsters || [])
    .find((x) => x.id === id)?.name || id;

  if (!templates.length) {
    panel.append(el('p', { class: 'muted', style: 'font-size:13px;margin:0 0 8px' },
      'Nothing prepared yet. Build a fight below, then save it here for '
      + 'the moment the party opens the wrong door.'));
  }
  for (const t of templates) {
    const row = el('div', {
      style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;'
        + 'padding:4px 0;border-bottom:1px dotted var(--etch)',
    });
    row.append(el('strong', { style: 'min-width:120px' }, t.name));
    row.append(el('span', { class: 'muted', style: 'flex:1;font-size:12px' },
      (t.monsters || []).map((m) => `${m.count}× ${monsterName(m.monsterId)}`)
        .join(' · ')));
    row.append(el('button', {
      class: 'act small',
      onClick: () => {
        let landed = 0;
        for (const m of t.monsters || []) {
          const mon = (ctx.monsters || []).find((x) => x.id === m.monsterId);
          if (mon) { addMonsters(mon, m.count); landed += m.count; }
        }
        toast(landed
          ? `${t.name} deployed — fresh hit points rolled`
          : 'None of those monsters are in the bestiary any more', landed ? 'ok' : 'warn');
        draw();
      },
    }, 'Deploy'));
    row.append(el('button', {
      class: 'act ghost small',
      onClick: async () => {
        await saveTemplates(templates.filter((x) => x.id !== t.id));
      },
    }, '×'));
    panel.append(row);
  }

  panel.append(el('div', { class: 'btnrow', style: 'margin-top:8px' },
    el('button', {
      class: 'act ghost small',
      onClick: async () => {
        const inFight = fight.combatants
          .filter((c) => c.kind === 'monster' && c.monsterId);
        if (!inFight.length) {
          toast('No monsters in the fight to save', 'warn');
          return;
        }
        const name = await sheetPrompt({
          title: 'Save as prepared', label: 'Name this encounter',
        });
        if (name === null || !name.trim()) return;
        const groups = {};
        for (const c of inFight) {
          groups[c.monsterId] = (groups[c.monsterId] || 0) + 1;
        }
        const entry = {
          id: `tpl-${fight.combatants.length}-${(campaign.encounterTemplates || []).length + 1}`,
          name: name.trim().slice(0, 60),
          monsters: Object.entries(groups)
            .map(([monsterId, count]) => ({ monsterId, count })),
        };
        await saveTemplates([...(campaign.encounterTemplates || []), entry]);
        toast(`Prepared: ${entry.name}`, 'ok');
      },
    }, 'Save as prepared')));
  return panel;
}

async function saveTemplates(templates) {
  const fresh = { ...campaign, encounterTemplates: templates };
  await db.put('campaigns', fresh);
  campaign = fresh;
  draw();
}

/**
 * The battle board: the fight lands on the campaign map. Tokens are the
 * combatants; a drag persists ONE position write per drop and publishes,
 * so the players' Table shows the same board a beat later. Tokens without
 * a position sit on a bench row along the bottom until the DM places them.
 * Deliberately no grid, no fog, no measurement - tokens on a picture is
 * the couch sweet spot; a VTT is out of scope.
 */
function boardPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Board'));
  const host = el('div', {});
  panel.append(host);
  db.get('maps', campaign.mapId).then((rec) => {
    if (!rec) {
      host.append(el('p', { class: 'muted', style: 'font-size:13px' },
        'The campaign has no map on the Deck yet.'));
      return;
    }
    const tokens = fight.combatants.map((c, i) => ({
      id: c.id,
      label: c.name,
      x: Number.isFinite(c.x) ? c.x : 0.06 + (i % 10) * 0.09,
      y: Number.isFinite(c.y) ? c.y : 0.94,
      side: c.side,
      colour: c.kind === 'pc' ? session.colourOf(c.characterId) : null,
    }));
    mapView(host, {
      record: rec,
      editable: false,
      tokens,
      tokensEditable: true,
      onTokenMoved: (id, x, y) => {
        setTokenPosition(id, x, y);
        publish();
      },
    });
  });
  panel.append(el('p', { class: 'welcome-fine', style: 'margin-top:6px' },
    'Drag the circles. Unplaced fighters wait on the bench row at the '
    + 'bottom; players watch the same board on their Table.'));
  return panel;
}

/**
 * One tap per mood. The six synth beds shipped for a year with a single
 * call site buried in Settings; the moment of play is HERE. DM speakers
 * only - the room hears the rain, the phones stay silent.
 */
function ambiencePanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Ambience'));
  const row = el('div', { class: 'btnrow' });
  const current = nowPlaying();
  for (const [id, bed] of Object.entries(BEDS)) {
    row.append(el('button', {
      class: `act small${current === id ? '' : ' ghost'}`,
      'aria-pressed': String(current === id),
      onClick: () => {
        if (nowPlaying() === id) stopBed(); else playBed(id);
        draw();
      },
    }, bed.label));
  }
  row.append(el('button', {
    class: 'act small dark', onClick: () => { stopBed(); draw(); },
  }, 'Quiet'));
  panel.append(row);
  panel.append(el('p', { class: 'welcome-fine', style: 'margin-top:6px' },
    'Plays on this machine\'s speakers only.'));
  return panel;
}

/* ------------------------------------------------------------------ */

/** Total level from the raw record - the strip has no derive() context. */
const totalLevel = (ch) => Math.max(1, (ch?.classes || [])
  .reduce((n, c) => n + (Number(c.level) || 0), 0));

function tableStrip() {
  if (!session.isOpen()) {
    // Solo: one quiet line, not a panel shouting about something that does
    // not exist. The fight below is the point of this screen - unless there
    // is no campaign at all, in which case the most important thing a DM
    // can do is start one, and Stage is where they land first.
    const strip = el('div', { class: 'strip' });
    if (!campaign) {
      strip.append(el('span', { class: 'grow' },
        'No campaign on the Deck yet. Start one from a book on your shelf.'));
      strip.append(el('button', {
        class: 'act small', onClick: () => ctx.goToLens('deck'),
      }, 'Go to the Deck'));
      return strip;
    }
    strip.append(el('span', { class: 'grow' },
      'Prepping solo. When the players arrive, host from the Lobby.'));
    strip.append(el('button', {
      class: 'act ghost small', onClick: () => go('lobby'),
    }, 'Go to the Lobby'));
    return strip;
  }

  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'At the table'));

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
