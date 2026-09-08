/**
 * One shared password, held in an environment variable.
 *
 * This is a wishlist between mates, so the threat being defended against is a
 * passer-by finding the URL, not an attacker. A single shared password is the
 * right weight: no accounts, no email, nothing to reset. It sits on the API
 * rather than the page, because the page is just markup — the rounds are what
 * need covering.
 *
 * The repo is public, so the password lives in COILECTIVE_PASSWORD and never
 * in the source. With it unset the API refuses everything rather than falling
 * open, which is the only safe way round for that mistake to fail.
 */

import { createHash, timingSafeEqual } from "node:crypto";

const COOKIE = "coilective_session";
const YEAR = 60 * 60 * 24 * 365;

export class Unauthorized extends Error {}
export class NotConfigured extends Error {}

/**
 * Typing tolerance, deliberately generous.
 *
 * Phones capitalise the first word and people add stray spaces, and a
 * passphrase that rejects "Printer pals" teaches everyone to keep it in a
 * note instead. Case and spacing carry no security here — the secret is the
 * words.
 */
const normalise = (raw) => String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The browser holds a hash, not the password.
 *
 * A stolen cookie is as good as the password either way, but there is no
 * reason for the plaintext to sit in a cookie jar when a digest works
 * identically.
 */
const tokenFor = (password) => createHash("sha256").update(normalise(password)).digest("hex");

/** Constant-time compare, so a wrong guess leaks nothing about the right one. */
function sameToken(a, b) {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

function expectedToken() {
  const password = process.env.COILECTIVE_PASSWORD;
  if (!normalise(password)) {
    throw new NotConfigured(
      "COILECTIVE_PASSWORD isn't set on this site, so nothing can be unlocked.",
    );
  }
  return tokenFor(password);
}

function cookieToken(request) {
  const header = request.headers.get("cookie") ?? "";
  for (const pair of header.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/**
 * `Secure` everywhere except plain-http localhost.
 *
 * A Secure cookie is simply not stored over http, so hard-coding it means
 * nobody can sign in under `netlify dev`. Deployed Netlify is https-only, so
 * this loses nothing in production.
 */
const secureFor = (request) => (new URL(request.url).protocol === "https:" ? "; Secure" : "");

const cookie = (request, value, maxAge) =>
  `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly${secureFor(request)}; SameSite=Lax`;

/** Right password? Then the Set-Cookie header that remembers it. */
export function login(request, password) {
  if (!sameToken(tokenFor(password), expectedToken())) {
    throw new Unauthorized("That's not the password.");
  }
  return cookie(request, tokenFor(password), YEAR);
}

/** Throws unless this request carries a valid session. */
export function assertAuthed(request) {
  if (!sameToken(cookieToken(request), expectedToken())) {
    throw new Unauthorized("Sign in first.");
  }
}

export const isAuthed = (request) => {
  try {
    assertAuthed(request);
    return true;
  } catch {
    return false;
  }
};
