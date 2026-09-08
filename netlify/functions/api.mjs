/**
 * The whole API, in one function.
 *
 * Netlify bills and cold-starts per function, and these handlers are a few
 * lines each sharing the same store, so one function with a small router is
 * less machinery than a file per endpoint.
 *
 *   GET    /api/state                          everything the page needs
 *   POST   /api/lookup                         { url } or { id } → variants
 *   GET    /api/catalogue                      what the colour index knows
 *   POST   /api/catalogue                      start a rebuild (202; poll GET)
 *   POST   /api/rounds                         { name } → new open round
 *   GET    /api/rounds/:id                     one round, settled
 *   POST   /api/rounds/:id/items               add an item
 *   PATCH  /api/rounds/:id/items/:itemId       { qty } or { discounted }
 *   DELETE /api/rounds/:id/items/:itemId       remove
 *   POST   /api/rounds/:id/close               { discount, shippingPence }
 *   POST   /api/rounds/:id/reopen
 *   PATCH  /api/rounds/:id                     { name } → rename
 *   DELETE /api/rounds/:id                     remove it entirely
 */

import { lookupProduct } from "../lib/bambu.mjs";
import { findColour } from "../lib/catalogue.mjs";
import { settleRound } from "../lib/money.mjs";
import {
  readAllRounds, readRound, createRound, addItem, removeItem, setQty,
  closeRound, reopenRound, renameRound, deleteRound, setDiscounted,
  readCatalogue, NotFound, Conflict, BadRequest,
} from "../lib/store.mjs";

export const config = { path: "/api/*" };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** A round plus the derived totals, so the page never does money maths. */
const withTotals = (round) => ({ ...round, settlement: settleRound(round) });

export default async function handler(request) {
  const { pathname } = new URL(request.url);
  const parts = pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = request.method;

  const body = async () => {
    try {
      return await request.json();
    } catch {
      throw new BadRequest("Expected a JSON body.");
    }
  };

  try {
    // GET /api/state
    if (method === "GET" && parts[0] === "state") {
      // Summaries are derived from the rounds, never cached in the index, so
      // the list can't show a name a round no longer has.
      const all = await readAllRounds();
      const open = all.find((r) => r.status === "open");
      return json({
        open: open ? withTotals(open) : null,
        rounds: all.map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          createdAt: r.createdAt,
          itemCount: r.items.reduce((n, i) => n + i.qty, 0),
          totalPence: settleRound(r).totalPence,
        })),
      });
    }

    // POST /api/lookup   { url } or { id }
    if (method === "POST" && parts[0] === "lookup") {
      const { url, id } = await body();

      if (id) {
        const catalogue = await readCatalogue();
        if (!catalogue) {
          throw new BadRequest("The colour catalogue hasn't been built yet. Refresh it first.");
        }
        try {
          return json(findColour(catalogue, id));
        } catch (err) {
          throw new BadRequest(err.message);
        }
      }

      if (!url) throw new BadRequest("Give a product link or a five-digit colour code.");
      return json(await lookupProduct(url));
    }

    if (parts[0] === "catalogue") {
      // GET /api/catalogue — what we know, without the bulk of it
      if (method === "GET") {
        const catalogue = await readCatalogue();
        return json(catalogue
          ? {
              builtAt: catalogue.builtAt,
              products: catalogue.products,
              colourCount: catalogue.colourCount ?? Object.keys(catalogue.colours ?? {}).length,
              failed: catalogue.failed ?? [],
            }
          : { builtAt: null, products: 0, colourCount: 0, failed: [] });
      }

      // POST /api/catalogue — start a rebuild and return immediately.
      // The work itself is far too slow for a synchronous function.
      if (method === "POST") {
        const target = new URL("/.netlify/functions/catalogue-refresh-background", request.url);
        // Deliberately not awaited: the background function reports via its
        // own 202 and the page polls GET /api/catalogue for the result.
        fetch(target, { method: "POST" }).catch((err) => console.error(err));
        return json({ started: true }, 202);
      }
    }

    if (parts[0] === "rounds") {
      const [, id, section, itemId] = parts;

      // POST /api/rounds
      if (method === "POST" && !id) {
        const { name } = await body();
        return json(withTotals(await createRound(name)), 201);
      }

      if (!id) return json({ error: "Not found." }, 404);

      // GET /api/rounds/:id
      if (method === "GET" && !section) {
        return json(withTotals(await readRound(id)));
      }

      // DELETE /api/rounds/:id
      if (method === "DELETE" && !section) {
        return json(await deleteRound(id));
      }

      if (section === "items") {
        const payload = await body();
        const revision = payload.revision;

        if (method === "POST" && !itemId) {
          return json(withTotals(await addItem(id, revision, payload)), 201);
        }
        if (method === "PATCH" && itemId) {
          if (payload.discounted !== undefined) {
            return json(withTotals(await setDiscounted(id, revision, itemId, payload.discounted)));
          }
          return json(withTotals(await setQty(id, revision, itemId, payload.qty)));
        }
        if (method === "DELETE" && itemId) {
          return json(withTotals(await removeItem(id, revision, itemId)));
        }
      }

      if (method === "POST" && section === "close") {
        const { revision, discount, shippingPence } = await body();
        return json(withTotals(await closeRound(id, revision, { discount, shippingPence })));
      }

      // PATCH /api/rounds/:id  { name }
      if (method === "PATCH" && !section) {
        const { revision, name } = await body();
        return json(withTotals(await renameRound(id, revision, name)));
      }

      if (method === "POST" && section === "reopen") {
        const { revision } = await body();
        return json(withTotals(await reopenRound(id, revision)));
      }
    }

    return json({ error: `No route for ${method} ${pathname}` }, 404);
  } catch (err) {
    // Every thrown message here is written to be shown to a person.
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    if (err instanceof NotFound) return json({ error: err.message }, 404);
    if (err instanceof Conflict) return json({ error: err.message }, 409);
    console.error(err);
    return json({ error: err.message ?? "Something went wrong." }, 500);
  }
}
