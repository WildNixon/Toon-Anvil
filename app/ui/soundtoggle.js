/**
 * The speaker: one button that turns sound effects on or off for this
 * device, and is the user gesture that unlocks audio when it turns them on.
 *
 * Textless on purpose. The gym finds buttons by their visible text, and the
 * ribbon sits before <main> in the document - a button reading "Sound" would
 * be found first by some lookup one day. An SVG with an aria-label is
 * invisible to text lookups and perfectly visible to a screen reader.
 */

import { el } from '../core/store.js';
import * as audio from '../core/audio.js';
import * as sfx from '../core/sfx.js';

const ICON_ON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" '
  + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" '
  + 'stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/>'
  + '<path d="M16 8.5a4.5 4.5 0 0 1 0 7"/><path d="M18.5 5.5a8 8 0 0 1 0 13"/></svg>';
const ICON_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" '
  + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" '
  + 'stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/>'
  + '<path d="M16 9l5 6M21 9l-5 6"/></svg>';

// The switch shows the CHOICE (audio.chosen), not whether sound may play
// right now (audio.enabled) - a framed copy of the app can never play, but
// its switch must still turn off again after it was turned on.
function paint(btn) {
  const on = audio.chosen();
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Sound effects: on - tap to turn off'
    : 'Sound effects: off - tap to turn on';
  btn.innerHTML = on ? ICON_ON : ICON_OFF;
}

/**
 * The button. `compact` is the ribbon size; the default is the Settings
 * and Stage size. Turning sound on plays one die so the tap answers itself.
 */
export function soundButton({ compact = false } = {}) {
  const btn = el('button', {
    class: 'sound-toggle' + (compact ? ' compact' : ''),
    type: 'button',
    'aria-label': 'Sound effects',
    onClick: () => {
      const now = audio.setEnabled(!audio.chosen());
      paint(btn);
      if (now) {
        sfx.prefetch();
        sfx.load('dice').then(() => sfx.play('dice', { gain: 0.6 })).catch(() => {});
      }
    },
  });
  paint(btn);
  return btn;
}
