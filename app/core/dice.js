/**
 * Dice. Parsing, rolling, and the d20 test.
 *
 * Every roll returns a structured result (not just a number) because the
 * combat log and the homebrew trigger system both need to see the raw dice:
 * "did any d20 come up a natural 1" is a question the Fool Monk's Fumble Into
 * Fortune has to ask on every single roll.
 *
 * Every entry point takes an optional `rng`. The app passes nothing and gets
 * unpredictable dice; the campaign emulator threads a seeded RNG through so
 * runs are reproducible. Note the modulo bias that used to live in `rnd()` is
 * gone - rng.die() derives from a uniform float, so a d20 is actually uniform
 * rather than very slightly favouring low faces.
 */

import { defaultRng } from './rng.js';

const DICE_RE = /([+-]?)\s*(\d*)d(\d+)|([+-]?)\s*(\d+)(?!\s*d)/gi;

const rollDie = (sides, rng) => (rng || defaultRng).die(sides);

/** Parse "2d6+3" / "1d8" / "-1d4+2" into {dice:[{n,sides,sign}], flat}. */
export function parse(expr) {
  const spec = { dice: [], flat: 0, source: String(expr).trim() };
  if (!spec.source) return spec;
  let m;
  DICE_RE.lastIndex = 0;
  while ((m = DICE_RE.exec(spec.source)) !== null) {
    if (m[3]) {
      spec.dice.push({
        n: m[2] === '' ? 1 : parseInt(m[2], 10),
        sides: parseInt(m[3], 10),
        sign: m[1] === '-' ? -1 : 1,
      });
    } else if (m[5] !== undefined) {
      spec.flat += (m[4] === '-' ? -1 : 1) * parseInt(m[5], 10);
    }
  }
  return spec;
}

/**
 * Roll an expression.
 * @param {string} expr e.g. "2d6+3"
 * @param {object} [opts] {crit} - crit doubles the DICE only, never the flat
 *   modifier, per the 2024 rules.
 */
export function roll(expr, { crit = false, rng = null } = {}) {
  const spec = parse(expr);
  const rolls = [];
  let total = spec.flat;
  for (const group of spec.dice) {
    const count = crit ? group.n * 2 : group.n;
    const values = [];
    for (let i = 0; i < count; i += 1) values.push(rollDie(group.sides, rng));
    rolls.push({ ...group, count, values });
    total += group.sign * values.reduce((a, b) => a + b, 0);
  }
  return { expr: spec.source, total, rolls, flat: spec.flat, crit };
}

/**
 * A d20 test: attack roll, ability check or saving throw.
 *
 * Returns every d20 face rolled so callers can inspect naturals. `nat` is the
 * face that was actually USED after advantage/disadvantage - which is the one
 * that matters for crits, and (for the Warrior of the Fool) for fumbles.
 */
export function d20({ mod = 0, advantage = false, disadvantage = false,
                      bonus = 0, critRange = 20, rng = null } = {}) {
  // Advantage and disadvantage cancel exactly, they don't stack.
  const adv = advantage && !disadvantage;
  const dis = disadvantage && !advantage;
  const faces = [rollDie(20, rng)];
  if (adv || dis) faces.push(rollDie(20, rng));
  const nat = adv ? Math.max(...faces) : dis ? Math.min(...faces) : faces[0];
  const total = nat + mod + bonus;
  return {
    faces, nat, mod: mod + bonus, total,
    advantage: adv, disadvantage: dis,
    isCrit: nat >= critRange,
    isFumble: nat === 1,
  };
}

/** Average of an expression, for encounter maths and "expected damage" UI. */
export function average(expr) {
  const spec = parse(expr);
  return spec.dice.reduce(
    (sum, g) => sum + g.sign * g.n * (g.sides + 1) / 2, spec.flat,
  );
}

/** Roll 4d6-drop-lowest, six times - the classic array. */
export function rollAbilityScores(rng = null) {
  const out = [];
  for (let i = 0; i < 6; i += 1) {
    const dice = [rollDie(6, rng), rollDie(6, rng), rollDie(6, rng), rollDie(6, rng)]
      .sort((a, b) => b - a);
    out.push({ total: dice[0] + dice[1] + dice[2], dice, dropped: dice[3] });
  }
  return out;
}

/** Format a roll for the log: "17 (d20:14 +3)". */
export function fmt(result) {
  if (result.faces) {
    const dice = result.faces.length > 1
      ? `d20:[${result.faces.join(', ')}]->${result.nat}`
      : `d20:${result.nat}`;
    const mod = result.mod ? ` ${result.mod >= 0 ? '+' : ''}${result.mod}` : '';
    return `${result.total} (${dice}${mod})`;
  }
  const parts = result.rolls.map((g) => `${g.count}d${g.sides}:[${g.values.join(', ')}]`);
  const mod = result.flat ? ` ${result.flat >= 0 ? '+' : ''}${result.flat}` : '';
  return `${result.total} (${parts.join(' ')}${mod})`;
}
