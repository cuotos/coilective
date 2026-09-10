/**
 * The whole front end.
 *
 * State is one object fetched from /api/state and re-rendered wholesale — at
 * this size that is simpler and less error-prone than tracking what changed,
 * and every mutation returns the updated round so there is nothing to merge.
 *
 * The API does all money arithmetic and sends back a `settlement`, so nothing
 * here divides or rounds anything.
 */

const $ = (id) => document.getElementById(id);

let state = { open: null, rounds: [] };
let viewing = null; // a closed round being looked at, or null for the open one
let pending = null; // the product a lookup returned, awaiting a variant choice

// --- which deploy is this -------------------------------------------------

/**
 * Says when the running version was built.
 *
 * public/version.json is written by the build, so it is absent when the page
 * is served straight off disk — that is what "running locally" means here.
 * Fetched rather than baked into the markup so index.html is the same file in
 * the repo and in production.
 */
async function showVersion() {
  const label = $("version");
  try {
    const response = await fetch("/version.json", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const { builtAt, commit } = await response.json();
    const when = new Date(builtAt).toLocaleString("en-GB", {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
    label.textContent = `Updated ${when}${commit ? ` · ${commit}` : ""}`;
  } catch {
    label.textContent = "Running locally";
  }
}

// --- theme ----------------------------------------------------------------

/**
 * Dark or light. The inline script in the head has already stamped one on
 * <html> before paint, so this only handles switching it afterwards.
 */
const THEME_KEY = "coilective:theme";

const theme = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

function setTheme(next) {
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch { /* not fatal — it just won't be remembered */ }
  renderTheme();
}

// The button is labelled with the theme it switches to, not the current one.
function renderTheme() {
  const other = theme() === "dark" ? "light" : "dark";
  $("theme-toggle").textContent = other;
  $("theme-toggle").title = `Switch to the ${other} theme`;
}

// --- who am I -------------------------------------------------------------

const NAME_KEY = "coilective:name";

/**
 * Names are lowercase a-z and nothing else.
 *
 * The name *is* the identity a round splits money by, so "Dan", "dan " and
 * "Dan_2" turning into three people who each owe a share is a real bug, not a
 * tidiness concern. Normalising on the way in means it cannot happen.
 */
const normaliseName = (raw) => String(raw ?? "").toLowerCase().replace(/[^a-z]/g, "");

// Held in memory as well as localStorage, so a private window still works for
// the session rather than asking again on every action.
let myName = (() => {
  try {
    return normaliseName(localStorage.getItem(NAME_KEY));
  } catch {
    return "";
  }
})();

const me = () => myName;

function setMe(name) {
  myName = name;
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch { /* not fatal — it just won't be remembered next load */ }
  renderWhoami();
}

/**
 * Ask who they are, and refuse to be dismissed until they say.
 *
 * Nothing here works without a name — every item is filed under it — so with
 * none set the dialog opens on load with no cancel and Escape disabled. Once
 * there is one, the same dialog edits it and can be backed out of.
 */
function askName({ force = false } = {}) {
  if (me() && !force) return;
  const input = $("name-input");
  input.value = me();
  $("name-cancel").hidden = !me();
  $("name-error").hidden = true;
  if (!$("name-dialog").open) $("name-dialog").showModal();
  input.focus();
  input.select();
}

function saveName() {
  const name = normaliseName($("name-input").value);
  if (!name) {
    $("name-error").textContent = "Lowercase letters only, and at least one of them.";
    $("name-error").hidden = false;
    return;
  }
  setMe(name);
  $("name-dialog").close();
  render();
}

function renderWhoami() {
  const name = me();
  $("whoami").hidden = !name;
  $("whoami-name").textContent = name;
}

// --- talking to the API ---------------------------------------------------

function showError(message) {
  const box = $("error");
  box.textContent = message;
  box.hidden = !message;
}

/** Thrown when the API wants the password — 401, or 503 if none is configured. */
class Locked extends Error {}

async function api(path, options = {}) {
  showError("");
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 503) {
    throw new Locked(payload.error || "Sign in first.");
  }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

// --- the password ---------------------------------------------------------

/**
 * Ask for the shared password.
 *
 * The cookie the server sets lasts a year, so this is a once-per-device thing
 * in practice. It reappears if the session is cleared or the password changes,
 * from wherever in the app that happened.
 */
function askPassword(message = "") {
  $("lock-error").textContent = message;
  $("lock-error").hidden = !message;
  if (!$("lock-dialog").open) $("lock-dialog").showModal();
  $("lock-input").focus();
  $("lock-input").select();
}

async function unlock() {
  const password = $("lock-input").value;
  if (!password) return askPassword("Type the password.");

  $("lock-save").disabled = true;
  try {
    await api("/login", { method: "POST", body: JSON.stringify({ password }) });
  } catch (err) {
    return askPassword(err.message);
  } finally {
    $("lock-save").disabled = false;
  }

  $("lock-input").value = "";
  $("lock-dialog").close();
  askName(); // only now — no point asking who you are through a locked door
  await refresh();
  showCatalogueState();
}

const money = (pence, currency = "GBP") => {
  const symbol = { GBP: "£", USD: "$", EUR: "€" }[currency] ?? `${currency} `;
  const sign = pence < 0 ? "-" : "";
  return `${sign}${symbol}${(Math.abs(pence) / 100).toFixed(2)}`;
};

// --- rendering ------------------------------------------------------------

/** The round on screen: a closed one if you clicked into it, else the open one. */
const shown = () => viewing ?? state.open;

function render() {
  renderWhoami();
  const round = shown();

  // The server guarantees an open round, so this only shows before the first
  // response has landed.
  if (!round) {
    $("round-name").textContent = "Loading…";
    $("round-status").hidden = true;
    $("rename-round").hidden = true;
    $("redate-round").hidden = true;
    $("add-form").hidden = true;
    $("close-round").hidden = true;
    $("reopen-round").hidden = true;
    return;
  }

  const open = round.status === "open";
  $("round-name").textContent = round.name;
  $("round-status").hidden = false;
  $("round-status").textContent = open
    ? "open"
    : `ordered ${new Date(orderedOn(round)).toLocaleDateString("en-GB")}`;
  $("round-status").className = `pill ${open ? "pill-open" : "pill-closed"}`;
  $("rename-round").hidden = false;
  // Only a closed round has an order date to correct.
  $("redate-round").hidden = open;
  $("add-form").hidden = !open;
  $("close-round").hidden = !open;
  $("reopen-round").hidden = open;

  renderItems(round);
  renderTotals(round);
  renderHistory();
}

function renderItems(round) {
  const box = $("items");
  if (round.items.length === 0) {
    box.innerHTML = `<p class="empty">Nothing added yet. Paste a link above.</p>`;
    return;
  }

  const people = [...new Set(round.items.map((i) => i.person))].sort();
  const owed = new Map(round.settlement.people.map((p) => [p.person, p]));
  const editable = round.status === "open";

  box.innerHTML = people.map((person) => {
    const items = round.items.filter((i) => i.person === person);
    const summary = owed.get(person);
    const mine = person.toLowerCase() === me().toLowerCase();

    return `<div class="person-block">
      <div class="person-head">
        <span class="name">${esc(person)}${mine ? " (you)" : ""}</span>
        <span class="count">${summary.itemCount} spool${summary.itemCount === 1 ? "" : "s"}</span>
        <span class="owes">${money(summary.owesPence)}</span>
      </div>
      ${items.map((item) => `
        <div class="item ${item.discounted === false ? "excluded" : ""}" data-item="${item.id}">
          <div class="what">
            <div class="product">${item.url
              ? `<a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.productName)}</a>`
              : esc(item.productName)}</div>
            ${item.variant ? `<div class="variant">${esc(item.variant)}</div>` : ""}
          </div>
          ${editable
            ? `<label class="sale-toggle ${item.discounted === false ? "" : "on"}">
                 <input type="checkbox" data-sale="${item.id}" ${item.discounted === false ? "" : "checked"}>
                 sale</label>`
            : item.discounted === false ? `<span class="no-sale-note">not in sale</span>` : ""}
          ${editable
            ? `<input class="qty" type="number" min="1" max="99" value="${item.qty}" data-qty="${item.id}">`
            : `<span class="variant">×${item.qty}</span>`}
          <span class="line">${money(item.unitPricePence * item.qty, item.currency)}</span>
          ${editable ? `<button class="quiet danger" data-remove="${item.id}" title="Remove">✕</button>` : ""}
        </div>`).join("")}
    </div>`;
  }).join("");

  if (editable) {
    box.querySelectorAll("[data-qty]").forEach((input) => {
      input.addEventListener("change", () => changeQty(input.dataset.qty, input.value));
    });
    box.querySelectorAll("[data-remove]").forEach((button) => {
      button.addEventListener("click", () => removeItem(button.dataset.remove));
    });
    box.querySelectorAll("[data-sale]").forEach((input) => {
      input.addEventListener("change", () => setSale(input.dataset.sale, input.checked));
    });
  }
}

function renderTotals(round) {
  const s = round.settlement;
  if (round.items.length === 0) { $("totals").innerHTML = ""; return; }

  const discountLine = round.discount
    ? `<div><span class="label">Discount${round.discount.kind === "percent" ? ` (${round.discount.value}%)` : ""}</span><span class="value">−${money(s.discountPence)}</span></div>`
    : "";
  const shippingLine = s.shippingPence
    ? `<div><span class="label">Postage</span><span class="value">${money(s.shippingPence)}</span></div>`
    : "";

  const settleTable = round.status === "closed"
    ? `<table class="settle">
        <thead><tr>
          <th>Who</th><th class="num">Spools</th><th class="num">Items</th>
          <th class="num">Discount</th><th class="num">Postage</th><th class="num">Owes</th>
          <th></th>
        </tr></thead>
        <tbody>${s.people.map((p) => `<tr class="${p.isPayer ? "is-payer" : ""}">
          <td>${esc(p.person)}${p.isPayer ? " (paid)" : ""}</td>
          <td class="num">${p.itemCount}</td>
          <td class="num">${money(p.subtotalPence)}</td>
          <td class="num">−${money(p.discountPence)}</td>
          <td class="num">${money(p.shippingPence)}</td>
          <td class="num owes">${money(p.owesPence)}</td>
          <td class="paid-cell">${paidTick(s, p)}</td>
        </tr>`).join("")}</tbody>
      </table>
      ${payerLine(round, s)}`
    : "";

  $("totals").innerHTML = `
    <div class="totals">
      <div><span class="label">Items</span><span class="value">${money(s.subtotalPence)}</span></div>
      ${discountLine}${shippingLine}
      <div class="grand"><span class="label">Total</span><span class="value">${money(s.totalPence)}</span></div>
    </div>
    ${settleTable}`;

  for (const box of $("totals").querySelectorAll("[data-settled]")) {
    box.addEventListener("change", () => setSettledUp(box.dataset.settled, box.checked));
  }
  const picker = $("totals").querySelector("[data-paid-by]");
  if (picker) picker.addEventListener("change", () => choosePayer(picker.value));
}

/**
 * The tick against one person's debt.
 *
 * Nothing to tick until somebody says who paid — until then there is no one
 * for the money to go to — and the payer has no debt of their own.
 */
function paidTick(settlement, person) {
  if (!settlement.paidBy || person.isPayer) return "";
  return `<label class="paid-toggle ${person.settled ? "on" : ""}">
    <input type="checkbox" data-settled="${esc(person.person)}" ${person.settled ? "checked" : ""}>
    paid
  </label>`;
}

/** Who fronted the money, and what they are still owed. */
function payerLine(round, settlement) {
  const people = settlement.people.map((p) => p.person);

  if (!settlement.paidBy) {
    return `<div class="payer">
      <span>Who paid for this?</span>
      <select data-paid-by>
        <option value="">nobody yet</option>
        ${people.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("")}
      </select>
    </div>`;
  }

  const outstanding = settlement.outstandingPence;
  const status = outstanding === 0
    ? `<span class="outstanding clear">everyone has settled up</span>`
    : `<span class="outstanding">still owed ${money(outstanding)}</span>`;

  return `<div class="payer">
    <span><strong>${esc(settlement.paidBy)}</strong> paid the ${money(settlement.totalPence)}</span>
    ${status}
    <select data-paid-by>
      ${people.map((p) => `<option value="${esc(p)}" ${p === settlement.paidBy ? "selected" : ""}>${esc(p)}</option>`).join("")}
    </select>
  </div>`;
}

/**
 * Correct the day the order went in.
 *
 * Needed because a round entered after the fact closes today. Asked for as
 * YYYY-MM-DD, which is unambiguous — 07/04 and 04/07 are not.
 */
const redateRound = () => guard(async () => {
  const round = shown();
  const current = orderedOn(round).slice(0, 10);
  const answer = prompt("What day did this order go in? (YYYY-MM-DD)", current);
  if (answer === null || !answer.trim() || answer.trim() === current) return;

  const updated = await api(`/rounds/${round.id}`, {
    method: "PATCH",
    body: JSON.stringify({ revision: round.revision, closedAt: answer.trim() }),
  });
  if (viewing) viewing = updated; else state.open = updated;
  state = await api("/state");
  render();
});

const setSettledUp = (person, settled) => guard(async () => {
  const round = shown();
  const updated = await api(`/rounds/${round.id}/settled`, {
    method: "POST",
    body: JSON.stringify({ revision: round.revision, person, settled }),
  });
  if (viewing) viewing = updated; else state.open = updated;
  render();
});

const choosePayer = (paidBy) => guard(async () => {
  const round = shown();
  const updated = await api(`/rounds/${round.id}`, {
    method: "PATCH",
    body: JSON.stringify({ revision: round.revision, paidBy: paidBy || null }),
  });
  if (viewing) viewing = updated; else state.open = updated;
  render();
});

/** When the order went in: the day it closed, falling back to when it started. */
const orderedOn = (round) => round.closedAt ?? round.createdAt;

function renderHistory() {
  const closed = state.rounds
    .filter((r) => r.status === "closed")
    // Newest order first, by the date it went in rather than the date the
    // round was started — a round entered retrospectively has today's start.
    .sort((a, b) => new Date(orderedOn(b)) - new Date(orderedOn(a)));

  $("history-panel").hidden = closed.length === 0;
  $("history").innerHTML = closed.map((r) => `
    <li>
      <span class="grow-link"><a href="#" data-round="${r.id}">${esc(r.name)}</a>
        <span class="variant"> — ${new Date(orderedOn(r)).toLocaleDateString("en-GB")}, ${r.itemCount} spools</span></span>
      <span class="amount">${money(r.totalPence)}</span>
      <button class="quiet danger" data-delete="${r.id}" data-name="${esc(r.name)}" title="Delete this round">✕</button>
    </li>`).join("");

  $("history").querySelectorAll("[data-round]").forEach((link) => {
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      viewing = await api(`/rounds/${link.dataset.round}`);
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  $("history").querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteRound(button.dataset.delete, button.dataset.name));
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// --- actions --------------------------------------------------------------

async function guard(work) {
  try {
    await work();
  } catch (err) {
    // Every request goes through here, so any expired session anywhere in the
    // app lands back at the password rather than showing a dead-end error.
    if (err instanceof Locked) return askPassword(err.message);
    showError(err.message);
  }
}

const refresh = () => guard(async () => {
  state = await api("/state");
  viewing = null;
  render();
});

/**
 * Rename the round on screen.
 *
 * Rounds are auto-named after the month they started, so this is how one gets
 * called what people actually call it. It also renames a closed round, since
 * that is usually when you realise "Sept 2026" was the big PLA order.
 */
const renameRound = () => guard(async () => {
  const round = shown();
  const name = prompt("Call this round what?", round.name);
  if (name === null || !name.trim() || name.trim() === round.name) return;

  const updated = await api(`/rounds/${round.id}`, {
    method: "PATCH",
    body: JSON.stringify({ revision: round.revision, name: name.trim() }),
  });
  if (viewing) viewing = updated;
  state = await api("/state");
  render();
});

const doLookup = () => guard(async () => {
  const entry = $("url").value.trim();
  if (!entry) return showError("Paste a product link, or type a colour code.");
  if (!me()) return askName();

  // Five digits is a colour code off the spool; anything else is a link.
  const payload = /^\d{5}$/.test(entry) ? { id: entry } : { url: entry };

  $("lookup").disabled = true;
  $("lookup").textContent = "Looking…";
  try {
    pending = await api("/lookup", { method: "POST", body: JSON.stringify(payload) });
    openVariantDialog();
  } finally {
    $("lookup").disabled = false;
    $("lookup").textContent = "Add";
  }
});

/** How many colours the index knows, and an offer to build it if it's empty. */
/**
 * Says what the colour index knows, with no button to rebuild it.
 *
 * It cannot be rebuilt from here: the store prices by the caller's IP and
 * these functions run in Ohio, so a rebuild from the site would come back in
 * dollars. It is built from a UK machine with `npm run catalogue` instead.
 */
const showCatalogueState = () => guard(async () => {
  const cat = await api("/catalogue");
  const label = $("catalogue-state");
  if (!cat.builtAt) {
    label.textContent = "no colours indexed yet — run npm run catalogue.";
    return;
  }
  const when = new Date(cat.builtAt).toLocaleString("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  label.textContent = `${cat.colourCount} colours, indexed ${when}.`;
});

/**
 * Kicks off a rebuild and waits for it.
 *
 * The build is paced slowly on purpose — the store rate-limits — so it runs as
 * a background function and we poll for `builtAt` to move.
 */
function openVariantDialog() {
  $("variant-title").textContent = pending.productName;
  $("variant-select").innerHTML = pending.variants.map((v, i) =>
    `<option value="${i}"${v.inStock ? "" : " disabled"}>${esc(v.label)} — ${money(v.pricePence, v.currency)}${v.inStock ? "" : " (out of stock)"}</option>`,
  ).join("");
  $("variant-qty").value = "1";
  $("variant-sale").checked = true;
  $("variant-sale-label").classList.add("on");
  $("variant-dialog").showModal();
}

const addPending = () => guard(async () => {
  const variant = pending.variants[Number($("variant-select").value)];
  const round = state.open;
  const updated = await api(`/rounds/${round.id}/items`, {
    method: "POST",
    body: JSON.stringify({
      revision: round.revision,
      person: me(),
      url: pending.url,
      productName: pending.productName,
      variant: variant.label,
      unitPricePence: variant.pricePence,
      currency: variant.currency,
      qty: Number($("variant-qty").value),
      discounted: $("variant-sale").checked,
    }),
  });
  state.open = updated;
  pending = null;
  $("variant-dialog").close();
  $("url").value = "";
  render();
});

const setSale = (itemId, discounted) => guard(async () => {
  state.open = await api(`/rounds/${state.open.id}/items/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify({ revision: state.open.revision, discounted }),
  });
  render();
});

const changeQty = (itemId, qty) => guard(async () => {
  state.open = await api(`/rounds/${state.open.id}/items/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify({ revision: state.open.revision, qty: Number(qty) }),
  });
  render();
});

const removeItem = (itemId) => guard(async () => {
  state.open = await api(`/rounds/${state.open.id}/items/${itemId}`, {
    method: "DELETE",
    body: JSON.stringify({ revision: state.open.revision }),
  });
  render();
});

const confirmClose = () => guard(async () => {
  const kind = $("discount-kind").value;
  const raw = $("discount-value").value.trim();
  const discount =
    kind === "none" ? { kind: "none" }
    : kind === "percent" ? { kind: "percent", value: Number(raw || 0) }
    : { kind: "amount", amount: raw || "0" };

  state.open = await api(`/rounds/${state.open.id}/close`, {
    method: "POST",
    body: JSON.stringify({
      revision: state.open.revision,
      discount,
      shippingPence: Math.round(Number($("shipping").value || 0) * 100),
      paidBy: $("paid-by").value || null,
    }),
  });
  $("close-dialog").close();
  state = await api("/state");
  viewing = state.open ? null : await api(`/rounds/${state.rounds[0].id}`);
  render();
});

/** Deleting a round cannot be undone, so it asks first. */
const deleteRound = (id, name) => guard(async () => {
  if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
  await api(`/rounds/${id}`, { method: "DELETE" });
  await refresh();
});

const doReopen = () => guard(async () => {
  const round = shown();
  const updated = await api(`/rounds/${round.id}/reopen`, {
    method: "POST",
    body: JSON.stringify({ revision: round.revision }),
  });
  state = await api("/state");
  viewing = null;
  state.open = updated;
  render();
});

// --- wiring ---------------------------------------------------------------

$("lookup").addEventListener("click", doLookup);
$("url").addEventListener("keydown", (e) => e.key === "Enter" && doLookup());
$("variant-add").addEventListener("click", addPending);
$("variant-sale").addEventListener("change", (event) => {
  $("variant-sale-label").classList.toggle("on", event.target.checked);
});
$("variant-cancel").addEventListener("click", () => { pending = null; $("variant-dialog").close(); });
$("close-round").addEventListener("click", () => {
  // Only people with something in the round can have paid for it.
  const people = [...new Set((shown()?.items ?? []).map((i) => i.person))].sort();
  $("paid-by").innerHTML = `<option value="">decide later</option>`
    + people.map((p) => `<option value="${esc(p)}" ${p === me() ? "selected" : ""}>${esc(p)}</option>`).join("");
  $("close-dialog").showModal();
});
$("close-cancel").addEventListener("click", () => $("close-dialog").close());
$("close-confirm").addEventListener("click", confirmClose);
$("reopen-round").addEventListener("click", doReopen);
$("change-name").addEventListener("click", () => askName({ force: true }));
$("rename-round").addEventListener("click", renameRound);
$("redate-round").addEventListener("click", redateRound);
$("theme-toggle").addEventListener("click", () => setTheme(theme() === "dark" ? "light" : "dark"));
$("lock-save").addEventListener("click", unlock);
$("lock-input").addEventListener("keydown", (e) => e.key === "Enter" && unlock());
// No escape from this one: there is nothing to show without it.
$("lock-dialog").addEventListener("cancel", (event) => event.preventDefault());
$("name-save").addEventListener("click", saveName);
$("name-cancel").addEventListener("click", () => $("name-dialog").close());
$("name-input").addEventListener("keydown", (e) => e.key === "Enter" && saveName());
// Show them what will actually be stored as they type, rather than quietly
// rewriting "Dan" to "dan" after they commit.
$("name-input").addEventListener("input", (event) => {
  event.target.value = normaliseName(event.target.value);
});
// Escape and backdrop dismissal are only allowed once there is a name to keep.
$("name-dialog").addEventListener("cancel", (event) => {
  if (!me()) event.preventDefault();
});
$("home").addEventListener("click", () => refresh());

$("discount-kind").addEventListener("change", (event) => {
  const none = event.target.value === "none";
  $("discount-value").disabled = none;
  $("discount-value").placeholder = event.target.value === "percent" ? "10" : "5.00";
  if (none) $("discount-value").value = "";
});

// The password gates the lot. `guard` turns the 401 from this first call into
// the lock dialog, and unlocking picks up from there.
renderTheme();
renderWhoami();
showVersion();
guard(async () => {
  state = await api("/state");
  askName(); // before anything else: everything is filed under it
  render();
  showCatalogueState();
});
