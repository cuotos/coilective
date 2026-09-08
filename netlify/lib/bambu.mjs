/**
 * Reading a product off the Bambu Lab store.
 *
 * Their product pages carry schema.org JSON-LD — a `ProductGroup` whose
 * `hasVariant` lists every colour and size with its own price, currency and
 * stock. That is a published, structured format rather than markup we're
 * guessing at, so this is a parse and not a scrape.
 *
 * It will still break if they drop the structured data. Every failure here
 * throws a message meant to be shown to a person, so the UI can fall back to
 * typing a price by hand.
 */

import { toPence } from "./money.mjs";

const ALLOWED_HOST = /(^|\.)bambulab\.com$/;

/**
 * Prices come from the UK store or not at all.
 *
 * Bambu run a storefront per region and Cloudflare redirects you to the one
 * matching your IP, so the same URL is £17.99 from Manchester and $21.99 from
 * Ohio. We settle up in sterling, so any regional link is rewritten to the UK
 * store rather than trusted as given — paste a us.store link and you still get
 * the UK price.
 */
const UK_STORE = "uk.store.bambulab.com";
const REGIONAL_STORE = /^[a-z]{2}\.store\.bambulab\.com$/;

/** Rejects anything that isn't a Bambu store URL, so this can't be used as a proxy. */
export function assertBambuUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That doesn't look like a URL.");
  }
  if (url.protocol !== "https:") throw new Error("The link needs to be https.");
  if (!ALLOWED_HOST.test(url.hostname)) {
    throw new Error("That's not a bambulab.com link. Only the Bambu store is supported.");
  }
  const host = REGIONAL_STORE.test(url.hostname) ? UK_STORE : url.hostname;
  // Drop tracking and variant params so the same product isn't cached twice.
  return `https://${host}${url.pathname}`;
}

/** Every `<script type="application/ld+json">` on the page, parsed. */
function jsonLdBlocks(html) {
  const blocks = [];
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      blocks.push(JSON.parse(match[1]));
    } catch {
      // A page can carry several blocks; one being malformed is not fatal.
    }
  }
  return blocks.flatMap((block) => (Array.isArray(block) ? block : [block]));
}

function variantsOf(node) {
  const list = node.hasVariant ?? (node["@type"] === "Product" ? [node] : []);
  return list
    .map((variant) => {
      const offer = Array.isArray(variant.offers) ? variant.offers[0] : variant.offers;
      if (!offer?.price) return null;

      let pricePence;
      try {
        pricePence = toPence(String(offer.price));
      } catch {
        return null;
      }

      // "PLA Basic - Jade White (10100) / Refill / 1 kg" → the part that varies
      const full = String(variant.name ?? "").trim();
      const label = full.startsWith(`${node.name} - `) ? full.slice(node.name.length + 3) : full;

      return {
        label: label || full,
        pricePence,
        // No default: a missing currency is unknown, not sterling. Claiming
        // GBP here is how dollars end up added into a sterling total.
        currency: offer.priceCurrency ?? null,
        inStock: String(offer.availability ?? "").endsWith("InStock"),
      };
    })
    .filter(Boolean);
}

/**
 * Fetches a product page and returns what it sells.
 *
 * @returns {{ productName: string, url: string, variants: Array }}
 */
export async function lookupProduct(rawUrl, { fetchImpl = fetch } = {}) {
  const url = assertBambuUrl(rawUrl);

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { "user-agent": "coilective (group order tracker)" },
      // Not followed on purpose. The store redirects to whichever regional
      // storefront matches the caller's IP, and following that quietly
      // returns another country's prices in another country's currency.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`Couldn't reach the Bambu store: ${err.message}`);
  }
  if (response.status >= 300 && response.status < 400) {
    const to = response.headers.get("location") ?? "somewhere else";
    throw new Error(
      `The store sent us to ${to} instead of the UK site, so the price would be `
      + `in the wrong currency. That happens when the request doesn't come from the UK.`,
    );
  }
  if (!response.ok) {
    throw new Error(`The Bambu store returned ${response.status} for that link.`);
  }

  const nodes = jsonLdBlocks(await response.text());
  const product = nodes.find((n) => n["@type"] === "ProductGroup" || n["@type"] === "Product");
  if (!product) {
    throw new Error("That page has no product data on it. Is it a product page?");
  }

  const variants = variantsOf(product);
  if (variants.length === 0) {
    throw new Error("Found the product but none of its prices. Add it by hand.");
  }

  // Belt and braces behind the redirect check: the UK store could in principle
  // quote something other than sterling, and that must not reach a total.
  const wrong = variants.find((v) => v.currency !== "GBP");
  if (wrong) {
    throw new Error(
      `That page quotes prices in ${wrong.currency ?? "no stated currency"}, not pounds. `
      + `Only UK store prices can be used.`,
    );
  }

  return { productName: String(product.name ?? "Unknown product"), url, variants };
}
