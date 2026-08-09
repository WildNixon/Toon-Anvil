/**
 * DM mode - the campaign through four lenses.
 *
 *   STAGE  the live now: the fight, who is at the table, party vitals, and
 *          the DM's levers (forge, grants, assignments).
 *   WORLD  the prep: bestiary, encounter builder, treasure, improvisation,
 *          rules reference.
 *   STORY  the whole party's event feed with names, plus the open threads.
 *   SETUP  the table itself, the forge, and the homebrew workshop.
 *
 * All of it works with no network - the screen a DM keeps open at the table
 * must not depend on anything being reachable. With a table open, Stage,
 * Story and Setup update live off the change feed; World deliberately never
 * does, because a half-typed monster search surviving a player's die roll
 * matters more than freshness there.
 */

import { getState, el } from '../../core/store.js';
import { compendium, compendiumWithCustom, dataFile } from '../../core/db.js';
import { tabs } from '../../ui/kit.js';
import * as live from '../../core/live.js';
import { pull, adopt } from './runner.js';
import * as stage from './stage.js';
import * as world from './world.js';
import * as story from './story.js';
import * as setup from './setup.js';

export const title = 'DM';

let container = null;
let monsters = [];
let glossary = [];
let magicItems = [];
let tables = null;
let lens = 'stage';
let unsubscribe = null;

const LENSES = {
  stage: { label: 'Stage', mod: stage },
  world: { label: 'World', mod: world },
  story: { label: 'Story', mod: story },
  setup: { label: 'Setup', mod: setup },
};

export async function render(root) {
  container = root;
  if (!monsters.length) {
    // Custom content is appended, so a DM's own monsters show up in the
    // bestiary, the encounter runner and the random tables alongside the SRD.
    [monsters, glossary, magicItems] = await Promise.all([
      compendiumWithCustom('monsters'), compendium('glossary'),
      compendiumWithCustom('magic-items'),
    ]);
  }
  if (!tables) tables = await dataFile('dm-tables.json', null);
  // A DM who reloads mid-fight gets the fight back. Solo this is a no-op:
  // pull() answers null with no table open, and the encounter stays scratch.
  const shared = await pull();
  if (shared) adopt(shared);
  await draw();

  // One live subscription for the whole mode, dispatched by lens. No
  // `encounters` kind on purpose: the runner is the DM's local truth,
  // published outward - re-adopting remote state would fight their own
  // in-flight edits. (Players' Party screen subscribes to it instead.)
  if (unsubscribe) unsubscribe();
  unsubscribe = live.subscribe(['table', 'characters', 'events'], async ({ changes, gap }) => {
    if (!container.isConnected) { unsubscribe?.(); unsubscribe = null; return; }
    const kinds = new Set(changes.map((c) => c.kind));
    const wants = {
      stage: kinds.has('table') || kinds.has('characters'),
      story: kinds.has('events') || kinds.has('characters'),
      setup: kinds.has('table'),
      world: false,
    };
    if (gap || wants[lens]) await draw();
  });
}

const ctx = () => ({
  monsters, glossary, magicItems, tables,
  sources,
  redraw: draw,
  goToLens: (id) => { lens = id; draw(); },
});

/** Sources for derive(), assembled the same way the shell does it. */
function sources() {
  const { compendium: c, homebrew } = getState();
  return {
    classes: c.classes || [], species: c.species || [],
    backgrounds: c.backgrounds || [], feats: c.feats || [],
    srdEffects: c.srdEffects || {}, equipment: c.equipment,
    homebrew: homebrew || [],
  };
}

async function draw() {
  container.innerHTML = '';
  const head = el('div', { class: 'panel rivets accent' });
  head.append(el('span', { class: 'lvl accent' }, 'Dungeon Master'));
  head.append(el('h3', {},
    `${monsters.length} monsters · ${glossary.length} rules entries`));
  head.append(tabs({
    items: Object.entries(LENSES).map(([id, l]) => ({ id, label: l.label })),
    active: lens,
    onSelect: (id) => { lens = id; draw(); },
  }));
  container.append(head);

  const box = el('div', {});
  container.append(box);
  await LENSES[lens].mod.render(box, ctx());
}
