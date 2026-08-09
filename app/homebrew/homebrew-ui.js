/**
 * Homebrew mode - import, inspect, map, and manage custom content.
 *
 * The import flow is deliberately two-step and visible: extract, then show
 * exactly what was found and what the mapper *thinks* each feature does, with
 * its confidence and the sentence it matched. You accept or reject. Nothing is
 * silently assumed to be correct.
 */

import { getState, setState, el, esc, md, toast } from '../core/store.js';
import { db, serverBase } from '../core/db.js';
import { scrapeFile, scrape } from './scraper.js';
import { extract } from './ingest.js';
import { suggestAll, acceptSuggestions, mappingStats } from './mapping.js';
import { describeEffect, validateEffect, EFFECT_TYPES } from './effects.js';
import { detect, parse as parseAdapter } from './adapters.js';
import { emitHtml, downloadHtml } from './emit-html.js';
import { sheetHtml, sheetJson, downloadSheet } from './sheet.js';
import { recompute, go } from '../app.js';
import { uploadPdf, verdictLine, CATEGORY_LABELS } from '../core/shelf.js';

export const title = 'Homebrew';

let container = null;
let staged = null;   // brew awaiting confirmation

export async function render(root) {
  container = root;
  draw();
  probeSamples();
}

function draw() {
  container.innerHTML = '';
  container.append(importPanel());
  if (showDrop) container.append(dropPanel());
  if (staged) container.append(reviewPanel(staged));
  container.append(libraryPanel());
}

/* ------------------------------------------------------------------ */

function importPanel() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Import'));
  panel.append(el('h3', {}, 'Ingest a homebrew page'));
  panel.append(el('p', { class: 'muted' },
    'Drop .html homebrew (rendered in a sandbox, so script-built tables are '
    + 'captured) - or drop a whole .pdf book: the shelf detects whether it is '
    + 'a setting, an adventure, player options or a bestiary, files it, and '
    + 'splits it.'));

  const drop = el('div', {
    class: 'empty',
    'aria-label': 'Drop homebrew pages or PDF books',
    style: 'cursor:pointer;border-style:dashed;border-width:2px',
  }, 'Drop .html pages or .pdf books here, or click to choose');

  // .html goes to the sandbox scraper, .pdf to the shelf. The old handler
  // FILTERED to html, which discarded a dropped PDF without a word.
  const routeFiles = (files) => {
    const html = files.filter((f) => /\.html?$/i.test(f.name));
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
    if (html.length) handleFiles(html);
    for (const f of pdfs) shelvePdf(f);
    if (!html.length && !pdfs.length && files.length) {
      toast('Only .html pages and .pdf books land here', 'warn');
    }
  };

  const pick = () => {
    const input = el('input', {
      type: 'file', accept: '.html,.htm,.pdf', multiple: true,
    });
    input.addEventListener('change', () => routeFiles([...input.files]));
    input.click();
  };
  drop.addEventListener('click', pick);
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.style.borderColor = 'var(--accent)';
  });
  drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.style.borderColor = '';
    routeFiles([...e.dataTransfer.files]);
  });

  panel.append(drop);

  // The last verdict stays visible: a toast is gone in four seconds, and
  // "where did my book go" deserves a standing answer with a next step.
  if (lastShelved) {
    const row = el('div', {
      style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;'
        + 'margin-top:10px',
    });
    row.append(el('span', { class: 'chip accent' },
      CATEGORY_LABELS[lastShelved.category] || lastShelved.category || '?'));
    row.append(el('span', { style: 'flex:1;font-size:13px' },
      `${lastShelved.name || 'The book'}: ${verdictLine(lastShelved)}`));
    if (['settings', 'adventures'].includes(lastShelved.category)) {
      row.append(el('button', {
        class: 'act small',
        title: 'Settings and adventures are Deck material - regions, factions, lore',
        onClick: () => {
          // Stash the slug so the Deck can highlight this book's row.
          // Highlight only - auto-opening anything from here would yank
          // the DM into a review they did not ask for.
          try {
            sessionStorage.setItem('toonanvil.deckOpenBook', lastShelved.slug);
          } catch { /* private mode */ }
          go('dm-deck');
        },
      }, 'Open in the Deck'));
    }
    panel.append(row);
  }

  const folderRow = el('div', { class: 'btnrow', style: 'margin-top:12px' });
  folderRow.append(el('button', {
    class: 'act',
    onClick: () => {
      showDrop = !showDrop;
      // Re-read every time it is opened. The listing is what triggers
      // auto-split server-side, so a cached one means a file you just dropped
      // is invisible AND unprocessed until you reload the whole page.
      if (showDrop) dropListing = null;
      draw();
    },
  }, showDrop ? 'Hide library' : 'Open library'));
  // Only offered when the server actually finds files beside the project - on
  // a fresh clone there is no such folder, and a button naming someone else's
  // directory is worse than no button.
  if (sampleListing?.files?.length) {
    folderRow.append(el('button', {
      class: 'act ghost', onClick: importFromFolder,
    }, `Import from ${sampleListing.dir}`));
  }
  panel.append(folderRow);
  return panel;
}

/* ------------------------------------------------------------------ */
/* drop folder                                                         */
/* ------------------------------------------------------------------ */

let showDrop = false;
let dropListing = null;
let dropFilter = '';
let lastShelved = null;   // the most recent PDF verdict, kept on screen

async function shelvePdf(f) {
  toast(`Reading ${f.name} - a big book takes a minute or two...`, 'ok');
  const res = await uploadPdf(f);
  lastShelved = { ...res, name: res.name || f.name };
  if (res.status !== 200) {
    toast(verdictLine(res), 'bad');
  } else {
    toast(verdictLine(res), 'ok');
    // The listing is re-read on next open; a shelved book is split already,
    // so it appears under "From your PDFs" without a reload.
    showDrop = true;
    dropListing = null;
    loadDrop();
    return;
  }
  draw();
}
let openDocs = new Set();
// Per-document selection of extracted subclass groups, so a reader can
// combine what the splitter guessed apart.
const selectedSubs = new Map();
let examples = null;

async function loadDrop() {
  try {
    dropListing = await (await fetch(`${serverBase()}/api/library`)).json();
  } catch {
    dropListing = { error: 'needs serve.py running', inbox: [], documents: [] };
  }
  try {
    examples = (await (await fetch(`${serverBase()}/api/examples`)).json()).files || [];
  } catch { examples = []; }
  draw();
}

const ROW = 'display:flex;gap:9px;align-items:center;padding:6px 0;'
          + 'border-bottom:1px solid var(--etch)';

function fileRow(f, label = null) {
  const row = el('div', { style: ROW });
  row.append(el('span', { class: 'chip' }, f.kind || 'file'));
  row.append(el('span', { style: 'flex:1;font-size:13px;overflow:hidden' },
    label || f.name));
  row.append(el('button', {
    class: 'act small', onClick: () => ingestDropFile(f),
  }, 'Analyse'));
  return row;
}

/**
 * The Library browser.
 *
 * Grouped by WHERE something came from, because the flat list this replaces
 * showed 226 rows with names like
 * "Armokil-s-Archive-...--15th-level-tiny-conclave-feature.json" and buried
 * both the inbox and the answer to "where did my PDF go".
 */
function dropPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Library'));

  if (!dropListing) {
    panel.append(el('p', { class: 'muted' }, 'Loading...'));
    loadDrop();
    return panel;
  }
  if (dropListing.error) {
    panel.append(el('div', { class: 'empty' },
      `The library ${dropListing.error}. Start it with "python run.py".`));
    return panel;
  }

  const inbox = dropListing.inbox || [];
  const docs = dropListing.documents || [];
  const corpus = dropListing.corpus || [];

  // --- what just happened, if anything ---------------------------------
  if (dropListing.justSplit?.length) {
    panel.append(el('div', { class: 'note ok' },
      `Split ${dropListing.justSplit.join(', ')} into library/extracted. `
      + 'It will not be split again.'));
  }

  // --- 1. inbox --------------------------------------------------------
  panel.append(el('h3', {}, 'Your inbox'));
  panel.append(el('p', { class: 'muted', style: 'font-size:13px' },
    `Drop files in ${dropListing.inboxDir} and reload. `
    + `Accepts ${(dropListing.accepts || []).join(' ')}. `
    + 'PDFs are split automatically; nothing is ever written back here.'));

  if (!inbox.length) {
    const empty = el('div', { class: 'empty' });
    empty.append(el('p', {}, 'Your inbox is empty.'));
    // A first-time user with nothing to drop still gets to see it work.
    for (const ex of examples || []) {
      empty.append(el('button', {
        class: 'act', onClick: () => ingestDropFile({ ...ex, kind: 'html' }),
      }, `Try the example: ${ex.name.replace(/\.[^.]+$/, '')}`));
    }
    panel.append(empty);
  } else {
    for (const f of inbox) panel.append(fileRow(f));
  }

  // --- 2. from your PDFs ------------------------------------------------
  if (docs.length) {
    panel.append(el('h3', { style: 'margin-top:20px' }, 'From your PDFs'));
    for (const doc of docs) {
      const open = openDocs.has(doc.document);
      const head = el('div', {
        style: `${ROW};cursor:pointer`,
        onClick: () => {
          if (open) openDocs.delete(doc.document); else openDocs.add(doc.document);
          draw();
        },
      });
      const total = Object.values(doc.contents || {}).reduce((a, b) => a + b, 0);
      head.append(el('span', { class: 'chip' }, open ? '−' : '+'));
      head.append(el('span', { style: 'flex:1;font-size:13px' }, doc.document));
      head.append(el('span', { class: 'muted', style: 'font-size:11px' },
        Object.entries(doc.contents || {})
          .map(([k, n]) => `${n} ${k}`).join(' · ') || `${total} items`));
      panel.append(head);

      if (open) {
        const box = el('div', {
          style: 'margin:4px 0 10px 16px;max-height:280px;overflow-y:auto',
        });
        const q = dropFilter.trim().toLowerCase();
        const subs = (doc.subclasses || [])
          .filter((s) => !q || String(s.name || s).toLowerCase().includes(q));
        if (!subs.length) {
          box.append(el('p', { class: 'muted', style: 'font-size:12px' },
            'No subclasses listed for this document.'));
        }
        // Extracted subclasses live together in one subclasses.json per
        // document, so a row addresses its entry by index rather than by a
        // file of its own.
        //
        // Rows are SELECTABLE because PDF grouping is a guess whenever the
        // document does not name its subclasses. When a subclass has been
        // split across several rows - or a row has swept up features that
        // belong elsewhere - you need to be able to say so yourself rather
        // than accept whatever the splitter decided.
        const selected = selectedSubs.get(doc.document) || new Set();
        selectedSubs.set(doc.document, selected);

        subs.slice(0, 80).forEach((s) => {
          const idx = (doc.subclasses || []).indexOf(s);
          const row = el('div', { style: ROW });
          const tick = el('input', {
            type: 'checkbox', style: 'width:16px;height:16px;flex:none',
            onChange: (e) => {
              if (e.target.checked) selected.add(idx); else selected.delete(idx);
              draw();
            },
          });
          tick.checked = selected.has(idx);
          row.append(tick);
          row.append(el('span', { class: 'chip' }, s.class || '?'));
          row.append(el('span', { style: 'flex:1;font-size:13px' }, s.name));
          // Say whether the document named this or we guessed, because the
          // two deserve very different amounts of trust.
          row.append(el('span', {
            class: 'chip',
            style: s.nameSource === 'text'
              ? 'background:rgba(47,107,98,.25)' : 'background:rgba(154,106,18,.25)',
            title: s.nameSource === 'text'
              ? 'The document names this subclass explicitly'
              : 'Nothing named it - grouped by level order, so check it',
          }, s.nameSource === 'text' ? 'named' : 'guessed'));
          row.append(el('span', { class: 'muted', style: 'font-size:11px' },
            `${s.features} feat · p${(s.pages || []).join('-')}`));
          row.append(el('button', {
            class: 'act small',
            onClick: () => ingestDropFile({
              name: s.name, kind: 'subclass', index: idx,
              url: `/library/extracted/${doc.document}/subclasses.json`,
            }),
          }, 'Analyse'));
          box.append(row);
        });

        if (selected.size) {
          const chosen = [...selected].sort((a, b) => a - b);
          const bar = el('div', {
            class: 'panel',
            style: 'margin-top:10px;padding:12px;background:rgba(184,74,22,.12)',
          });
          bar.append(el('p', { style: 'font-size:13px;margin:0 0 8px' },
            `${chosen.length} selected: `
            + chosen.map((i) => doc.subclasses[i]?.name).join(' + ')));
          const nameInput = el('input', {
            type: 'text', placeholder: 'Name for the combined subclass',
            value: doc.subclasses[chosen[0]]?.name || '',
            style: 'margin-bottom:8px',
          });
          bar.append(nameInput);
          const btns = el('div', { class: 'btnrow' });
          btns.append(el('button', {
            class: 'act',
            onClick: () => ingestDropFile({
              name: nameInput.value.trim() || doc.subclasses[chosen[0]]?.name,
              kind: 'subclass-merge', indices: chosen,
              url: `/library/extracted/${doc.document}/subclasses.json`,
            }),
          }, chosen.length === 1 ? 'Analyse as named' : `Combine ${chosen.length} into one`));
          btns.append(el('button', {
            class: 'act ghost',
            onClick: () => { selected.clear(); draw(); },
          }, 'Clear'));
          bar.append(btns);
          box.append(bar);
        }
        if (subs.length > 80) {
          box.append(el('p', { class: 'muted', style: 'font-size:12px' },
            `Showing 80 of ${subs.length} - use the filter to narrow.`));
        }

        // Everything that is NOT a subclass. The splitter has always written
        // these out; nothing ever surfaced them, so a DM dropping a bestiary
        // got their subclasses and silently lost their monsters.
        const KIND_LABEL = {
          monster: 'Monsters', magic_item: 'Magic items', spell: 'Spells',
          feat: 'Feats', species: 'Species',
        };
        for (const [kind, rows] of Object.entries(doc.other || {})) {
          if (!rows.length) continue;
          box.append(el('h3', { style: 'margin:14px 0 4px;font-size:14px' },
            `${KIND_LABEL[kind] || kind} (${rows.length})`));
          for (const [i, r] of rows.entries()) {
            const row = el('div', { style: ROW });
            row.append(el('span', { class: 'chip' }, kind.replace('_', ' ')));
            row.append(el('span', { style: 'flex:1;font-size:13px' }, r.title));
            row.append(el('span', { class: 'muted', style: 'font-size:11px' },
              `${r.chars} chars · p${r.page ?? '?'}`));
            row.append(el('button', {
              class: 'act small',
              onClick: () => ingestDropFile({
                name: r.title, kind: 'content', contentKind: kind, index: i,
                url: `/library/extracted/${doc.document}/${kind}.json`,
              }),
            }, 'Parse'));
            box.append(row);
          }
        }

        panel.append(box);
      }
    }
    const search = el('input', {
      type: 'text', value: dropFilter, placeholder: 'Filter subclasses by name...',
      onInput: (e) => { dropFilter = e.target.value; draw(); },
    });
    panel.append(search);
  }

  // --- 3. reference corpus ---------------------------------------------
  if (corpus.length) {
    panel.append(el('h3', { style: 'margin-top:20px' }, 'Reference corpus'));
    panel.append(el('p', { class: 'muted', style: 'font-size:13px' },
      `${corpus.length} open-licensed subclasses from Open5e, used as the `
      + 'comparison set for "plays most like". You do not need to analyse '
      + 'these individually.'));
  }

  return panel;
}

/** Ingest one drop-folder file through the right adapter. */
async function ingestDropFile(f) {
  toast(`Reading ${f.name}...`);
  try {
    const res = await fetch(`${serverBase()}${f.url}`);
    let brew;

    if (f.kind === 'content') {
      // Monsters, magic items and spells. These do NOT go through the subclass
      // review panel - they are not subclasses - so they are parsed, reported
      // on, and saved straight to their own store.
      const { parseContent } = await import('./parse-content.js');
      const rows = await res.json();
      const block = rows[f.index];
      if (!block) throw new Error(`entry ${f.index} is not in that file`);

      const parsed = parseContent(f.contentKind, block.text, {
        name: block.title,
        source: { document: f.url.split('/')[3], page: block.page },
      });

      if (parsed.container) {
        // A section heading holding several records. Saying so beats saving
        // the first one under the section's name.
        toast(parsed.warnings[0], 'warn');
        return;
      }
      if (!parsed.ok) {
        toast(`${block.title}: could not parse — missing `
          + `${parsed.missing.join(', ')}`, 'bad');
        return;
      }

      const store = { monster: 'custom-monsters', magic_item: 'custom-items',
        spell: 'custom-spells' }[f.contentKind];
      await db.put(store, parsed.record);
      const pct = Math.round(parsed.coverage * 100);
      toast(`Saved ${parsed.record.name} — ${pct}% of its fields parsed`
        + (parsed.missing.length ? ` (missing ${parsed.missing.join(', ')})` : ''),
      parsed.coverage === 1 ? 'ok' : 'warn');
      return;
    }

    if (f.kind === 'subclass') {
      // One entry out of a document's subclasses.json. Already in our own
      // schema - it was written by the splitter - so it needs no adapter.
      const all = await res.json();
      brew = all[f.index];
      if (!brew) throw new Error(`entry ${f.index} is not in that document`);
    } else if (f.kind === 'subclass-merge') {
      // Several extracted groups, joined into the subclass the reader can see
      // they really are. Features are merged and re-sorted by level; the page
      // range spans everything so the original is still checkable.
      const all = await res.json();
      const parts = f.indices.map((i) => all[i]).filter(Boolean);
      if (!parts.length) throw new Error('none of those entries exist');
      const features = parts.flatMap((p) => p.features || [])
        .sort((a, b) => (a.level || 0) - (b.level || 0));
      const pages = parts.flatMap((p) => p.pages || []).filter(Number.isFinite);
      brew = {
        ...parts[0],
        id: `${(f.name || parts[0].name).toLowerCase().replace(/\W+/g, '-')}-merged`,
        name: f.name || parts[0].name,
        features,
        pages: pages.length ? [Math.min(...pages), Math.max(...pages)] : parts[0].pages,
        // The class is whichever the parts agree on; disagreement means the
        // combination is probably wrong, and saying so is better than picking.
        class: parts.every((p) => p.class === parts[0].class) ? parts[0].class : null,
        extractionWarning:
          `Combined by hand from ${parts.length} extracted group(s): `
          + `${parts.map((p) => p.name).join(', ')}. Pages `
          + `${pages.length ? `${Math.min(...pages)}-${Math.max(...pages)}` : '?'}.`,
      };
    } else if (f.kind === 'pdf') {
      // PDF text is extracted server-side; the browser only ever sees text.
      const payload = await res.json();
      if (payload.error) throw new Error(payload.error);
      brew = parseAdapter('pdf', payload.text, { filename: f.name });
    } else if (f.kind === 'html' || f.kind === 'htm') {
      const raw = await res.text();
      const scraped = await scrape(raw);
      brew = extract(scraped.doc, { filename: f.name, title: scraped.title, raw });
      brew.ranScripts = scraped.ranScripts;
      brew.adapter = 'html';
      brew.fidelity = 'high';
    } else {
      const raw = await res.text();
      const kind = detect(f.name, raw);
      brew = parseAdapter(kind, raw, { filename: f.name });
    }

    staged = suggestAll(brew);
    draw();
    window.scrollTo(0, 0);
    const s = mappingStats(acceptSuggestions(staged));
    toast(`${brew.name}: ${s.live}/${s.features} features live (${brew.fidelity} fidelity)`,
      s.live ? 'ok' : 'warn');
  } catch (err) {
    console.error('[homebrew] drop ingest failed', f.name, err);
    toast(`${f.name}: ${err.message}`, 'bad');
  }
}

/**
 * Files sitting beside the project folder, if any.
 *
 * Probed rather than assumed: the button that offers them names a real
 * directory, so it must not appear on a machine where that directory is empty
 * or absent.
 */
let sampleListing = null;

async function probeSamples() {
  try {
    const r = await (await fetch(`${serverBase()}/api/samples`)).json();
    if (r.files?.length) { sampleListing = r; draw(); }
  } catch { /* no server, or nothing there - the button just stays hidden */ }
}

async function importFromFolder() {
  let listing;
  try {
    listing = await (await fetch('/api/samples')).json();
  } catch {
    return toast('That needs serve.py running (shared-server mode).', 'bad');
  }
  if (!listing.files?.length) {
    return toast(`No .html files found in ${listing.dir}`, 'warn');
  }
  toast(`Ingesting ${listing.files.length} pages from ${listing.dir}...`);
  const results = [];
  for (const f of listing.files) {
    try {
      const raw = await (await fetch(f.url)).text();
      const { scrape } = await import('./scraper.js');
      const scraped = await scrape(raw);
      const brew = extract(scraped.doc, {
        filename: f.name, title: scraped.title, raw,
      });
      brew.ranScripts = scraped.ranScripts;
      results.push(suggestAll(brew));
    } catch (err) {
      console.error('[homebrew] folder ingest failed', f.name, err);
      toast(`${f.name}: ${err.message}`, 'bad');
    }
  }
  if (!results.length) return;
  staged = results.length === 1 ? results[0] : { batch: results };
  draw();
  return null;
}

async function handleFiles(files) {
  if (!files.length) return;
  toast(`Ingesting ${files.length} file${files.length > 1 ? 's' : ''}...`);
  const results = [];
  for (const file of files) {
    try {
      const scraped = await scrapeFile(file);
      const brew = extract(scraped.doc, {
        filename: scraped.filename, title: scraped.title, raw: scraped.raw,
      });
      brew.ranScripts = scraped.ranScripts;
      results.push(suggestAll(brew));
    } catch (err) {
      console.error('[homebrew] ingest failed', file.name, err);
      toast(`${file.name}: ${err.message}`, 'bad');
    }
  }
  if (!results.length) return;
  staged = results.length === 1 ? results[0] : { batch: results };
  draw();
}

/* ------------------------------------------------------------------ */

function reviewPanel(brew) {
  if (brew.batch) {
    const wrap = el('div');
    for (const b of brew.batch) wrap.append(reviewPanel(b));
    const row = el('div', { class: 'btnrow', style: 'margin-bottom:20px' });
    row.append(el('button', {
      class: 'act',
      onClick: async () => {
        for (const b of brew.batch) await save(b);
        staged = null;
        draw();
      },
    }, `Save all ${brew.batch.length}`));
    row.append(el('button', {
      class: 'act ghost', onClick: () => { staged = null; draw(); },
    }, 'Discard'));
    wrap.prepend(row);
    return wrap;
  }

  const stats = mappingStats(acceptSuggestions(brew));
  const panel = el('div', {
    class: 'panel rivets',
    style: brew.accent ? `border-top-color:${brew.accent}` : '',
  });

  panel.append(el('span', {
    class: 'lvl', style: brew.accent ? `background:${brew.accent}` : '',
  }, `${brew.kind} · ${brew.class || 'unknown class'} · ${brew.ruleset}`));
  panel.append(el('h3', {
    style: brew.accent ? `color:${brew.accent}` : '',
  }, brew.name));

  if (brew.flavor?.quote) {
    panel.append(el('p', { style: 'font-style:italic' }, `"${brew.flavor.quote}"`));
  }

  // --- what was found
  const found = el('div', { class: 'grid stats', style: 'margin:14px 0' });
  const stat = (k, v, sub) => {
    const s = el('div', { class: 'stat' });
    s.append(el('div', { class: 'k' }, k));
    s.append(el('div', { class: 'v' }, String(v)));
    if (sub) s.append(el('div', { class: 'sub' }, sub));
    found.append(s);
  };
  stat('Features', brew.features.length);
  stat('Mapped', stats.live, `${stats.unmapped} text-only`);
  stat('Effects', stats.effects);
  stat('Roll tables', (brew.rollTables || []).length,
    (brew.rollTables || []).map((t) => t.die).join(' '));
  stat('Spell table', brew.spellTable
    ? Object.values(brew.spellTable.byLevel).flat().length : 0, 'spells');
  panel.append(found);

  if (!brew.ranScripts) {
    panel.append(el('p', { class: 'mono', style: 'color:var(--warn)' },
      'Note: the page\'s scripts did not report back in time - only static '
      + 'content was read. Anything built at runtime may be missing.'));
  }

  // --- roll tables found
  for (const t of brew.rollTables || []) {
    const box = el('details', { style: 'margin-bottom:8px' });
    box.append(el('summary', { style: 'cursor:pointer' },
      `${t.name} (${t.die}, ${t.entries.length} entries)`));
    const list = el('div', { class: 'scroll-x' });
    const table = el('table');
    for (const e of t.entries.slice(0, 30)) {
      const tr = el('tr');
      tr.append(el('td', { class: 'mono', style: 'width:40px' }, String(e.n)));
      tr.append(el('td', {}, e.text));
      if (e.tone) tr.append(el('td', {},
        el('span', { class: `chip ${e.tone === 'good' ? 'ok' : 'bad'}` }, e.tone)));
      table.append(tr);
    }
    list.append(table);
    box.append(list);
    panel.append(box);
  }

  // --- feature mapping
  panel.append(el('div', { class: 'rule' }));
  panel.append(el('div', { class: 'eyebrow', style: 'margin-bottom:10px' },
    'Features and proposed mechanics'));

  for (const f of brew.features) {
    panel.append(featureRow(brew, f));
  }

  const row = el('div', { class: 'btnrow', style: 'margin-top:16px' });
  row.append(el('button', {
    class: 'act', onClick: async () => { await save(brew); staged = null; draw(); },
  }, 'Save to library'));
  row.append(el('button', {
    class: 'act ghost', onClick: () => { staged = null; draw(); },
  }, 'Discard'));
  panel.append(row);

  panel.append(outputsBlock(brew));
  return panel;
}

/* ------------------------------------------------------------------ */
/* analysis: balance verdict + play guide                              */
/* ------------------------------------------------------------------ */

/** Cached per brew id so re-rendering does not re-run the simulator. */
const analyses = new Map();

function simSources() {
  const { compendium, homebrew } = getState();
  return {
    classes: compendium.classes || [], species: compendium.species || [],
    backgrounds: compendium.backgrounds || [], feats: compendium.feats || [],
    srdEffects: compendium.srdEffects || {}, equipment: compendium.equipment,
    homebrew: homebrew || [],
  };
}

/**
 * Run the measurement: campaigns for this subclass and its SRD sibling, paired
 * ablations for each live effect, then the play guide.
 *
 * Deliberately NOT automatic. It runs hundreds of simulated campaigns, and
 * quietly burning that on every ingest would make the app feel broken.
 */
async function analyse(rawBrew, { seeds = 6, autoBalance = false } = {}) {
  const brew = acceptSuggestions(rawBrew);
  const { compendia, dataFile, serverBase: sb } = await import('../core/db.js');
  const { runCampaign } = await import('../sim/campaign.js');
  const { score, SIBLING, tune } = await import('../sim/tune.js');
  const { buildGuide } = await import('../sim/playguide.js');

  const c = await compendia('monsters', 'spells');
  const mechFile = await dataFile('spell-mechanics.json');
  const sources = { ...simSources(), homebrew: [...simSources().homebrew.filter((h) => h.id !== brew.id), brew] };
  const base = {
    sources, monsters: c.monsters, spells: c.spells,
    mechanics: mechFile.mechanics, maxLevel: 20,
  };

  const mean = (runs, k) => runs.reduce((n, r) => n + r.metrics[k], 0) / runs.length;
  const measure = (subclassId) => {
    const runs = Array.from({ length: seeds }, (_, s) => runCampaign({
      classId: brew.class, subclassId, seed: s, ...base,
    }));
    return {
      stDpr: mean(runs, 'stDpr'), dpr: mean(runs, 'dpr'),
      wipeRate: mean(runs, 'wipeRate'), cpa: mean(runs, 'cpa'),
      downRate: mean(runs, 'downRate'), runs,
    };
  };

  const mine = measure(brew.id);
  const sibId = SIBLING[brew.class];
  let sibling = null;
  let sc = null;
  if (sibId) {
    const sibM = measure(sibId);
    const cls = sources.classes.find((x) => x.id === brew.class);
    sibling = {
      id: sibId,
      name: (cls?.subclasses || []).find((s) => s.id === sibId)?.name || sibId,
      metrics: sibM,
    };
    sc = score(mine, sibM);
  }

  // Paired ablations, one per live effect, sharing seeds with the baseline.
  const ablations = [];
  for (const f of brew.features) {
    for (const eff of f.effects || []) {
      if (eff.type === 'narrative_only') continue;
      if (!['ac_formula', 'unarmed_strike', 'damage_rider', 'trigger',
        'ability_substitution', 'crit_range', 'action_option'].includes(eff.type)) continue;
      const on = [];
      const off = [];
      for (let s = 0; s < seeds; s += 1) {
        on.push(runCampaign({ classId: brew.class, subclassId: brew.id, seed: s, ...base }));
        off.push(runCampaign({
          classId: brew.class, subclassId: brew.id, seed: s, ...base,
          ablate: { brewId: brew.id, featureId: f.id, effectType: eff.type },
        }));
      }
      const d = on.map((r, i) => r.metrics.dpr - off[i].metrics.dpr);
      const m = d.reduce((a, b) => a + b, 0) / d.length;
      const sd = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, d.length - 1));
      const se = sd / Math.sqrt(d.length);
      const ci = [m - 1.96 * se, m + 1.96 * se];
      ablations.push({
        label: `${brew.name}: ${f.name} (${eff.type})`,
        featureId: f.id, effectType: eff.type,
        dDpr: m, ciDpr: ci,
        detectable: !(ci[0] <= 0 && 0 <= ci[1]),
      });
    }
  }

  // Corpus behaviour vectors for "plays like".
  //
  // These are MEASURED - every corpus subclass run through full campaigns -
  // and cached on the server, because building them costs ~20s and the answer
  // only changes when the mapper does. The previous version scored an effect
  // COUNT proxy here, which returned the same neighbours for subclasses that
  // play nothing alike. If the cache is absent the guide omits the section
  // rather than falling back to a cheaper answer that reads just as confident.
  let corpus = null;
  try {
    const { loadVectors } = await import('../sim/vectors.js');
    corpus = await loadVectors();
  } catch { /* corpus optional */ }

  const guide = buildGuide({
    brew, sources, monsters: c.monsters, spells: c.spells,
    mechanics: mechFile.mechanics, seeds, ablations, corpus,
  });

  // --- auto-balance -----------------------------------------------------
  let changes = [];
  let balanced = null;
  if (autoBalance && sc && Math.abs(sc.composite) > 0.10) {
    const result = await tune({
      brew, sources, monsters: c.monsters, spells: c.spells,
      mechanics: mechFile.mechanics, band: 0.10, seeds, maxRounds: 4,
    });
    changes = result.applied.map((a) => ({
      knob: a.knob, from: a.from, to: a.to, compositeAfter: a.compositeAfter,
      evidence: `composite ${(sc.composite * 100).toFixed(0)}% -> `
        + `${(a.compositeAfter * 100).toFixed(0)}%`,
    }));
    if (changes.length) balanced = result.variant;
  }

  const analysis = sc ? {
    composite: sc.composite, axes: sc.axes, sibling,
    inBand: Math.abs(sc.composite) <= 0.10,
    changes, metricVersion: 'bars v2',
    metrics: { stDpr: mine.stDpr, wipeRate: mine.wipeRate, cpa: mine.cpa },
  } : null;

  return { brew, balanced, analysis, guide, ablations, seeds };
}

/* ------------------------------------------------------------------ */
/* outputs                                                             */
/* ------------------------------------------------------------------ */

function outputsBlock(rawBrew) {
  const brew = acceptSuggestions(rawBrew);
  const stats = mappingStats(brew);
  const wrap = el('div', { style: 'margin-top:18px' });
  wrap.append(el('div', { class: 'rule' }));
  wrap.append(el('div', { class: 'eyebrow', style: 'margin-bottom:8px' }, 'Outputs'));

  const lvlWrap = el('div', {
    style: 'display:flex;gap:9px;align-items:center;margin-bottom:10px',
  });
  lvlWrap.append(el('span', { class: 'eyebrow' }, 'Sheet level'));
  const lvlInput = el('input', {
    type: 'number', min: '1', max: '20', value: '10', style: 'width:74px',
  });
  lvlWrap.append(lvlInput);
  wrap.append(lvlWrap);

  // ---- balance + play guide -------------------------------------------
  const cached = analyses.get(brew.id);
  const analysisRow = el('div', { class: 'btnrow', style: 'margin-bottom:12px' });
  const status = el('div', { class: 'mono muted', style: 'font-size:12px;margin-bottom:10px' });

  const runAnalysis = async (autoBalance) => {
    if (!stats.live) return toast('Nothing mapped to measure', 'bad');
    status.textContent = 'Running simulated campaigns to level 20...';
    analysisRow.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const t0 = performance.now();
      const res = await analyse(rawBrew, { seeds: 6, autoBalance });
      analyses.set(brew.id, res);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      toast(`Analysis complete in ${secs}s`, 'ok');
      draw();
    } catch (err) {
      console.error('[homebrew] analysis failed', err);
      status.textContent = `failed: ${err.message}`;
      toast(`Analysis failed: ${err.message}`, 'bad');
      analysisRow.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
    return null;
  };

  analysisRow.append(el('button', {
    class: 'act', onClick: () => runAnalysis(false),
  }, cached ? 'Re-run analysis' : 'Measure balance & playstyle'));
  analysisRow.append(el('button', {
    class: 'act ghost', onClick: () => runAnalysis(true),
  }, 'Measure + auto-balance'));
  wrap.append(analysisRow);
  wrap.append(status);

  if (cached) wrap.append(analysisSummary(cached));

  const sources = () => {
    const { compendium, homebrew } = getState();
    return {
      classes: compendium.classes || [], species: compendium.species || [],
      backgrounds: compendium.backgrounds || [], feats: compendium.feats || [],
      srdEffects: compendium.srdEffects || {},
      equipment: compendium.equipment,
      homebrew: [...(homebrew || []).filter((h) => h.id !== brew.id), brew],
    };
  };

  const row = el('div', { class: 'btnrow' });

  row.append(el('button', {
    class: 'act', onClick: async (ev) => {
      // The page IS the product. Emitting one without the balance verdict and
      // play guide - and telling the user afterwards that they should have
      // pressed a different button first - hands them a worse artifact than
      // the one they asked for. Measure first if we have not already.
      let a = analyses.get(brew.id);
      const btn = ev.currentTarget;
      if (!a) {
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Measuring...';
        toast('Running campaigns to measure this subclass...');
        try {
          // Measure only. Silently rewriting someone's subclass because they
          // clicked "download the page" would be a change they never asked
          // for; auto-balance stays an explicit choice.
          a = await analyse(rawBrew, { seeds: 6, autoBalance: false });
          analyses.set(brew.id, a);
        } catch (err) {
          console.error('[homebrew] analysis failed', err);
          toast(`Could not measure: ${err.message}. Emitting without it.`, 'warn');
        } finally {
          btn.disabled = false;
          btn.textContent = label;
        }
      }
      downloadHtml({
        brew: a?.balanced || brew,
        original: a?.balanced ? brew : null,
        analysis: a?.analysis || null,
        guide: a?.guide || null,
        coverage: stats,
      });
      toast(a ? 'Page downloaded with balance report and play guide'
        : 'Page downloaded (measurement unavailable)', a ? 'ok' : 'warn');
      if (a) draw();
    },
  }, 'Subclass page (HTML)'));

  row.append(el('button', {
    class: 'act ghost', onClick: () => {
      const lvl = Math.max(1, Math.min(20, +lvlInput.value || 10));
      downloadSheet(brew, lvl, sources());
      toast(`Level ${lvl} sheet downloaded`, 'ok');
    },
  }, 'Character sheet (HTML)'));

  row.append(el('button', {
    class: 'act ghost', onClick: async () => {
      const lvl = Math.max(1, Math.min(20, +lvlInput.value || 10));
      try {
        const sheet = sheetJson(brew, lvl, sources());
        const res = await fetch(`${serverBase()}/api/pdf`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sheet }),
        });
        if (!res.ok) throw new Error(`server said ${res.status}`);
        const blob = await res.blob();
        const a = el('a', {
          href: URL.createObjectURL(blob),
          download: `${brew.id}-level-${lvl}.pdf`,
        });
        a.click();
        URL.revokeObjectURL(a.href);
        toast(`Level ${lvl} sheet PDF downloaded`, 'ok');
      } catch (err) {
        toast(`PDF needs serve.py running: ${err.message}`, 'bad');
      }
    },
  }, 'Character sheet (PDF)'));

  row.append(el('button', {
    class: 'act ghost', onClick: () => {
      const blob = new Blob([JSON.stringify(brew, null, 2)],
        { type: 'application/json' });
      const a = el('a', {
        href: URL.createObjectURL(blob), download: `${brew.id}.json`,
      });
      a.click();
      URL.revokeObjectURL(a.href);
      toast('JSON downloaded', 'ok');
    },
  }, 'JSON'));

  wrap.append(row);

  if (!stats.live) {
    wrap.append(el('p', { class: 'mono', style: 'color:var(--warn);margin-top:9px' },
      'No live mechanics were mapped, so the sheet will show base-class values '
      + 'only and no balance verdict can be computed.'));
  }
  return wrap;
}

/** Compact in-app view of what the measurement found. */
function analysisSummary(res) {
  const { analysis, guide, ablations, seeds } = res;
  const box = el('div', {
    style: 'background:var(--paper);padding:14px;border-left:4px solid var(--accent);'
         + 'border-radius:2px;margin-bottom:12px',
  });
  const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`;

  if (analysis) {
    box.append(el('div', { style: 'display:flex;gap:9px;align-items:baseline;flex-wrap:wrap' },
      el('strong', {}, analysis.inBand ? 'Balanced' : 'Outside the band'),
      el('span', { class: `chip ${analysis.inBand ? 'ok' : 'warn'}` },
        pct(analysis.composite)),
      el('span', { class: 'muted', style: 'font-size:13px' },
        `vs ${analysis.sibling?.name || 'SRD sibling'} · ${seeds} paired seeds`)));
    box.append(el('div', { class: 'mono muted', style: 'font-size:12px;margin-top:5px' },
      `damage ${pct(analysis.axes.dDmg)} · survivability ${pct(analysis.axes.dSurv)}`
      + ` · control ${pct(analysis.axes.dCtl)}`));
    if (analysis.changes.length) {
      box.append(el('div', { class: 'eyebrow', style: 'margin-top:9px' }, 'Auto-balanced'));
      for (const c of analysis.changes) {
        box.append(el('div', { class: 'mono', style: 'font-size:12px' },
          `${c.knob}: ${c.from} → ${c.to}  (${c.evidence})`));
      }
    }
  } else {
    box.append(el('p', { class: 'muted' },
      'No SRD sibling known for this class, so no balance comparison.'));
  }

  const det = ablations.filter((a) => a.detectable);
  box.append(el('div', { class: 'eyebrow', style: 'margin-top:10px' },
    `Feature value — ${det.length} of ${ablations.length} measurable`));
  for (const a of det.slice(0, 4)) {
    box.append(el('div', { class: 'mono', style: 'font-size:12px' },
      `${a.label.split(':').slice(1).join(':').trim()}: ${a.dDpr >= 0 ? '+' : ''}`
      + `${a.dDpr.toFixed(2)} DPA [${a.ciDpr[0].toFixed(2)}, ${a.ciDpr[1].toFixed(2)}]`));
  }

  if (guide) {
    box.append(el('div', { class: 'eyebrow', style: 'margin-top:10px' },
      `Play guide — ${guide.combat.length} combat, ${guide.roleplay.length} roleplay,`
      + ` ${guide.comparative.length} comparative`));
    for (const i of [...guide.combat, ...guide.comparative].slice(0, 3)) {
      box.append(el('div', { style: 'font-size:13px;margin-top:3px' },
        el('strong', {}, `${i.headline} `),
        el('span', { class: 'chip' }, i.basis)));
    }
    if (guide.limits?.length) {
      box.append(el('div', { class: 'mono', style: 'font-size:11px;color:var(--warn);margin-top:7px' },
        guide.limits.join(' · ')));
    }
  }
  return box;
}

function featureRow(brew, f) {
  const box = el('details', {
    style: 'border-bottom:1px solid var(--etch);padding:10px 0',
  });
  const sum = el('summary', { style: 'cursor:pointer' });
  sum.append(el('span', { class: 'lvl ghost', style: 'margin:0 8px 0 0' }, `L${f.level}`));
  sum.append(el('strong', {}, f.name));

  const accepted = (f.suggestions || []).filter((s) => s.confidence >= 0.7);
  sum.append(el('span', {
    class: `chip ${accepted.length ? 'ok' : ''}`, style: 'margin-left:8px',
  }, accepted.length ? `${accepted.length} live` : 'text only'));
  box.append(sum);

  const body = el('div', { style: 'padding:10px 0 0 12px' });

  if (!f.suggestions?.length) {
    body.append(el('p', { class: 'muted', style: 'font-size:14px' },
      'No mechanics detected. This feature will render as text on the sheet '
      + 'and still plays fine - you can add an effect by hand below.'));
  }

  for (const [i, s] of (f.suggestions || []).entries()) {
    const on = s.confidence >= 0.7;
    const line = el('div', {
      style: 'display:flex;gap:10px;align-items:flex-start;padding:6px 0',
    });
    line.append(el('input', {
      type: 'checkbox', checked: on, style: 'width:auto;margin-top:4px',
      onChange: (e) => {
        s.confidence = e.target.checked ? Math.max(0.7, s.confidence) : 0.1;
        draw();
      },
    }));
    const detail = el('div', { style: 'flex:1' });
    detail.append(el('div', {}, describeEffect(s.effect)));
    detail.append(el('div', { class: 'mono muted', style: 'font-size:11px' },
      `${Math.round(s.confidence * 100)}% · matched: "${s.evidence.slice(0, 90)}"`));
    const errs = validateEffect(s.effect);
    if (errs.length) {
      detail.append(el('div', { class: 'mono', style: 'font-size:11px;color:var(--bad)' },
        errs.join('; ')));
    }
    line.append(detail);
    line.append(el('span', { class: 'chip' }, s.effect.type));
    body.append(line);
  }

  body.append(el('div', { html: md(f.text || ''), style: 'font-size:14px;margin-top:8px' }));
  box.append(body);
  return box;
}

async function save(brew) {
  const record = acceptSuggestions(brew);
  // Drop the suggestion scaffolding; keep only what the engine consumes.
  record.features = record.features.map(({ suggestions, ...f }) => f);
  await db.put('homebrew', record);
  const homebrew = await db.list('homebrew');
  setState({ homebrew });
  recompute();
  const stats = mappingStats(record);
  toast(`Saved ${record.name}: ${stats.live}/${stats.features} features live`, 'ok');
}

/* ------------------------------------------------------------------ */

function libraryPanel() {
  const { homebrew } = getState();
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Library'));
  panel.append(el('h3', {}, `Your homebrew (${homebrew.length})`));

  if (!homebrew.length) {
    panel.append(el('p', { class: 'muted' }, 'Nothing imported yet.'));
    return panel;
  }

  for (const b of homebrew) {
    const stats = mappingStats(b);
    const row = el('div', {
      style: 'display:flex;gap:12px;align-items:center;padding:10px 0;'
           + 'border-bottom:1px solid var(--etch)',
    });
    row.append(el('span', {
      class: 'chip', style: b.accent ? `background:${b.accent};color:#fff` : '',
    }, b.kind));
    const info = el('div', { style: 'flex:1' });
    info.append(el('div', {}, el('strong', {}, b.name)));
    info.append(el('div', { class: 'mono muted', style: 'font-size:11px' },
      `${b.class || 'unknown'} · ${stats.live}/${stats.features} features live · `
      + `${stats.effects} effects · ${b.sourceFile || 'manual'}`));
    row.append(info);
    row.append(el('button', {
      class: 'act ghost small',
      onClick: () => { staged = suggestAll(b); draw(); window.scrollTo(0, 0); },
    }, 'Review'));
    row.append(el('button', {
      class: 'act ghost small',
      onClick: () => exportBrew(b),
    }, 'Export'));
    row.append(el('button', {
      class: 'act ghost small',
      onClick: async () => {
        if (!confirm(`Remove "${b.name}" from the library?`)) return;
        await db.del('homebrew', b.id);
        setState({ homebrew: await db.list('homebrew') });
        recompute();
        draw();
      },
    }, 'Remove'));
    panel.append(row);
  }
  return panel;
}

function exportBrew(b) {
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${b.id}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported homebrew JSON');
}
