/**
 * Market arithmetic, pure - the one place a price is computed.
 *
 * The region's price dial (set on the DM's Deck) and the shopkeeper's
 * attitude (haggled at the counter) meet here, and ONLY here: the displayed
 * price, the affordability check, the purse debit and the sell-back all
 * call these two functions, so the number on the label is always the number
 * that leaves the purse.
 *
 * The dial cuts both ways on purpose: cheap regions buy low AND sell low.
 * Hauling goods from a x0.5 backwater to a x2.0 boomtown is caravan
 * gameplay under dials the DM controls, not an exploit.
 */

export const clampMod = (m) => Math.min(2, Math.max(0.5, Number(m) || 1));

/** What one unit costs at the counter, in copper. Never below 1. */
export function unitPrice(baseCp, attitude = 0, regionMod = 1) {
  return Math.max(1, Math.round(
    (baseCp || 0) * clampMod(regionMod) * (1 - attitude / 100),
  ));
}

/** What the shop pays for a thing back, in copper. Never negative. */
export function sellBack(costCp, regionMod = 1) {
  return Math.max(0, Math.floor(((costCp || 0) / 2) * clampMod(regionMod)));
}
