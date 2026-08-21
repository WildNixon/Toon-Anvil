/**
 * The audio core: one context, one master gain, one rule about when sound
 * is allowed at all.
 *
 * Before this, the only sound in the app was the ambience beds, and they
 * worked by luck: both call sites were click handlers, so the context they
 * constructed happened to start unlocked. A sting fired from an event
 * subscriber - a remote roll arriving, a clock striking on a server push -
 * would have been silently swallowed by the autoplay policy, and playBed
 * would still have said ok.
 *
 * Three rules, each enforced here rather than remembered elsewhere:
 *
 *   1. SOUND IS OFF UNTIL THIS DEVICE SAYS OTHERWISE. Five phones chiming
 *      at once is a problem; one tap turns it on, and that sticks to the
 *      device (localStorage), never to the table.
 *   2. A FRAMED COPY IS SILENT BY CONSTRUCTION. The gym drives the real app
 *      in iframes, and nothing in a side panel should make noise. This is
 *      what keeps every test frame mute without a stub - and why
 *      resolveEnabled() is pure and takes "framed" as an argument.
 *   3. THE CONTEXT IS CONSTRUCTED IN ONE PLACE, inside a user gesture.
 *      unlock() is the only `new AudioContext` in the app. Everything else
 *      asks context() and gets null until somebody has tapped.
 */

export const SOUND_KEY = 'toonanvil.sound';
export const VOLUME_KEY = 'toonanvil.volume';
const DEFAULT_VOLUME = 0.8;
const GESTURES = ['pointerup', 'touchend', 'keydown'];

let ctx = null;
let masterNode = null;
let armed = false;
let wasRunningWhenHidden = false;
const unlockListeners = [];

/** Pure: is sound on, given what is stored and whether we are in a frame? */
export function resolveEnabled(stored, framed) {
  return stored === 'on' && !framed;
}

function isFramed() {
  try { return window.self !== window.top; } catch { return true; }
}

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function enabled() {
  return resolveEnabled(read(SOUND_KEY), isFramed());
}

/** The device's volume, 0..1. Stored, with a sane default. */
export function volume() {
  const v = Number(read(VOLUME_KEY));
  return Number.isFinite(v) && v > 0 ? Math.min(1, v) : DEFAULT_VOLUME;
}

export function setVolume(v) {
  const clamped = Math.max(0, Math.min(1, Number(v) || 0));
  try { localStorage.setItem(VOLUME_KEY, String(clamped)); } catch { /* fine */ }
  if (ctx && masterNode) {
    masterNode.gain.linearRampToValueAtTime(clamped, ctx.currentTime + 0.1);
  }
  return clamped;
}

/** The context, or null. NEVER constructs - that is unlock()'s job. */
export function context() { return ctx; }

/** The master gain every sound plays through, or null before unlock. */
export function master() { return masterNode; }

/**
 * Turn sound on or off for this device. Callers are click handlers, so when
 * turning on, the unlock happens inside the gesture that asked for it.
 */
export function setEnabled(on) {
  try {
    if (on) localStorage.setItem(SOUND_KEY, 'on');
    else localStorage.removeItem(SOUND_KEY);
  } catch { /* storage denied - the choice lasts the page, which is fine */ }
  if (on && !isFramed()) {
    const c = unlock();
    if (!c || c.state !== 'running') arm();
  }
  return enabled();
}

/**
 * Construct (once) and resume the context. Returns it, or null where Web
 * Audio is missing. Safe to call repeatedly; cheap after the first time.
 *
 * The one-sample silent buffer is the iOS idiom: Safari counts a context as
 * "used in a gesture" only once something has actually been started on it.
 */
export function unlock() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!ctx) {
    try {
      ctx = new Ctx();
      masterNode = ctx.createGain();
      masterNode.gain.value = volume();
      masterNode.connect(ctx.destination);
    } catch {
      ctx = null; masterNode = null;
      return null;
    }
  }
  if (ctx.state !== 'running') {
    try { ctx.resume().catch(() => {}); } catch { /* older Safari */ }
  }
  try {
    const kick = ctx.createBufferSource();
    kick.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    kick.connect(masterNode);
    kick.start(0);
  } catch { /* not fatal */ }
  if (ctx.state === 'running') {
    for (const fn of unlockListeners.splice(0)) {
      try { fn(ctx); } catch { /* a listener must not take the core down */ }
    }
  }
  return ctx;
}

/** Run fn once the context is running - now, if it already is. */
export function onUnlock(fn) {
  if (ctx && ctx.state === 'running') { try { fn(ctx); } catch { /* see above */ } return; }
  unlockListeners.push(fn);
}

/**
 * Arm one-shot gesture listeners that unlock on the next tap or key. They
 * re-arm themselves while the context is not running (iOS reports
 * "interrupted" after a phone call), and disarm once it is.
 *
 * pointerup/touchend/keydown on purpose, never pointerdown: Safari does not
 * count pointerdown as user activation.
 */
function arm() {
  if (armed) return;
  armed = true;
  const once = () => {
    const c = unlock();
    if (c && c.state === 'running') {
      for (const ev of GESTURES) document.removeEventListener(ev, once, true);
      armed = false;
    }
  };
  for (const ev of GESTURES) {
    document.addEventListener(ev, once, { capture: true, passive: true });
  }
}

/**
 * Called once from boot. Does nothing unless this device has sound on - so
 * a fresh install, and every gym frame, adds no listeners and constructs
 * nothing. Page-hide ducks and suspends; coming back resumes only what was
 * running.
 */
export function install() {
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (!ctx || !masterNode) return;
    if (document.hidden) {
      wasRunningWhenHidden = ctx.state === 'running';
      try {
        masterNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.15);
        setTimeout(() => { try { ctx.suspend(); } catch { /* fine */ } }, 180);
      } catch { /* fine */ }
    } else if (wasRunningWhenHidden) {
      try {
        ctx.resume().catch(() => {});
        masterNode.gain.linearRampToValueAtTime(volume(), ctx.currentTime + 0.2);
      } catch { /* the next gesture will re-arm */ }
      if (ctx.state !== 'running') arm();
    }
  });
  if (enabled()) arm();
}
