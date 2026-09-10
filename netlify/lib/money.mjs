/**
 * Money is integer pence everywhere in this app.
 *
 * Filament prices arrive as strings like "17.99" and get split several ways.
 * Doing that in floats means 0.1 + 0.2 problems in something people use to
 * settle up with friends, so parse once at the edge and never use a float
 * again.
 */

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
export function settleRound(round) {
  const items = round.items ?? [];
  const people = [...new Set(items.map((i) => i.person))].sort();
  const mine = (person) => items.filter((i) => i.person === person);

  const subtotals = people.map((person) => spend(mine(person)));
  const saleSpend = people.map((person) => spend(mine(person).filter(inSale)));

  const subtotal = subtotals.reduce((a, b) => a + b, 0);
  const discountable = saleSpend.reduce((a, b) => a + b, 0);
  const discount = discountPence(round.discount, discountable);
  const shipping = round.shippingPence ?? 0;

  const discountShares = splitProportionally(discount, saleSpend);
  const shippingShares = splitProportionally(shipping, subtotals);
  const owed = people.map((_, i) => subtotals[i] - discountShares[i] + shippingShares[i]);

  const paidBy = round.paidBy ?? null;
  const settledBy = new Set(round.settledBy ?? []);

  return {
    paidBy,
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
