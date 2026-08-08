/**
 * Ingest adapters.
 *
 * Homebrew arrives in whatever format it circulates in. Each adapter turns one
 * format into the SAME structured record the HTML ingest already produces, so
 * everything downstream - mapping.js, effects.js, derive.js, the simulator -
 * works unchanged.
 *
 * That reuse is the whole reason this is adapters rather than a rewrite:
 * `suggestForFeature` in mapping.js operates on plain TEXT, not on HTML.
 *
 * Fidelity is not equal across formats and pretending otherwise would be the
 * dishonest move. Each adapter reports its own `fidelity` so the coverage gate
 * downstream can distinguish "this subclass has no mechanics" from "we could
 * not read this file properly".
 */

const clean = (s) => String(s || '')
  .replace(/ /g, ' ')
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[ \t]+/g, ' ')
  .trim();

const slug = (s) => clean(s).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Level phrasing differs by era and publisher:
 *   "Beginning at 3rd level"      Tome of Heroes / 2014 style
 *   "At 6th level"                ditto
 *   "Starting at 10th level"      ditto
 *   "When you reach 14th level"   ditto
 *   "Level 3:"                    2024 style
 */
const LEVEL_PATTERNS = [
  /\bLevel\s+(\d+)\s*:/i,
  /\b(?:Beginning|Starting)\s+at\s+(\d+)(?:st|nd|rd|th)\s+level/i,
  /\bWhen you reach\s+(\d+)(?:st|nd|rd|th)\s+level/i,
  /\bAt\s+(\d+)(?:st|nd|rd|th)\s+level/i,
  /\b(\d+)(?:st|nd|rd|th)\s+level\b/i,
];

export function levelFrom(text, fallback = 3) {
  for (const re of LEVEL_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 20) return n;
    }
  }
  return fallback;
}

/** Resource costs written in prose, since there is no `.cost` span to read. */
const COST_RE = /\bexpend(?:ing)?\s+(\d+|one|two|three)\s+([A-Za-z ]{3,24}?)\s*(?:point|dice|die|use)/i;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5 };

function costsFrom(text) {
  const out = [];
  const m = COST_RE.exec(text);
  if (m) {
    const raw = m[1].toLowerCase();
    out.push({
      raw: m[0],
      amount: NUMBER_WORDS[raw] ?? parseInt(raw, 10) ?? null,
      resource: clean(m[2]).replace(/\b\w/g, (c) => c.toUpperCase()),
      variable: false,
    });
  }
  return out;
}

/** Sub-features written as bold or leading-capital run-ins. */
function termsFrom(text) {
  const terms = [];
  const re = /\*\*(.+?)\.?\*\*\s*(.+?)(?=\n|\*\*|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = clean(m[1]).replace(/[.:]$/, '');
    if (name && name.length < 60) terms.push({ name, text: clean(m[2]) });
  }
  return terms;
}

/** Build one feature record in the shape ingest.js already produces. */
function makeFeature(name, body, fallbackLevel) {
  const text = clean(body);
  return {
    id: slug(name),
    level: levelFrom(text, fallbackLevel),
    name: clean(name),
    text,
    html: '',
    terms: termsFrom(body),
    costs: costsFrom(text),
    effects: [],
    mappingStatus: 'unmapped',
  };
}

/**
 * Numbered 1..N runs become roll tables, the same rule the HTML ingest uses.
 * Only an exact 1..N sequence counts - that is what makes it a die.
 */
function rollTablesFrom(text) {
  const tables = [];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let run = [];
  const flush = () => {
    if (run.length >= 4) {
      const die = `d${run.length}`;
      if (/^d(4|6|8|10|12|20|100)$/.test(die)) {
        tables.push({ name: `Table (${die})`, die, entries: run.slice() });
      }
    }
    run = [];
  };
  for (const line of lines) {
    const m = /^(\d+)[.)|\s]\s*(.+)$/.exec(line);
    if (m && parseInt(m[1], 10) === run.length + 1) {
      run.push({ n: run.length + 1, text: clean(m[2]), tone: null });
    } else {
      flush();
    }
  }
  flush();
  return tables;
}

/* ================================================================== */
/* Open5e JSON                                                         */
/* ================================================================== */

/**
 * Open5e archetypes put features behind `#####Name` markers with the level
 * stated in the following prose. Highest-fidelity non-HTML format: the field
 * boundaries are already machine-drawn, only the level needs reading.
 */
export function fromOpen5e(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  // Some entries use a literal "/n" token as their line break rather than a
  // real newline. Blood Domain does, and because its "#####" headings then
  // never start a line, the splitter saw 5,295 characters and zero features.
  const desc = String(data.desc || '')
    .replace(/\s*\/n\s*/g, '\n')
    .replace(/\\n/g, '\n');

  // Allow leading whitespace before the hashes. Blood Domain writes
  // "\n ##### Bonus Proficiencies" with a single leading space, and anchoring
  // strictly at "^#" meant a 5,295-character subclass parsed to zero features.
  const parts = desc.split(/^[ \t]*#{3,6}[ \t]*/m);
  const flavorBlock = parts.shift() || '';

  const features = [];
  let fallback = 3;
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const name = nl === -1 ? part : part.slice(0, nl);
    const body = nl === -1 ? '' : part.slice(nl + 1);
    if (!clean(name)) continue;
    const f = makeFeature(name, body, fallback);
    fallback = Math.max(fallback, f.level);
    features.push(f);
  }

  return {
    id: slug(data.id || data.name),
    name: clean(data.name),
    kind: 'subclass',
    class: String(data.class || '').toLowerCase(),
    ruleset: '2014',
    accent: null,
    flavor: {
      eyebrow: `${data.className || ''} subclass`.trim(),
      subtitle: data.source?.document || '',
      quote: '',
      lede: clean(flavorBlock).split(/\n{2,}/).filter(Boolean).slice(0, 3),
    },
    features: features.sort((a, b) => a.level - b.level),
    spellTable: null,
    rollTables: rollTablesFrom(desc),
    designNotes: [],
    source: data.source || null,
    adapter: 'open5e',
    fidelity: 'high',
    ingestedAt: new Date().toISOString(),
    mapped: false,
  };
}

/* ================================================================== */
/* Markdown                                                            */
/* ================================================================== */

/**
 * Homebrewery and MediaWiki exports. Features are the deepest heading level
 * that appears more than twice - guessing "### is always a feature" breaks on
 * documents that start at ## or #.
 */
export function fromMarkdown(md, meta = {}) {
  const text = String(md);
  const headings = [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)]
    .map((m) => ({ level: m[1].length, title: m[2].trim(), index: m.index }));

  const counts = {};
  for (const h of headings) counts[h.level] = (counts[h.level] || 0) + 1;
  const featureLevel = Object.entries(counts)
    .filter(([, n]) => n >= 2)
    .map(([lvl]) => Number(lvl))
    .sort((a, b) => b - a)[0] ?? 3;

  const title = headings.find((h) => h.level < featureLevel)?.title
    || meta.filename?.replace(/\.\w+$/, '')
    || 'Untitled homebrew';

  const features = [];
  let fallback = 3;
  const feats = headings.filter((h) => h.level === featureLevel);
  for (const [i, h] of feats.entries()) {
    const end = i + 1 < feats.length ? feats[i + 1].index : text.length;
    const body = text.slice(h.index + h.title.length, end)
      .replace(/^#+\s*/, '');
    const f = makeFeature(h.title, body, fallback);
    fallback = Math.max(fallback, f.level);
    features.push(f);
  }

  const first = feats[0]?.index ?? text.length;
  return {
    id: slug(title),
    name: clean(title),
    kind: 'subclass',
    class: guessClass(text),
    ruleset: /2024|5\.5/.test(text) ? '2024' : '2014',
    accent: null,
    flavor: {
      eyebrow: '', subtitle: '', quote: '',
      lede: clean(text.slice(0, first)).split(/\n{2,}/)
        .filter((l) => l && !l.startsWith('#')).slice(0, 3),
    },
    features: features.sort((a, b) => a.level - b.level),
    spellTable: null,
    rollTables: rollTablesFrom(text),
    designNotes: [],
    source: meta.source || null,
    adapter: 'markdown',
    fidelity: 'medium',
    ingestedAt: new Date().toISOString(),
    mapped: false,
  };
}

/* ================================================================== */
/* Plain text (also the PDF path)                                      */
/* ================================================================== */

/**
 * The weakest adapter, and the one PDFs land in.
 *
 * With no markup at all, a feature heading has to be guessed from typography:
 * a short line, title-cased, not ending in a full stop, followed by prose. PDF
 * text extraction also interleaves columns and drops the semantic markers that
 * make HTML reliable - so this reports LOW fidelity and the coverage gate is
 * expected to flag its output rather than trust it.
 */
export function fromText(raw, meta = {}) {
  const text = String(raw).replace(/\r/g, '');
  const lines = text.split('\n');

  const isHeading = (line, next) => {
    const t = line.trim();
    if (t.length < 3 || t.length > 60) return false;
    if (/[.,;:]$/.test(t)) return false;
    if (!/^[A-Z]/.test(t)) return false;
    // Mostly title case, and followed by something that looks like prose.
    const words = t.split(/\s+/);
    if (words.length > 7) return false;
    const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;
    if (capitalised / words.length < 0.6) return false;
    return Boolean(next && next.trim().length > 40);
  };

  const marks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (isHeading(lines[i], lines[i + 1])) marks.push(i);
  }

  const features = [];
  let fallback = 3;
  for (const [i, at] of marks.entries()) {
    const end = i + 1 < marks.length ? marks[i + 1] : lines.length;
    const body = lines.slice(at + 1, end).join('\n');
    if (clean(body).length < 40) continue;
    const f = makeFeature(lines[at], body, fallback);
    fallback = Math.max(fallback, f.level);
    features.push(f);
  }

  const title = meta.title || lines.find((l) => l.trim())?.trim()
    || meta.filename?.replace(/\.\w+$/, '') || 'Untitled homebrew';

  return {
    id: slug(title),
    name: clean(title),
    kind: 'subclass',
    class: guessClass(text),
    ruleset: /2024|5\.5/.test(text) ? '2024' : '2014',
    accent: null,
    flavor: { eyebrow: '', subtitle: '', quote: '', lede: [] },
    features: features.sort((a, b) => a.level - b.level),
    spellTable: null,
    rollTables: rollTablesFrom(text),
    designNotes: [],
    source: meta.source || null,
    adapter: meta.fromPdf ? 'pdf' : 'text',
    fidelity: 'low',
    // Surfaced in the UI so a poor extraction is visibly poor.
    extractionWarning: meta.fromPdf
      ? 'Extracted from PDF text. Column order and formatting markers are '
        + 'often lost, so feature boundaries and levels may be wrong. Check '
        + 'them before trusting the analysis.'
      : null,
    ingestedAt: new Date().toISOString(),
    mapped: false,
  };
}

/* ================================================================== */
/* dispatch                                                            */
/* ================================================================== */

const CLASS_NAMES = [
  'barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk',
  'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard',
];

function guessClass(text) {
  const head = String(text).slice(0, 3000).toLowerCase();
  let best = null;
  let bestCount = 0;
  for (const c of CLASS_NAMES) {
    const n = (head.match(new RegExp(`\\b${c}\\b`, 'g')) || []).length;
    if (n > bestCount) { bestCount = n; best = c; }
  }
  return best;
}

/** Pick an adapter from the filename and content. */
export function detect(filename = '', content = '') {
  const name = String(filename).toLowerCase();
  if (name.endsWith('.json')) return 'open5e';
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'html';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown';
  if (name.endsWith('.pdf')) return 'pdf';
  const head = String(content).slice(0, 500).trim();
  if (head.startsWith('{') || head.startsWith('[')) return 'open5e';
  if (/^#{1,6}\s/m.test(String(content).slice(0, 2000))) return 'markdown';
  if (/<html|<body|<div/i.test(head)) return 'html';
  return 'text';
}

/**
 * Parse content with the right adapter.
 * HTML is handled by the caller (it needs the sandboxed iframe), so this
 * throws for 'html' rather than silently producing a worse result.
 */
export function parse(kind, content, meta = {}) {
  switch (kind) {
    case 'open5e': return fromOpen5e(content);
    case 'markdown': return fromMarkdown(content, meta);
    case 'pdf': return fromText(content, { ...meta, fromPdf: true });
    case 'text': return fromText(content, meta);
    case 'html':
      throw new Error('html must go through scraper.js (sandboxed iframe)');
    default:
      throw new Error(`unknown adapter "${kind}"`);
  }
}

export const FIDELITY = { high: 1.0, medium: 0.7, low: 0.4 };
