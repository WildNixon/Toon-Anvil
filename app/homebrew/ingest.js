/**
 * Structural extraction (ingest layer 1).
 *
 * Turns a scraped homebrew page into a structured subclass record. This layer
 * is fully automatic and makes no attempt to understand rules text - it finds
 * the *shape*: name, parent class, features by level, sub-features, resource
 * costs, spell tables and roll tables.
 *
 * The three source pages in D:\Dnd share a convention (a `.lvl` badge, an `h3`
 * name, `.term` sub-features, `.cost` spends) but not a class naming scheme -
 * the sorcerers use `.panel`, the monk uses `.feature`. Selectors are therefore
 * a union, and every extractor degrades to "found nothing" rather than throwing.
 *
 * Layer 2 (mapping.js) is what attaches machine-readable effects.
 */

const FEATURE_SELECTORS = '.panel, .feature, .feat, article.feature';
const SKIP_HEADINGS = /design notes?|balance|notes? (&|and) suggestions|for whoever/i;

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const clean = (s) => String(s || '')
  .replace(/\u00a0/g, ' ')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201c\u201d]/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

const slug = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const textOf = (node) => clean(node?.textContent || '');

/** Block text with paragraph breaks preserved, for storage and display. */
function blockText(node) {
  if (!node) return '';
  const parts = [];
  for (const child of node.querySelectorAll('p, li, h4')) {
    const t = clean(child.textContent);
    if (t) parts.push(child.tagName === 'LI' ? `• ${t}` : t);
  }
  if (!parts.length) return textOf(node);
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {Document} doc  a scraped, script-executed document
 * @param {object} meta   {filename, title, raw}
 */
export function extract(doc, meta = {}) {
  const body = doc.body || doc;

  const identity = extractIdentity(body, meta);
  const features = extractFeatures(body);
  const spellTable = extractSpellTable(body);
  const rollTables = extractRollTables(body);
  const designNotes = extractDesignNotes(body);
  const accent = extractAccent(meta.raw || '');

  return {
    id: identity.id,
    name: identity.name,
    kind: identity.kind,
    class: identity.parentClass,
    ruleset: identity.ruleset,
    version: identity.version,
    accent,
    flavor: identity.flavor,
    features,
    spellTable,
    rollTables,
    designNotes,
    sourceFile: meta.filename || null,
    ingestedAt: new Date().toISOString(),
    // Populated by mapping.js; every feature starts as narrative-only.
    mapped: false,
  };
}

/* ---- identity ---------------------------------------------------- */

const CLASS_NAMES = [
  'barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk',
  'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard',
];

function extractIdentity(body, meta) {
  const h1 = body.querySelector('header h1, h1');
  // <h1>Ferrous<em>Sorcery</em></h1> and <h1>Warrior<span>of the</span><span>Fool</span></h1>
  // both need a space inserted at element boundaries or they run together.
  const name = h1
    ? clean([...h1.childNodes].map((n) => n.textContent).join(' '))
    : clean(meta.title || meta.filename || 'Untitled homebrew');

  const eyebrow = textOf(body.querySelector('.eyebrow'));
  const subtitle = textOf(body.querySelector('.subtitle'));
  const haystack = `${eyebrow} ${subtitle} ${meta.filename || ''}`.toLowerCase();

  const parentClass = CLASS_NAMES.find((c) => haystack.includes(c)) || null;

  let kind = 'subclass';
  if (/\bclass\b/.test(eyebrow.toLowerCase())
      && !/subclass/.test(eyebrow.toLowerCase())) kind = 'class';
  if (/\bspecies\b|\bancestry\b|\brace\b/.test(haystack)) kind = 'species';
  if (/\bbackground\b/.test(haystack)) kind = 'background';
  if (/\bfeat\b/.test(haystack) && !/feature/.test(haystack)) kind = 'feat';

  const ruleset = /2024|5\.5|one d&d/i.test(haystack) ? '2024' : '2014';
  const version = (/(?:homebrew\s*)?v(\d+)/i.exec(eyebrow) || [])[1] || null;

  return {
    id: slug(name) || slug(meta.filename) || `homebrew-${Date.now().toString(36)}`,
    name,
    kind,
    parentClass,
    ruleset,
    version,
    flavor: {
      eyebrow,
      subtitle,
      quote: textOf(body.querySelector('.quote, blockquote')),
      lede: [...body.querySelectorAll('.lede')].map(textOf).filter(Boolean),
    },
  };
}

/* ---- features ---------------------------------------------------- */

function extractFeatures(body) {
  const out = [];
  const seen = new Set();

  for (const node of body.querySelectorAll(FEATURE_SELECTORS)) {
    const heading = node.querySelector('h3, h4');
    if (!heading) continue;
    const name = textOf(heading);
    if (!name || SKIP_HEADINGS.test(name)) continue;

    // A design-notes panel has no level badge and sits under a notes heading.
    const badge = textOf(node.querySelector('.lvl, .level, .lvl-badge'));
    const level = parseInt((/(\d+)/.exec(badge) || [])[1], 10);
    if (!Number.isFinite(level) && isUnderDesignNotes(node)) continue;

    const key = `${level || 0}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      id: slug(name),
      level: Number.isFinite(level) ? level : 1,
      name,
      text: blockText(node),
      html: sanitiseHtml(node),
      terms: extractTerms(node),
      costs: extractCosts(node),
      effects: [],          // layer 2 fills this in
      mappingStatus: 'unmapped',
    });
  }
  return out.sort((a, b) => a.level - b.level);
}

function isUnderDesignNotes(node) {
  let cursor = node.parentElement;
  while (cursor) {
    const h = cursor.querySelector?.('h2');
    if (h && SKIP_HEADINGS.test(textOf(h))) return true;
    cursor = cursor.parentElement;
  }
  return false;
}

/** `.term` spans mark named sub-features: "FERROUS PLATING. While you aren't..." */
function extractTerms(node) {
  const terms = [];
  for (const span of node.querySelectorAll('.term')) {
    const label = textOf(span).replace(/[.:]\s*$/, '');
    const host = span.closest('p, li, div') || span.parentElement;
    let text = textOf(host);
    if (text.toLowerCase().startsWith(label.toLowerCase())) {
      text = clean(text.slice(label.length).replace(/^[.:\s]+/, ''));
    }
    if (label) terms.push({ name: label, text });
  }
  return terms;
}

/** `.cost` spans mark resource spends: "1 Sorcery Point", "3 Focus Points". */
function extractCosts(node) {
  const costs = [];
  for (const span of node.querySelectorAll('.cost')) {
    const raw = textOf(span);
    const m = /(\d+)(?:\s*or\s*more)?\s+(.+?)s?$/i.exec(raw);
    costs.push({
      raw,
      amount: m ? parseInt(m[1], 10) : null,
      resource: m ? titleCase(m[2]) : raw,
      variable: /or more/i.test(raw),
    });
  }
  return costs;
}

const titleCase = (s) => clean(s).replace(/\b\w/g, (c) => c.toUpperCase())
  .replace(/\bPoints?\b/i, 'Points');

/* ---- spell table -------------------------------------------------- */

/**
 * "Ferrous Spells" style tables: a level column and a spells column.
 * Fully automatic - this is one of the tedious bits worth never typing again.
 */
function extractSpellTable(body) {
  for (const table of body.querySelectorAll('table')) {
    const headers = [...table.querySelectorAll('th')].map((th) => textOf(th).toLowerCase());
    const looksRight = headers.some((h) => /level/.test(h))
      && headers.some((h) => /spell/.test(h));
    if (!looksRight) continue;

    const byLevel = {};
    for (const row of table.querySelectorAll('tr')) {
      const cells = [...row.querySelectorAll('td')];
      if (cells.length < 2) continue;
      const lvl = parseInt((/(\d+)/.exec(textOf(cells[0])) || [])[1], 10);
      if (!Number.isFinite(lvl)) continue;
      const spells = textOf(cells[1]).split(/\s*,\s*/).map(clean).filter(Boolean);
      if (spells.length) byLevel[lvl] = spells;
    }
    if (Object.keys(byLevel).length) return { byLevel, source: 'table' };
  }
  return null;
}

/* ---- roll tables --------------------------------------------------- */

/**
 * Roll tables appear in two shapes across the source pages:
 *   1. a <table> whose first column is 1..N          (the d8 "signs" tables)
 *   2. divs built at runtime by the page's own JS    (the d20 Fool's Fortune)
 * Both are handled, because the second one is invisible to a static parse and
 * is the single most important mechanic on that page.
 */
function extractRollTables(body) {
  const tables = [];

  for (const table of body.querySelectorAll('table')) {
    const rows = [...table.querySelectorAll('tr')]
      .map((tr) => [...tr.querySelectorAll('td')])
      .filter((cells) => cells.length >= 2);
    const entries = sequentialEntries(
      rows.map((cells) => ({ n: textOf(cells[0]), text: textOf(cells[1]) })),
    );
    if (entries) tables.push(named(body, table, entries));
  }

  // Runtime-rendered lists: a container whose children each lead with 1..N.
  for (const container of body.querySelectorAll('div, ol, section')) {
    const kids = [...container.children];
    if (kids.length < 4 || kids.length > 100) continue;
    if (kids.some((k) => k.querySelector('table'))) continue;
    const candidate = kids.map((kid) => {
      const numNode = kid.querySelector('.n, .num, .roll, strong:first-child');
      const n = numNode ? textOf(numNode) : (/^\s*(\d+)/.exec(textOf(kid)) || [])[1];
      let text = textOf(kid);
      if (numNode) {
        text = clean(text.replace(textOf(numNode), ''));
      } else {
        text = clean(text.replace(/^\s*\d+[.)\s]*/, ''));
      }
      const tone = /\b(good)\b/.test(kid.className) ? 'good'
        : /\b(bad)\b/.test(kid.className) ? 'bad' : null;
      return { n, text, tone };
    });
    const entries = sequentialEntries(candidate);
    if (entries && !tables.some((t) => t.entries.length === entries.length
        && t.entries[0].text === entries[0].text)) {
      tables.push(named(body, container, entries));
    }
  }

  return tables;
}

/** Accept only a run that is exactly 1..N in order - that is what makes it a die. */
function sequentialEntries(candidate) {
  if (candidate.length < 4) return null;
  const entries = [];
  for (const [i, row] of candidate.entries()) {
    const n = parseInt(String(row.n).trim(), 10);
    if (n !== i + 1) return null;
    if (!row.text) return null;
    entries.push({ n, text: row.text, tone: row.tone || null });
  }
  const die = `d${entries.length}`;
  return /^d(4|6|8|10|12|20|100)$/.test(die) ? entries : null;
}

function named(body, node, entries) {
  // Walk back to the nearest preceding heading for a name.
  let cursor = node;
  let heading = null;
  while (cursor && !heading) {
    let sib = cursor.previousElementSibling;
    while (sib && !heading) {
      if (/^H[1-4]$/.test(sib.tagName)) heading = sib;
      else heading = sib.querySelector?.('h1, h2, h3, h4') || null;
      sib = sib.previousElementSibling;
    }
    cursor = cursor.parentElement;
  }
  const rawName = heading ? textOf(heading) : `Table (d${entries.length})`;
  return {
    name: clean(rawName.replace(/\s*\(d\d+\)\s*$/i, '')) || `d${entries.length} table`,
    die: `d${entries.length}`,
    entries,
  };
}

/* ---- design notes -------------------------------------------------- */

function extractDesignNotes(body) {
  const notes = [];
  for (const node of body.querySelectorAll(FEATURE_SELECTORS)) {
    const heading = node.querySelector('h3, h4');
    if (!heading) continue;
    const name = textOf(heading);
    if (!isUnderDesignNotes(node)) continue;
    notes.push({ name, text: blockText(node) });
  }
  for (const list of body.querySelectorAll('.qlist')) {
    for (const li of list.querySelectorAll('li')) {
      const t = textOf(li);
      if (t) notes.push({ name: 'Open question', text: t });
    }
  }
  return notes;
}

/* ---- presentation -------------------------------------------------- */

const ALLOWED_TAGS = new Set([
  'P', 'UL', 'OL', 'LI', 'STRONG', 'EM', 'B', 'I', 'BR', 'SPAN', 'TABLE',
  'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'H4', 'DIV', 'SMALL', 'CODE',
]);
const ALLOWED_CLASSES = new Set(['term', 'cost', 'tag', 'a', 'r', 'pol', 'lvl']);

/**
 * Keep the author's inline markup (which carries meaning - `.term`, `.cost`)
 * while dropping anything scriptable or layout-hijacking.
 */
function sanitiseHtml(node) {
  const copy = node.cloneNode(true);
  for (const heading of copy.querySelectorAll('h1, h2, h3, .lvl')) heading.remove();
  for (const el of [...copy.querySelectorAll('*')]) {
    if (!ALLOWED_TAGS.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
    for (const attr of [...el.attributes]) {
      if (attr.name === 'class') {
        const keep = attr.value.split(/\s+/).filter((c) => ALLOWED_CLASSES.has(c));
        if (keep.length) el.setAttribute('class', keep.join(' '));
        else el.removeAttribute('class');
      } else {
        el.removeAttribute(attr.name);
      }
    }
  }
  return copy.innerHTML.trim();
}

/** Lift the page's own accent colour so it keeps its identity inside the app. */
function extractAccent(rawHtml) {
  const root = /:root\s*\{([^}]*)\}/i.exec(rawHtml);
  if (!root) return null;
  const vars = [...root[1].matchAll(/--([\w-]+)\s*:\s*(#[0-9a-f]{3,8})/gi)]
    .map(([, name, hex]) => ({ name, hex }));
  if (!vars.length) return null;

  const named = vars.find((v) => /accent|molten|vermilion|ember|flame|crimson/i.test(v.name));
  if (named) return named.hex;

  // Otherwise take the most saturated non-neutral colour on the page.
  const scored = vars
    .map((v) => ({ ...v, sat: saturation(v.hex) }))
    .filter((v) => v.sat > 0.25)
    .sort((a, b) => b.sat - a.sat);
  return scored[0]?.hex || null;
}

function saturation(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}
