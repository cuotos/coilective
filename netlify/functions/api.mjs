/**
 * The whole API, in one function.
 *
 * Netlify bills and cold-starts per function, and these handlers are a few
 * lines each sharing the same store, so one function with a small router is
 * less machinery than a file per endpoint.
 *
 *   POST   /api/login                          { password } → a session cookie
 *   GET    /api/state                          everything the page needs
 *   POST   /api/lookup                         { url } or { id } → variants
 *   GET    /api/catalogue                      what the colour index knows
 *   PUT    /api/catalogue                      upload one built on a UK machine
 *   GET    /api/rounds/:id                     one round, settled
 *   POST   /api/rounds/:id/items               add an item
 *   PATCH  /api/rounds/:id/items/:itemId       { qty } or { discounted }
 *   DELETE /api/rounds/:id/items/:itemId       remove
 *   POST   /api/rounds/:id/close               { discount, shippingPence, paidBy }
 *   POST   /api/rounds/:id/settled             { person, settled } → tick off a debt
 *   POST   /api/rounds/:id/reopen
 *   PATCH  /api/rounds/:id                     { name } or { paidBy }
 *   DELETE /api/rounds/:id                     remove it entirely
 */

import { assertAuthed, login, NotConfigured, Unauthorized } from "../lib/auth.mjs";
import { lookupProduct } from "../lib/bambu.mjs";
import { findColour } from "../lib/catalogue.mjs";
import { settleRound } from "../lib/money.mjs";
import {
  ensureOpenRound, readRound, addItem, removeItem, setQty,
  closeRound, reopenRound, renameRound, deleteRound, setDiscounted,
  setPaidBy, setSettled,
  readCatalogue, writeCatalogue, NotFound, Conflict, BadRequest,
} from "../lib/store.mjs";

export const config = { path: "/api/*" };

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
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
    // POST /api/login   { password }
    // Ahead of the guard, obviously — it is how you get past it.
    if (method === "POST" && parts[0] === "login") {
      const { password } = await body();
      return json({ ok: true }, 200, { "set-cookie": login(request, password) });
    }

    // Everything past here needs the password. One check, so a route added
    // later cannot forget to make it.
    assertAuthed(request);

    // GET /api/state
    if (method === "GET" && parts[0] === "state") {
      // Summaries are derived from the rounds, never cached in the index, so
      // the list can't show a name a round no longer has. There is always an
      // open round to show — this is what creates it if a close left none.
      const { open, rounds: all } = await ensureOpenRound();
      return json({
        open: withTotals(open),
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
          throw new BadRequest(
            "The colour catalogue hasn't been uploaded yet. Run `npm run catalogue` from a UK machine.",
          );
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

      // PUT /api/catalogue — take one built elsewhere.
      //
      // Not built here: the store quotes prices by the caller's IP, and
      // Netlify's free-plan functions run in Ohio, where that means dollars.
      // `npm run catalogue` builds it from a UK machine and posts it up;
      // writeCatalogue refuses one that is not in sterling.
      if (method === "PUT") {
        const uploaded = await writeCatalogue(await body());
        return json({
          builtAt: uploaded.builtAt,
          products: uploaded.products,
          colourCount: uploaded.colourCount,
          carriedOver: uploaded.carriedOver ?? 0,
          failed: uploaded.failed ?? [],
        });
      }
    }

    if (parts[0] === "rounds") {
      const [, id, section, itemId] = parts;

      // No route to create one: the open round is made by /api/state when a
      // close leaves none, so there is nothing for a caller to start.
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
        const { revision, discount, shippingPence, paidBy } = await body();
        return json(withTotals(await closeRound(id, revision, { discount, shippingPence, paidBy })));
      }

      // POST /api/rounds/:id/settled  { person, settled }
      if (method === "POST" && section === "settled") {
        const { revision, person, settled } = await body();
        return json(withTotals(await setSettled(id, revision, person, settled)));
      }

      // PATCH /api/rounds/:id  { name } or { paidBy }
      if (method === "PATCH" && !section) {
        const { revision, name, paidBy } = await body();
        if (paidBy !== undefined) {
          return json(withTotals(await setPaidBy(id, revision, paidBy)));
        }
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
    if (err instanceof Unauthorized) return json({ error: err.message }, 401);
    // 503 rather than 401: the password is missing from the site, not wrong.
    if (err instanceof NotConfigured) return json({ error: err.message }, 503);
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    if (err instanceof NotFound) return json({ error: err.message }, 404);
    if (err instanceof Conflict) return json({ error: err.message }, 409);
    console.error(err);
    return json({ error: err.message ?? "Something went wrong." }, 500);
  }
}
