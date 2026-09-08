/**
 * Rebuilds the colour catalogue, in the background.
 *
 * The build makes ~50 requests to a store that rate-limits hard, so it is
 * paced deliberately slowly and takes the better part of a minute — well past
 * what a synchronous function is allowed. A background function returns 202
 * straight away and keeps working; the page polls GET /api/catalogue and
 * notices `builtAt` change.
 */

import { buildCatalogue } from "../lib/catalogue.mjs";
import { writeCatalogue } from "../lib/store.mjs";

export default async function handler() {
  const built = await buildCatalogue();
  await writeCatalogue(built);
  console.log(
    `catalogue: ${built.products} products, ${built.colourCount} colours, ${built.failed.length} failed`,
  );
}
