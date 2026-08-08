/**
 * Random number generation.
 *
 * Real play wants unpredictable dice. The campaign emulator wants the exact
 * opposite: without a seed you cannot tell whether a tuning change helped or
 * the dice were simply kinder, and every paired comparison becomes noise.
 *
 * So there are two implementations behind one interface, and callers take an
 * RNG rather than reaching for a global.
 *
 *   cryptoRng()      unpredictable, for the app
 *   seededRng(seed)  deterministic, reproducible, for the sim
 *
 * Sub-streams matter as much as seeding. If encounter generation and attack
 * rolls draw from the same sequence, adding one monster shifts every subsequent
 * die and two "identical" runs diverge for reasons that have nothing to do with
 * the change under test. `rng.stream('combat')` gives an independent sequence
 * derived from the parent seed, so unrelated systems cannot perturb each other.
 */

/** FNV-1a: string -> uint32. Used to derive stream seeds from names. */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32 - 32-bit, one multiply-xorshift round. Passes gjrand and PractRand
 * to well past the volume a campaign sweep needs, and is a few lines.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * An RNG handle.
 *
 * @property {() => number} float   uniform [0,1)
 * @property {(n:number) => number} int   uniform integer [0,n)
 * @property {(n:number) => number} die   uniform integer [1,n] - a die roll
 * @property {(name:string) => Rng} stream  independent derived sub-stream
 */
function makeRng(next, { seed = null, label = 'rng' } = {}) {
  let count = 0;
  const self = {
    seed,
    label,
    deterministic: seed !== null,
    float() { count += 1; return next(); },
    int(n) { return Math.floor(self.float() * n); },
    die(sides) { return self.int(sides) + 1; },
    /** How many values have been drawn - used to prove a run consumed dice. */
    draws() { return count; },
    stream(name) {
      if (seed === null) return cryptoRng(`${label}:${name}`);
      // Mixing the parent seed with the stream name keeps sub-streams stable
      // across runs while remaining independent of one another.
      return seededRng((hashString(`${seed}:${name}`)) >>> 0, `${label}:${name}`);
    },
    /** Pick one element uniformly. */
    pick(arr) { return arr[self.int(arr.length)]; },
    /** Fisher-Yates, non-mutating. */
    shuffle(arr) {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i -= 1) {
        const j = self.int(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
  return self;
}

/** Deterministic RNG. Same seed always yields the same sequence. */
export function seededRng(seed, label = 'seeded') {
  const s = typeof seed === 'string' ? hashString(seed) : (seed >>> 0);
  return makeRng(mulberry32(s), { seed: s, label });
}

/** Unpredictable RNG backed by the platform CSPRNG. */
export function cryptoRng(label = 'crypto') {
  // Draw in blocks: one syscall per 256 values rather than per value.
  const BLOCK = 256;
  let buf = new Uint32Array(BLOCK);
  let idx = BLOCK;
  const next = () => {
    if (idx >= BLOCK) {
      globalThis.crypto.getRandomValues(buf);
      idx = 0;
    }
    const v = buf[idx];
    idx += 1;
    return v / 4294967296;
  };
  return makeRng(next, { seed: null, label });
}

/**
 * The RNG used when a caller does not supply one.
 *
 * Real play gets crypto. The sim never relies on this - it threads an explicit
 * seeded RNG through every call, so that forgetting to pass one shows up as a
 * determinism failure rather than as quietly-nondeterministic results.
 */
export const defaultRng = cryptoRng('default');
