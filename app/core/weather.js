/**
 * The sky, as a pure function.
 *
 * Weather is computed, never stored: weatherFor(tables, {seed, day, region})
 * answers the same for the same inputs forever, so every client - the DM's
 * Deck, a player's Party screen - derives today's sky independently and
 * agrees, and any past or future day is one call away. Storing it would
 * create a second source of truth that could drift from this one.
 *
 * THE STREAM RULE: the rng comes from seededRng(seed).stream(name), never
 * seededRng(seed, label). The label does not mix into the sequence - it is
 * debug decoration - and this project shipped that bug once (every terrain
 * rolled the same encounter distance). .stream() hashes seed and name
 * together, which is what makes day 14 in the Vale a different sky from
 * day 14 in the mountains.
 *
 * Draw order (temp, wind, precip, event) is part of the contract:
 * reordering the draws changes every campaign's history of skies.
 */

import { seededRng } from './rng.js';

function pickWeighted(rng, weights) {
  const entries = Object.entries(weights || {});
  const total = entries.reduce((n, [, w]) => n + w, 0);
  if (!total) return null;
  let roll = rng.float() * total;
  for (const [key, w] of entries) {
    roll -= w;
    if (roll < 0) return key;
  }
  return entries[entries.length - 1][0];
}

const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());

/**
 * Today's weather in one region. `tables` is dm-tables.json; regions carry
 * one of its ten terrain keys, and unknown terrain falls back to forest
 * rather than crashing a screen over a typo in an ingested region.
 */
export function weatherFor(tables, { seed, day, region }) {
  if (!tables?.weather || !region) return null;
  const climate = tables.weather[region.terrain] || tables.weather.forest;
  if (!climate) return null;

  const rng = seededRng(seed).stream(`weather:${day}:${region.id}`);
  const temp = pickWeighted(rng, climate.temp);
  const wind = pickWeighted(rng, climate.wind);
  const precip = pickWeighted(rng, climate.precip);
  const event = rng.float() < (climate.eventChance || 0)
    ? rng.pick(climate.events || []) : null;

  return {
    day,
    regionId: region.id,
    terrain: region.terrain,
    temp, wind, precip, event,
    summary: `${cap(temp)}, ${wind}, ${precip}`,
    source: 'authored',
  };
}

/**
 * The next n skies, pure - one weatherFor per day, nothing stored. The
 * Deck's forecast strip is exactly this; a player could compute the same
 * week from the public seed, which is the point.
 */
export function forecastFor(tables, { seed, day, region }, n = 7) {
  return Array.from({ length: n },
    (_, i) => weatherFor(tables, { seed, day: day + i, region }));
}
