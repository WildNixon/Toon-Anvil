/**
 * Emit a standalone HTML page for an analysed homebrew.
 *
 * Self-contained by design: inline CSS and JS, no external requests, no fonts
 * fetched from a CDN. It opens from a USB stick or an email attachment, which
 * is how homebrew actually travels.
 *
 * The visual language is lifted from the three source pages in D:\Dnd - heavy
 * display caps, letterpress panels with a hard top border, mono uppercase
 * eyebrows, a level badge per feature. An ingested brew keeps its own accent
 * colour where it had one.
 *
 * Two things the page is careful about:
 *   - Every balance change is shown as a DIFF with the measurement that
 *     justified it, and there is an original/balanced toggle. The machine's
 *     opinion is visible and rejectable.
 *   - Every line of play advice is tagged with the basis it came from.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/** Trusted-ish inline markdown from ingested prose. Escaped first. */
function md(text) {
  return esc(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/_(.+?)_/g, '<em>$1</em>')
      .replace(/\n/g, '<br>')}</p>`)
    .join('');
}

const BASIS_LABEL = {
  measured: 'measured',
  quoted: 'from the text',
  derived: 'implication',
  comparative: 'compared',
};

function styles(accent) {
  const a = accent || '#b84a16';
  return `
:root{--iron:#1c2124;--slag:#3a4247;--steel:#d2d6d3;--plate:#c0c6c4;
 --zinc:#eef1ef;--accent:${a};--verd:#2f6b62;--etch:rgba(28,33,36,.2)}
*{box-sizing:border-box}
body{margin:0;background:var(--steel);color:var(--iron);
 font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.62;
 background-image:repeating-linear-gradient(90deg,rgba(255,255,255,.16) 0 1px,transparent 1px 3px),
  radial-gradient(circle at 78% 4%,${a}1f,transparent 44%)}
.wrap{max-width:860px;margin:0 auto;padding:0 22px 96px}
h1,h2,h3{font-family:'Arial Black',Impact,sans-serif;font-weight:400;line-height:1.02;
 text-transform:uppercase;margin:0;letter-spacing:-.01em}
p{margin:0 0 1em}
header{padding:52px 0 22px}
header h1{font-size:clamp(40px,10vw,84px)}
header h1 em{font-style:normal;color:var(--accent);display:block}
.eyebrow{font-family:Consolas,monospace;font-size:11px;letter-spacing:.24em;
 text-transform:uppercase;color:var(--slag)}
.rule{height:6px;background:var(--iron);margin:20px 0 16px;position:relative}
.rule::after{content:"";position:absolute;right:0;top:0;height:6px;width:22%;background:var(--accent)}
.quote{font-style:italic;font-size:20px;max-width:46ch;border-left:3px solid var(--accent);
 padding-left:16px;margin:22px 0 0}
.lede{font-size:18px;max-width:62ch}
section{margin-top:48px}
.head{display:flex;align-items:center;gap:14px;margin-bottom:20px}
.head h2{font-size:clamp(24px,5vw,34px)}
.head .bar{flex:1;height:3px;background:var(--etch)}
.panel{background:var(--plate);padding:22px;margin-bottom:16px;border-radius:2px;
 border-top:4px solid var(--iron);box-shadow:0 2px 0 rgba(28,33,36,.16);position:relative}
.panel::before,.panel::after{content:"";position:absolute;top:12px;width:7px;height:7px;
 border-radius:50%;background:var(--slag);opacity:.5}
.panel::before{left:10px}.panel::after{right:10px}
.panel h3{font-size:24px;color:var(--accent);margin-bottom:10px}
.lvl{display:inline-block;font-family:Consolas,monospace;font-size:10px;font-weight:700;
 letter-spacing:.18em;text-transform:uppercase;background:var(--iron);color:var(--zinc);
 padding:3px 9px;border-radius:2px;margin-bottom:9px}
.lvl.accent{background:var(--accent)}
table{width:100%;border-collapse:collapse;margin-bottom:1em}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--etch)}
th{font-family:Consolas,monospace;font-size:10px;letter-spacing:.14em;
 text-transform:uppercase;color:var(--slag)}
td:first-child{font-family:Consolas,monospace;font-weight:700;width:52px}
.verdict{background:var(--iron);color:var(--zinc);padding:24px;border-radius:2px;margin:34px 0}
.verdict h2{color:var(--accent);font-size:26px;margin-bottom:6px}
.verdict p{color:rgba(238,241,239,.86)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin:18px 0}
.stat{background:rgba(238,241,239,.08);padding:11px;border-radius:2px}
.stat .k{font-family:Consolas,monospace;font-size:10px;letter-spacing:.14em;
 text-transform:uppercase;color:rgba(238,241,239,.55)}
.stat .v{font-family:'Arial Black',sans-serif;font-size:22px;color:var(--zinc)}
.chip{display:inline-block;font-family:Consolas,monospace;font-size:10px;font-weight:700;
 letter-spacing:.1em;text-transform:uppercase;padding:3px 8px;border-radius:999px;
 background:var(--etch);color:var(--iron)}
.chip.ok{background:var(--verd);color:#fff}
.chip.warn{background:#9a6a12;color:#fff}
.chip.bad{background:#a3301a;color:#fff}
.chip.accent{background:var(--accent);color:#fff}
.insight{padding:12px 0;border-bottom:1px solid var(--etch)}
.insight:last-child{border-bottom:0}
.insight .h{font-weight:700;display:flex;gap:9px;align-items:baseline;flex-wrap:wrap}
.insight .d{color:var(--slag);font-size:15px;margin-top:3px}
.diff{font-family:Consolas,monospace;font-size:13px;background:rgba(238,241,239,.08);
 padding:10px 12px;border-left:3px solid var(--accent);margin:8px 0;border-radius:2px}
.toggle{display:flex;gap:8px;margin:14px 0}
.toggle button{font-family:Consolas,monospace;font-size:11px;font-weight:700;letter-spacing:.12em;
 text-transform:uppercase;padding:9px 14px;border:1px solid var(--accent);border-radius:2px;
 background:transparent;color:var(--accent);cursor:pointer}
.toggle button[aria-pressed="true"]{background:var(--accent);color:#fff}
footer{margin-top:52px;padding-top:18px;border-top:3px solid var(--etch);
 font-family:Consolas,monospace;font-size:11px;letter-spacing:.06em;color:var(--slag)}
footer a{color:var(--slag)}
.warn-box{background:#fdf3e7;border-left:4px solid #9a6a12;padding:13px 15px;margin:18px 0}
@media print{body{background:#fff}.panel{break-inside:avoid}.toggle{display:none}}
`;
}

/* ------------------------------------------------------------------ */

function featurePanels(features, balancedIds = new Set()) {
  return features.map((f) => {
    const live = (f.effects || []).filter((e) => e.type !== 'narrative_only');
    const changed = balancedIds.has(f.id);
    return `<div class="panel">
      <span class="lvl${changed ? ' accent' : ''}">Level ${f.level}</span>
      ${changed ? '<span class="chip accent" style="margin-left:8px">adjusted</span>' : ''}
      <h3>${esc(f.name)}</h3>
      ${md(f.text)}
      ${live.length ? `<p class="eyebrow">${live.length} live mechanic${live.length > 1 ? 's' : ''}: ${
        live.map((e) => esc(e.type)).join(', ')}</p>` : ''}
    </div>`;
  }).join('');
}

function rollTableSection(tables) {
  if (!tables?.length) return '';
  return tables.map((t) => `<section>
    <div class="head"><h2>${esc(t.name)}</h2><div class="bar"></div></div>
    <div class="panel"><table>
      ${t.entries.map((e) => `<tr><td>${e.n}</td><td>${esc(e.text)}</td></tr>`).join('')}
    </table></div></section>`).join('');
}

function verdictBlock(analysis) {
  if (!analysis) return '';
  const { composite, axes, sibling, inBand, changes = [], metricVersion } = analysis;
  const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`;
  return `<div class="verdict">
    <div class="eyebrow" style="color:var(--accent)">Balance</div>
    <h2>${inBand ? 'Balanced' : 'Outside the band'}</h2>
    <p>Measured against <strong>${esc(sibling?.name || 'its SRD sibling')}</strong>
      over simulated campaigns to level 20.
      Composite <strong>${pct(composite)}</strong>
      ${inBand ? '&mdash; inside the &plusmn;10% band.' : '&mdash; outside the &plusmn;10% band.'}</p>
    <div class="stats">
      <div class="stat"><div class="k">Damage</div><div class="v">${pct(axes.dDmg)}</div></div>
      <div class="stat"><div class="k">Survivability</div><div class="v">${pct(axes.dSurv)}</div></div>
      <div class="stat"><div class="k">Control</div><div class="v">${pct(axes.dCtl)}</div></div>
    </div>
    ${changes.length ? `
      <div class="eyebrow" style="color:var(--accent);margin-top:14px">What was changed</div>
      ${changes.map((c) => `<div class="diff">${esc(c.knob)}:
        <strong>${esc(String(c.from))} &rarr; ${esc(String(c.to))}</strong><br>
        ${c.evidence ? esc(c.evidence) : `composite &rarr; ${pct(c.compositeAfter)}`}</div>`).join('')}
      <div class="toggle" role="group" aria-label="Show original or balanced">
        <button data-v="balanced" aria-pressed="true">Balanced</button>
        <button data-v="original" aria-pressed="false">Original</button>
      </div>
      <p style="font-size:14px;color:rgba(238,241,239,.6)">
        These adjustments are this tool's opinion, computed under metric
        ${esc(metricVersion || 'v2')}. A subclass can be deliberately strong for a
        particular table &mdash; the original is one click away and the source file
        was never modified.</p>`
      : `<p style="font-size:14px;color:rgba(238,241,239,.6)">${
        inBand
          ? 'No changes were needed &mdash; this is already inside the band.'
          : 'Auto-balance was not run, so nothing here has been changed. The '
            + 'measurement above says it sits outside the band; whether that is '
            + 'a problem is a decision for your table. Re-run with auto-balance '
            + 'to see what the tool would propose.'}</p>`}
  </div>`;
}

function guideSection(guide) {
  if (!guide) return '';
  const block = (title, items) => (items?.length ? `
    <div class="head"><h2>${title}</h2><div class="bar"></div></div>
    <div class="panel">
      ${items.map((i) => `<div class="insight">
        <div class="h">${esc(i.headline)}
          <span class="chip">${esc(BASIS_LABEL[i.basis] || i.basis)}</span></div>
        <div class="d">${esc(i.detail)}</div>
      </div>`).join('')}
    </div>` : '');

  return `<section>
    ${block('How to play it', guide.combat)}
    ${block('At the table', guide.roleplay)}
    ${block('How it compares', guide.comparative)}
    ${guide.limits?.length ? `<div class="warn-box">
      <strong>What this guide could not tell you</strong>
      <ul>${guide.limits.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>` : ''}
  </section>`;
}

/* ------------------------------------------------------------------ */

/**
 * @param {object} cfg {brew, original, analysis, guide, coverage}
 * @returns {string} a complete standalone HTML document
 */
export function emitHtml(cfg) {
  const { brew, original = null, analysis = null, guide = null, coverage = null } = cfg;
  const accent = brew.accent || null;

  const changedIds = new Set(
    (analysis?.changes || []).map((c) => c.featureId).filter(Boolean),
  );

  const lowFidelity = brew.fidelity === 'low' || brew.extractionWarning;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(brew.name)} — analysed by Toon Anvil</title>
<style>${styles(accent)}</style></head>
<body><div class="wrap">

<header>
  <div class="eyebrow">${esc(brew.flavor?.eyebrow || `${brew.class || ''} subclass`)}
    ${brew.ruleset ? `· D&amp;D ${esc(brew.ruleset)}` : ''}</div>
  <h1>${esc(brew.name)}</h1>
  <div class="rule"></div>
  ${brew.flavor?.subtitle ? `<div class="eyebrow">${esc(brew.flavor.subtitle)}</div>` : ''}
  ${brew.flavor?.quote ? `<p class="quote">"${esc(brew.flavor.quote)}"</p>` : ''}
</header>

${(brew.flavor?.lede || []).map((l) => `<p class="lede">${esc(l)}</p>`).join('')}

${lowFidelity ? `<div class="warn-box"><strong>Low-confidence extraction.</strong>
  ${esc(brew.extractionWarning || 'This was read from a format that loses structure.')}
  Feature boundaries and levels may be wrong; check them against the original
  before trusting the analysis below.</div>` : ''}

${verdictBlock(analysis)}

<section>
  <div class="head"><h2>Features</h2><div class="bar"></div></div>
  <div id="features">${featurePanels(brew.features, changedIds)}</div>
  ${original ? `<template id="original-features">${
    featurePanels(original.features)}</template>` : ''}
</section>

${rollTableSection(brew.rollTables)}
${guideSection(guide)}

${coverage ? `<section>
  <div class="head"><h2>How much of this is live</h2><div class="bar"></div></div>
  <div class="panel">
    <p>${coverage.live} of ${coverage.features} features have machine-readable
    mechanics (${coverage.effects} effects total). The rest render as text and
    play fine &mdash; they are simply not simulated, so the balance numbers above
    do not account for them.</p>
    <p class="eyebrow">Adapter: ${esc(brew.adapter || 'html')} · fidelity ${esc(brew.fidelity || 'high')}</p>
  </div>
</section>` : ''}

<footer>
  ${brew.source?.document ? `Source: ${esc(brew.source.document)}${
    brew.source.licenseUrl ? ` — <a href="${esc(brew.source.licenseUrl)}">licence</a>` : ''}<br>` : ''}
  Analysed by Toon Anvil${analysis?.metricVersion ? ` under metric ${esc(analysis.metricVersion)}` : ''}
  on ${esc(new Date().toISOString().slice(0, 10))}.
  Balance figures come from simulated campaigns, not from play. Homebrew remains
  the property of its author.
</footer>
</div>

<script>
(function(){
  var tpl = document.getElementById('original-features');
  var host = document.getElementById('features');
  if (!tpl || !host) return;
  var balanced = host.innerHTML;
  document.querySelectorAll('.toggle button').forEach(function(b){
    b.addEventListener('click', function(){
      var v = b.dataset.v;
      host.innerHTML = v === 'original' ? tpl.innerHTML : balanced;
      document.querySelectorAll('.toggle button').forEach(function(o){
        o.setAttribute('aria-pressed', String(o.dataset.v === v));
      });
    });
  });
}());
</script>
</body></html>`;
}

/** Trigger a browser download of the emitted page. */
export function downloadHtml(cfg) {
  const html = emitHtml(cfg);
  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${cfg.brew.id || 'homebrew'}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
  return html;
}
