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
  capabilities, forget, generateText, BEDS, playBed, stopBed, nowPlaying,
} from '../../core/providers.js';
import { startSandbox } from '../../app.js';

export const title = 'Settings';

let container = null;
let caps = null;
let testing = null;

export async function render(root) {
  container = root;
  draw();
  caps = await capabilities({ refresh: true });
  draw();
}

function draw() {
  container.innerHTML = '';
  container.append(storagePanel());
  container.append(connectorPanel());
  container.append(ambiencePanel());
}

/* ------------------------------------------------------------------ */

function storagePanel() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Storage'));
  panel.append(el('h3', {}, 'Where your work is kept'));

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

const KIND_LABEL = { llm: 'Writing', image: 'Pictures', sfx: 'Sound' };

function connectorPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Connectors'));
  panel.append(el('h3', {}, 'Optional, and off by default'));
  panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
    'Toon Anvil works completely without any of these. They add a writing '
    + 'assistant for improvisation, portraits, and sound - nothing that '
    + 'changes a rule or a number.'));

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

  const providers = Object.entries(caps.providers || {});
  const byKind = {};
  for (const [id, p] of providers) (byKind[p.kind] ||= []).push([id, p]);

  for (const [kind, list] of Object.entries(byKind)) {
    panel.append(el('h3', { style: 'margin-top:16px;font-size:16px' },
      KIND_LABEL[kind] || kind));
    for (const [id, p] of list) {
      const row = el('div', {
        style: 'padding:8px 0;border-bottom:1px solid var(--etch)',
      });
      const top = el('div', {
        style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap',
      });
      top.append(el('span', {
        class: 'chip',
        style: p.configured ? 'background:rgba(47,107,98,.3)'
          : 'background:rgba(58,66,71,.2)',
      }, p.configured ? 'ready' : 'not set up'));
      top.append(el('strong', { style: 'flex:1;min-width:150px' }, p.label));
      if (p.configured && kind === 'llm') {
        top.append(el('button', {
          class: 'act small',
          onClick: async () => {
            testing = id; draw();
            const r = await generateText({
              provider: id, maxTokens: 60,
              prompt: 'In one sentence, describe a rain-soaked harbour town at '
                + 'dusk. Do not mention rules or dice.',
            });
            testing = null; draw();
            toast(r.ok ? `${p.label}: ${r.text.slice(0, 110)}`
              : `${p.label} failed: ${r.reason}`, r.ok ? 'ok' : 'bad');
          },
        }, testing === id ? 'Asking...' : 'Test'));
      }
      row.append(top);
      row.append(el('p', {
        class: 'muted', style: 'font-size:13px;margin:4px 0 0',
      }, p.note));
      panel.append(row);
    }
  }

  panel.append(el('button', {
    class: 'act ghost', style: 'margin-top:12px',
    onClick: async () => { forget(); caps = await capabilities({ refresh: true }); draw(); },
  }, 'Check again'));

  if (!caps.anyConfigured) {
    panel.append(el('p', { class: 'muted', style: 'font-size:13px;margin-top:10px' },
      'Nothing is configured, which is a perfectly good place to stay. The '
      + 'cheapest thing to add is a local model: install Ollama, pull a model, '
      + 'and the writing assistant works with no key and no cost.'));
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
