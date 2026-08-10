/**
 * The campaign map: an image you hold, pan, zoom and pin.
 *
 * No libraries. A clipping frame holds a transformed layer; the wheel zooms
 * about the cursor, pointer capture drags, and pins are real absolutely-
 * positioned BUTTONS counter-scaled against the zoom so they stay one size -
 * buttons because a pin you can focus, click and read by screen reader is a
 * pin, and a painted dot is not.
 *
 * Pin coordinates are normalized 0..1 so the same record fits any screen.
 * Writes happen on pointerup only - a base64 map record PUT per drag-move
 * would hammer the wire for nothing.
 *
 * Two faces, one component: the Deck mounts it editable; the players' view
 * mounts it read-only over a record the server already redacted (revealed
 * pins only, notes stripped) - nothing to hide client-side, because the
 * client was never sent it.
 */

import { el } from '../core/store.js';

export const PIN_KINDS = ['location', 'npc', 'faction', 'quest', 'party'];

const PIN_GLYPH = {
  location: '◆', npc: '●', faction: '▲', quest: '★', party: '⚑',
};

export function mapView(host, {
  record,
  editable = false,
  regions = [],
  onChange = null,
  onPartyMoved = null,
  // Battle tokens: circular initial-chips in the same counter-scaled layer
  // as the pins. [{id, label, x, y, side?, colour?}], coordinates 0..1.
  // Display state belongs to the caller; a finished drag reports through
  // onTokenMoved(id, x, y) - one call per drop, like pin writes.
  tokens = null,
  tokensEditable = false,
  onTokenMoved = null,
}) {
  let k = 1;
  let px = 0;
  let py = 0;
  let editing = null;      // pin id with the editor open

  const frame = el('div', { class: 'map-frame' });
  const layer = el('div', { class: 'map-layer' });
  const img = el('img', {
    class: 'map-img', src: record.image, alt: record.name || 'Campaign map',
    draggable: 'false',
  });
  layer.append(img);
  frame.append(layer);
  host.append(frame);

  const editor = el('div', { class: 'map-editor', hidden: true });
  host.append(editor);

  const apply = () => {
    layer.style.transform = `translate(${px}px, ${py}px) scale(${k})`;
    layer.style.setProperty('--k', String(k));
  };

  /* ---- zoom about the cursor -------------------------------------- */
  frame.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = frame.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const next = Math.min(8, Math.max(0.2, k * (1.0015 ** -e.deltaY)));
    px = cx - ((cx - px) * (next / k));
    py = cy - ((cy - py) * (next / k));
    k = next;
    apply();
  }, { passive: false });

  /* ---- pan (and pin drag) ------------------------------------------ */
  let drag = null;
  frame.addEventListener('pointerdown', (e) => {
    const tokenBtn = e.target.closest?.('.map-token');
    const pinBtn = e.target.closest?.('.map-pin');
    if (tokenBtn && tokensEditable) {
      drag = { kind: 'token', id: tokenBtn.dataset.id, moved: false };
    } else if (pinBtn && editable) {
      drag = { kind: 'pin', id: pinBtn.dataset.id, moved: false };
    } else {
      drag = { kind: 'pan', x: e.clientX - px, y: e.clientY - py };
    }
    // try/catch: synthetic pointer events (the UI tests) have no active
    // pointer to capture, and a throw here would kill the drag machinery.
    try { frame.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  });
  const layerPoint = (e) => {
    const rect = layer.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };
  frame.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.kind === 'pan') {
      px = e.clientX - drag.x;
      py = e.clientY - drag.y;
      apply();
    } else if (drag.kind === 'token') {
      const t = (tokens || []).find((x) => x.id === drag.id);
      if (!t) return;
      const p = layerPoint(e);
      t.x = p.x;
      t.y = p.y;
      drag.moved = true;
      drawTokens();
    } else {
      const pin = (record.pins || []).find((x) => x.id === drag.id);
      if (!pin) return;
      const p = layerPoint(e);
      pin.x = p.x;
      pin.y = p.y;
      drag.moved = true;
      drawPins();
    }
  });
  frame.addEventListener('pointerup', (e) => {
    if (drag?.kind === 'pin' && drag.moved) {
      // One write per drop, not per twitch.
      onChange?.(record);
      const pin = (record.pins || []).find((x) => x.id === drag.id);
      if (pin?.kind === 'party') settleParty(pin);
    }
    if (drag?.kind === 'token' && drag.moved) {
      const t = (tokens || []).find((x) => x.id === drag.id);
      if (t) onTokenMoved?.(t.id, t.x, t.y);
    }
    drag = null;
    try { frame.releasePointerCapture(e.pointerId); } catch { /* gone */ }
  });

  /** The party pin adopts the region of the nearest regioned pin. */
  function settleParty(party) {
    let best = null;
    for (const p of record.pins || []) {
      if (p === party || !p.regionId) continue;
      const d = Math.hypot(p.x - party.x, p.y - party.y);
      if (d < 0.06 && (!best || d < best.d)) best = { d, regionId: p.regionId };
    }
    if (best) onPartyMoved?.(best.regionId);
  }

  /* ---- pins --------------------------------------------------------- */
  function drawPins() {
    for (const old of layer.querySelectorAll('.map-pin')) old.remove();
    for (const pin of record.pins || []) {
      const btn = el('button', {
        class: `map-pin${pin.revealed ? '' : ' hidden-pin'}`,
        'data-id': pin.id,
        'data-kind': pin.kind,
        style: `left:${(pin.x * 100).toFixed(2)}%;top:${(pin.y * 100).toFixed(2)}%`,
        // The note rides the tooltip: hover answers "what is this place"
        // without opening the editor.
        title: pin.note ? `${pin.label} — ${pin.note}` : pin.label,
        'aria-label': `${pin.label} — ${pin.kind}`
          + (pin.revealed ? '' : ' (hidden from players)'),
        onClick: () => {
          if (drag?.moved) return;
          editing = editing === pin.id ? null : pin.id;
          drawEditor();
        },
      }, PIN_GLYPH[pin.kind] || '◆');
      layer.append(btn);
    }
  }

  /* ---- the pin editor (editable face only) -------------------------- */
  function drawEditor() {
    const pin = (record.pins || []).find((x) => x.id === editing);
    if (!pin) { editor.hidden = true; editor.innerHTML = ''; return; }
    editor.hidden = false;
    editor.innerHTML = '';

    const strong = el('strong', {}, pin.label || 'Unnamed pin');
    editor.append(strong);
    if (!editable) {
      // Read-only face: the label and, one day, the linked record.
      return;
    }

    const label = el('input', {
      type: 'text', value: pin.label || '', 'aria-label': 'Pin label',
      style: 'max-width:200px',
    });
    label.addEventListener('change', () => {
      pin.label = label.value.trim();
      onChange?.(record);
      drawPins();
    });

    const kind = el('select', { 'aria-label': 'Pin kind', style: 'width:auto' });
    for (const kd of PIN_KINDS) {
      kind.append(el('option', { value: kd, selected: kd === pin.kind }, kd));
    }
    kind.addEventListener('change', () => {
      pin.kind = kind.value;
      onChange?.(record);
      drawPins();
    });

    const region = el('select', {
      'aria-label': 'Pin region', style: 'width:auto',
    });
    region.append(el('option', { value: '' }, 'no region'));
    for (const r of regions) {
      region.append(el('option', {
        value: r.id, selected: r.id === pin.regionId,
      }, r.name));
    }
    region.addEventListener('change', () => {
      pin.regionId = region.value || null;
      onChange?.(record);
      if (pin.kind === 'party' && pin.regionId) onPartyMoved?.(pin.regionId);
    });

    const revealed = el('button', {
      class: `act ${pin.revealed ? '' : 'ghost'} small`,
      title: 'Whether players can see this pin at all',
      onClick: () => {
        pin.revealed = !pin.revealed;
        onChange?.(record);
        drawPins();
        drawEditor();
      },
    }, pin.revealed ? 'Revealed' : 'Hidden');

    const del = el('button', {
      class: 'act ghost small',
      onClick: () => {
        record.pins = (record.pins || []).filter((x) => x.id !== pin.id);
        editing = null;
        onChange?.(record);
        drawPins();
        drawEditor();
      },
    }, 'Remove');

    editor.append(label, kind, region, revealed, del);
  }

  /* ---- adding pins (editable face) ---------------------------------- */
  let placing = null;
  function armPlacement(kindName) {
    placing = kindName;
    frame.classList.add('placing');
  }
  frame.addEventListener('click', (e) => {
    if (!placing || e.target.closest?.('.map-pin')) return;
    const rect = layer.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    const pin = {
      id: `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      x, y, kind: placing, label: `New ${placing}`, linkId: null,
      regionId: null, note: '', revealed: placing === 'party',
    };
    record.pins = [...(record.pins || []), pin];
    placing = null;
    frame.classList.remove('placing');
    onChange?.(record);
    drawPins();
    editing = pin.id;
    drawEditor();
  });

  /* ---- battle tokens ------------------------------------------------ */
  const initials = (label) => String(label || '?').trim().split(/\s+/)
    .map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  function drawTokens() {
    for (const old of layer.querySelectorAll('.map-token')) old.remove();
    for (const t of tokens || []) {
      layer.append(el('button', {
        class: 'map-token',
        'data-id': t.id,
        'data-side': t.side || 'enemy',
        title: t.label,
        'aria-label': `${t.label} — battle token`,
        style: `left:${(t.x * 100).toFixed(2)}%;top:${(t.y * 100).toFixed(2)}%`
          + (t.colour ? `;background:${t.colour}` : ''),
      }, initials(t.label)));
    }
  }

  apply();
  drawPins();
  if (tokens) drawTokens();

  return {
    armPlacement,
    redrawPins: drawPins,
    redrawTokens: drawTokens,
    destroy: () => { frame.remove(); editor.remove(); },
  };
}
