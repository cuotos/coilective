/**
 * A catalogue of filament colours, indexed by their Bambu id.
 *
 * Bambu print their colour codes on the spool and on the receipt — the
 * `11100` in "Ivory White (11100)" — and that is what people read out to each
 * other. An id alone does not say which product page it lives on, so this
 * builds an index by walking the store's own sitemap and reading every
 * filament product's structured data.
 *
 * It self-maintains: the sitemap is the store's own list, so a new colour or a
 * new material appears on the next refresh with nothing to edit here.
 */

import { lookupProduct } from "./bambu.mjs";

const SITEMAP = "https://uk.store.bambulab.com/sitemap_products_1.xml";

/** A Bambu colour code, as printed on the spool: "Ivory White (11100) / …". */
const COLOUR_CODE = /\((\d{5})\)/;

/**
 * Handles worth fetching.
 *
 * Filtering by name is only a first pass to keep the fetch count sane — the
 * real filter is whether a product's variants carry colour codes, which spare
 * parts and printers never do.
 */
// Both are tested against the handle alone, never the path — "/products/"
// itself contains "duct", which quietly excluded every product.
const MATERIAL = /^((pla|petg|abs|asa|tpu|pa\d?|paht|pet|pps|pc|pva|bvoh|support)[-a-z0-9]*|[a-z0-9-]*filament)$/;
const NOT_FILAMENT = /plate|assembly|sensor|\bkit\b|cable|housing|nut|spring|gear|funnel|hub|feeder|guide|idler|retraction|shaft|swatch|platform|ring|display|extruder|camera|battery|combo|decoration|holder|dryer|fan|duct|connector|balls|ornament|barb|module|footpad|tube/;

const handleOf = (path) => path.replace(/^\/products\//, "");

async function candidateHandles(fetchImpl, attempts = 4) {
  let response;
  for (let attempt = 1; ; attempt++) {
    response = await fetchImpl(SITEMAP, {
      headers: { "user-agent": "coilective (group order tracker)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) break;
    // The store rate-limits the sitemap as readily as a product page.
    if (response.status !== 429 || attempt >= attempts) {
      throw new Error(`The store's sitemap returned ${response.status}.`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
  }

  const xml = await response.text();
  const paths = [...new Set((xml.match(/\/products\/[a-z0-9-]+/g) ?? []))];
  return paths.filter((path) => {
    const handle = handleOf(path);
    return MATERIAL.test(handle) && !NOT_FILAMENT.test(handle);
  });
}

/**
 * Fetches a product, waiting and retrying if the store rate-limits us.
 *
 * The store returns 429 under even mild concurrency, and treating that as
 * "not filament" made the catalogue silently incomplete — PLA Translucent
 * vanished from it that way.
 */
async function lookupWithRetry(url, fetchImpl, attempts = 6) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await lookupProduct(url, { fetchImpl });
    } catch (err) {
      const rateLimited = /returned 429/.test(err.message);
      if (!rateLimited || attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 800 * 2 ** (attempt - 1)));
    }
  }
}

/** Runs `work` over `items`, `limit` at a time, so the store isn't hammered. */
async function pooled(items, limit, work) {
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        results.push(await work(item));
        await new Promise((r) => setTimeout(r, 250)); // be a polite guest
      }
    }),
  );
  return results;
}

/**
 * Builds the whole index.
 *
 * @returns {{ builtAt: string, products: number, colourCount: number,
 *             failed: Array, colours: object }}
 *   `colours` maps a Bambu id to everything needed to add it to a round.
 *   `failed` lists products that could not be read, so a partial build is
 *   visible rather than silent.
 */
export async function buildCatalogue({ fetchImpl = fetch, concurrency = 2 } = {}) {
  const handles = await candidateHandles(fetchImpl);
  const failed = [];

  const products = await pooled(handles, concurrency, async (path) => {
    const url = `https://uk.store.bambulab.com${path}`;
    try {
      return await lookupWithRetry(url, fetchImpl);
    } catch (err) {
      // A page with no product data simply isn't filament. Anything else —
      // a 429, a timeout — means the catalogue is short, and saying so beats
      // pretending the colour doesn't exist.
      if (!/no product data|returned 404/.test(err.message)) {
        failed.push({ handle: handleOf(path), reason: err.message });
      }
      return null;
    }
  });

  const colours = {};
  let counted = 0;

  for (const product of products.filter(Boolean)) {
    const coded = product.variants.filter((v) => COLOUR_CODE.test(v.label));
    if (coded.length === 0) continue; // not filament
    counted += 1;

    for (const variant of coded) {
      const id = variant.label.match(COLOUR_CODE)[1];
      // A colour can appear as Refill and as "Filament with spool" at
      // different prices, so keep them all rather than letting one win.
      colours[id] ??= { id, productName: product.productName, url: product.url, variants: [] };
      colours[id].variants.push(variant);
    }
  }

  return {
    builtAt: new Date().toISOString(),
    products: counted,
    colourCount: Object.keys(colours).length,
    failed,
    colours,
  };
}

/** What a colour id resolves to, in the shape the add-item flow expects. */
export function findColour(catalogue, rawId) {
  const id = String(rawId ?? "").trim();
  if (!/^\d{5}$/.test(id)) {
    throw new Error("A Bambu colour code is five digits, like 11100.");
  }
  const hit = catalogue?.colours?.[id];
  if (!hit) {
    throw new Error(
      `No colour ${id} in the catalogue. Refresh it, or paste the product link instead.`,
    );
  }
  return { productName: hit.productName, url: hit.url, variants: hit.variants };
}
