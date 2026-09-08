# coilective

A shared wishlist for group filament orders, and who owes what once the order
lands.

Bambu Lab run bulk sales worth clubbing together for. This keeps track of who
wants which spools, pulls the prices off the store so nobody types them in, and
works out what each person owes once the discount is known.

## Running it

```bash
npm install
npm run dev        # http://localhost:8888
npm test
```

Needs Node 22.13 or newer, and a `.env` holding the shared password:

```
COILECTIVE_PASSWORD=whatever you agreed
```
 `npm run dev` is `netlify dev`, which serves the
static page, runs the functions, and emulates Netlify Blobs against
`.netlify/` on disk.

## Deploying

It is a static page plus Netlify Functions, so a Netlify site pointed at this
repo needs no configuration beyond the defaults in `netlify.toml`, plus
`COILECTIVE_PASSWORD` set on the site. Persistence is Netlify Blobs, which
requires no setup and no connection string.

## How it works

```
public/index.html            the whole UI
public/app.js                fetch state, render, mutate
netlify/functions/api.mjs    every endpoint, one small router
netlify/lib/money.mjs        prices, splitting, settlement
netlify/lib/bambu.mjs        reading a product off the store
netlify/lib/catalogue.mjs    the colour-code index
netlify/lib/store.mjs        Blobs persistence
```

A **round** is one group order. There is always exactly one open, and it is
the wishlist: people add to it whenever they fancy something, and closing it is
the act of ordering. A close therefore leaves nothing open, so the next read
makes the successor — nobody has to remember to start one.

Rounds are named after the month they began, with a number if that is taken,
and can be renamed to whatever people actually call them. Closed rounds stay
readable so you can still see who owed what.

Reopening a closed round absorbs the empty successor standing in its way. One
with items in it is somebody's wishlist and is left alone.

### Prices come from the store

Bambu's product pages carry schema.org JSON-LD listing every variant with its
price, currency and stock, so adding an item is a parse rather than a scrape.
Paste a product link and pick a colour, or type the five-digit code printed on
the spool — `11100` is PLA Matte Ivory White.

Codes are resolved through an index built from the store's own sitemap, so a
new colour appears after a rebuild with nothing to edit here. The store
rate-limits hard, so the build is paced slowly and takes about a minute; it
reports any product it could not read rather than pretending the colour does
not exist.

Uploads merge rather than replace. Which products the store rate-limits varies
run to run, so a straight replace loses colours that were known five minutes
ago — PETG Clear disappeared out from under an order that way. A colour the new
build could not read keeps its previous entry.

The index is built from a UK machine and uploaded, because it cannot be built
on the server — see below:

```bash
npm run catalogue                          # to the live site
npm run catalogue -- http://localhost:8888
```

The price captured is the one showing when the item was added. That is what
the order actually cost, so it is not re-fetched later.

### Prices are the UK ones, or there is no price

Bambu run a storefront per region and Cloudflare redirects you to the one
matching your IP, so the same URL is £17.99 from Manchester and $21.99 from
Ohio. Since everything settles in sterling, the redirect is never followed:
a lookup that lands anywhere but the UK store fails and says why, and any
regional link is rewritten to `uk.store` before fetching.

Nothing defaults a missing currency to GBP — that is exactly how a dollar
price got added into a sterling total once. `addItem` refuses anything that
is not GBP as a last line of defence, whichever route the item arrived by,
because the settlement maths adds prices together and never looks at currency.

This is a live constraint, not just a guard. Nothing on Netlify's free plan
can read a UK price: functions run in Ohio, and edge functions — which do run
near the visitor — egress via the EU, so the store sends them to `eu.store`
and quotes euros. Pinning functions to London needs a Pro plan.

So the index is built on a laptop in the UK and uploaded through
`PUT /api/catalogue`, and `writeCatalogue` refuses one that is not in
sterling. Prices are therefore as at the last rebuild rather than as at the
moment of adding — rebuild before an order round and they match.

### Money

Integer pence everywhere. Prices arrive as strings like `"17.99"`, get parsed
once at the edge, and are never floats again — this is used to settle up with
friends, and `0.1 + 0.2` problems are not welcome.

Shared costs split **in proportion to spend**, not per head. Someone with £60
of filament takes twice the discount of someone with £30, so everyone lands on
the same effective rate and nobody subsidises anybody.

Splits use the largest-remainder method, so the parts always sum to the whole.
Naive rounding hands out £9.99 of a £10 discount and leaves someone arguing
over a penny.

The discount splits only across the items it **applies to**. Each item carries
an "in the sale" flag, defaulting to yes. A sale covering PLA but not PETG must
not hand a PETG buyer someone else's discount, which splitting by total spend
would do. Postage ignores the flag — a parcel does not care what is in it.

### Themes

Dark and light, following the system until you pick one. The choice is stamped
on `<html>` by an inline script in the head rather than handled in CSS, so each
palette is written out once — two copies of the light one would eventually
disagree — and there is no flash of the wrong theme before the app loads.

Every colour in the sheet is a token, so a theme is a palette swap. The green
is the part that has to move: `#4ade80` on white is about 1.7:1, unreadable, so
light gets a darkened one. Both palettes are checked against WCAG AA.

### Concurrent edits

Blobs has no transactions, so every mutation carries the `revision` the caller
last saw and is refused if the round has moved on. Two people adding at the
same moment get "someone else changed this, reload" instead of one addition
silently vanishing.

### Getting in

One shared password, checked on the API rather than in the page. The browser
never sees it: it is posted once, compared server-side against
`COILECTIVE_PASSWORD`, and what comes back is an HttpOnly cookie holding a
hash. Nothing in `public/` knows the password, and the static files are not
worth protecting anyway — the rounds are, and they are all behind the guard.

With `COILECTIVE_PASSWORD` unset the API refuses everything rather than
falling open, so a forgotten variable locks the site instead of publishing it.

Case and extra spaces are ignored when checking. The secret is the words; a
passphrase that rejects "Printer Pals" from a phone keyboard only teaches
people to paste it from a note.

### Identity

Once past the password, type your name — lowercase letters only, kept in
`localStorage`. It is the identity money is split by, so it is normalised: "Dan"
and "dan " being two people who each owe a share is a bug, not untidiness.

Everyone shares the one password, so nothing stops a friend editing your rows.
That is honest rather than secure, which for a group of mates is the right
trade.
