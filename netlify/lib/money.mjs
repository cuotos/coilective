/**
 * Money is integer pence everywhere in this app.
 *
 * Filament prices arrive as strings like "17.99" and get split several ways.
 * Doing that in floats means 0.1 + 0.2 problems in something people use to
 * settle up with friends, so parse once at the edge and never use a float
 * again.
 */

import config from "../../sale.config.mjs";

/** "17.99" or 17.99 → 1799. Throws rather than guess at nonsense. */
export function toPence(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100);
  }
  if (typeof value !== "string") throw new TypeError(`not a price: ${value}`);

  const cleaned = value.trim().replace(/[£$€,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) throw new TypeError(`not a price: ${value}`);
  return Math.round(Number(cleaned) * 100);
}

const SYMBOLS = { GBP: "£", USD: "$", EUR: "€" };

export function formatMoney(pence, currency = "GBP") {
  const sign = pence < 0 ? "-" : "";
  const abs = Math.abs(pence);
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  return `${sign}${symbol}${(abs / 100).toFixed(2)}`;
}

/**
 * Divide `totalPence` across `weights` in proportion, exactly.
 *
 * Naive rounding loses or invents pennies — with three people and a £10
 * discount you can hand out £9.99 and leave someone arguing over a penny.
 * This floors every share, then gives the remaining pennies to the largest
 * fractional remainders (the largest-remainder method), so the parts always
 * sum to the whole.
 *
 * Ties break towards the larger weight, then towards the earlier index, so
 * the same input always produces the same output.
 */
export function splitProportionally(totalPence, weights) {
  if (!Array.isArray(weights) || weights.length === 0) return [];
  if (weights.some((w) => w < 0)) throw new RangeError("weights cannot be negative");

  const sum = weights.reduce((a, b) => a + b, 0);
  // Nobody has spent anything, so proportion is meaningless — split evenly.
  const effective = sum === 0 ? weights.map(() => 1) : weights;
  const effectiveSum = sum === 0 ? weights.length : sum;

  const exact = effective.map((w) => (totalPence * w) / effectiveSum);
  const shares = exact.map(Math.floor);

  let remaining = totalPence - shares.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value), weight: effective[index] }))
    .sort((a, b) => b.fraction - a.fraction || b.weight - a.weight || a.index - b.index);

  for (let i = 0; remaining > 0; i = (i + 1) % order.length) {
    shares[order[i].index] += 1;
    remaining -= 1;
  }

  return shares;
}

/**
 * The sale tiers, read from sale.config.mjs at the root of the repo.
 *
 * They live in a file of their own because they are not facts about the
 * software — they are what Bambu happened to be doing last time, and they
 * move. Editing them should not mean reading this.
 *
 * Checked on load rather than trusted. A malformed edit that threw here would
 * take the API down with a clear message, which is a far better outcome than
 * quietly telling everybody the wrong discount.
 */
/**
 * Every set in the config, validated once at load.
 *
 * A malformed edit throws here and takes the API down with a message naming
 * the set — far better than quietly telling everybody the wrong discount.
 */
const SETS = Object.fromEntries(
  Object.entries(config.sets ?? {}).map(([name, set]) => [name, readSaleSet(set, name)]),
);

if (Object.keys(SETS).length === 0) {
  throw new TypeError("sale.config.mjs: no sale sets are defined.");
}
if (!SETS[config.default]) {
  throw new TypeError(
    `sale.config.mjs: default is "${config.default}", which is not one of: ${Object.keys(SETS).join(", ")}.`,
  );
}

export function readSaleSet({ label, postagePence, freePostageAt, tiers } = {}, name = "?") {
  const where = `sale.config.mjs set "${name}"`;
  const whole = (value) => Number.isInteger(value) && value >= 0;

  if (!whole(postagePence)) throw new TypeError(`${where}: postagePence must be whole pence.`);
  if (!whole(freePostageAt) || freePostageAt < 1) {
    throw new TypeError(`${where}: freePostageAt must be a spool count of at least 1.`);
  }
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new TypeError(`${where}: tiers must list at least one tier.`);
  }
  for (const tier of tiers) {
    if (!whole(tier?.spools) || tier.spools < 1) {
      throw new TypeError(`${where}: a tier needs a spool count of at least 1 (got ${tier?.spools}).`);
    }
    if (!Number.isFinite(tier.percent) || tier.percent < 0 || tier.percent > 100) {
      throw new TypeError(`${where}: ${tier.spools} spools has a percent of ${tier.percent}.`);
    }
  }

  // The free-postage point is a step on the same ladder, so the "next tier"
  // nudge can point at it while it is still the nearest thing to reach for.
  const steps = [...tiers];
  if (!steps.some((t) => t.spools === freePostageAt)) steps.push({ spools: freePostageAt, percent: 0 });
  steps.sort((a, b) => a.spools - b.spools);

  for (let i = 1; i < steps.length; i += 1) {
    if (steps[i].spools === steps[i - 1].spools) {
      throw new TypeError(`${where}: ${steps[i].spools} spools is listed twice.`);
    }
    if (steps[i].percent < steps[i - 1].percent) {
      throw new TypeError(
        `${where}: ${steps[i].spools} spools gives ${steps[i].percent}%, `
        + `less than the ${steps[i - 1].percent}% at ${steps[i - 1].spools}. `
        + `A bigger order cannot be worth less.`,
      );
    }
  }

  return { name, label: label ?? name, postagePence, freePostageAt, steps };
}

/** Which set is used when nobody has chosen one. */
export const defaultSaleSetName = () => config.default;

/** Every set, for the picker. */
export const saleSets = () => Object.values(SETS);

/**
 * One set by name, falling back to the default.
 *
 * A round can name a set that has since been removed from the config. That is
 * a reason to show the default, not to take the app down.
 */
export const saleSet = (name) => SETS[name] ?? SETS[config.default];

/**
 * The tier a given number of spools reaches, and the next one up.
 *
 * Takes the set rather than reading a global, because an open round uses
 * whichever set is live while a closed round uses the copy frozen onto it.
 *
 * Counts only spools the sale applies to — a print plate does not earn anyone
 * a bulk discount.
 */
export function estimateDiscount(spools, set = saleSet(config.default)) {
  const reached = set.steps.filter((t) => spools >= t.spools).at(-1) ?? null;
  const next = set.steps.find((t) => spools < t.spools) ?? null;

  const freePostage = spools >= set.freePostageAt;

  return {
    spools,
    saleSet: set.name,
    saleSetLabel: set.label,
    percent: reached?.percent ?? 0,
    freePostage,
    // Postage is the usual charge until the order earns its way out of it.
    postagePence: freePostage ? 0 : set.postagePence,
    // What another few spools would be worth, so the wishlist can say so.
    next: next && {
      spools: next.spools,
      more: next.spools - spools,
      percent: next.percent,
      freePostage: next.spools === set.freePostageAt,
    },
  };
}

/** An item counts towards the discount unless it is explicitly marked out. */
const inSale = (item) => item.discounted !== false;

const spend = (items) => items.reduce((sum, i) => sum + i.unitPricePence * i.qty, 0);

/**
 * What each person owes for a round.
 *
 * Two shared costs, split two different ways:
 *
 * The **discount** splits across the items it actually applies to. A sale that
 * covers PLA but not PETG must not hand a PETG buyer someone else's discount,
 * which is what splitting by total spend would do.
 *
 * **Postage** splits across everyone's whole spend, discount-eligible or not —
 * a parcel does not care what is in it.
 *
 * Both are proportional, so everyone lands on the same effective rate for the
 * part that applies to them, and nobody subsidises anybody.
 *
 * One person pays the store, so what everyone else owes is owed to them. The
 * payer's own share is already spent, never a debt, and `settledBy` records
 * who has since squared up.
 */
export function settleRound(round, { activeSaleSet } = {}) {
  const items = round.items ?? [];
  const people = [...new Set(items.map((i) => i.person))].sort();
  const mine = (person) => items.filter((i) => i.person === person);

  const subtotals = people.map((person) => spend(mine(person)));
  const saleSpend = people.map((person) => spend(mine(person).filter(inSale)));
  const saleSpools = items.filter(inSale).reduce((n, item) => n + item.qty, 0);

  const subtotal = subtotals.reduce((a, b) => a + b, 0);
  const discountable = saleSpend.reduce((a, b) => a + b, 0);
  const discount = discountPence(round.discount, discountable);
  const shipping = round.shippingPence ?? 0;

  // A closed round carries a copy of the set it was closed under, so editing
  // the config or switching the active sale cannot change a settled order.
  // An open round follows whichever set is live.
  // `activeSaleSet` is a name from the settings blob, but a resolved set is
  // accepted too so callers and tests are not tied to what the config happens
  // to be called today.
  const active = typeof activeSaleSet === "object" && activeSaleSet !== null
    ? activeSaleSet
    : saleSet(activeSaleSet ?? defaultSaleSetName());
  const set = round.saleSet ?? active;
  const tier = estimateDiscount(saleSpools, set);
  // Priced here rather than in the page, like every other figure: the sale
  // applies to the discountable spend, not the whole order.
  const estimatedDiscount = discountPence({ kind: "percent", value: tier.percent }, discountable);

  /**
   * Discounts are split per line, then added up per person.
   *
   * Doing it the other way round — split by person, then apportion within
   * them — lets the two disagree by a penny, and then a line saying £10.25
   * sits under a total that only works if it was £10.26. One split, aggregated
   * upwards, cannot drift.
   */
  const lineWeights = items.map((item) => (inSale(item) ? item.unitPricePence * item.qty : 0));
  const lineDiscounts = splitProportionally(discount, lineWeights);
  const lineEstDiscounts = splitProportionally(estimatedDiscount, lineWeights);

  const sumFor = (person, shares) => items
    .reduce((total, item, i) => (item.person === person ? total + shares[i] : total), 0);

  const discountShares = people.map((person) => sumFor(person, lineDiscounts));
  const estDiscountShares = people.map((person) => sumFor(person, lineEstDiscounts));

  const shippingShares = splitProportionally(shipping, subtotals);
  const owed = people.map((_, i) => subtotals[i] - discountShares[i] + shippingShares[i]);

  const paidBy = round.paidBy ?? null;
  const settledBy = new Set(round.settledBy ?? []);

  const estPostageShares = splitProportionally(tier.postagePence, subtotals);

  return {
    paidBy,
    /**
     * What each line came to, keyed by item id.
     *
     * `totalPence` is the line after the discount reaching it — the number
     * somebody wants when they ask "so what did that spool actually cost?".
     */
    lines: Object.fromEntries(items.map((item, i) => [
      item.id,
      {
        listPence: item.unitPricePence * item.qty,
        discountPence: lineDiscounts[i],
        totalPence: item.unitPricePence * item.qty - lineDiscounts[i],
        estimate: {
          discountPence: lineEstDiscounts[i],
          totalPence: item.unitPricePence * item.qty - lineEstDiscounts[i],
        },
      },
    ])),
    // What the sale would give this many spools. Only meaningful while the
    // round is open; once closed, the real discount is recorded.
    estimate: {
      ...tier,
      discountPence: estimatedDiscount,
      // Postage counts: a small order saving 30% and paying £4 to post can
      // come to more than a bigger one that posts free.
      totalPence: subtotal - estimatedDiscount + tier.postagePence,
    },
    people: people.map((person, i) => ({
      person,
      // The payer is square by definition: they are the one out of pocket.
      isPayer: person === paidBy,
      settled: person === paidBy || settledBy.has(person),
      itemCount: mine(person).reduce((n, it) => n + it.qty, 0),
      subtotalPence: subtotals[i],
      // What of their spend the discount could apply to, so the UI can show
      // why two people with the same spend owe different amounts.
      discountablePence: saleSpend[i],
      discountPence: discountShares[i],
      shippingPence: shippingShares[i],
      owesPence: owed[i],
      // What this person would owe if the sale gives what it usually does.
      // Only meaningful while the round is open.
      estimate: {
        discountPence: estDiscountShares[i],
        postagePence: estPostageShares[i],
        owesPence: subtotals[i] - estDiscountShares[i] + estPostageShares[i],
      },
    })),
    subtotalPence: subtotal,
    discountablePence: discountable,
    discountPence: discount,
    shippingPence: shipping,
    totalPence: subtotal - discount + shipping,
    // What the payer is still waiting on. Zero once everyone has settled, and
    // null while nobody has said who paid.
    outstandingPence: paidBy === null
      ? null
      : people.reduce(
          (sum, person, i) =>
            person === paidBy || settledBy.has(person) ? sum : sum + owed[i],
          0,
        ),
  };
}

/**
 * How much discount there is.
 *
 * Measured against the discount-eligible spend, not the whole order — a 43%
 * sale on the PLA in a mixed order is 43% of the PLA.
 */
export function discountPence(discount, discountablePence) {
  if (!discount) return 0;
  if (discount.kind === "percent") {
    const capped = Math.min(Math.max(discount.value, 0), 100);
    return Math.round((discountablePence * capped) / 100);
  }
  if (discount.kind === "amount") {
    return Math.min(Math.max(discount.pence, 0), discountablePence);
  }
  throw new TypeError(`unknown discount kind: ${discount.kind}`);
}
