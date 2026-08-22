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
import { db, dataFile } from '../../core/db.js';
import { go } from '../../app.js';
import * as session from '../../core/session.js';
import { weatherFor } from '../../core/weather.js';
import { currentRegion } from '../../core/campaign.js';
import {
  runnerPanel, publish, state as fight, addMonsters, setTokenPosition,
} from './runner.js';
import { mapView } from '../../ui/map.js';
import { partyPanel } from './party.js';
import { diceRail } from '../../ui/components/dicerail.js';
import { doneStrip } from '../../ui/components/liveside.js';
import { BEDS, playBed, stopBed, nowPlaying, bedForSky } from '../../core/providers.js';
import { soundButton } from '../../ui/soundtoggle.js';
import * as speak from '../../core/speak.js';

// dm-tables.json, for today's sky. Fetched once, lazily, and the screen
// redraws when it lands - the lobby's shelf listing does the same.
let dmTables = null;
let tablesFetching = false;
function ensureTables() {
  if (dmTables !== null || tablesFetching) return;
  tablesFetching = true;
  dataFile('dm-tables.json', null).then((t) => {
    tablesFetching = false;
    dmTables = t || false;
    if (box?.dataset.rendered === 'dm-stage' || box?.isConnected) draw();
  });
}
import { sheetPrompt } from '../../ui/kit.js';

let box = null;
let ctx = null;
let campaign = null;
let npcs = [];
let onCampaign = null;

export function render(root, context, activeCamp = null, extra = {}) {
  box = root;
  ctx = context;
  campaign = activeCamp;
  npcs = extra.npcs || [];
  onCampaign = extra.onCampaign || null;
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
  rail.append(fold('Voice', voicePanel()));

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
  // The DM's speaker first: effects for this machine, beds after it.
  row.append(soundButton());
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

  // Today's sky, as one offer. Never auto-played: the Deck computes the
  // weather, this names the bed that fits it, and the DM taps or does not.
  if (campaign) {
    if (dmTables === null) ensureTables();
    const sky = dmTables ? weatherFor(dmTables, {
      seed: campaign.seed, day: campaign.day, region: currentRegion(campaign),
    }) : null;
    const fit = bedForSky(sky);
    if (fit && nowPlaying() !== fit) {
      panel.append(el('div', { class: 'btnrow', style: 'margin-top:6px' },
        el('button', {
          class: 'act small ghost',
          title: sky?.summary || 'The bed that fits today in the Deck',
          onClick: () => { playBed(fit); draw(); },
        }, `${BEDS[fit].label} for today's sky`)));
    }
  }
  panel.append(el('p', { class: 'welcome-fine', style: 'margin-top:6px' },
    'Plays on this machine\'s speakers only.'));
  return panel;
}

/* ------------------------------------------------------------------ */
/* Voice - the DM speaks as an NPC or a monster, and saves it to them   */
/* ------------------------------------------------------------------ */

/** A saved-timbre ref back to a name the DM will recognise, real case
 *  and all - a combatant in the fight names it best, since the ref itself
 *  is lowercased for stable matching. */
function labelForRef(ref) {
  if (!ref) return ref;
  const inFight = (fight.combatants || []).find((c) => speak.refFor(c) === ref);
  if (inFight?.name) return inFight.name;
  if (ref.startsWith('monster:')) {
    const id = ref.slice(8);
    return (ctx.monsters || []).find((m) => m.id === id)?.name || id;
  }
  if (ref.startsWith('npc:')) {
    const id = ref.slice(4);
    return npcs.find((n) => n.id === id)?.name || id;
  }
  if (ref.startsWith('custom:')) return ref.slice(7);
  return ref;
}

/** The combatants in the current fight that CAN carry a voice, de-duped. */
function voiceableCombatants() {
  const seen = new Set();
  const out = [];
  for (const c of fight.combatants || []) {
    const ref = speak.refFor(c);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, name: c.name });
  }
  return out;
}

function voicePanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Voice'));
  const st = speak.status();

  // The gesture. One label, always - a lookup by text must stay stable -
  // and the state rides aria-pressed and a class. Release listeners live on
  // the document, because a player's roll redraws this whole rail and the
  // button can be swapped out from under the DM's finger mid-press.
  const status = el('p', { class: 'muted', style: 'font-size:13px;margin:6px 0' });
  const paintStatus = () => {
    const s = speak.status();
    status.textContent = s.reason
      || (s.latched ? 'Latched - tap to release'
        : s.speaking ? 'Speaking' : 'Press and hold to speak; double-tap to latch.');
  };
  const hold = el('button', {
    class: 'act speak-hold', type: 'button',
    'aria-label': 'Hold to speak', 'aria-pressed': String(st.speaking),
    style: 'width:100%;min-height:56px',
  }, 'Hold to speak');
  const onUp = async () => {
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    speak.release();
    hold.setAttribute('aria-pressed', String(speak.status().speaking));
    hold.classList.toggle('latched', speak.status().latched);
    paintStatus();
  };
  hold.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    await speak.press();
    hold.setAttribute('aria-pressed', String(speak.status().speaking));
    hold.classList.toggle('latched', speak.status().latched);
    paintStatus();
  });
  if (st.latched) hold.classList.add('latched');
  panel.append(hold);
  paintStatus();
  panel.append(status);

  // Speak as: follow the turn, then the presets, then every saved voice -
  // from the campaign AND this machine's fallback, so a voice saved with no
  // campaign open still appears.
  const saved = speak.savedTimbres(campaign);
  const speakAs = el('select', { 'aria-label': 'Speak as' });
  speakAs.append(el('option', { value: 'follow' }, 'Follow the turn'));
  for (const [id, p] of Object.entries(speak.PRESETS)) {
    speakAs.append(el('option', { value: `preset:${id}` }, p.label));
  }
  for (const ref of Object.keys(saved)) {
    speakAs.append(el('option', { value: `ref:${ref}` }, `${labelForRef(ref)} (saved)`));
  }
  speakAs.value = st.choice && (st.choice === 'follow'
    || [...speakAs.options].some((o) => o.value === st.choice)) ? st.choice : 'follow';

  const settingsFor = (choiceKey) => {
    if (choiceKey === 'follow') {
      const active = (fight.combatants || [])[fight.turn || 0];
      const ref = speak.refFor(active);
      return speak.timbreFor(ref, campaign) || speak.PRESETS.plain.settings;
    }
    if (choiceKey.startsWith('preset:')) {
      return speak.PRESETS[choiceKey.slice(7)]?.settings || speak.PRESETS.plain.settings;
    }
    if (choiceKey.startsWith('ref:')) {
      return speak.timbreFor(choiceKey.slice(4), campaign) || speak.PRESETS.plain.settings;
    }
    return speak.PRESETS.plain.settings;
  };

  const pitch = el('input', {
    type: 'range', min: '-12', max: '12', step: '1',
    'aria-label': 'Pitch', style: 'width:100%',
  });
  const cur = speak.normalize(st.settings);
  pitch.value = String(cur.pitch);
  pitch.title = `${cur.pitch} semitones`;

  speakAs.addEventListener('change', () => {
    const s = speak.normalize(settingsFor(speakAs.value));
    speak.choose(speakAs.value, s);
    pitch.value = String(s.pitch);
    pitch.title = `${s.pitch} semitones`;
  });
  pitch.addEventListener('input', () => {
    const s = speak.normalize({ ...speak.status().settings, pitch: Number(pitch.value) });
    speak.choose(speak.status().choice, s);
    pitch.title = `${s.pitch} semitones`;
  });
  panel.append(el('label', { class: 'field', style: 'font-size:12px' }, 'Speak as'));
  panel.append(speakAs);
  panel.append(el('label', { class: 'field', style: 'font-size:12px;margin-top:6px' }, 'Pitch'));
  panel.append(pitch);

  // Save to: the fight's monsters and customs, then the campaign's NPCs.
  const targets = voiceableCombatants();
  for (const n of npcs) targets.push({ ref: `npc:${n.id}`, name: n.name });
  if (targets.length) {
    const saveTo = el('select', { 'aria-label': 'Save to' });
    saveTo.append(el('option', { value: '' }, 'Save this voice to...'));
    const seen = new Set();
    for (const t of targets) {
      if (seen.has(t.ref)) continue;
      seen.add(t.ref);
      saveTo.append(el('option', { value: t.ref }, t.name));
    }
    if (st.choice?.startsWith('ref:')) {
      saveTo.append(el('option', { value: `forget:${st.choice.slice(4)}` }, 'Forget this voice'));
    }
    saveTo.addEventListener('change', () => {
      const v = saveTo.value;
      if (!v) return;
      if (v.startsWith('forget:')) {
        const r = speak.forgetTimbre(v.slice(7), campaign);
        if (r.campaign && onCampaign) onCampaign(r.campaign);
        else { toast('Voice forgotten', 'ok'); draw(); }
        return;
      }
      const r = speak.saveTimbre(v, speak.status().settings, campaign);
      toast(`${labelForRef(v)} speaks like this now`, 'ok');
      if (r.campaign && onCampaign) onCampaign(r.campaign);
      else draw();
    });
    panel.append(el('label', { class: 'field', style: 'font-size:12px;margin-top:6px' }, 'Save to'));
    panel.append(saveTo);
  }

  if (st.mic === 'open') {
    panel.append(el('div', { class: 'btnrow', style: 'margin-top:8px' },
      el('button', {
        class: 'act ghost small',
        onClick: () => { speak.releaseMic(); draw(); },
      }, 'Release the mic')));
  }

  panel.append(el('p', { class: 'welcome-fine', style: 'margin-top:6px' },
    'Plays on this machine\'s speakers only - wear headphones or use an '
    + 'external speaker, or the microphone hears itself. Nothing you say '
    + 'leaves this machine.'));
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
