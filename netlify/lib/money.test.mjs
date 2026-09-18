import { test } from "node:test";
import assert from "node:assert/strict";
import { toPence, formatMoney, splitProportionally, settleRound, discountPence, estimateDiscount, readSaleSet, saleSets, saleSet, defaultSaleSetName } from "./money.mjs";

test("parses the price strings Bambu actually returns", () => {
  assert.equal(toPence("17.99"), 1799);
  assert.equal(toPence("17.9"), 1790);
  assert.equal(toPence("18"), 1800);
  assert.equal(toPence("£17.99"), 1799);
  assert.equal(toPence("1,017.99"), 101799);
  assert.equal(toPence(17.99), 1799);
});

test("refuses nonsense rather than guessing", () => {
  for (const bad of ["", "free", "17.99 GBP each", null, undefined, {}]) {
    assert.throws(() => toPence(bad), TypeError, `should reject ${JSON.stringify(bad)}`);
  }
});

test("formats with the right symbol", () => {
  assert.equal(formatMoney(1799), "£17.99");
  assert.equal(formatMoney(1799, "USD"), "$17.99");
  assert.equal(formatMoney(0), "£0.00");
  assert.equal(formatMoney(-500), "-£5.00");
  assert.equal(formatMoney(1799, "SEK"), "SEK 17.99");
});

test("a split always sums to the whole", () => {
  // The point of the exercise: three ways of £10 is 3.34/3.33/3.33, not 3x3.33
  assert.deepEqual(splitProportionally(1000, [1, 1, 1]), [334, 333, 333]);
  assert.equal(splitProportionally(1000, [1, 1, 1]).reduce((a, b) => a + b, 0), 1000);
});

test("a split is proportional to weight", () => {
  assert.deepEqual(splitProportionally(900, [6000, 3000]), [600, 300]);
  assert.deepEqual(splitProportionally(100, [3000, 1000]), [75, 25]);
});

test("awkward proportions still sum exactly", () => {
  for (const total of [1, 7, 99, 1000, 12345]) {
    for (const weights of [[1, 2], [1, 1, 1], [5000, 1799, 1799], [1, 0, 0], [7, 11, 13, 17]]) {
      const shares = splitProportionally(total, weights);
      assert.equal(
        shares.reduce((a, b) => a + b, 0),
        total,
        `${total} across ${weights} gave ${shares}`,
      );
    }
  }
});

test("nobody having spent anything splits evenly rather than dividing by zero", () => {
  assert.deepEqual(splitProportionally(100, [0, 0, 0]), [34, 33, 33]);
});

test("zero to split gives everyone zero", () => {
  assert.deepEqual(splitProportionally(0, [1799, 3598]), [0, 0]);
});

test("a percentage discount is a percentage of the subtotal", () => {
  assert.equal(discountPence({ kind: "percent", value: 10 }, 10000), 1000);
  assert.equal(discountPence({ kind: "percent", value: 12.5 }, 1799), 225);
  assert.equal(discountPence(null, 10000), 0);
});

test("a discount cannot exceed the order or go negative", () => {
  assert.equal(discountPence({ kind: "amount", pence: 999999 }, 5000), 5000);
  assert.equal(discountPence({ kind: "amount", pence: -100 }, 5000), 0);
  assert.equal(discountPence({ kind: "percent", value: 150 }, 5000), 5000);
  assert.equal(discountPence({ kind: "percent", value: -10 }, 5000), 0);
});

const round = {
  shippingPence: 499,
  discount: { kind: "percent", value: 10 },
  items: [
    { person: "dan", unitPricePence: 1799, qty: 2 },  // 35.98
    { person: "dan", unitPricePence: 2499, qty: 1 },  // 24.99
    { person: "sam", unitPricePence: 1799, qty: 1 },  // 17.99
  ],
};

test("settling a round balances", () => {
  const s = settleRound(round);
  assert.equal(s.subtotalPence, 3598 + 2499 + 1799);
  assert.equal(s.totalPence, s.subtotalPence - s.discountPence + s.shippingPence);
  // what everyone owes must add up to what the order actually costs
  assert.equal(
    s.people.reduce((sum, p) => sum + p.owesPence, 0),
    s.totalPence,
    "the sum of what people owe must equal the order total",
  );
});

test("settling splits the shared costs by spend, not by head", () => {
  const s = settleRound(round);
  const dan = s.people.find((p) => p.person === "dan");
  const sam = s.people.find((p) => p.person === "sam");

  assert.equal(dan.subtotalPence, 6097);
  assert.equal(sam.subtotalPence, 1799);
  assert.equal(dan.itemCount, 3);
  assert.equal(sam.itemCount, 1);
  // dan spent ~3.4x more, so takes ~3.4x the discount and postage
  assert.ok(dan.discountPence > sam.discountPence * 3);
  assert.ok(dan.shippingPence > sam.shippingPence * 3);
});

test("an empty round settles to zero rather than throwing", () => {
  const s = settleRound({ items: [] });
  assert.deepEqual(s.people, []);
  assert.equal(s.totalPence, 0);
});

test("the payer owes nobody, and everyone else owes them", () => {
  const round = {
    paidBy: "dan",
    items: [
      { person: "dan", unitPricePence: 6000, qty: 1 },
      { person: "matt", unitPricePence: 3000, qty: 1 },
      { person: "sam", unitPricePence: 1000, qty: 1 },
    ],
  };
  const s = settleRound(round);
  const of = (name) => s.people.find((p) => p.person === name);

  assert.equal(s.paidBy, "dan");
  assert.equal(of("dan").isPayer, true);
  // Already out of pocket, so square by definition — not a debt to collect.
  assert.equal(of("dan").settled, true);
  assert.equal(of("matt").settled, false);

  // Everyone but the payer, until they tick off.
  assert.equal(s.outstandingPence, 4000);
});

test("settling up reduces what the payer is still owed", () => {
  const items = [
    { person: "dan", unitPricePence: 6000, qty: 1 },
    { person: "matt", unitPricePence: 3000, qty: 1 },
    { person: "sam", unitPricePence: 1000, qty: 1 },
  ];
  const settled = settleRound({ paidBy: "dan", settledBy: ["matt"], items });

  assert.equal(settled.people.find((p) => p.person === "matt").settled, true);
  assert.equal(settled.outstandingPence, 1000);

  const all = settleRound({ paidBy: "dan", settledBy: ["matt", "sam"], items });
  assert.equal(all.outstandingPence, 0);
});

test("with no payer named there is nothing outstanding to report", () => {
  // Not zero — zero would read as "everyone has paid up".
  const s = settleRound({ items: [{ person: "dan", unitPricePence: 1000, qty: 1 }] });
  assert.equal(s.paidBy, null);
  assert.equal(s.outstandingPence, null);
});

test("the sale tiers land on the right discount", () => {
  assert.equal(estimateDiscount(0).percent, 0);
  assert.equal(estimateDiscount(3).percent, 0);   // free postage, no money off
  assert.equal(estimateDiscount(4).percent, 30);
  assert.equal(estimateDiscount(5).percent, 30);  // between tiers, keeps the lower
  assert.equal(estimateDiscount(6).percent, 40);
  assert.equal(estimateDiscount(10).percent, 43);
  assert.equal(estimateDiscount(40).percent, 43); // no tier above the top one
});

test("free postage arrives at three spools and stays", () => {
  assert.equal(estimateDiscount(2).freePostage, false);
  assert.equal(estimateDiscount(3).freePostage, true);
  assert.equal(estimateDiscount(20).freePostage, true);
});

test("the next tier says how many more spools it wants", () => {
  assert.deepEqual(estimateDiscount(1).next, { spools: 3, more: 2, percent: 0, freePostage: true });
  assert.deepEqual(estimateDiscount(4).next, { spools: 6, more: 2, percent: 40, freePostage: false });
  assert.deepEqual(estimateDiscount(9).next, { spools: 10, more: 1, percent: 43, freePostage: false });
  // Nothing to reach for at the top.
  assert.equal(estimateDiscount(10).next, null);
});

test("the estimate counts spools, not lines, and ignores what the sale misses", () => {
  const s = settleRound({
    items: [
      { person: "dan", unitPricePence: 1799, qty: 4 },
      { person: "matt", unitPricePence: 1799, qty: 2 },
      // A print plate earns nobody a bulk discount.
      { person: "dan", unitPricePence: 2099, qty: 1, discounted: false },
    ],
  });
  assert.equal(s.estimate.spools, 6);
  assert.equal(s.estimate.percent, 40);
});

test("postage is the usual £4 until the order earns its way out of it", () => {
  assert.equal(estimateDiscount(2).postagePence, 400);
  assert.equal(estimateDiscount(3).postagePence, 0);
  assert.equal(estimateDiscount(10).postagePence, 0);
});

test("the estimated total counts postage, not just the discount", () => {
  // One spool: no discount, but £4 to post it.
  const one = settleRound({ items: [{ person: "dan", unitPricePence: 1799, qty: 1 }] });
  assert.equal(one.estimate.totalPence, 1799 + 400);

  // Four: 30% off and free postage.
  const four = settleRound({ items: [{ person: "dan", unitPricePence: 1799, qty: 4 }] });
  assert.equal(four.estimate.totalPence, 7196 - 2159);
});

test("each person's estimate splits the same way the real discount will", () => {
  const s = settleRound({
    items: [
      { person: "dan", unitPricePence: 6000, qty: 1 },
      { person: "matt", unitPricePence: 2000, qty: 1 },
      { person: "sam", unitPricePence: 2000, qty: 2 },
    ],
  });
  // 4 spools in the sale, so 30% off £120.00 and free postage.
  assert.equal(s.estimate.percent, 30);
  assert.equal(s.estimate.discountPence, 3600);

  const of = (name) => s.people.find((p) => p.person === name).estimate;
  assert.equal(of("dan").discountPence, 1800);   // £60 of £120, so half the £36
  assert.equal(of("matt").discountPence, 600);
  assert.equal(of("sam").discountPence, 1200);

  assert.equal(of("dan").owesPence, 6000 - 1800);
  // The shares add up to the whole, as everywhere else.
  const shares = s.people.reduce((n, p) => n + p.estimate.owesPence, 0);
  assert.equal(shares, s.estimate.totalPence);
});

test("a person's estimate carries their share of postage too", () => {
  const s = settleRound({
    items: [
      { person: "dan", unitPricePence: 3000, qty: 1 },
      { person: "matt", unitPricePence: 1000, qty: 1 },
    ],
  });
  // Two spools: no discount, £4 postage split by spend 3:1.
  assert.equal(s.estimate.postagePence, 400);
  const of = (name) => s.people.find((p) => p.person === name).estimate;
  assert.equal(of("dan").postagePence, 300);
  assert.equal(of("matt").postagePence, 100);
  assert.equal(of("matt").owesPence, 1100);
});

test("line discounts add up to the round's discount, and to each person's", () => {
  const round = {
    discount: { kind: "percent", value: 43.02 },
    items: [
      { id: "a", person: "dan", unitPricePence: 1799, qty: 2 },
      { id: "b", person: "dan", unitPricePence: 2099, qty: 1 },
      { id: "c", person: "matt", unitPricePence: 1799, qty: 1 },
      // Out of the sale, so it keeps its full price.
      { id: "d", person: "dan", unitPricePence: 3499, qty: 1, discounted: false },
    ],
  };
  const s = settleRound(round);
  const lines = Object.values(s.lines);

  // No penny invented or lost between the lines and the whole.
  assert.equal(lines.reduce((n, l) => n + l.discountPence, 0), s.discountPence);
  assert.equal(s.lines.d.discountPence, 0);
  assert.equal(s.lines.d.totalPence, 3499);

  // And a person's discount is exactly their lines' discounts.
  const dan = s.people.find((p) => p.person === "dan");
  assert.equal(
    s.lines.a.discountPence + s.lines.b.discountPence + s.lines.d.discountPence,
    dan.discountPence,
  );
});


test("a named sale set is read as written, in any order", () => {
  const sale = readSaleSet({
    label: "Test sale",
    postagePence: 500,
    freePostageAt: 2,
    tiers: [{ spools: 8, percent: 45 }, { spools: 3, percent: 25 }],
  }, "test");

  assert.equal(sale.name, "test");
  assert.equal(sale.label, "Test sale");
  assert.equal(sale.postagePence, 500);
  // Sorted by spool count, with the free-postage point folded in as a step so
  // the "next tier" nudge can point at it.
  assert.deepEqual(sale.steps, [
    { spools: 2, percent: 0 },
    { spools: 3, percent: 25 },
    { spools: 8, percent: 45 },
  ]);
});

test("a tier already at the free-postage count is not duplicated", () => {
  const sale = readSaleSet({
    postagePence: 400, freePostageAt: 3, tiers: [{ spools: 3, percent: 10 }],
  }, "test");
  assert.deepEqual(sale.steps, [{ spools: 3, percent: 10 }]);
});

test("a malformed sale set refuses to load rather than misprice an order", () => {
  const good = { postagePence: 400, freePostageAt: 3, tiers: [{ spools: 4, percent: 30 }] };
  const read = (patch) => readSaleSet({ ...good, ...patch }, "test");

  // A bigger order cannot be worth less than a smaller one.
  assert.throws(() => read({ tiers: [{ spools: 4, percent: 30 }, { spools: 6, percent: 20 }] }),
    /cannot be worth less/);
  assert.throws(() => read({ tiers: [{ spools: 4, percent: 30 }, { spools: 4, percent: 40 }] }),
    /listed twice/);
  assert.throws(() => read({ tiers: [] }), /at least one tier/);
  assert.throws(() => read({ tiers: [{ spools: 0, percent: 30 }] }), /at least 1/);
  assert.throws(() => read({ tiers: [{ spools: 4, percent: 140 }] }), /percent/);
  assert.throws(() => read({ postagePence: 4.5 }), /whole pence/);
  assert.throws(() => read({ freePostageAt: 0 }), /at least 1/);

  // The set name is in the message, so a bad edit says which set is wrong.
  assert.throws(() => read({ tiers: [] }), /test/);
});

test("the config exposes every set, and names a default that exists", () => {
  assert.ok(saleSets().length >= 1, "at least one set");
  const names = saleSets().map((s) => s.name);
  assert.ok(names.includes(defaultSaleSetName()), "the default names a set that exists");
});

test("an unknown set name falls back to the default rather than throwing", () => {
  // A round can name a set that has since been deleted from the config. That
  // must not take the whole app down.
  const fallback = saleSet("no-such-set");
  assert.equal(fallback.name, defaultSaleSetName());
});

test("an open round estimates with whichever set is active", () => {
  const items = [{ person: "dan", unitPricePence: 1000, qty: 4 }];

  const bulk = settleRound({ items }, { activeSaleSet: "bulk" });
  const easter = settleRound({ items }, { activeSaleSet: "easter" });

  // Four spools: 30% under the bulk sale, 35% under Easter.
  assert.equal(bulk.estimate.percent, 30);
  assert.equal(easter.estimate.percent, 35);
  assert.equal(bulk.estimate.saleSet, "bulk");
  assert.equal(easter.estimate.saleSet, "easter");
});

test("a closed round uses the set frozen onto it, not the live one", () => {
  // The whole point: editing the config, or switching the active set, must not
  // change what a settled order says.
  const frozen = readSaleSet(
    { label: "As it was", postagePence: 400, freePostageAt: 3, tiers: [{ spools: 4, percent: 30 }] },
    "as-it-was",
  );

  const round = {
    status: "closed",
    saleSet: frozen,
    items: [{ person: "dan", unitPricePence: 1000, qty: 4 }],
  };

  // Active set says 35%; the round's own set says 30% and wins.
  const s = settleRound(round, { activeSaleSet: "easter" });
  assert.equal(s.estimate.percent, 30);
  assert.equal(s.estimate.saleSet, "as-it-was");
});

test("what a closed round owes never depended on the tiers anyway", () => {
  // Belt and braces on the property that actually matters. The discount is the
  // figure typed at close, not one the tiers produce.
  const round = {
    status: "closed",
    discount: { kind: "amount", pence: 1234 },
    items: [{ person: "dan", unitPricePence: 5000, qty: 2 }],
  };

  const underBulk = settleRound(round, { activeSaleSet: "bulk" });
  const underEaster = settleRound(round, { activeSaleSet: "easter" });

  assert.equal(underBulk.discountPence, 1234);
  assert.equal(underEaster.discountPence, 1234);
  assert.equal(underBulk.totalPence, underEaster.totalPence);
});
