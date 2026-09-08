/**
 * Builds the colour index here and uploads it.
 *
 * It cannot be built on the server. Bambu run a storefront per region and
 * Cloudflare redirects on the caller's IP, so the same product is £17.99 from
 * Manchester and $21.99 from Ohio — which is where Netlify's free-plan
 * functions run. So it is built from a UK connection and posted up.
 *
 *   npm run catalogue                     # uploads to the live site
 *   npm run catalogue -- http://localhost:8888
 *
 * The password comes from COILECTIVE_PASSWORD, the same variable the site
 * uses, read from .env so it is not typed on a command line.
 */

import { readFileSync } from "node:fs";
import { buildCatalogue } from "../netlify/lib/catalogue.mjs";

const DEFAULT_SITE = "https://coilective.danpotepa.co.uk";

/** Reads COILECTIVE_PASSWORD from the environment, falling back to .env. */
function password() {
  if (process.env.COILECTIVE_PASSWORD) return process.env.COILECTIVE_PASSWORD;
  try {
    const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
      .split("\n")
      .find((l) => l.startsWith("COILECTIVE_PASSWORD="));
    if (line) return line.slice("COILECTIVE_PASSWORD=".length).trim();
  } catch { /* fall through to the error below */ }
  throw new Error("Set COILECTIVE_PASSWORD, or put it in .env.");
}

const site = (process.argv[2] ?? DEFAULT_SITE).replace(/\/$/, "");

console.log(`building the index (this takes a minute — the store rate-limits)…`);
const built = await buildCatalogue();
console.log(`  ${built.products} products, ${built.colourCount} colours, ${built.failed.length} failed`);
for (const f of built.failed) console.log(`    ${f.handle}: ${f.reason}`);

// Fail here rather than uploading dollars and being refused at the far end.
const wrong = Object.values(built.colours)
  .flatMap((c) => c.variants)
  .find((v) => v.currency !== "GBP");
if (wrong) {
  console.error(`\nprices came back in ${wrong.currency ?? "no currency"}, not GBP.`);
  console.error("Are you on a VPN? The store has to see a UK connection.");
  process.exit(1);
}

console.log(`\nuploading to ${site}…`);

const login = await fetch(`${site}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: password() }),
});
if (!login.ok) throw new Error(`login failed: ${(await login.json()).error ?? login.status}`);

const response = await fetch(`${site}/api/catalogue`, {
  method: "PUT",
  headers: {
    "content-type": "application/json",
    cookie: login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "),
  },
  body: JSON.stringify(built),
});
const result = await response.json();
if (!response.ok) throw new Error(`upload failed: ${result.error ?? response.status}`);

const carried = result.carriedOver
  ? `, ${result.carriedOver} kept from an earlier build`
  : "";
console.log(`done — ${result.colourCount} colours live${carried}, built ${result.builtAt}`);
