/**
 * Small canvas charts for the Deck's dials - dials, not dashboards.
 *
 * Colours come from the CSS tokens at draw time, so a chart is correct in
 * parchment and candlelight both; the canvas is scaled by devicePixelRatio
 * so the lines are crisp on any screen. The ghost-track and dashed-reference
 * tricks come from the gym's own charts, which proved them.
 */

const cssColour = (nameOrValue) => {
  if (String(nameOrValue).startsWith('--')) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(nameOrValue).trim() || '#888';
  }
  return nameOrValue;
};

const PALETTE = ['--accent', '--accent-2', '--gold', '--ok', '--warn', '--bad'];

function prep(canvas, height) {
  const cssW = canvas.clientWidth || canvas.parentElement?.clientWidth || 600;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = '100%';
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(height * dpr);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  return { g, w: cssW, h: height };
}

/**
 * Line series. series: [{ label, colour?, points: [{x, y}] }] - x in any
 * monotonic unit (days), y numeric. refY draws a dashed reference line.
 */
export function lineChart(canvas, { series, yMin = null, yMax = null,
  refY = null, height = 150 }) {
  const { g, w, h } = prep(canvas, height);
  const pad = { l: 34, r: 10, t: 10, b: 20 };

  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  if (!xs.length) return;
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  let lo = yMin !== null ? yMin : Math.min(...ys, refY ?? Infinity);
  let hi = yMax !== null ? yMax : Math.max(...ys, refY ?? -Infinity);
  if (lo === hi) { lo -= 1; hi += 1; }

  const X = (x) => pad.l + ((x - x0) / Math.max(1e-9, x1 - x0)) * (w - pad.l - pad.r);
  const Y = (y) => h - pad.b - ((y - lo) / (hi - lo)) * (h - pad.t - pad.b);

  const ink = cssColour('--muted');
  g.font = '10px "Plex Mono", monospace';
  g.fillStyle = ink;
  g.fillText(String(Math.round(hi)), 4, Y(hi) + 4);
  g.fillText(String(Math.round(lo)), 4, Y(lo) + 4);

  if (refY !== null && refY >= lo && refY <= hi) {
    g.strokeStyle = ink;
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(pad.l, Y(refY));
    g.lineTo(w - pad.r, Y(refY));
    g.stroke();
    g.setLineDash([]);
  }

  series.forEach((s, i) => {
    if (!s.points.length) return;
    g.strokeStyle = cssColour(s.colour || PALETTE[i % PALETTE.length]);
    g.lineWidth = 2;
    g.beginPath();
    const sorted = [...s.points].sort((a, b) => a.x - b.x);
    sorted.forEach((p, j) => {
      if (j === 0) g.moveTo(X(p.x), Y(p.y));
      else g.lineTo(X(p.x), Y(p.y));
    });
    g.stroke();
    // A dot on the latest reading - the number that matters today.
    const last = sorted[sorted.length - 1];
    g.fillStyle = g.strokeStyle;
    g.beginPath();
    g.arc(X(last.x), Y(last.y), 3, 0, Math.PI * 2);
    g.fill();
  });
}

/** Bars with a ghost track - a shortfall you can see. */
export function barChart(canvas, { bars, max = null, height = 150 }) {
  const { g, w, h } = prep(canvas, height);
  const pad = { l: 10, r: 10, t: 8, b: 22 };
  if (!bars.length) return;
  const top = max !== null ? max : Math.max(...bars.map((b) => b.value), 1);
  const bw = (w - pad.l - pad.r) / bars.length;
  const track = cssColour('--etch');
  const ink = cssColour('--muted');

  bars.forEach((b, i) => {
    const x = pad.l + i * bw + 4;
    const width = bw - 8;
    const full = h - pad.t - pad.b;
    const val = Math.max(0, Math.min(1, b.value / top)) * full;
    g.fillStyle = track;
    g.fillRect(x, pad.t, width, full);
    g.fillStyle = cssColour(b.colour || PALETTE[i % PALETTE.length]);
    g.fillRect(x, pad.t + full - val, width, val);
    g.fillStyle = ink;
    g.font = '9px "Plex Mono", monospace';
    g.textAlign = 'center';
    g.fillText(String(b.label).slice(0, 12), x + width / 2, h - 8);
  });
  g.textAlign = 'left';
}
