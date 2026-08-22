/**
 * SPEAK - the DM's voice, changed on the way to the speakers.
 *
 * Microphone in, a pitch shifter and a few effects, out through the audio
 * core's master gain on the DM's own machine. Called "speak" and "timbre"
 * throughout, never "voice": in this app a voice is the LLM-written draft
 * the Improvise panel gives an NPC, and the two must not be confused.
 *
 * Two halves. buildChain() makes the node graph on ANY BaseAudioContext -
 * an OfflineAudioContext in the gym, where the octave is measured, never
 * heard - and the live path owns the microphone stream and the hold-to-
 * speak gain. The live path answers in words, in this order, and touches
 * Web Audio only past the third gate:
 *
 *   no microphone on this device or address   (a phone on --lan: http://<lan-ip>
 *                                               is not a secure context)
 *   the microphone was refused
 *   sound is off on this device               (false in every gym frame by
 *                                               construction - nothing is
 *                                               constructed there)
 *   ...then the chain is built on the core's context, inside the gesture.
 *
 * The microphone is asked for BEFORE the sound gate on purpose: it is what
 * the DM pressed the button for, the browser remembers the grant, and it is
 * the order that lets a framed copy be exercised while still constructing
 * nothing.
 */

import * as audio from './audio.js';
import { seededRng } from './rng.js';

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  pitch: [-12, 12], grain: [0.02, 0.06], tone: [-1, 1], drive: [0, 1],
  reverb: [0, 1], quaver: [0, 1], gain: [0, 2],
};
export const DEFAULTS = {
  pitch: 0, grain: 0.04, tone: 0, drive: 0, reverb: 0, quaver: 0, gain: 1,
};

/** Clamp and fill. Never throws; junk becomes the default. */
export function normalize(settings) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const v = Number(settings?.[key]);
    const [lo, hi] = LIMITS[key];
    out[key] = Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : DEFAULTS[key];
  }
  out.pitch = Math.round(out.pitch);
  return out;
}

/** Semitones -> playback ratio. -12 halves, +12 doubles. */
export const ratioFor = (semitones) => 2 ** ((Number(semitones) || 0) / 12);

/** The menu. `plain` first, so "your own voice" is always one tap away. */
export const PRESETS = {
  plain: { label: 'Plain', line: 'Your own voice, untouched.',
    settings: { ...DEFAULTS } },
  ogre: { label: 'Ogre', line: 'Slow, heavy, from a cave of a chest.',
    settings: { pitch: -7, grain: 0.05, tone: -0.6, drive: 0.35, reverb: 0.15, quaver: 0, gain: 1.1 } },
  goblin: { label: 'Goblin', line: 'Quick and thin, with a rattle in it.',
    settings: { pitch: 6, grain: 0.03, tone: 0.4, drive: 0.15, reverb: 0, quaver: 0.25, gain: 1 } },
  ghost: { label: 'Ghost', line: 'Far away, breathing through a wall.',
    settings: { pitch: 2, grain: 0.06, tone: -0.3, drive: 0, reverb: 0.8, quaver: 0.5, gain: 0.9 } },
  dragon: { label: 'Dragon', line: 'A voice the floor can feel.',
    settings: { pitch: -10, grain: 0.06, tone: -0.5, drive: 0.6, reverb: 0.4, quaver: 0, gain: 1.2 } },
  giant: { label: 'Giant', line: 'Big, slow, not unkind.',
    settings: { pitch: -5, grain: 0.05, tone: -0.4, drive: 0.1, reverb: 0.3, quaver: 0, gain: 1.15 } },
  fey: { label: 'Fey', line: 'Bright, sweet, never quite still.',
    settings: { pitch: 5, grain: 0.03, tone: 0.2, drive: 0, reverb: 0.5, quaver: 0.6, gain: 0.95 } },
  sending: { label: 'Sending', line: 'A message from somewhere else.',
    settings: { pitch: 0, grain: 0.03, tone: 0.9, drive: 0.45, reverb: 0, quaver: 0, gain: 1 } },
};

/* ------------------------------------------------------------------ */
/* the chain                                                           */
/* ------------------------------------------------------------------ */

// One worklet load per context. A WeakMap so an offline context used once
// by the gym is not kept alive by this module.
const worklets = new WeakMap();

function ensureWorklet(ctx) {
  if (!ctx || !ctx.audioWorklet) {
    return Promise.reject(new Error('this browser has no AudioWorklet'));
  }
  let p = worklets.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(new URL('../audio/voice-worklet.js', import.meta.url));
    worklets.set(ctx, p);
  }
  return p;
}

/** A soft-clip curve; k = 0 is the identity. */
function shaperCurve(drive) {
  const k = drive * 50;
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = k ? ((1 + k) * x) / (1 + k * Math.abs(x)) : x;
  }
  return curve;
}

/** Decaying seeded noise: the same room every time it is built. */
function impulse(ctx, seconds) {
  const rng = seededRng('speak-reverb');
  const len = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch += 1) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i += 1) d[i] = (rng.float() * 2 - 1) * (1 - i / len) ** 3;
  }
  return buf;
}

/**
 * Build the graph on `ctx`. Resolves to { ok, chain } or { ok: false,
 * reason }. The chain's output gain starts at ZERO: the live path ramps it
 * up while the button is held, and a test sets it to one.
 *
 *   input -> pitch worklet -> tone filter -> drive shaper
 *         -> [dry] + [reverb -> wet] -> tremolo -> output
 */
export async function buildChain(ctx, settings) {
  const s = normalize(settings);
  try {
    await ensureWorklet(ctx);
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
  let nodes;
  try {
    const input = ctx.createGain();
    const shifter = new AudioWorkletNode(ctx, 'toon-pitch', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    const filter = ctx.createBiquadFilter();
    const shaper = ctx.createWaveShaper();
    shaper.oversample = '2x';
    const dry = ctx.createGain();
    const verb = ctx.createConvolver();
    const wet = ctx.createGain();
    const trem = ctx.createGain();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    const output = ctx.createGain();
    output.gain.value = 0;
    lfo.frequency.value = 5.5;
    input.connect(shifter).connect(filter).connect(shaper);
    shaper.connect(dry).connect(trem);
    shaper.connect(verb).connect(wet).connect(trem);
    lfo.connect(lfoGain).connect(trem.gain);
    lfo.start();
    trem.connect(output);
    nodes = { input, shifter, filter, shaper, dry, verb, wet, trem, lfo, lfoGain, output };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }

  let verbSeconds = 0;
  const chain = {
    ...nodes,
    settings: s,
    /** Retune in place; the pitch slider is live without a rebuild. */
    apply(next) {
      const v = normalize(next);
      chain.settings = v;
      const t = ctx.currentTime;
      nodes.shifter.parameters.get('ratio').setTargetAtTime(ratioFor(v.pitch), t, 0.02);
      nodes.shifter.parameters.get('grain').setTargetAtTime(v.grain, t, 0.02);
      if (v.tone <= 0) {
        nodes.filter.type = 'lowpass';
        nodes.filter.frequency.setTargetAtTime(800 + (1 + v.tone) * 7200, t, 0.02);
      } else {
        nodes.filter.type = 'highpass';
        nodes.filter.frequency.setTargetAtTime(80 + v.tone * 1500, t, 0.02);
      }
      nodes.filter.Q.value = 0.7;
      nodes.shaper.curve = shaperCurve(v.drive);
      if (v.reverb > 0) {
        const seconds = 0.3 + v.reverb * 1.7;
        if (Math.abs(seconds - verbSeconds) > 0.05) {
          nodes.verb.buffer = impulse(ctx, seconds);
          verbSeconds = seconds;
        }
        nodes.wet.gain.setTargetAtTime(v.reverb * 0.6, t, 0.02);
        nodes.dry.gain.setTargetAtTime(1 - v.reverb * 0.4, t, 0.02);
      } else {
        nodes.wet.gain.setTargetAtTime(0, t, 0.02);
        nodes.dry.gain.setTargetAtTime(1, t, 0.02);
      }
      nodes.trem.gain.setTargetAtTime(1 - v.quaver * 0.5, t, 0.02);
      nodes.lfoGain.gain.setTargetAtTime(v.quaver * 0.5, t, 0.02);
      return v;
    },
    dispose() {
      try { nodes.lfo.stop(); } catch { /* already */ }
      try { nodes.shifter.port.postMessage('stop'); } catch { /* gone */ }
      for (const n of Object.values(nodes)) { try { n.disconnect(); } catch { /* fine */ } }
    },
  };
  // Set the initial values directly rather than by ramp, so a render that
  // starts at t = 0 is already in tune.
  nodes.shifter.parameters.get('ratio').value = ratioFor(s.pitch);
  nodes.shifter.parameters.get('grain').value = s.grain;
  chain.apply(s);
  return { ok: true, chain };
}

/* ------------------------------------------------------------------ */
/* the home - a saved timbre per NPC and per monster                   */
/* ------------------------------------------------------------------ */

/*
 * A timbre is DM-only prep, so it lives on the campaign record - which the
 * server redacts for players - exactly as prepared encounters do. NOT on
 * the npcs record (a shared kind with no redactor: every seated player
 * could read it, and monsters would have nowhere to live) and NOT on the
 * combatant (snapshot() sends it over the wire to every seat). With no
 * campaign open - a solo DM mid-fight - it falls back to this machine's own
 * localStorage, which is the right scope anyway: the microphone and the
 * speakers are this machine's.
 */

const LOCAL_KEY = 'toonanvil.timbres';

/** How a thing is addressed: a monster by its kind, a custom by its name,
 *  an NPC by its id. PCs never carry a timbre (a DM decision) -> null. */
export function refFor(thing) {
  if (!thing) return null;
  if (typeof thing.id === 'string' && thing.id.startsWith('npc-')) return `npc:${thing.id}`;
  if (thing.kind === 'monster' && thing.monsterId) return `monster:${thing.monsterId}`;
  if (thing.kind === 'custom' && thing.name) return `custom:${String(thing.name).trim().toLowerCase()}`;
  return null;
}

/** The campaign record, with one timbre set. Pure - returns a new record. */
export function withTimbre(campaign, ref, settings) {
  if (!campaign || !ref) return campaign;
  return { ...campaign, timbres: { ...(campaign.timbres || {}), [ref]: normalize(settings) } };
}

/** The campaign record, with one timbre removed. Pure. */
export function withoutTimbre(campaign, ref) {
  if (!campaign || !ref || !campaign.timbres) return campaign;
  const timbres = { ...campaign.timbres };
  delete timbres[ref];
  return { ...campaign, timbres };
}

/** The timbre a campaign holds for a ref, or null. Pure. */
export function timbreIn(campaign, ref) {
  const s = campaign?.timbres?.[ref];
  return s ? normalize(s) : null;
}

function localTimbres() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') || {}; }
  catch { return {}; }
}

/** The campaign first, then this machine's fallback. */
export function timbreFor(ref, campaign = null) {
  if (!ref) return null;
  return timbreIn(campaign, ref) || (localTimbres()[ref]
    ? normalize(localTimbres()[ref]) : null);
}

/**
 * Every saved timbre this DM can reach, keyed by ref - the machine's own
 * plus the campaign's, the campaign winning a tie. The picker lists exactly
 * what timbreFor can resolve, so a voice saved with no campaign open still
 * shows up in the menu.
 */
export function savedTimbres(campaign = null) {
  return { ...localTimbres(), ...(campaign?.timbres || {}) };
}

/**
 * Save a timbre. With a campaign it writes the campaign (the server keeps it
 * from players); without one it writes this machine. Returns the campaign
 * record when it changed, so the caller can persist and adopt it.
 */
export function saveTimbre(ref, settings, campaign = null) {
  if (!ref) return { ok: false, reason: 'that one cannot carry a voice' };
  if (campaign) return { ok: true, campaign: withTimbre(campaign, ref, settings) };
  try {
    const all = localTimbres();
    all[ref] = normalize(settings);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
  } catch { /* storage denied - the voice still works this session */ }
  return { ok: true, campaign: null };
}

/** Forget a timbre, from whichever home holds it. */
export function forgetTimbre(ref, campaign = null) {
  if (!ref) return { ok: false };
  if (campaign) return { ok: true, campaign: withoutTimbre(campaign, ref) };
  try {
    const all = localTimbres();
    delete all[ref];
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
  } catch { /* fine */ }
  return { ok: true, campaign: null };
}

/* ------------------------------------------------------------------ */
/* the live path                                                       */
/* ------------------------------------------------------------------ */

const live = {
  stream: null, source: null, chain: null, ctx: null,
  mic: 'closed',      // closed | open | denied | absent
  speaking: false, latched: false, reason: null,
  choice: 'follow', settings: { ...DEFAULTS }, lastPress: 0,
};

const fail = (reason) => { live.reason = reason; return { ok: false, reason }; };

/** What the panel repaints from after any redraw. */
export function status() {
  return {
    mic: live.mic, speaking: live.speaking, latched: live.latched,
    reason: live.reason, choice: live.choice, settings: { ...live.settings },
  };
}

/** Pick what to speak as. `key` is the panel's choice; settings are applied live. */
export function choose(key, settings) {
  live.choice = key;
  live.settings = normalize(settings);
  if (live.chain) live.chain.apply(live.settings);
  return live.settings;
}

function ramp(to) {
  const ctx = live.ctx;
  const out = live.chain?.output;
  if (!ctx || !out) return;
  const t = ctx.currentTime;
  out.gain.cancelScheduledValues(t);
  out.gain.setTargetAtTime(to, t, to > 0 ? 0.015 : 0.03);
}

async function start() {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
  if (!md || typeof md.getUserMedia !== 'function') {
    live.mic = 'absent';
    return fail('No microphone on this device or address. The voice changer '
      + 'runs on the DM\'s own machine at 127.0.0.1.');
  }
  if (!live.stream) {
    try {
      live.stream = await md.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
      live.mic = 'open';
    } catch (err) {
      const refused = err?.name === 'NotAllowedError';
      live.mic = refused ? 'denied' : 'closed';
      return fail(refused
        ? 'The microphone was refused. Allow it in the address bar, then press again.'
        : `The microphone could not be opened: ${err?.message || err}`);
    }
  }
  if (!audio.enabled()) {
    return fail('Sound is off on this device - tap the speaker in Ambience, then press again.');
  }
  let ctx = audio.context();
  if (!ctx || ctx.state !== 'running') ctx = audio.unlock();
  if (!ctx) return fail('this browser has no Web Audio');
  if (!live.chain || live.ctx !== ctx) {
    const built = await buildChain(ctx, live.settings);
    if (!built.ok) return fail(built.reason);
    live.chain = built.chain;
    live.ctx = ctx;
    try {
      live.source = ctx.createMediaStreamSource(live.stream);
      live.source.connect(live.chain.input);
      live.chain.output.connect(audio.master());
    } catch (err) {
      return fail(`The microphone could not be wired in: ${err?.message || err}`);
    }
  }
  live.reason = null;
  return { ok: true };
}

/**
 * The button went down. A second press within 350 ms latches the voice on
 * for a monologue. Answers { ok } or { ok: false, reason }, never throws.
 */
export async function press() {
  const now = (typeof performance !== 'undefined' ? performance : Date).now();
  const double = now - live.lastPress < 350;
  live.lastPress = now;
  const r = await start();
  if (!r.ok) return r;
  if (double) live.latched = true;
  live.speaking = true;
  ramp(live.settings.gain);
  return { ok: true, latched: live.latched };
}

/** The button came up. A latched voice stays up until unlatch(). */
export function release() {
  if (live.latched) return { ok: true, latched: true };
  live.speaking = false;
  ramp(0);
  return { ok: true, latched: false };
}

export function unlatch() {
  live.latched = false;
  live.speaking = false;
  ramp(0);
  return { ok: true };
}

/** Give the microphone back. The next press asks the browser again. */
export function releaseMic() {
  unlatch();
  try { live.source?.disconnect(); } catch { /* fine */ }
  try { for (const t of live.stream?.getTracks() || []) t.stop(); } catch { /* fine */ }
  try { live.chain?.dispose(); } catch { /* fine */ }
  live.stream = null; live.source = null; live.chain = null; live.ctx = null;
  live.mic = 'closed';
  live.reason = null;
  return { ok: true };
}

// A latched voice must not come back on by itself when the DM returns to
// the tab: the core suspends the context on hide, this drops the latch.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && live.latched) unlatch();
  });
}
