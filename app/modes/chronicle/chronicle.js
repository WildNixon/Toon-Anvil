/**
 * Chronicle mode - the log, and the export that goes to your DM.
 *
 * This is a VIEW over the event stream, not a separate diary. Everything here
 * was written by the other modes as it happened.
 *
 * The export's value is the open-threads section: because promises, secrets
 * and introductions are typed events with a thread key, we can compute what
 * was opened and never closed. That is the difference between handing a DM a
 * transcript and handing them a list of hooks.
 */

import { getState, el, esc, toast } from '../../core/store.js';
import {
  query, openThreads, summarise, bySession, EVENT_TYPES, CATEGORIES, log,
} from '../../core/events.js';
import { fromCopper } from '../../core/rules2024.js';
import { earnedDeeds, dateInWords, countInWords } from '../../core/deeds.js';

export const title = 'Chronicle';

let container = null;
let events = [];
// Session starts the whole seat can see - the DM marks them, so they do not
// carry this character's id and the scoped query above would miss them.
let sessions = [];
let filter = { cat: null, notableOnly: false };

export async function render(root) {
  container = root;
  await reload();
}

async function reload() {
  const { characterId } = getState();
  events = await query(characterId ? { characterId } : {});
  sessions = await query({ type: 'session_start' }).catch(() => []);
  draw();
}

function draw() {
  container.innerHTML = '';
  container.append(summaryPanel());
  container.append(deedsPanel());
  container.append(threadsPanel());
  container.append(journalPanel());
  container.append(timelinePanel());
}

/* ------------------------------------------------------------------ */

function summaryPanel() {
  const s = summarise(events);
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Chronicle'));
  panel.append(el('h3', {}, `${s.total} recorded events`));

  const grid = el('div', { class: 'grid stats' });
  const add = (k, v, sub) => {
    const c = el('div', { class: 'stat' });
    c.append(el('div', { class: 'k' }, k));
    c.append(el('div', { class: 'v' }, String(v)));
    if (sub) c.append(el('div', { class: 'sub' }, sub));
    grid.append(c);
  };
  add('Kills', s.kills);
  add('Crits', s.crits);
  add('Spells', s.spellsCast);
  add('Damage out', s.damageDealt);
  add('Damage in', s.damageTaken);
  add('NPCs met', s.npcsMet);
  add('Spent', fromCopper(s.copperSpent));
  panel.append(grid);

  const row = el('div', { class: 'btnrow', style: 'margin-top:16px' });
  row.append(el('button', { class: 'act', onClick: () => exportAs('md') },
    'Export for DM (Markdown)'));
  row.append(el('button', { class: 'act ghost', onClick: () => exportAs('html') },
    'Printable HTML'));
  row.append(el('button', { class: 'act ghost', onClick: () => exportAs('json') },
    'Raw JSON'));
  panel.append(row);
  return panel;
}

/* ------------------------------------------------------------------ */

/**
 * Deeds: achievements, earned only by what the record says. No locked rows
 * to want, no numbers at all (dates and counts come out as words, on
 * purpose - the phone gym counts the digits on a screen).
 */
function deedsPanel() {
  const earned = earnedDeeds(events, { sessions });
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Deeds'));
  panel.append(el('h3', {}, earned.length
    ? `${countInWords(earned.length)} earned`
    : 'none earned yet'));

  if (!earned.length) {
    panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
      'Deeds come from what actually happened: a first kill, a natural '
      + 'twenty, a promise kept, a long rest taken. Play, and they arrive.'));
  }
  for (const d of earned) {
    const row = el('div', {
      style: 'display:flex;gap:10px;align-items:flex-start;padding:8px 0;'
        + 'border-bottom:1px solid var(--etch)',
    });
    row.append(el('span', { class: 'chip accent' }, d.title));
    const info = el('div', { style: 'flex:1' });
    info.append(el('div', {}, d.line));
    info.append(el('div', { class: 'mono muted', style: 'font-size:11px' },
      `earned ${dateInWords(d.earnedAt)}`));
    row.append(info);
    panel.append(row);
  }
  panel.append(el('p', { class: 'welcome-fine', style: 'margin-top:8px' },
    'Earned only, never teased. At a table nobody logs a kill - the runner '
    + 'records damage, not deaths - so First blood is a solo deed for now.'));
  return panel;
}

/* ------------------------------------------------------------------ */

function threadsPanel() {
  const threads = openThreads(events);
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Open threads'));
  panel.append(el('h3', {}, `${threads.length} loose ends`));
  panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
    'Promises with no resolution, secrets never used, people met once. '
    + 'This is the part a DM can actually build on.'));

  if (!threads.length) {
    panel.append(el('div', { class: 'empty' },
      'Nothing open. Make a promise or meet someone in Roleplay mode.'));
    return panel;
  }
  for (const t of threads) {
    const row = el('div', {
      style: 'display:flex;gap:10px;align-items:flex-start;padding:8px 0;'
        + 'border-bottom:1px solid var(--etch)',
    });
    row.append(el('span', {
      class: `chip ${t.kind === 'promise' ? 'warn' : t.kind === 'secret' ? 'accent' : ''}`,
    }, t.kind));
    const info = el('div', { style: 'flex:1' });
    info.append(el('div', {}, t.summary));
    info.append(el('div', { class: 'mono muted', style: 'font-size:11px' },
      new Date(t.since).toLocaleString()));
    row.append(info);
    panel.append(row);
  }
  return panel;
}

/* ------------------------------------------------------------------ */

function journalPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Journal'));
  const input = el('textarea', {
    placeholder: 'Anything the other modes could not capture on its own...',
  });
  panel.append(input);
  panel.append(el('div', { class: 'btnrow', style: 'margin-top:10px' },
    el('button', {
      class: 'act',
      onClick: async () => {
        const text = input.value.trim();
        if (!text) return toast('Write something first', 'bad');
        await log('journal', { text });
        input.value = '';
        await reload();
        return toast('Added to the chronicle', 'ok');
      },
    }, 'Add entry'),
    el('button', {
      class: 'act ghost',
      onClick: async () => {
        await log('session_start', { at: new Date().toISOString() });
        await reload();
        toast('Session marked', 'ok');
      },
    }, 'Mark session start')));
  return panel;
}

/* ------------------------------------------------------------------ */

function timelinePanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Timeline'));

  const filters = el('div', { class: 'btnrow', style: 'margin-bottom:12px' });
  filters.append(el('button', {
    class: `act ${filter.cat === null ? '' : 'ghost'} small`,
    onClick: () => { filter.cat = null; draw(); },
  }, 'All'));
  for (const [key, label] of Object.entries(CATEGORIES)) {
    filters.append(el('button', {
      class: `act ${filter.cat === key ? '' : 'ghost'} small`,
      onClick: () => { filter.cat = key; draw(); },
    }, label));
  }
  filters.append(el('button', {
    class: `act ${filter.notableOnly ? '' : 'ghost'} small`,
    onClick: () => { filter.notableOnly = !filter.notableOnly; draw(); },
  }, 'Notable only'));
  panel.append(filters);

  let shown = events;
  if (filter.cat) shown = shown.filter((e) => e.cat === filter.cat);
  if (filter.notableOnly) shown = shown.filter((e) => EVENT_TYPES[e.type]?.notable);
  shown = shown.slice(-200).reverse();

  if (!shown.length) {
    panel.append(el('div', { class: 'empty' }, 'Nothing logged yet.'));
    return panel;
  }

  for (const ev of shown) {
    const row = el('div', {
      style: 'display:flex;gap:10px;align-items:baseline;padding:5px 0;'
        + 'border-bottom:1px solid var(--etch)',
    });
    row.append(el('span', { class: 'mono muted', style: 'font-size:11px;width:120px' },
      new Date(ev.ts).toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })));
    row.append(el('span', {
      class: `chip ${EVENT_TYPES[ev.type]?.notable ? 'accent' : ''}`,
      style: 'min-width:74px;justify-content:center',
    }, ev.cat));
    row.append(el('span', { style: 'flex:1' }, ev.summary));
    panel.append(row);
  }
  return panel;
}

/* ------------------------------------------------------------------ */
/* export                                                              */
/* ------------------------------------------------------------------ */

function buildMarkdown() {
  const { character, derived } = getState();
  const s = summarise(events);
  const threads = openThreads(events);
  const sessions = bySession(events);

  const lines = [];
  lines.push(`# ${character?.name || 'Character'} - chronicle for the DM`);
  lines.push('');
  if (derived) {
    lines.push(`**${(derived.classes || []).map((c) => `${c.class} ${c.level}`).join(' / ')}**`
      + ` · AC ${derived.ac} · HP ${derived.hp.current}/${derived.hp.max}`);
    lines.push('');
  }
  lines.push(`_${s.total} events`
    + `${s.first ? ` from ${new Date(s.first).toLocaleDateString()}` : ''}`
    + `${s.last ? ` to ${new Date(s.last).toLocaleDateString()}` : ''}._`);
  lines.push('');

  lines.push('## Where things stand');
  lines.push('');
  lines.push(`- Foes defeated: **${s.kills}** (${s.crits} critical hits)`);
  lines.push(`- Damage dealt / taken: **${s.damageDealt} / ${s.damageTaken}**`);
  lines.push(`- Spells cast: **${s.spellsCast}**`);
  lines.push(`- People met: **${s.npcsMet}**`);
  lines.push(`- Spent: **${fromCopper(s.copperSpent)}**`);
  lines.push('');

  // The section that makes this worth reading.
  lines.push('## Open threads');
  lines.push('');
  if (!threads.length) {
    lines.push('_Nothing currently unresolved._');
  } else {
    lines.push('Things this character started and has not finished. '
      + 'Each one is a hook you can pull on.');
    lines.push('');
    for (const t of threads) {
      lines.push(`- **[${t.kind}]** ${t.summary}`
        + ` _(since ${new Date(t.since).toLocaleDateString()})_`);
    }
  }
  lines.push('');

  const notable = events.filter((e) => EVENT_TYPES[e.type]?.notable);
  if (notable.length) {
    lines.push('## Moments that mattered');
    lines.push('');
    for (const ev of notable.slice(-40)) {
      lines.push(`- \`${new Date(ev.ts).toLocaleDateString()}\` ${ev.summary}`);
    }
    lines.push('');
  }

  if (sessions.length > 1) {
    lines.push('## By session');
    lines.push('');
    for (const [i, sess] of sessions.entries()) {
      const ss = summarise(sess.events);
      lines.push(`### Session ${i + 1} - ${new Date(sess.start).toLocaleDateString()}`);
      lines.push('');
      lines.push(`${ss.total} events · ${ss.kills} defeated · `
        + `${ss.damageDealt} damage dealt · ${ss.npcsMet} met`);
      lines.push('');
      for (const ev of sess.events.filter((e) => EVENT_TYPES[e.type]?.notable).slice(0, 15)) {
        lines.push(`- ${ev.summary}`);
      }
      lines.push('');
    }
  }

  const journal = events.filter((e) => e.type === 'journal');
  if (journal.length) {
    lines.push('## In their own words');
    lines.push('');
    for (const ev of journal.slice(-25)) {
      lines.push(`> ${ev.payload?.text || ev.summary}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('_Generated by Toon Anvil._');
  return lines.join('\n');
}

function exportAs(format) {
  const { character } = getState();
  const base = (character?.name || 'character').replace(/\W+/g, '-').toLowerCase();
  let blob;
  let filename;

  if (format === 'json') {
    blob = new Blob([JSON.stringify({
      character: character?.name, exported: new Date().toISOString(),
      summary: summarise(events), openThreads: openThreads(events), events,
    }, null, 2)], { type: 'application/json' });
    filename = `${base}-chronicle.json`;
  } else if (format === 'html') {
    const md = buildMarkdown();
    const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(character?.name || 'Chronicle')}</title>
<style>
 body{font-family:Georgia,serif;max-width:760px;margin:40px auto;padding:0 20px;
      line-height:1.6;color:#1c2124}
 h1,h2,h3{font-family:'Arial Black',Impact,sans-serif;text-transform:uppercase;
          letter-spacing:-.01em}
 h1{border-bottom:6px solid #1c2124;padding-bottom:8px}
 h2{color:#b84a16;margin-top:32px}
 blockquote{border-left:3px solid #b84a16;margin:0;padding-left:16px;font-style:italic}
 code{font-family:Consolas,monospace;font-size:.85em;color:#3a4247}
 li{margin-bottom:.35em}
 @media print{body{margin:0}}
</style></head><body>
${mdToHtml(md)}
</body></html>`;
    blob = new Blob([html], { type: 'text/html' });
    filename = `${base}-chronicle.html`;
  } else {
    blob = new Blob([buildMarkdown()], { type: 'text/markdown' });
    filename = `${base}-chronicle.md`;
  }

  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Exported ${filename}`, 'ok');
}

/** Minimal markdown renderer, sufficient for the export we generate. */
function mdToHtml(mdText) {
  return esc(mdText)
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^- (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^---$/gm, '<hr>')
    .replace(/\n{2,}/g, '\n<p></p>\n');
}
