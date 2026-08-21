/**
 * Optional connectors: an LLM for improvisation, images, and sound.
 *
 * Three rules this module exists to enforce.
 *
 * 1. NOTHING HERE IS REQUIRED. Toon Anvil is an offline tool that happens to
 *    be able to phone out. Every call site must work when nothing is
 *    configured, so every function returns a `{ ok: false, reason }` rather
 *    than throwing, and the UI says what it *would* offer rather than hiding.
 *
 * 2. THE BROWSER NEVER SEES A KEY. Keys live server-side; the page calls the
 *    local server and the server calls the provider. That kills the two usual
 *    failure modes at once - a key sitting in localStorage where any injected
 *    script can read it, and provider CORS refusing a browser-origin request.
 *
 * 3. THE KEY IS ALWAYS THE USER'S. No key ships with this project, and none is
 *    ever asked for here. The server reads whatever the user put in an
 *    environment variable or a gitignored secrets file, and this module only
 *    ever learns WHETHER one is present.
 */

import * as audio from './audio.js';
import { serverBase } from './db.js';

/* ------------------------------------------------------------------ */
/* capability discovery                                                */
/* ------------------------------------------------------------------ */

let cached = null;

/**
 * What is actually available right now.
 *
 * Returns a map of provider id to { configured, label, note }. Never throws:
 * with no server at all, everything is simply unconfigured, which is the same
 * state the UI already has to handle.
 */
export async function capabilities({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  try {
    const res = await fetch(`${serverBase()}/api/providers`);
    if (!res.ok) throw new Error(String(res.status));
    cached = await res.json();
  } catch {
    cached = {
      available: false,
      reason: 'the local server is not running, so connectors are unavailable',
      providers: {},
    };
  }
  return cached;
}

export function forget() { cached = null; }

/**
 * What the connectors have actually cost so far.
 *
 * Deliberately separate from `capabilities()`: that one quotes an ESTIMATE
 * before you spend, this reports what was really spent afterwards, and
 * collapsing the two would let a guess quietly become a fact. Never throws -
 * with no server the honest answer is "no calls, nothing spent".
 */
export async function spendSummary() {
  try {
    const res = await fetch(`${serverBase()}/api/spend`);
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } catch {
    return { calls: 0, cents: 0, byCapability: {}, budgetCents: null };
  }
}

/** Is a specific provider ready to be called? */
export async function isConfigured(id) {
  const caps = await capabilities();
  return Boolean(caps.providers?.[id]?.configured);
}

/* ------------------------------------------------------------------ */
/* calling                                                             */
/* ------------------------------------------------------------------ */

/**
 * Post to a connector endpoint.
 *
 * A failure is a VALUE, not an exception. Every caller here is a nice-to-have
 * sitting next to something that already works offline, and a thrown error
 * would take the working thing down with it.
 */
async function call(path, body, { timeout = 60000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(`${serverBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, reason: data.error || `server said ${res.status}`, status: res.status };
    }
    return { ok: true, ...data };
  } catch (err) {
    return {
      ok: false,
      reason: err.name === 'AbortError'
        ? `no answer within ${Math.round(timeout / 1000)}s`
        : `could not reach the local server: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* text                                                                */
/* ------------------------------------------------------------------ */

/**
 * Ask for prose.
 *
 * Used for NPC dialogue, room description, and rewriting a generated rumour in
 * a particular voice. Always presented to the DM as a DRAFT to edit - a
 * language model is a fast writer, not an authority on anybody's campaign, and
 * the UI never substitutes its output for a rules answer.
 */
export async function generateText({
  prompt, system = null, provider = null, maxTokens = 400, temperature = 0.9,
  capability = null,
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    return { ok: false, reason: 'nothing to write about' };
  }
  // `capability` names the catalogue row being bought. The server uses it for
  // two things a caller cannot be trusted to get right on its own: whether
  // this text may leave the machine at all, and what the spend is recorded
  // against. Naming none is allowed - that is a transport probe and carries
  // nothing of the user's. Naming one that is not in the catalogue is refused
  // by the server, because otherwise a typo would pick the privacy policy.
  return call('/api/llm', {
    prompt, system, provider, maxTokens, temperature, capability,
  });
}

/* ------------------------------------------------------------------ */
/* images                                                              */
/* ------------------------------------------------------------------ */

/**
 * Ask for a picture.
 *
 * Ships wired to a LOCAL Stable Diffusion endpoint only. Hosted providers are
 * deliberately left for the user to connect: an image API is the easiest way
 * to spend real money by accident, and this is a tool that otherwise costs
 * nothing to run.
 */
export async function generateImage({ prompt, provider = null, size = '512x512' } = {}) {
  if (!prompt || !String(prompt).trim()) {
    return { ok: false, reason: 'nothing to draw' };
  }
  return call('/api/image', { prompt, provider, size }, { timeout: 180000 });
}

/* ------------------------------------------------------------------ */
/* sound                                                               */
/* ------------------------------------------------------------------ */

/** Search a CC-licensed sound library. Attribution comes back with the result. */
export async function searchSounds({ query, limit = 8 } = {}) {
  if (!query || !String(query).trim()) {
    return { ok: false, reason: 'nothing to search for' };
  }
  return call('/api/sfx/search', { query, limit }, { timeout: 30000 });
}

/** Generate a sound effect from a description. */
export async function generateSound({ prompt, seconds = 4 } = {}) {
  if (!prompt || !String(prompt).trim()) {
    return { ok: false, reason: 'nothing to make a sound of' };
  }
  return call('/api/sfx/generate', { prompt, seconds }, { timeout: 120000 });
}

/* ------------------------------------------------------------------ */
/* local ambience - no key, no network, no provider                    */
/* ------------------------------------------------------------------ */

/**
 * Ambient beds, synthesised in the browser.
 *
 * Deliberately not a connector: no key, no request, no cost, works on a train.
 * It is here rather than behind an API because atmosphere at a table is worth
 * having by default, and every hosted alternative is worth having only if you
 * already wanted to pay for one.
 *
 * Each bed is filtered noise plus a little shaped movement. None of it is a
 * recording, so there is nothing to licence.
 */
export const BEDS = {
  rain: { label: 'Rain', filter: 'lowpass', freq: 1400, q: 0.4, gain: 0.14, wobble: 0.2 },
  wind: { label: 'Wind', filter: 'bandpass', freq: 620, q: 0.7, gain: 0.13, wobble: 0.08 },
  tavern: { label: 'Tavern murmur', filter: 'bandpass', freq: 420, q: 1.4, gain: 0.16, wobble: 0.5 },
  cave: { label: 'Cave drip', filter: 'lowpass', freq: 300, q: 2.2, gain: 0.12, wobble: 0.05 },
  fire: { label: 'Fireside', filter: 'bandpass', freq: 900, q: 0.9, gain: 0.11, wobble: 0.9 },
  sea: { label: 'Sea', filter: 'lowpass', freq: 800, q: 0.5, gain: 0.15, wobble: 0.12 },
};

let playing = null;

function noiseBuffer(ctx, seconds = 4) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Brown-ish noise: integrating white noise puts the energy low, which is
  // what makes it sound like weather rather than static.
  let last = 0;
  for (let i = 0; i < data.length; i += 1) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.2;
  }
  return buf;
}

export function playBed(id, { volume = 1 } = {}) {
  const bed = BEDS[id];
  if (!bed) return { ok: false, reason: `no bed called "${id}"` };
  stopBed();
  try {
    // The core owns the context and the master gain. A bed tap is its own
    // user gesture, so this is also the unlock - and beds are deliberately
    // NOT gated by the sound-effects switch: tapping one is the opt-in.
    const audioCtx = audio.unlock();
    if (!audioCtx) return { ok: false, reason: 'this browser has no Web Audio' };
    const src = audioCtx.createBufferSource();
    src.buffer = noiseBuffer(audioCtx);
    src.loop = true;

    const filter = audioCtx.createBiquadFilter();
    filter.type = bed.filter;
    filter.frequency.value = bed.freq;
    filter.Q.value = bed.q;

    const gain = audioCtx.createGain();
    gain.gain.value = 0;

    // A slow LFO on the filter stops it sounding like a fan.
    const lfo = audioCtx.createOscillator();
    const lfoGain = audioCtx.createGain();
    lfo.frequency.value = bed.wobble;
    lfoGain.gain.value = bed.freq * 0.35;
    lfo.connect(lfoGain).connect(filter.frequency);

    src.connect(filter).connect(gain).connect(audio.master());
    src.start();
    lfo.start();
    // Fade in: an ambience that starts at full volume is a jump-scare.
    gain.gain.linearRampToValueAtTime(
      bed.gain * volume, audioCtx.currentTime + 1.5,
    );

    playing = { id, src, lfo, gain };
    return { ok: true, id, label: bed.label };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export function stopBed() {
  if (!playing) return;
  const { src, lfo, gain } = playing;
  const audioCtx = audio.context();
  try {
    gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.6);
    setTimeout(() => { try { src.stop(); lfo.stop(); } catch { /* already */ } }, 700);
  } catch { /* nothing to stop */ }
  playing = null;
}

export function nowPlaying() { return playing?.id || null; }
