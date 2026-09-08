import { test } from "node:test";
import assert from "node:assert/strict";
import { assertBambuUrl, lookupProduct } from "./bambu.mjs";

test("accepts Bambu store links and strips tracking", () => {
  assert.equal(
    assertBambuUrl("https://uk.store.bambulab.com/products/pla-basic-filament?variant=42&utm_source=x"),
    "https://uk.store.bambulab.com/products/pla-basic-filament",
  );
  assert.equal(
    assertBambuUrl("https://eu.store.bambulab.com/products/petg-hf"),
    "https://eu.store.bambulab.com/products/petg-hf",
  );
});

test("refuses anything that is not the Bambu store", () => {
  // Without this the function is an open proxy for fetching arbitrary URLs.
  for (const bad of [
    "https://example.com/products/x",
    "https://bambulab.com.evil.test/x",
    "http://uk.store.bambulab.com/x",
    "not a url",
  ]) {
    assert.throws(() => assertBambuUrl(bad), Error, `should reject ${bad}`);
  }
});

const page = (ld) => `<html><head>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head><body></body></html>`;

const stub = (body, init = {}) => async () => new Response(body, { status: 200, ...init });

test("reads variants out of a ProductGroup", async () => {
  const result = await lookupProduct("https://uk.store.bambulab.com/products/pla-basic-filament", {
    fetchImpl: stub(page({
      "@type": "ProductGroup",
      name: "PLA Basic",
      hasVariant: [
        {
          name: "PLA Basic - Jade White (10100) / Refill / 1 kg",
          offers: { price: "17.99", priceCurrency: "GBP", availability: "https://schema.org/InStock" },
        },
        {
          name: "PLA Basic - Orange (10300) / Spool / 1 kg",
          offers: { price: "21.49", priceCurrency: "GBP", availability: "https://schema.org/OutOfStock" },
        },
      ],
    })),
  });

  assert.equal(result.productName, "PLA Basic");
  assert.equal(result.variants.length, 2);
  // the product name is stripped from the front, leaving only what varies
  assert.equal(result.variants[0].label, "Jade White (10100) / Refill / 1 kg");
  assert.equal(result.variants[0].pricePence, 1799);
  assert.equal(result.variants[0].inStock, true);
  assert.equal(result.variants[1].pricePence, 2149);
  assert.equal(result.variants[1].inStock, false);
});

test("handles a plain Product with a single offer", async () => {
  const result = await lookupProduct("https://uk.store.bambulab.com/products/thing", {
    fetchImpl: stub(page({
      "@type": "Product",
      name: "AMS Lite",
      offers: { price: "99.00", priceCurrency: "GBP" },
    })),
  });
  assert.equal(result.variants.length, 1);
  assert.equal(result.variants[0].pricePence, 9900);
});

test("skips variants with no usable price rather than failing the lot", async () => {
  const result = await lookupProduct("https://uk.store.bambulab.com/products/thing", {
    fetchImpl: stub(page({
      "@type": "ProductGroup",
      name: "Mixed",
      hasVariant: [
        { name: "Mixed - good", offers: { price: "5.00", priceCurrency: "GBP" } },
        { name: "Mixed - no offer" },
        { name: "Mixed - junk price", offers: { price: "call us" } },
      ],
    })),
  });
  assert.equal(result.variants.length, 1);
});

test("says something useful when the page has no product data", async () => {
  await assert.rejects(
    () => lookupProduct("https://uk.store.bambulab.com/pages/about", { fetchImpl: stub("<html></html>") }),
    /no product data/,
  );
});

test("reports an HTTP failure plainly", async () => {
  await assert.rejects(
    () => lookupProduct("https://uk.store.bambulab.com/products/gone", {
      fetchImpl: async () => new Response("nope", { status: 404 }),
    }),
    /returned 404/,
  );
});

test("survives a malformed JSON-LD block alongside a good one", async () => {
  const html = `<html>
    <script type="application/ld+json">{ not json </script>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "Product", name: "Fine", offers: { price: "1.00" },
    })}</script></html>`;
  const result = await lookupProduct("https://uk.store.bambulab.com/products/x", { fetchImpl: stub(html) });
  assert.equal(result.productName, "Fine");
});
