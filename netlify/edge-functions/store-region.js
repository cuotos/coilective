/**
 * Temporary probe: does an edge function reach the UK store as the UK?
 *
 * Netlify's serverless functions run in Ohio, so the Bambu store redirects
 * them to us.store and quotes dollars. Edge functions run near the visitor, so
 * a request from the UK should reach uk.store and stay there. This reports
 * what actually happens, because guessing at a CDN's egress is guessing.
 *
 * Delete once that question is answered.
 */

const PRODUCT = "https://uk.store.bambulab.com/products/pla-matte";

export default async function handler(request, context) {
  const response = await fetch(PRODUCT, {
    headers: { "user-agent": "coilective (group order tracker)" },
    redirect: "manual",
  });

  let currency = null;
  if (response.ok) {
    const html = await response.text();
    currency = html.match(/"priceCurrency":\s*"([A-Z]{3})"/)?.[1] ?? "not found";
  }

  return Response.json({
    edgeRegion: context.geo?.city ?? context.geo?.country?.code ?? "unknown",
    visitorGeo: context.geo,
    storeStatus: response.status,
    redirectedTo: response.headers.get("location"),
    currency,
  }, { headers: { "cache-control": "no-store" } });
}

export const config = { path: "/where" };
