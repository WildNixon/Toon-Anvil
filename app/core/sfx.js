/**
 * Short sounds for moments: a die landing, a crit, a clock striking.
 *
 * The recordings are a vendored CC0 pack under assets/sfx/ - real files,
 * each one named in assets/sfx/manifest.json with where it came from and
 * what was done to it (see ATTRIBUTION.md). They are decoded once into
 * buffers and played through the audio core's master gain, so the ambience
 * beds and these share one volume and one page-hide rule.
 *
 * play() answers in words, in this order, and touches Web Audio only past
 * the third gate:
 *
 *   unknown id      -> "no sting called ..."   (a typo is not a sound)
 *   sound is off    -> "sound is off on this device"
 *   not unlocked    -> "audio is not unlocked yet"
 *   not decoded     -> "still loading" - and starts the load. A sting that
 *                      arrives a second late is worse than none at all.
 *
 * The first two gates are what keep every gym frame silent: a framed copy
 * of the app never counts as enabled, so nothing here ever constructs.
 */

import * as audio from './audio.js';

export const PACK_BASE = './assets/sfx/';

/** id -> { label, file, gain }. Gains sit in (0, 0.5) like the beds do. */
export const STINGS = {
  dice: { label: 'Dice', file: 'dice.mp3', gain: 0.35 },
  crit: { label: 'Critical hit', file: 'crit.mp3', gain: 0.42 },
  fumble: { label: 'Natural one', file: 'fumble.mp3', gain: 0.35 },
  hit: { label: 'Took a hit', file: 'hit.mp3', gain: 0.34 },
  heal: { label: 'Healed', file: 'heal.mp3', gain: 0.3 },
  downed: { label: 'Down', file: 'downed.mp3', gain: 0.42 },
  'death-tick': { label: 'Death save', file: 'death-tick.mp3', gain: 0.36 },
  revive: { label: 'Back on your feet', file: 'revive.mp3', gain: 0.4 },
  'your-turn': { label: 'Your turn', file: 'your-turn.mp3', gain: 0.36 },
  round: { label: 'New round', file: 'round.mp3', gain: 0.3 },
  'session-start': { label: 'The session begins', file: 'session-start.mp3', gain: 0.4 },
  'table-closed': { label: 'The table closed', file: 'table-closed.mp3', gain: 0.3 },
  'level-up': { label: 'Level up', file: 'level-up.mp3', gain: 0.42 },
  'clock-tick': { label: 'Clock tick', file: 'clock-tick.mp3', gain: 0.26 },
  'clock-strike': { label: 'Clock strikes', file: 'clock-strike.mp3', gain: 0.42 },
  'spell-cast': { label: 'Spell cast', file: 'spell-cast.mp3', gain: 0.3 },
  'rest-long': { label: 'Long rest', file: 'rest-long.mp3', gain: 0.3 },
};

const buffers = new Map();
const loading = new Map();

function decode(ctx, bytes) {
  // The callback form works on every browser that has Web Audio at all;
  // the promise form is missing on older Safari.
  return new Promise((resolve, reject) => {
    try { ctx.decodeAudioData(bytes, resolve, reject); } catch (err) { reject(err); }
  });
}

/** Fetch and decode one sting. Resolves to its buffer; cached after. */
export function load(id) {
  const sting = STINGS[id];
  if (!sting) return Promise.reject(new Error(`no sting called "${id}"`));
  if (buffers.has(id)) return Promise.resolve(buffers.get(id));
  if (loading.has(id)) return loading.get(id);
  const ctx = audio.context();
  if (!ctx) return Promise.reject(new Error('no audio context yet'));
  const p = fetch(PACK_BASE + sting.file)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((bytes) => decode(ctx, bytes))
    .then((buf) => { buffers.set(id, buf); loading.delete(id); return buf; })
    .catch((err) => { loading.delete(id); throw err; });
  loading.set(id, p);
  return p;
}

/** Decode the whole pack - a couple of hundred KB - once sound is unlocked. */
export function prefetch() {
  for (const id of Object.keys(STINGS)) load(id).catch(() => {});
}

audio.onUnlock(() => prefetch());

/** How many stings are decoded and ready. */
export function ready() { return buffers.size; }

/**
 * Play one sting. Returns { ok } or { ok: false, reason } - never throws,
 * because nothing that calls this should be able to fail because of it.
 */
export function play(id, { gain = 1, rate = 1, pan = 0 } = {}) {
  const sting = STINGS[id];
  if (!sting) return { ok: false, reason: `no sting called "${id}"` };
  if (!audio.enabled()) return { ok: false, reason: 'sound is off on this device' };
  const ctx = audio.context();
  if (!ctx || ctx.state !== 'running') {
    return { ok: false, reason: 'audio is not unlocked yet' };
  }
  const buf = buffers.get(id);
  if (!buf) {
    load(id).catch(() => {});
    return { ok: false, reason: 'still loading' };
  }
  try {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = sting.gain * gain;
    let tail = src.connect(g);
    if (pan && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      tail = tail.connect(p);
    }
    tail.connect(audio.master());
    src.start(0);
    return { ok: true, id };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
