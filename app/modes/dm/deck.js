/**
 * DECK - the campaign as a control panel.
 *
 * The captain's instruments, top to bottom: the dials (day, sky, where the
 * party stands, the forge, the table), then the levers. Advance the day and
 * every player's Party screen dates itself; the sky is computed, never
 * stored, so every client derives the same weather from the campaign's seed.
 *
 * This commit: campaign + calendar + weather + regions. The map, the
 * factions and the economy dock here next.
 */

import { getState, el, toast } from '../../core/store.js';
import * as session from '../../core/session.js';
import * as live from '../../core/live.js';
import { log } from '../../core/events.js';
import {
  listCampaigns, activeCampaign, saveCampaign, setActive,
  newRegion, newFaction, currentRegion,
  newClock, tickClock, advanceDayClocks,
} from '../../core/campaign.js';
import {
  campaignStartBlock as foundingBlock, deckBooks, cleanTitle,
} from './founding.js';
import { query } from '../../core/events.js';
import { lineChart, barChart } from '../../ui/chart.js';
import { weatherFor, forecastFor } from '../../core/weather.js';
import { statTile, dial } from '../../ui/kit.js';
import { mapView, PIN_KINDS } from '../../ui/map.js';
import { db } from '../../core/db.js';
import { detect, parse } from '../../homebrew/adapters.js';
import {
  uploadPdf, listShelf, getSections, refileBook, verdictLine,
  CATEGORIES as SHELF_CATEGORIES, CATEGORY_LABELS,
} from '../../core/shelf.js';
import { dmData } from './shared.js';
import * as sfx from '../../core/sfx.js';
import { show as showMoment, strikeMoment } from '../../ui/moments.js';

export const title = 'Deck';

let container = null;
let unsubscribe = null;
let tables = null;
let campaign = null;
let all = [];
let mapRecord = null;
let mapHandle = null;
// Setting-ingest review state: sections awaiting the DM's filing.
let ingest = null;   // { source, sections: [{ title, body, filedAs }] }
// GET /api/shelf result; null means "fetch on next draw". The Deck reads it
// lazily so an offline solo Deck still renders everything else.
let shelfListing = null;
let shelfFetching = false;
// Book slug stashed by the workshop's "Open in the Deck" bridge - read once,
// used to highlight (never auto-open) the matching row.
let highlightSlug = null;

/** One in-flight shelf fetch, however many panels ask in a single draw. */
function ensureShelfListing() {
  if (shelfListing !== null || shelfFetching) return;
  shelfFetching = true;
  listShelf().then((r) => {
    shelfFetching = false;
    shelfListing = r;
    if (container?.dataset.rendered === 'dm-deck') draw();
  });
}

export async function render(root) {
  container = root;
  ({ tables } = await dmData());
  // Entering the mode re-reads the shelf: it is server state another surface
  // (the workshop drop, the CLI) may have grown since the Deck last looked.
  shelfListing = null;
  try {
    highlightSlug = sessionStorage.getItem('toonanvil.deckOpenBook');
    sessionStorage.removeItem('toonanvil.deckOpenBook');
  } catch { highlightSlug = null; }
  await refresh();
  draw();

  if (unsubscribe) unsubscribe();
  unsubscribe = live.subscribe(['campaigns', 'maps', 'table'], async () => {
    if (container.dataset.rendered !== 'dm-deck') {
      unsubscribe?.(); unsubscribe = null; return;
    }
    await refresh();
    draw();
  });
}

async function refresh() {
  all = await listCampaigns();
  campaign = await activeCampaign();
  mapRecord = campaign?.mapId
    ? await db.get('maps', campaign.mapId).catch(() => null)
    : null;
}

function draw() {
  container.innerHTML = '';
  if (!campaign) {
    container.append(newCampaignPanel());
    return;
  }
  container.append(dialsPanel());
  // A review in progress is THE current work - it jumps to the top rather
  // than living six panels down where nobody found it. A fresh book-founded
  // campaign that has not been ingested yet gets a one-line nudge instead.
  if (ingest) container.append(ingestPanel());
  else if (campaign.sourceSlug && !(campaign.regions || []).length) {
    container.append(bookNudge());
  }
  container.append(clocksPanel());
  container.append(mapPanel());
  const columns = el('div', { class: 'grid two' });
  columns.append(factionsPanel());
  columns.append(economyPanel());
  container.append(columns);
  container.append(regionsPanel());
  if (!ingest) container.append(ingestPanel());
  container.append(campaignPanel());
}

/* ------------------------------------------------------------------ */
/* clocks                                                              */
/* ------------------------------------------------------------------ */

/**
 * Pressure that fills. Segments are BUTTONS, not a dial() - dial() owns
 * the "X"/"X value" aria contract the tests hold, and a clock is a row of
 * discrete taps rather than a slider.
 */
function clocksPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Clocks'));
  panel.append(el('h3', {}, 'Pressure'));
  const clocks = campaign.clocks || [];

  if (!clocks.length) {
    panel.append(el('p', { class: 'muted', style: 'font-size:13px;margin:0 0 8px' },
      'No clocks yet. A clock is a promise with a countdown: the ritual '
      + 'completes, the siege lands, the debt comes due.'));
  }

  const save = async (next, extra = null) => {
    campaign.clocks = next;
    await saveCampaign(campaign);
    if (extra) await extra();
    draw();
  };

  for (const c of clocks) {
    const row = el('div', {
      class: 'clock-row',
      dataset: { id: c.id },
    });
    row.append(el('span', { class: 'clock-label' }, c.label));

    const segs = el('div', {
      class: 'clock-segs', role: 'group',
      'aria-label': `${c.label} — ${c.filled} of ${c.size} filled`,
    });
    for (let i = 0; i < c.size; i += 1) {
      segs.append(el('button', {
        class: `clock-seg${i < c.filled ? ' on' : ''}`,
        'aria-label': `${c.label} segment ${i + 1}`,
        onClick: () => {
          // Tapping the last filled segment empties back to it; tapping
          // any other fills up to it. A clock is dragged forwards more
          // often than back, and this is one tap for either.
          const want = (i + 1 === c.filled) ? i : i + 1;
          sfx.play('clock-tick');
          const strikes = want >= c.size && c.filled < c.size;
          save(clocks.map((x) => (x.id === c.id
            ? tickClock(x, want - x.filled) : x)),
          strikes
            // The id, not the label. The event log is read by every seat,
            // and "the ritual completes" is the whole spoiler - the server
            // redacts it now, but a secret should not be written into a
            // shared log and then removed on the way out. Same rule as
            // safeRollPayload: allow-list at the source. The MOMENT names
            // the clock, because it is drawn on this screen and nowhere else.
            ? () => {
              showMoment(strikeMoment(c.label));
              sfx.play('clock-strike');
              return log('clock_advanced', {
                clockId: c.id, public: !!c.public,
                filled: want, size: c.size, struck: true,
              }, { campaignId: campaign.id });
            }
            : null);
        },
      }));
    }
    row.append(segs);

    row.append(el('span', { class: 'mono muted', style: 'font-size:11px' },
      `${c.filled}/${c.size}`));
    row.append(el('button', {
      class: `act small${c.public ? '' : ' ghost'}`,
      title: c.public ? 'The players can see this one'
        : 'Hidden: the server strips it from what players receive',
      onClick: () => save(clocks.map((x) => (x.id === c.id
        ? { ...x, public: !x.public } : x))),
    }, c.public ? 'shown' : 'secret'));
    row.append(el('button', {
      class: `act small${c.advanceOnDay ? '' : ' ghost'}`,
      title: 'Fill one segment every time the day advances',
      onClick: () => save(clocks.map((x) => (x.id === c.id
        ? { ...x, advanceOnDay: !x.advanceOnDay } : x))),
    }, c.advanceOnDay ? 'ticks daily' : 'manual'));
    row.append(el('button', {
      class: 'act ghost small',
      'aria-label': `Remove ${c.label}`,
      onClick: () => save(clocks.filter((x) => x.id !== c.id)),
    }, '×'));
    panel.append(row);
  }

  const add = el('div', { class: 'btnrow', style: 'margin-top:8px' });
  const label = el('input', {
    type: 'text', placeholder: 'The ritual completes',
    'aria-label': 'Clock name', style: 'max-width:220px',
  });
  add.append(label);
  add.append(el('button', {
    class: 'act',
    onClick: () => {
      const name = label.value.trim();
      if (!name) return;
      save([...clocks, newClock(name)]);
    },
  }, 'Start a clock'));
  panel.append(add);
  return panel;
}

function bookNudge() {
  const strip = el('div', { class: 'strip' });
  strip.append(el('span', { class: 'grow' },
    `The book is on the shelf — ingest ${cleanTitle(campaign.sourceName)} `
    + 'to lay out regions and factions.'));
  strip.append(el('button', {
    class: 'act small',
    onClick: () => ingestFromShelf(campaign.sourceSlug, campaign.sourceName),
  }, 'Open the book'));
  return strip;
}

/* ------------------------------------------------------------------ */
/* dials                                                               */
/* ------------------------------------------------------------------ */

function dialsPanel() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, campaign.name));

  const region = currentRegion(campaign);
  const sky = region
    ? weatherFor(tables, { seed: campaign.seed, day: campaign.day, region })
    : null;
  const status = session.current() || {};
  const players = (status.profiles || []).filter((p) => p.role === 'player');

  const dials = el('div', { class: 'grid stats', style: 'margin-bottom:12px' });
  dials.append(statTile('Day', campaign.day, 'of the campaign'));
  dials.append(statTile('The sky', sky ? sky.summary : '—',
    region ? region.name : 'add a region below'));
  dials.append(statTile('The party', region ? region.name : '—',
    region ? region.terrain : 'no region yet'));
  dials.append(statTile('Forge', session.isOpen()
    ? (session.forgeOpen() ? 'open' : 'shut') : '—',
  session.isOpen() ? 'toggle in Setup or Stage' : 'no table'));
  dials.append(statTile('Table', session.isOpen()
    ? `${players.length} joined` : 'solo',
  session.isOpen() ? 'open' : 'open one in Setup'));
  if (campaign.sourceSlug) {
    // Last tile on purpose: the frozen flow regexes read the first 'Day'
    // and the first 'The sky' in text order, and those live above.
    dials.append(statTile('The book', cleanTitle(campaign.sourceName),
      'ingest it again any time',
      () => ingestFromShelf(campaign.sourceSlug, campaign.sourceName)));
  }
  panel.append(dials);

  if (sky?.event) {
    panel.append(el('p', {
      class: 'mono', style: 'font-size:12px;color:var(--accent-text);margin:0 0 10px',
    }, `Today: ${sky.event}`));
  }

  // The week ahead, computed - never stored. Deterministic weather means
  // seven pure calls; players could derive the same week from the public
  // seed, which is the point. Tiles never say 'The sky' and sit below the
  // stats grid, so the flow regexes that read the first match stay true.
  if (region) {
    panel.append(el('div', { class: 'eyebrow', style: 'margin:2px 0 4px' },
      'The week ahead'));
    const week = el('div', {
      style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px',
    });
    forecastFor(tables, {
      seed: campaign.seed, day: campaign.day, region,
    }, 7).forEach((f, i) => {
      if (!f) return;
      week.append(el('span', {
        class: 'mono muted',
        style: 'font-size:11px;padding:3px 8px;border:1px solid var(--etch);'
          + 'border-radius:3px' + (f.event ? ';color:var(--accent-text)' : ''),
        ...(f.event ? { title: f.event } : {}),
      }, `${i === 0 ? 'Today' : `Day ${f.day}`} — ${f.summary}${f.event ? ' !' : ''}`));
    });
    panel.append(week);
  }

  const row = el('div', { class: 'btnrow' });
  row.append(el('button', {
    class: 'act',
    title: 'End the day. Tomorrow has its own sky.',
    onClick: async () => {
      campaign.day += 1;
      // The day carries the clocks with it: pressure that only moves when
      // somebody remembers is not pressure.
      const ticked = advanceDayClocks(campaign.clocks || []);
      campaign.clocks = ticked.clocks;
      await saveCampaign(campaign);
      await log('day_advanced', { day: campaign.day },
        { campaignId: campaign.id });
      for (const struck of ticked.struck) {
        // One moment per clock that struck - advanceDayClocks already
        // hands back only the ones that crossed to full THIS tick.
        showMoment(strikeMoment(struck.label));
        // eslint-disable-next-line no-await-in-loop
        await log('clock_advanced', {
          clockId: struck.id, public: !!struck.public,
          filled: struck.filled, size: struck.size,
          struck: true, day: campaign.day,
        }, { campaignId: campaign.id });
      }
      if (ticked.struck.length) sfx.play('clock-strike');
      toast(ticked.struck.length
        ? `Day ${campaign.day}: ${ticked.struck.map((s) => s.label).join(', ')}`
        : `Day ${campaign.day} dawns`, ticked.struck.length ? 'warn' : 'ok');
      draw();
    },
  }, 'Advance the day'));
  // The manual hand on the calendar: type a day, go there. Deterministic
  // weather makes any day recomputable, so jumping is honest time travel.
  // (An input's value never appears in textContent - the flow that reads
  // the number after 'Day' cannot see this control.)
  const jump = el('input', {
    type: 'number', min: '1', step: '1', placeholder: 'day...',
    'aria-label': 'Jump to day', style: 'max-width:90px',
  });
  row.append(jump);
  row.append(el('button', {
    class: 'act ghost',
    title: 'Set the calendar to that day outright',
    onClick: async () => {
      const d = Math.max(1, Math.floor(Number(jump.value)));
      if (!Number.isFinite(d) || !jump.value || d === campaign.day) return;
      campaign.day = d;
      await saveCampaign(campaign);
      await log('day_advanced', { day: d, jumped: true },
        { campaignId: campaign.id });
      toast(`Day ${d} dawns`, 'ok');
      draw();
    },
  }, 'Go to that day'));
  panel.append(row);
  return panel;
}

/* ------------------------------------------------------------------ */
/* the map                                                             */
/* ------------------------------------------------------------------ */

async function saveMap() {
  if (mapRecord) await db.put('maps', mapRecord);
}

function mapPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'The map'));

  if (!mapRecord) {
    panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
      "Drop the setting's map - the one from the book, or exported from any "
      + 'map tool. Pan, zoom, pin the places and the party; reveal pins to '
      + 'the players one by one.'));

    const file = el('input', {
      type: 'file', accept: 'image/*', 'aria-label': 'Map image file',
      style: 'max-width:280px',
    });
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) {
        toast('That image is over 8 MB - export it smaller', 'bad');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => adoptImage(String(reader.result), f.name);
      reader.readAsDataURL(f);
    });
    panel.append(file);

    // The paste fallback: also what an automated test can drive, since
    // nothing can populate a file input.
    const url = el('input', {
      type: 'text', placeholder: 'or paste an image / data: URL...',
      'aria-label': 'Map image URL', style: 'max-width:280px;margin-top:8px',
    });
    const row = el('div', { class: 'btnrow', style: 'margin-top:8px' });
    row.append(url);
    row.append(el('button', {
      class: 'act ghost small',
      onClick: () => {
        const v = url.value.trim();
        if (!v) return toast('Paste an image URL first', 'warn');
        adoptImage(v, campaign.name);
        return null;
      },
    }, 'Use this image'));
    panel.append(row);
    return panel;
  }

  const bar = el('div', { class: 'btnrow', style: 'margin-bottom:8px' });
  for (const kind of PIN_KINDS) {
    bar.append(el('button', {
      class: 'act ghost small',
      title: `Then click the map to place the ${kind} pin`,
      onClick: () => {
        mapHandle?.armPlacement(kind);
        toast(`Click the map to place the ${kind}`, 'ok');
      },
    }, `+ ${kind}`));
  }
  bar.append(el('button', {
    class: 'act ghost small',
    onClick: async () => {
      if (!window.confirm('Remove the map and every pin on it?')) return;
      await db.del('maps', mapRecord.id).catch(() => null);
      campaign.mapId = null;
      await saveCampaign(campaign);
      mapRecord = null;
      draw();
    },
  }, 'Remove map'));
  panel.append(bar);

  const host = el('div', {});
  panel.append(host);
  mapHandle = mapView(host, {
    record: mapRecord,
    editable: true,
    regions: campaign.regions,
    onChange: () => saveMap(),
    onPartyMoved: async (regionId) => {
      if (campaign.currentRegionId === regionId) return;
      const region = campaign.regions.find((r) => r.id === regionId);
      campaign.currentRegionId = regionId;
      await saveCampaign(campaign);
      await log('region_moved',
        { regionId, regionName: region?.name, day: campaign.day },
        { campaignId: campaign.id });
      toast(`The party crossed into ${region?.name || 'a new region'}`, 'ok');
      draw();
    },
  });
  // The map at a glance, without opening a single pin.
  const pins = mapRecord.pins || [];
  panel.append(el('p', { class: 'mono muted', style: 'font-size:11px;margin:6px 0 0' },
    `${pins.length} pin${pins.length === 1 ? '' : 's'} · `
    + `${pins.filter((p) => !p.revealed).length} hidden from players · `
    + `party in ${currentRegion(campaign)?.name || 'no region'}`));
  panel.append(el('p', { class: 'welcome-fine', style: 'margin-top:6px' },
    'Wheel to zoom, drag to pan. Dim pins are hidden from players; the '
    + 'server never sends them what you have not revealed. Drop the party '
    + 'flag near a regioned pin and the party moves there.'));
  return panel;
}

async function adoptImage(src, name) {
  const probe = new Image();
  probe.onload = async () => {
    mapRecord = {
      id: `map-${campaign.id}`,
      name: name || campaign.name,
      image: src,
      w: probe.naturalWidth, h: probe.naturalHeight,
      pins: [],
    };
    await db.put('maps', mapRecord);
    campaign.mapId = mapRecord.id;
    await saveCampaign(campaign);
    toast('The map is on the table', 'ok');
    draw();
  };
  probe.onerror = () => toast('That does not load as an image', 'bad');
  probe.src = src;
}

/* ------------------------------------------------------------------ */
/* factions - the political dial                                       */
/* ------------------------------------------------------------------ */

function factionsPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Factions'));

  if (!campaign.factions.length) {
    panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
      'Who holds power, and how they feel about the party. Standings are '
      + 'public when you mark them so; agendas never leave this machine '
      + 'for a player.'));
  }

  for (const f of campaign.factions) {
    const row = el('div', {
      style: 'padding:8px 0;border-bottom:1px solid var(--etch)',
    });
    const top = el('div', {
      style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap',
    });
    top.append(el('span', {
      style: `width:10px;height:10px;border-radius:50%;background:${f.colour};`
        + 'display:inline-block;flex:none',
    }));
    top.append(el('strong', { style: 'flex:1;min-width:100px' }, f.name));
    // One labelled control, slider for the hand and a number for precision;
    // commits once per settled change, so one logged shift per drag.
    top.append(dial({
      label: 'Standing', value: f.standing, min: -10, max: 10, step: 1,
      ariaLabel: `${f.name} standing`,
      onCommit: async (v) => {
        f.standing = v;
        await saveCampaign(campaign);
        // The id carries the standing; the NAME does not travel. A faction
        // the DM has not made public is absent from redact_campaign
        // entirely, so writing its name here published the one thing that
        // redaction exists to hide - that it exists at all.
        await log('faction_standing',
          { factionId: f.id, public: !!f.public, value: f.standing,
            day: campaign.day },
          { campaignId: campaign.id });
        draw();
      },
    }));

    top.append(el('button', {
      class: `act ${f.public ? '' : 'ghost'} small`,
      title: 'Whether players see this faction and its standing at all',
      onClick: async () => {
        f.public = !f.public;
        await saveCampaign(campaign);
        draw();
      },
    }, f.public ? 'Public' : 'Unknown'));
    top.append(el('button', {
      class: 'act ghost small',
      onClick: async () => {
        campaign.factions = campaign.factions.filter((x) => x.id !== f.id);
        await saveCampaign(campaign);
        draw();
      },
    }, 'x'));
    row.append(top);

    const agenda = el('textarea', {
      placeholder: 'Their agenda - what they are actually doing...',
      'aria-label': `${f.name} agenda`,
      style: 'min-height:44px;font-size:13px;margin-top:6px',
    });
    agenda.value = f.agenda || '';
    agenda.addEventListener('change', async () => {
      f.agenda = agenda.value;
      await saveCampaign(campaign);
    });
    row.append(agenda);
    row.append(el('div', { class: 'welcome-fine' },
      'SECRET - the server never sends agendas to a player.'));
    panel.append(row);
  }

  const name = el('input', {
    type: 'text', placeholder: 'New faction name...',
    'aria-label': 'New faction name', style: 'max-width:200px',
  });
  const add = el('div', { class: 'btnrow', style: 'margin-top:10px' });
  add.append(name);
  add.append(el('button', {
    class: 'act ghost small',
    onClick: async () => {
      const n = name.value.trim();
      if (!n) return toast('Name the faction first', 'warn');
      campaign.factions.push(newFaction(n, campaign.factions.length));
      await saveCampaign(campaign);
      name.value = '';
      draw();
      return null;
    },
  }, 'Add faction'));
  panel.append(add);

  if (campaign.factions.length) {
    panel.append(el('div', { class: 'eyebrow', style: 'margin:12px 0 4px' },
      'Standing over the days'));
    const canvas = el('canvas', { 'aria-label': 'Faction standings over time' });
    panel.append(canvas);
    // A chart with unnamed lines is decoration. The legend chips carry the
    // same colours the series draw with - each faction's own.
    const legend = el('div', {
      class: 'chart-legend',
      style: 'display:flex;gap:12px;flex-wrap:wrap;font-size:11px;margin-top:4px',
    });
    for (const f of campaign.factions) {
      const item = el('span', {
        style: 'display:inline-flex;align-items:center;gap:5px',
      });
      item.append(el('span', {
        style: `width:10px;height:10px;border-radius:2px;background:${f.colour}`,
      }));
      item.append(el('span', { class: 'muted' }, f.name));
      legend.append(item);
    }
    panel.append(legend);
    drawStandingsChart(canvas);
  }
  return panel;
}

async function drawStandingsChart(canvas) {
  const events = await query({ campaignId: campaign.id, type: 'faction_standing' });
  const byFaction = new Map();
  for (const ev of events) {
    const id = ev.payload?.factionId;
    if (!id) continue;
    if (!byFaction.has(id)) byFaction.set(id, []);
    byFaction.get(id).push({ x: ev.payload.day ?? 0, y: ev.payload.value ?? 0 });
  }
  const series = [];
  for (const f of campaign.factions) {
    const points = byFaction.get(f.id) || [];
    // Today's reading is always on the chart, logged or not.
    points.push({ x: campaign.day, y: f.standing });
    series.push({ label: f.name, colour: f.colour, points });
  }
  if (series.length) {
    lineChart(canvas, { series, yMin: -10, yMax: 10, refY: 0 });
  }
}

/* ------------------------------------------------------------------ */
/* economy - the price dials                                           */
/* ------------------------------------------------------------------ */

function economyPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Economy'));

  if (!campaign.regions.length) {
    panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
      'Each region has a price dial. Where the party stands is what their '
      + 'Market charges - turn it and their open screens re-price.'));
    return panel;
  }

  for (const region of campaign.regions) {
    const row = el('div', {
      style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;'
        + 'padding:7px 0;border-bottom:1px solid var(--etch)',
    });
    row.append(el('strong', { style: 'flex:1;min-width:100px' }, region.name));
    // ASCII 'x' here on purpose; the Market's strip uses the real multiply
    // sign and the gym asserts each separately.
    row.append(dial({
      label: 'Prices', value: region.priceMod || 1, min: 0.5, max: 2,
      step: 0.05, prefix: 'x', ariaLabel: `${region.name} price dial`,
      onCommit: async (v) => {
        region.priceMod = v;
        await saveCampaign(campaign);
        await log('price_changed',
          { regionId: region.id, name: region.name, value: v, day: campaign.day },
          { campaignId: campaign.id });
        draw();
      },
    }));
    if (campaign.currentRegionId === region.id) {
      row.append(el('span', { class: 'chip accent' }, 'the party pays this'));
    }
    panel.append(row);
  }

  panel.append(el('div', { class: 'eyebrow', style: 'margin:12px 0 4px' },
    'Coin spent, by day'));
  const canvas = el('canvas', { 'aria-label': 'Party spending over time' });
  panel.append(canvas);
  drawSpendChart(canvas);

  panel.append(el('p', { class: 'welcome-fine', style: 'margin-top:6px' },
    'The dial cuts both ways - cheap regions buy cheap AND sell cheap. '
    + 'Hauling goods between your dials is caravan gameplay, not a bug.'));
  return panel;
}

async function drawSpendChart(canvas) {
  // Scoped to THIS campaign: purchases are day-stamped and campaign-tagged
  // at the shop's log site now. Old unstamped events carry no campaignId
  // and rightly drop out - they belong to no world.
  const events = await query({ type: 'purchase', campaignId: campaign.id });
  const byDay = new Map();
  for (const ev of events) {
    const day = ev.payload?.day ?? 0;
    byDay.set(day, (byDay.get(day) || 0) + (Number(ev.payload?.priceCp) || 0));
  }
  const bars = [...byDay.entries()].sort((a, b) => a[0] - b[0])
    .map(([day, cp]) => ({ label: `d${day}`, value: Math.round(cp / 100),
      colour: '--gold' }));
  if (!bars.length) bars.push({ label: `d${campaign.day}`, value: 0, colour: '--gold' });
  barChart(canvas, { bars });
}

/* ------------------------------------------------------------------ */
/* regions                                                             */
/* ------------------------------------------------------------------ */

function regionsPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Regions'));

  if (!campaign.regions.length) {
    panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
      'A region is a place with its own sky and its own prices. Add the '
      + 'first one and the dials wake up.'));
  }

  const terrains = Object.keys(tables?.terrain || {})
    .filter((k) => !k.startsWith('_'));

  for (const region of campaign.regions) {
    const row = el('div', {
      style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;'
        + 'padding:7px 0;border-bottom:1px solid var(--etch)',
    });
    const here = campaign.currentRegionId === region.id;
    row.append(el('button', {
      class: `act ${here ? '' : 'ghost'} small`,
      title: here ? 'The party is here' : 'Move the party here',
      onClick: async () => {
        if (here) return;
        campaign.currentRegionId = region.id;
        await saveCampaign(campaign);
        await log('region_moved',
          { regionId: region.id, regionName: region.name, day: campaign.day },
          { campaignId: campaign.id });
        toast(`The party crossed into ${region.name}`, 'ok');
        draw();
      },
    }, here ? 'Party is here' : 'Move party here'));
    row.append(el('strong', { style: 'min-width:120px' }, region.name));

    const terr = el('select', {
      'aria-label': `Terrain of ${region.name}`, style: 'width:auto',
    });
    for (const k of terrains) {
      terr.append(el('option', { value: k, selected: k === region.terrain }, k));
    }
    terr.addEventListener('change', async () => {
      region.terrain = terr.value;
      await saveCampaign(campaign);
      draw();
    });
    row.append(terr);

    const sky = weatherFor(tables,
      { seed: campaign.seed, day: campaign.day, region });
    row.append(el('span', { class: 'mono muted', style: 'font-size:11px;flex:1' },
      sky ? sky.summary : ''));
    panel.append(row);
  }

  // Add row: a name field is fine here (no gym flow greps this screen's
  // inputs positionally).
  const name = el('input', {
    type: 'text', placeholder: 'New region name...',
    'aria-label': 'New region name', style: 'max-width:220px',
  });
  const add = el('div', { class: 'btnrow', style: 'margin-top:10px' });
  add.append(name);
  add.append(el('button', {
    class: 'act ghost small',
    onClick: async () => {
      const n = name.value.trim();
      if (!n) return toast('Name the region first', 'warn');
      campaign.regions.push(newRegion(n));
      if (!campaign.currentRegionId) {
        campaign.currentRegionId = campaign.regions[0].id;
      }
      await saveCampaign(campaign);
      name.value = '';
      draw();
      return null;
    },
  }, 'Add region'));
  panel.append(add);
  return panel;
}

/* ------------------------------------------------------------------ */
/* setting ingest - split, then file it                                */
/* ------------------------------------------------------------------ */

function ingestPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Ingest a setting'));

  if (!ingest) {
    panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
      'Drop a setting document (.md, .txt - or a whole .pdf book) or paste '
      + 'its text. A PDF is filed on the shelf and split server-side; text '
      + 'splits into sections by heading. Either way you file each section - '
      + 'as a region, a faction, an NPC, or campaign lore - with one click. '
      + 'Nothing is guessed on your behalf; you know your setting, the '
      + 'parser does not.'));

    const file = el('input', {
      type: 'file', accept: '.md,.markdown,.txt,.pdf',
      'aria-label': 'Setting document', style: 'max-width:280px',
    });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      if (/\.pdf$/i.test(f.name)) ingestPdf(f);
      else splitText(await f.text(), f.name);
    });
    panel.append(file);

    const paste = el('textarea', {
      placeholder: 'or paste the setting text here...',
      'aria-label': 'Setting text', style: 'min-height:70px;margin-top:8px',
    });
    const row = el('div', { class: 'btnrow', style: 'margin-top:8px' });
    row.append(el('button', {
      class: 'act ghost small',
      onClick: () => {
        const v = paste.value.trim();
        if (!v) return toast('Paste some setting text first', 'warn');
        splitText(v, 'pasted text');
        return null;
      },
    }, 'Split the text'));
    panel.append(paste, row);
    panel.append(shelfBlock());
    return panel;
  }

  panel.append(el('p', { class: 'muted', style: 'font-size:13px;margin:0 0 8px' },
    `${ingest.sections.length} sections from ${ingest.source}. File what `
    + 'earns a place; skip the rest.'));

  // A whole book can be a thousand sections; the panel shows the first 200
  // and says so, rather than quietly hanging the tab on DOM weight.
  const shown = ingest.sections.slice(0, 200);
  if (shown.length < ingest.sections.length) {
    panel.append(el('p', { class: 'muted', style: 'font-size:12px;margin:0 0 8px' },
      `Showing the first ${shown.length} of ${ingest.sections.length}.`));
  }

  for (const s of shown) {
    const row = el('div', {
      style: 'padding:8px 0;border-bottom:1px solid var(--etch)',
    });
    const head = el('div', {
      style: 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap',
    });
    head.append(el('strong', { style: 'flex:1;min-width:140px' }, s.title));
    if (s.filedAs) {
      head.append(el('span', { class: 'chip ok' }, `filed as ${s.filedAs}`));
    } else {
      for (const [kind, act] of [
        ['region', fileAsRegion], ['faction', fileAsFaction],
        ['npc', fileAsNpc], ['lore', fileAsLore],
      ]) {
        head.append(el('button', {
          class: 'act ghost small',
          onClick: async () => { await act(s); s.filedAs = kind; draw(); },
        }, kind));
      }
    }
    row.append(head);
    row.append(el('p', {
      class: 'muted', style: 'font-size:12px;margin:4px 0 0',
    }, s.body.slice(0, 180) + (s.body.length > 180 ? '…' : '')));
    panel.append(row);
  }

  panel.append(el('div', { class: 'btnrow', style: 'margin-top:10px' },
    el('button', {
      class: 'act ghost small',
      onClick: () => { ingest = null; draw(); },
    }, 'Done - clear the bench')));
  return panel;
}

/* ---- the shelf: books already filed, one click from the review rows ---- */

async function ingestPdf(f) {
  toast(`Reading ${f.name} - a big book takes a minute or two...`, 'ok');
  const res = await uploadPdf(f);
  if (res.status !== 200) { toast(verdictLine(res), 'bad'); return; }
  toast(verdictLine(res), 'ok');
  shelfListing = null;
  await ingestFromShelf(res.slug, res.name || f.name);
}

async function ingestFromShelf(slug, name) {
  const got = await getSections(slug);
  const rows = (got.sections || [])
    .filter((s) => s.title && s.body)
    .map((s) => ({ title: s.title, body: s.body, filedAs: null }));
  if (!rows.length) {
    toast('No prose sections came out of that book', 'warn');
    return;
  }
  ingest = { source: name, sections: rows };
  draw();
}

function shelfBlock() {
  const box = el('div', { style: 'margin-top:16px' });
  box.append(el('span', { class: 'eyebrow' }, 'On the shelf'));

  if (!shelfListing) {
    ensureShelfListing();
    box.append(el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 0' },
      'Looking at the shelf...'));
    return box;
  }

  const cats = shelfListing.categories || {};
  const books = SHELF_CATEGORIES.flatMap((c) => cats[c] || []);
  if (shelfListing.status !== 200 || !books.length) {
    box.append(el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 0' },
      shelfListing.status !== 200
        ? 'The shelf needs serve.py running.'
        : 'Empty. Drop a .pdf book above and it files itself.'));
    return box;
  }

  for (const b of books) {
    const row = el('div', {
      style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;'
        + 'padding:6px 0;border-bottom:1px solid var(--etch)',
    });
    row.append(el('span', { style: 'flex:1;min-width:160px;font-size:13px' },
      b.name || b.slug));
    // What the book actually YIELDED - the DM's honest per-book report.
    // A bestiary that reads "3 monsters" is telling you the extraction
    // struggled, and that is worth knowing before session prep relies on it.
    const w = b.written || {};
    const n = (k, one, many) => (w[k]
      ? `${w[k]} ${w[k] === 1 ? one : many}` : '');
    const got = [n('monster', 'monster', 'monsters'),
      n('spell', 'spell', 'spells'), n('magic_item', 'item', 'items'),
      n('subclasses', 'subclass', 'subclasses'),
      n('species', 'species', 'species'), n('feat', 'feat', 'feats')]
      .filter(Boolean).join(' · ');
    row.append(el('span', { class: 'muted', style: 'font-size:12px' },
      got || (b.extractedOk ? 'prose only - no records' : '')));
    // Settings and adventures are Deck material; the rest live in the
    // workshop. The select is the one-click rescue for a wrong guess.
    if (b.category === 'settings' || b.category === 'adventures') {
      row.append(el('button', {
        class: 'act ghost small',
        onClick: () => ingestFromShelf(b.slug, b.name),
      }, 'Ingest'));
    } else {
      row.append(el('span', { class: 'muted', style: 'font-size:12px' },
        'in the workshop (Setup)'));
    }
    const sel = el('select', {
      'aria-label': `Category for ${b.name}`, style: 'width:auto',
    });
    for (const c of SHELF_CATEGORIES) {
      sel.append(el('option', { value: c, selected: c === b.category },
        CATEGORY_LABELS[c]));
    }
    sel.addEventListener('change', async () => {
      const out = await refileBook(b.hash, sel.value);
      if (out.status !== 200) {
        toast(out.error || 'Could not refile that', 'bad');
      } else {
        toast(`${b.name} refiled under ${CATEGORY_LABELS[sel.value]}`, 'ok');
      }
      shelfListing = null;
      draw();
    });
    row.append(sel);
    box.append(row);
  }
  return box;
}

/** Reuse the homebrew section splitter: brew.features IS heading+body. */
function splitText(text, filename) {
  try {
    const brew = parse(detect(filename, text), text, { filename });
    const sections = (brew.features || [])
      .filter((f) => f.name && f.text)
      .map((f) => ({ title: f.name, body: f.text, filedAs: null }));
    if (brew.flavor?.lede) {
      sections.unshift({ title: brew.name || 'Preamble',
        body: brew.flavor.lede, filedAs: null });
    }
    if (!sections.length) {
      toast('No headed sections found - is there any # or Title-cased structure?', 'warn');
      return;
    }
    ingest = { source: filename, sections };
    draw();
  } catch (err) {
    toast(`Could not split that: ${err.message}`, 'bad');
  }
}

// Ingested text lands where the DM points it. Bodies are clipped - a
// campaign record is an instrument panel, not an archive; the source
// document remains the archive.
async function fileAsRegion(s) {
  const region = newRegion(s.title, guessTerrain(s.body));
  region.note = s.body.slice(0, 500);
  campaign.regions.push(region);
  if (!campaign.currentRegionId) campaign.currentRegionId = region.id;
  await saveCampaign(campaign);
  await logFiled(s, 'region');
  toast(`${s.title} is a region`, 'ok');
}

async function fileAsFaction(s) {
  const f = newFaction(s.title, campaign.factions.length);
  // The ingested text becomes the SECRET agenda, private by default.
  f.agenda = s.body.slice(0, 500);
  campaign.factions.push(f);
  await saveCampaign(campaign);
  await logFiled(s, 'faction');
  toast(`${s.title} is a faction (agenda private)`, 'ok');
}

async function fileAsNpc(s) {
  await db.put('npcs', {
    id: `npc-${s.title.toLowerCase().replace(/\W+/g, '-').slice(0, 30)}`,
    name: s.title, where: '', want: '', disposition: 0,
    firstMet: new Date().toISOString(),
    notes: [s.body.slice(0, 500)],
  });
  await logFiled(s, 'npc');
  toast(`${s.title} is an NPC`, 'ok');
}

async function fileAsLore(s) {
  campaign.lore = campaign.lore || [];
  campaign.lore.push({ title: s.title, text: s.body, source: 'ingest' });
  await saveCampaign(campaign);
  await logFiled(s, 'lore');
  toast(`${s.title} kept as lore`, 'ok');
}

/** The Story feed sees the setup happen - quiet rows, but on the record. */
function logFiled(s, as) {
  return log('section_filed', { title: s.title, as, source: ingest?.source },
    { campaignId: campaign.id });
}

/** A light keyword nudge for the terrain select - a default, not a verdict. */
function guessTerrain(text) {
  const t = text.toLowerCase();
  const hints = [
    ['mountain', /mountain|peak|ridge|cliff|highland/],
    ['coast', /coast|harbou?r|port|shore|bay|island/],
    ['swamp', /swamp|marsh|bog|mire|fen/],
    ['desert', /desert|dune|sand|waste/],
    ['arctic', /ice|frozen|tundra|glacier|snow/],
    ['urban', /city|town|street|market|district/],
    ['underdark', /cave|cavern|underground|deep|tunnel/],
    ['grave', /grave|tomb|crypt|barrow|dead/],
  ];
  for (const [terrain, re] of hints) if (re.test(t)) return terrain;
  return 'forest';
}

/* ------------------------------------------------------------------ */
/* the campaign itself                                                 */
/* ------------------------------------------------------------------ */

function campaignPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Campaign'));

  for (const c of all) {
    const row = el('div', {
      style: 'display:flex;gap:10px;align-items:center;padding:5px 0',
    });
    row.append(el('strong', { style: 'flex:1' }, c.name));
    row.append(el('span', { class: 'mono muted', style: 'font-size:11px' },
      `day ${c.day} · seed ${c.seed}`
      + (c.sourceName ? ` · from ${c.sourceName}` : '')));
    if (c.active) row.append(el('span', { class: 'chip accent' }, 'active'));
    else {
      row.append(el('button', {
        class: 'act ghost small',
        onClick: async () => { await setActive(c.id); await refresh(); draw(); },
      }, 'Make active'));
    }
    panel.append(row);
  }

  panel.append(campaignStartBlock());
  panel.append(el('p', { class: 'welcome-fine', style: 'margin-top:10px' },
    'The seed is public and predicts nothing but the sky - players compute '
    + 'the same weather you do. Agendas are the secrets, and those never '
    + 'leave this machine for a player.'));
  return panel;
}

function newCampaignPanel() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'The Deck'));
  panel.append(el('h3', {}, 'Start a campaign'));
  panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
    'A campaign is the world the Deck drives: its calendar, its skies, its '
    + 'regions and prices, its factions. Begin from a book on your shelf - '
    + 'its sections open for filing the moment the campaign exists - or '
    + 'start blank and take the wheel.'));
  panel.append(campaignStartBlock({ hero: true }));
  return panel;
}

/**
 * A campaign is born in founding.js now, shared with the Lobby - this
 * wrapper just wires the Deck's own state and its after-founding move in.
 * `hero: true` (the empty Deck) leads with a full row per shelf book; the
 * compact form (campaign panel) offers a picker instead.
 */
function campaignStartBlock({ hero = false } = {}) {
  return foundingBlock({
    hero,
    books: deckBooks(shelfListing).filter((b) => b.extractedOk),
    shelfPending: shelfListing === null,
    all,
    highlightSlug,
    onHighlight: () => { highlightSlug = null; },
    onNeedShelf: ensureShelfListing,
    onFound: async (c, { book }) => {
      await refresh();
      if (book) {
        // Straight into the review rows: founding from a book IS the
        // setup flow - here. The Lobby deliberately does not do this.
        await ingestFromShelf(book.slug, book.name);
        if (!ingest) draw();
      } else {
        draw();
      }
    },
  });
}
