/**
 * What the simulator can actually execute.
 *
 * The mapper reports "live" effects - ones it understood well enough to turn
 * into structured mechanics. That is NOT the same as effects the combat
 * simulator runs, and conflating the two inflates every coverage number: a
 * subclass whose only mechanics are reactions maps at 100% live and then
 * measures identically to a subclass with no mechanics at all.
 *
 * This module is the simulator's honest statement about itself. It is the same
 * discipline as the spell coverage gate: suppress or flag what cannot be
 * measured rather than quietly scoring it as measured.
 *
 * Keep it in sync by hand when the engine gains a capability. A registry that
 * silently drifts optimistic is worse than none.
 */

/** Effect types the combat simulator resolves at run time. */
export const EXECUTABLE = new Set([
  'action_option',      // chosen by policy.js, resolved in campaign.js
  'damage_rider',       // added to attack damage via riderDice()
  'ac_formula',         // derive() -> AC -> monster hit rolls
  'crit_range',         // widened crit threshold on attack rolls
  'unarmed_strike',     // becomes a real attack option
  'resource',           // pool exists, spent by costed action options
  'always_prepared_spells', // enters the policy's prepared list
  'resistance',         // applied in applyDamage()
  'immunity',           // applied in applyDamage()
  'vulnerability',      // applied in applyDamage()
  'extra_attack',       // multiplies weapon swings per action
  'temp_hp',            // absorbed before HP in applyDamage()
]);

/**
 * Mapped, but inert in combat - with the reason, so the report can say WHY
 * rather than just marking it absent.
 */
export const NOT_EXECUTED = {
  reaction_option: 'reactions have no trigger model yet, so they never fire',
  proficiency: 'skill and tool proficiencies do not affect simulated combat',
  condition_immunity: 'monsters in the corpus rarely apply conditions',
  speed: 'movement is abstracted; positioning is not simulated',
  sense: 'vision and senses are not simulated',
  narrative_only: 'flavour, by definition not mechanical',
};

/** Split a brew's effects into what will be measured and what will not. */
export function executableSplit(brew) {
  const executed = {};
  const inert = {};
  for (const f of brew.features || []) {
    for (const e of f.effects || []) {
      const bag = EXECUTABLE.has(e.type) ? executed : inert;
      bag[e.type] = (bag[e.type] || 0) + 1;
    }
  }
  const nExec = Object.values(executed).reduce((a, b) => a + b, 0);
  const nInert = Object.values(inert).reduce((a, b) => a + b, 0);
  return {
    executed,
    inert,
    counts: { executed: nExec, inert: nInert, total: nExec + nInert },
    // The number that should be quoted next to any simulated result.
    executableCoverage: nExec + nInert ? nExec / (nExec + nInert) : 0,
    reasons: Object.fromEntries(
      Object.keys(inert)
        .filter((t) => NOT_EXECUTED[t])
        .map((t) => [t, NOT_EXECUTED[t]]),
    ),
  };
}

/**
 * Can this brew's behaviour be measured at all?
 *
 * A brew with zero executable effects will produce a vector identical to a
 * plain member of its class. Reporting that as "plays like X" would be a
 * measurement of the base class wearing the homebrew's name.
 */
export function isMeasurable(brew) {
  return executableSplit(brew).counts.executed > 0;
}

/**
 * Actions that cost a resource nothing grants.
 *
 * This is the quietest failure in the whole pipeline. canAfford() returns
 * false for a pool that does not exist, so the action never fires, contributes
 * nothing to any metric, and the subclass still reports healthy coverage - it
 * simply measures as if its signature mechanic were not there.
 *
 * It happens two ways, and BOTH are worth telling the user about:
 *   - the mapper failed to recognise the sentence declaring the pool;
 *   - the homebrew genuinely forgot to define it, which is a real design bug.
 *
 * Takes a derived character, so base-class pools (Rage, Focus Points) count as
 * granted and only genuinely missing ones are reported.
 */
export function danglingCosts(derived) {
  const pools = new Map(
    (derived.resources || []).map((r) => [String(r.name).toLowerCase(), r]),
  );
  const out = [];
  for (const action of derived.actions || []) {
    const name = action.cost?.resource;
    if (!name) continue;
    const pool = pools.get(String(name).toLowerCase());
    // A pool that resolves to 0 is exactly as unspendable as one that does not
    // exist - canAfford() fails either way - so checking only for existence
    // let an empty pool through. Ask the question that matters: can this
    // action ever actually be paid for?
    if (pool && pool.max >= (action.cost.amount || 1)) continue;
    out.push({
      action: action.name,
      resource: name,
      reason: pool ? `pool resolves to ${pool.max}` : 'no such resource',
      from: action.from || action._from?.name || null,
      granted: [...pools.keys()],
    });
  }
  return out;
}
