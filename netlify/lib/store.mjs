/**
 * Persistence, on Netlify Blobs.
 *
 * One blob per round, plus an `index` blob listing which rounds exist. The
 * index holds ids and creation dates only — never a name or a status. Those
 * live on the round, and duplicating them into the index meant the two could
 * disagree, which they promptly did. A round is always read and written whole,
 * so there is no partial state to keep consistent either.
 *
 * Blobs has no transactions, so two people writing the same round at the same
 * moment means the later write wins. Every mutation therefore takes a
 * `revision` the caller last saw and refuses if it has moved on, which turns a
 * silent lost update into a "someone else just changed this, reload" message.
 */

import { getStore } from "@netlify/blobs";
import { toPence } from "./money.mjs";

const STORE = "coilective";
const INDEX_KEY = "index";
const CATALOGUE_KEY = "catalogue";

/**
 * Reads are strongly consistent, deliberately.
 *
 * Blobs defaults to eventual consistency — a write takes up to 60s to reach
 * every edge. Every mutation here is a read-modify-write, so a stale read
 * silently drops whatever it could not see: two items added a second apart
 * lost the first. Strong reads are slower, which at a few requests per order
 * costs nothing worth measuring.
 */
const store = () => getStore({ name: STORE, consistency: "strong" });

function newId() {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10);
  return `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Which rounds exist, newest first. Ids and dates only.
 *
 * Older indexes also carried `name` and `status`; those are ignored so a
 * stale copy cannot resurface.
 */
export async function readIndex() {
  const index = await store().get(INDEX_KEY, { type: "json" });
  const rounds = (index?.rounds ?? []).map(({ id, createdAt }) => ({ id, createdAt }));
  return { rounds };
}

/**
 * Every round, in full, newest first.
 *
 * Reads one blob per round rather than trusting a summary. With a round or two
 * a month that is a handful of reads, and it is the only way the list cannot
 * be out of date.
 */
export async function readAllRounds() {
  const { rounds } = await readIndex();
  const all = await Promise.all(rounds.map((r) => readRound(r.id).catch(() => null)));
  return all.filter(Boolean);
}

async function writeIndex(index) {
  await store().setJSON(INDEX_KEY, index);
}

export async function readRound(id) {
  const round = await store().get(`round/${id}`, { type: "json" });
  if (!round) throw new NotFound(`No round called ${id}.`);
  return round;
}

async function writeRound(round) {
  await store().setJSON(`round/${round.id}`, round);
}

/**
 * The filament catalogue, cached.
 *
 * Building it costs ~50 fetches against a store that rate-limits, so it is
 * built rarely and read often.
 */
export async function readCatalogue() {
  return store().get(CATALOGUE_KEY, { type: "json" });
}

/**
 * Accepts a catalogue built somewhere else, and checks it before trusting it.
 *
 * The build has to run from a UK connection — Netlify's free-plan functions
 * are in Ohio, where the store quotes dollars — so it is built on a laptop and
 * uploaded. That makes this the boundary where a bad catalogue would otherwise
 * get in, so the currency of every variant is checked here rather than being
 * discovered later in someone's total.
 */
export async function writeCatalogue(catalogue) {
  const colours = catalogue?.colours;
  if (!catalogue?.builtAt || !colours || typeof colours !== "object") {
    throw new BadRequest("That doesn't look like a catalogue.");
  }

  const wrong = Object.values(colours)
    .flatMap((colour) => colour.variants ?? [])
    .find((variant) => variant.currency !== "GBP");
  if (wrong) {
    throw new BadRequest(
      `This catalogue has ${wrong.currency ?? "unpriced"} variants in it. `
      + `It has to be built from a UK connection.`,
    );
  }

  // Merged, never replaced. Which products the store rate-limits varies run to
  // run, so a straight replace loses colours that were known five minutes ago
  // — PETG Clear disappeared out from under an order that way. A colour the
  // new build could not read keeps its previous entry, stamped with the build
  // it came from so an old price is at least visible as old.
  const previous = await readCatalogue();
  const carried = Object.fromEntries(
    Object.entries(previous?.colours ?? {}).map(([id, colour]) => [
      id,
      { ...colour, builtAt: colour.builtAt ?? previous.builtAt },
    ]),
  );
  const merged = { ...carried, ...colours };

  const next = {
    ...catalogue,
    colours: merged,
    colourCount: Object.keys(merged).length,
    carriedOver: Object.keys(merged).length - Object.keys(colours).length,
  };

  await store().setJSON(CATALOGUE_KEY, next);
  return next;
}

export class NotFound extends Error {}
export class Conflict extends Error {}
export class BadRequest extends Error {}

/**
 * Applies `change` to a round and saves it.
 *
 * `expectedRevision` is what the caller last read. If the stored round has
 * moved on, nothing is written — better a refresh than a silently discarded
 * addition.
 */
async function mutate(id, expectedRevision, change) {
  const round = await readRound(id);
  if (expectedRevision !== undefined && round.revision !== expectedRevision) {
    throw new Conflict("Someone else changed this round. Reload and try again.");
  }
  const next = change(structuredClone(round));
  next.revision = (round.revision ?? 0) + 1;
  next.updatedAt = new Date().toISOString();
  await writeRound(next);
  return next;
}

/**
 * There is always exactly one open round, and it is the wishlist.
 *
 * Nobody starts a round: people add to the open one whenever they fancy
 * something, and closing it is the act of ordering. So a close leaves nothing
 * open, and the next read makes the successor — which means the wishlist is
 * never missing, and never something you have to remember to create.
 *
 * Called from GET /api/state, so it is a read that can write. That is the
 * trade for the invariant holding on a fresh site, after a delete, and
 * straight after a close, rather than in only the cases someone remembered.
 */
export async function ensureOpenRound() {
  const rounds = await readAllRounds();
  const open = rounds.find((r) => r.status === "open");
  if (open) return { open, rounds };

  const created = await createRound(defaultRoundName(rounds));
  return { open: created, rounds: [created, ...rounds] };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];

/**
 * What to call a round nobody named. The month it started, which is how these
 * get referred to anyway, with a number if that is taken.
 */
function defaultRoundName(existing) {
  const now = new Date();
  const base = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  const taken = new Set(existing.map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n <= taken.size + 2; n += 1) {
    if (!taken.has(`${base} (${n})`)) return `${base} (${n})`;
  }
  return `${base} (${now.getTime()})`; // unreachable in practice
}

async function createRound(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new BadRequest("Give the round a name.");

  // The index holds ids and dates only, so this has to read the rounds
  // themselves — asking the index for a status silently found nothing.
  const rounds = await readAllRounds();
  if (rounds.some((r) => r.status === "open")) {
    throw new BadRequest("There's already an open round. Close it before starting another.");
  }

  const round = {
    id: newId(),
    name: trimmed,
    status: "open",
    revision: 1,
    discount: null,
    shippingPence: 0,
    items: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
  };

  await writeRound(round);
  const index = await readIndex();
  index.rounds.unshift({ id: round.id, createdAt: round.createdAt });
  await writeIndex(index);
  return round;
}

export async function addItem(id, revision, item) {
  const person = String(item.person ?? "").trim();
  if (!person) throw new BadRequest("Say who this is for.");

  const qty = Number(item.qty ?? 1);
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new BadRequest("Quantity must be 1–99.");

  let unitPricePence;
  try {
    unitPricePence = typeof item.unitPricePence === "number"
      ? Math.round(item.unitPricePence)
      : toPence(item.unitPrice);
  } catch {
    throw new BadRequest("That price doesn't look like a number.");
  }
  if (unitPricePence < 0) throw new BadRequest("A price can't be negative.");

  // Everything downstream adds prices together and never looks at currency, so
  // one dollar figure would be summed into a sterling total as if it matched.
  // This is where that stops, whatever route the item arrived by.
  const currency = item.currency ?? "GBP";
  if (currency !== "GBP") {
    throw new BadRequest(
      `That price is in ${currency}, not pounds. Prices have to come from the UK store.`,
    );
  }

  return mutate(id, revision, (round) => {
    if (round.status !== "open") throw new BadRequest("That round is closed.");
    round.items.push({
      id: `item-${Math.random().toString(36).slice(2, 9)}`,
      person,
      url: item.url ?? null,
      productName: String(item.productName ?? "").trim() || "Unnamed item",
      variant: String(item.variant ?? "").trim() || null,
      unitPricePence,
      currency,
      qty,
      // Whether the round's discount applies to this item. Defaults to yes,
      // since store-wide sales are the common case.
      discounted: item.discounted !== false,
      addedAt: new Date().toISOString(),
      priceCheckedAt: item.url ? new Date().toISOString() : null,
    });
    return round;
  });
}

export async function removeItem(id, revision, itemId) {
  return mutate(id, revision, (round) => {
    if (round.status !== "open") throw new BadRequest("That round is closed.");
    const before = round.items.length;
    round.items = round.items.filter((i) => i.id !== itemId);
    if (round.items.length === before) throw new NotFound("That item is already gone.");
    return round;
  });
}

export async function setQty(id, revision, itemId, qty) {
  const n = Number(qty);
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new BadRequest("Quantity must be 1–99.");
  return mutate(id, revision, (round) => {
    if (round.status !== "open") throw new BadRequest("That round is closed.");
    const item = round.items.find((i) => i.id === itemId);
    if (!item) throw new NotFound("That item is gone.");
    item.qty = n;
    return round;
  });
}

/**
 * Closing is when the discount, postage and payer are known, so they are set
 * here. The payer can be left out and filled in afterwards — sometimes the
 * order goes in before anyone has worked out whose card is on it.
 */
export async function closeRound(id, revision, { discount, shippingPence, paidBy }) {
  return mutate(id, revision, (r) => {
    if (r.status === "closed") throw new BadRequest("That round is already closed.");
    if (r.items.length === 0) throw new BadRequest("Nothing in this round to close.");
    r.discount = normaliseDiscount(discount);
    r.shippingPence = Math.max(0, Math.round(Number(shippingPence) || 0));
    r.paidBy = paidBy ? whoInRound(r, paidBy) : null;
    r.settledBy = [];
    r.status = "closed";
    r.closedAt = new Date().toISOString();
    return r;
  });
}

/**
 * The payer has to be someone with items in the round.
 *
 * Free text here means a typo invents a person nobody owes, and the whole
 * point is knowing who to pay. Anyone ordering for the group has something in
 * it themselves.
 */
function whoInRound(round, person) {
  const name = String(person ?? "").trim().toLowerCase();
  const people = [...new Set(round.items.map((i) => i.person))];
  if (!people.includes(name)) {
    throw new BadRequest(`${name || "Nobody"} has nothing in this round, so can't be the payer.`);
  }
  return name;
}

/** Who fronted the money. Set at close, or corrected later. */
export async function setPaidBy(id, revision, paidBy) {
  return mutate(id, revision, (round) => {
    round.paidBy = paidBy ? whoInRound(round, paidBy) : null;
    // Debts are owed to the payer, so changing them makes the old ticks
    // meaningless rather than merely stale.
    round.settledBy = [];
    return round;
  });
}

/** Ticks somebody off as having paid the payer back, or un-ticks them. */
export async function setSettled(id, revision, person, settled) {
  return mutate(id, revision, (round) => {
    if (!round.paidBy) throw new BadRequest("Say who paid for the order first.");
    const name = whoInRound(round, person);
    const already = new Set(round.settledBy ?? []);
    if (settled === false) already.delete(name);
    else already.add(name);
    round.settledBy = [...already].sort();
    return round;
  });
}

/**
 * Reopen a closed round — for a close that turned out to be premature.
 *
 * Closing spawns an empty successor, so by the time anyone reopens there is
 * almost always one in the way. An empty round holds nothing anybody wants, so
 * reopening absorbs it rather than refusing on its account. One with items in
 * is somebody's wishlist and is left alone.
 */
export async function reopenRound(id, revision) {
  const rounds = await readAllRounds();
  const others = rounds.filter((r) => r.status === "open" && r.id !== id);
  if (others.some((r) => r.items.length > 0)) {
    throw new BadRequest("Another round is open with things in it. Close that one first.");
  }
  for (const empty of others) await deleteRound(empty.id);
  return mutate(id, revision, (r) => {
    r.status = "open";
    r.closedAt = null;
    return r;
  });
}

/** Marks an item in or out of the round's discount. */
export async function setDiscounted(id, revision, itemId, discounted) {
  return mutate(id, revision, (round) => {
    if (round.status !== "open") throw new BadRequest("That round is closed.");
    const item = round.items.find((i) => i.id === itemId);
    if (!item) throw new NotFound("That item is gone.");
    item.discounted = discounted !== false;
    return round;
  });
}

/** Renames a round. The name lives only here, so nothing else needs updating. */
export async function renameRound(id, revision, name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new BadRequest("A round needs a name.");
  return mutate(id, revision, (round) => {
    round.name = trimmed;
    return round;
  });
}

/** Removes a round and its index entry. There is no undo. */
export async function deleteRound(id) {
  const round = await readRound(id); // 404s rather than silently succeeding
  await store().delete(`round/${id}`);

  const index = await readIndex();
  index.rounds = index.rounds.filter((r) => r.id !== id);
  await writeIndex(index);
  return { deleted: round.id, name: round.name };
}

function normaliseDiscount(discount) {
  if (!discount || discount.kind === "none") return null;
  if (discount.kind === "percent") {
    const value = Number(discount.value);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new BadRequest("A percentage discount has to be between 0 and 100.");
    }
    return { kind: "percent", value };
  }
  if (discount.kind === "amount") {
    let pence;
    try {
      pence = typeof discount.pence === "number" ? Math.round(discount.pence) : toPence(discount.amount);
    } catch {
      throw new BadRequest("That discount doesn't look like an amount.");
    }
    if (pence < 0) throw new BadRequest("A discount can't be negative.");
    return { kind: "amount", pence };
  }
  throw new BadRequest("Choose a percentage or an amount.");
}
