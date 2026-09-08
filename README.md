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

A **round** is one group order: it opens, people add items, it closes with
whatever discount and postage applied. Closed rounds stay readable so you can
still see who owed what.

### Prices come from the store

Bambu's product pages carry schema.org JSON-LD listing every variant with its
price, currency and stock, so adding an item is a parse rather than a scrape.
Paste a product link and pick a colour, or type the five-digit code printed on
the spool — `11100` is PLA Matte Ivory White.

Codes are resolved through an index built from the store's own sitemap, so a
new colour appears after a refresh with nothing to edit here. The store
rate-limits hard, so the build is paced slowly and runs as a background
function; it reports any product it could not read rather than pretending the
colour does not exist.

The price captured is the one showing when the item was added. That is what
the order actually cost, so it is not re-fetched later.

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
