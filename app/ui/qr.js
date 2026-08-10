/**
 * The join QR - a phone camera types the address so nobody has to.
 *
 * Wraps the vendored Nayuki encoder (app/ui/vendor/qrcodegen.js) behind two
 * pure functions: a boolean matrix the tests can interrogate and an SVG
 * string for the screen. String in, string out - no DOM here, so the logic
 * tier grades the encoder without a browser.
 *
 * The QR is always black on white regardless of theme: a scanner wants
 * contrast, not candlelight.
 */

import { QrCode } from './vendor/qrcodegen.js';

/** The module matrix for a payload: rows of booleans, true = dark. */
export function qrMatrix(text) {
  const qr = QrCode.encodeText(String(text), QrCode.Ecc.MEDIUM);
  const rows = [];
  for (let y = 0; y < qr.size; y += 1) {
    const row = [];
    for (let x = 0; x < qr.size; x += 1) row.push(qr.getModule(x, y));
    rows.push(row);
  }
  return rows;
}

/**
 * An SVG string of the code, quiet zone included. The payload never enters
 * the markup as text - only as path coordinates - so there is nothing to
 * escape and nothing to inject.
 */
export function qrSvg(text, { border = 4 } = {}) {
  const m = qrMatrix(text);
  const size = m.length + border * 2;
  const parts = [];
  for (let y = 0; y < m.length; y += 1) {
    for (let x = 0; x < m.length; x += 1) {
      if (m[y][x]) parts.push(`M${x + border} ${y + border}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"`
    + ' role="img" aria-label="Join QR code" shape-rendering="crispEdges">'
    + `<rect width="${size}" height="${size}" fill="#fff"/>`
    + `<path d="${parts.join('')}" fill="#000"/></svg>`;
}
