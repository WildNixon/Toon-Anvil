/**
 * Settings: storage, and the optional connectors.
 *
 * The connector half of this screen exists mostly to be honest about what is
 * NOT connected. Every provider is listed whether or not it is configured,
 * with the exact variable name to set, so "why can't I generate a portrait"
 * has an answer on the screen rather than in a README.
 *
 * No key is ever typed here. The page cannot read one and cannot set one -
 * keys live in the environment or in a gitignored secrets.json that only the
 * local server reads. That is deliberate: a field on a web page is the easiest
 * place in the world to leak a credential from.
 */

import { el, esc, toast, getState } from '../../core/store.js';
import { getDataSource, setDataSource } from '../../core/db.js';
import {
  capabilities, forget, generateText, spendSummary,
  BEDS, playBed, stopBed, nowPlaying,
} from '../../core/providers.js';
import {
  catalogueSection, providerSection, spendSection,
} from './connectors-panel.js';
import { startSandbox, refreshChrome } from '../../app.js';
import * as session from '../../core/session.js';
import * as theme from '../../ui/theme.js';
import { VERSION } from '../../version.js';

export const title = 'Settings';

let container = null;
let caps = null;
let spendInfo = null;
let testing = null;

export async function render(root) {
  container = root;
  draw();
  caps = await capabilities({ refresh: true });
  draw();
  // Second, and separately: what has actually been spent. Slower and less
  // important than the catalogue, so it must not hold the screen up.
  spendInfo = await spendSummary();
  draw();
}

function draw() {
  container.innerHTML = '';
  container.append(storagePanel());
  container.append(appearancePanel());
  container.append(seatPanel());
  container.append(connectorPanel());
  container.append(ambiencePanel());
}

/* ------------------------------------------------------------------ */

function appearancePanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Appearance'));
  panel.append(el('h3', {}, 'Parchment or candlelight'));
  panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
    'Parchment is the daylight look; candlelight is for the evening session. '
    + 'System follows your device.'));

  const stored = theme.stored();
  const row = el('div', { class: 'btnrow' });
  for (const [value, label] of [
    [null, 'System'], ['light', 'Parchment'], ['dark', 'Candlelight'],
  ]) {
    const on = stored === value;
    row.append(el('button', {
      class: `act ${on ? '' : 'ghost'} small`,
      onClick: () => { theme.setTheme(value); draw(); },
    }, label));
  }
  panel.append(row);
  return panel;
}

/* ------------------------------------------------------------------ */

function storagePanel() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Storage'));
  panel.append(el('h3', {}, 'Where your work is kept'));
  // The one place the app says which version it is. Mirrored from /VERSION;
  // run.py --check and the gym refuse the mirrors drifting apart.
  panel.append(el('p', { class: 'mono muted', style: 'font-size:11px;margin:0 0 8px' },
    `Toon Anvil ${VERSION}`));

  const { dataSource, ephemeral } = getState();
  panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
    ephemeral
      ? 'This is a sandbox session. Nothing is being saved.'
      : `Currently: ${dataSource === 'server' ? 'the local server, so the '
        + 'installed app and the browser tab share one set of characters'
        : 'this browser only'}.`));

  const row = el('div', { class: 'btnrow' });
  for (const [value, label] of Object.entries({
    auto: 'Automatic', server: 'Shared (local server)', local: 'This browser only',
  })) {
    const on = getDataSource() === value;
    row.append(el('button', {
      class: `act ${on ? '' : 'ghost'} small`,
      onClick: () => {
        setDataSource(value);
        toast('Saved - reload for it to take effect', 'ok');
        draw();
      },
    }, label));
  }
  panel.append(row);

  if (!ephemeral) {
    panel.append(el('button', {
      class: 'act ghost', style: 'margin-top:10px', onClick: startSandbox,
    }, 'Open a sandbox session'));
  }
  return panel;
}

/* ------------------------------------------------------------------ */

function seatPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Seat'));
  panel.append(el('h3', {}, 'Player or Dungeon Master'));

  if (session.isOpen()) {
    // At a table, the table decides; a local switch would be a lie the
    // server ignores.
    panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
      'A table is open - your seat there decides. '
      + `You are ${session.isDm() ? 'the Dungeon Master' : 'a player'}.`));
    return panel;
  }

  const dm = session.isDm();
  panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
    `This device is ${dm ? "in the DM's seat: the whole app is the "
      + "captain's screens - Stage, Deck, World, Story, Setup"
      : "in a player's seat: the whole app is about playing"}. `
    + 'The plaque in the top bar switches it too. At a real table the '
    + 'server decides what you may change, whatever the menu shows.'));

  panel.append(el('button', {
    class: 'act' + (dm ? ' ghost' : ''),
    onClick: async () => {
      session.setLocalRole(dm ? 'player' : 'dm');
      toast(dm ? "Back to the player's seat" : "You have the DM's seat", 'ok');
      await refreshChrome();
      draw();
    },
  }, dm ? "Return to the player's seat" : "Take the DM's seat"));
  return panel;
}

/* ------------------------------------------------------------------ */

function connectorPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Connectors'));
  panel.append(el('h3', {}, 'Optional, and off by default'));
  panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
    'Toon Anvil works completely without any of these. They add writing, '
    + 'pictures and sound - nothing that changes a rule or a number.'));

  // The part people actually need to read.
  const note = el('div', { class: 'note' });
  note.append(el('p', { style: 'margin:0 0 6px' },
    el('strong', {}, 'Your keys, not ours.')));
  note.append(el('p', { style: 'margin:0;font-size:14px' },
    'No key ships with this project and none can be typed on this page - a '
    + 'field on a web page is the easiest place in the world to leak a '
    + 'credential from. Put yours in an environment variable, or in a file '
    + 'called secrets.json in the project folder, which is excluded from git. '
    + 'The browser never receives a key: it asks the local server, and the '
    + 'server makes the call.'));
  panel.append(note);

  if (!caps) {
    panel.append(el('p', { class: 'muted' }, 'Checking...'));
    return panel;
  }
  if (!caps.available) {
    panel.append(el('div', { class: 'empty' },
      caps.reason || 'The local server is not running, so connectors are '
      + 'unavailable. Everything else still works.'));
    return panel;
  }

  // The catalogue comes FIRST: what a key would buy is the question a
  // person has before they care which vendor sells it.
  for (const node of catalogueSection(caps)) panel.append(node);

  const onTest = async (id, p) => {
    testing = id; draw();
    const r = await generateText({
      provider: id, maxTokens: 60, capability: 'connector_test',
      prompt: 'In one sentence, describe a rain-soaked harbour town at '
        + 'dusk. Do not mention rules or dice.',
    });
    testing = null;
    spendInfo = await spendSummary();
    draw();
    toast(r.ok ? `${p.label}: ${r.text.slice(0, 110)}`
      : `${p.label} failed: ${r.reason}`, r.ok ? 'ok' : 'bad');
  };
  for (const node of providerSection(caps, { testing, onTest })) panel.append(node);
  for (const node of spendSection(spendInfo)) panel.append(node);

  panel.append(el('button', {
    class: 'act ghost', style: 'margin-top:12px',
    onClick: async () => {
      forget();
      caps = await capabilities({ refresh: true });
      spendInfo = await spendSummary();
      draw();
    },
  }, 'Check again'));

  if (!caps.anyConfigured) {
    panel.append(el('p', { class: 'muted', style: 'font-size:13px;margin-top:10px' },
      'Nothing is configured, which is a perfectly good place to stay. The '
      + 'cheapest thing to add is a local model: install Ollama, pull a model, '
      + 'and everything above marked "no cost" works with no key and no bill.'));
  }
  return panel;
}
/* ------------------------------------------------------------------ */

function ambiencePanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Ambience'));
  panel.append(el('h3', {}, 'Sound with no key and no network'));
  panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
    'Synthesised in the browser - not recordings, so there is nothing to '
    + 'licence and nothing to download. Works offline.'));

  const row = el('div', { class: 'btnrow' });
  const current = nowPlaying();
  for (const [id, bed] of Object.entries(BEDS)) {
    row.append(el('button', {
      class: `act ${current === id ? '' : 'ghost'} small`,
      onClick: () => {
        if (nowPlaying() === id) stopBed();
        else {
          const r = playBed(id);
          if (!r.ok) toast(r.reason, 'bad');
        }
        draw();
      },
    }, bed.label));
  }
  panel.append(row);
  if (current) {
    panel.append(el('button', {
      class: 'act', style: 'margin-top:10px',
      onClick: () => { stopBed(); draw(); },
    }, 'Stop'));
  }
  return panel;
}
