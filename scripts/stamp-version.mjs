/**
 * Records when this deploy was built, for the footer.
 *
 * Netlify sets COMMIT_REF and friends in the build environment but has no
 * "deployed at" variable, so the build itself is the only place that knows.
 * Written into the published directory rather than baked into index.html, so
 * the page stays the same file in the repo and in production.
 */

import { writeFileSync } from "node:fs";

const version = {
  builtAt: new Date().toISOString(),
  // Short sha, so the footer can say which commit is live. Absent when built
  // outside Netlify.
  commit: process.env.COMMIT_REF?.slice(0, 7) ?? null,
  branch: process.env.BRANCH ?? null,
};

writeFileSync(new URL("../public/version.json", import.meta.url), `${JSON.stringify(version)}\n`);
console.log(`stamped ${version.builtAt}${version.commit ? ` (${version.commit})` : ""}`);
