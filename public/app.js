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

async function api(path, options = {}) {
  showError("");
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
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

  if (!round) {
    $("round-name").textContent = "No round open";
    $("round-status").hidden = true;
    $("add-form").hidden = true;
    $("close-round").hidden = true;
    $("reopen-round").hidden = true;
    $("items").innerHTML = `
      <p class="empty">Nothing on the go. Start one when you next want to club together.</p>
      <div class="row">
        <input class="grow" id="new-name" placeholder="e.g. September order">
        <button class="primary" id="new-round" type="button">Start a round</button>
      </div>`;
    $("totals").innerHTML = "";
    $("new-round").addEventListener("click", startRound);
    $("new-name").addEventListener("keydown", (e) => e.key === "Enter" && startRound());
    renderHistory();
    return;
  }

  const open = round.status === "open";
  $("round-name").textContent = round.name;
  $("round-status").hidden = false;
  $("round-status").textContent = open ? "open" : "closed";
  $("round-status").className = `pill ${open ? "pill-open" : "pill-closed"}`;
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
        </tr></thead>
        <tbody>${s.people.map((p) => `<tr>
          <td>${esc(p.person)}</td>
          <td class="num">${p.itemCount}</td>
          <td class="num">${money(p.subtotalPence)}</td>
          <td class="num">−${money(p.discountPence)}</td>
          <td class="num">${money(p.shippingPence)}</td>
          <td class="num owes">${money(p.owesPence)}</td>
        </tr>`).join("")}</tbody>
      </table>`
    : "";

  $("totals").innerHTML = `
    <div class="totals">
      <div><span class="label">Items</span><span class="value">${money(s.subtotalPence)}</span></div>
      ${discountLine}${shippingLine}
      <div class="grand"><span class="label">Total</span><span class="value">${money(s.totalPence)}</span></div>
    </div>
    ${settleTable}`;
}

function renderHistory() {
  const closed = state.rounds.filter((r) => r.status === "closed");
  $("history-panel").hidden = closed.length === 0;
  $("history").innerHTML = closed.map((r) => `
    <li>
      <span class="grow-link"><a href="#" data-round="${r.id}">${esc(r.name)}</a>
        <span class="variant"> — ${new Date(r.createdAt).toLocaleDateString("en-GB")}, ${r.itemCount} spools</span></span>
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
    showError(err.message);
  }
}

const refresh = () => guard(async () => {
  state = await api("/state");
  viewing = null;
  render();
});

const startRound = () => guard(async () => {
  const name = $("new-name").value.trim();
  if (!name) return showError("Give the round a name first.");
  state.open = await api("/rounds", { method: "POST", body: JSON.stringify({ name }) });
  state = await api("/state");
  viewing = null;
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
const showCatalogueState = () => guard(async () => {
  const cat = await api("/catalogue");
  const label = $("catalogue-state");
  if (!cat.builtAt) {
    label.innerHTML = `no colours indexed yet. <button class="quiet" id="build-catalogue" type="button">Build the index</button>`;
  } else {
    const when = new Date(cat.builtAt).toLocaleDateString("en-GB");
    label.innerHTML = `${cat.colourCount} colours indexed on ${when}. `
      + `<button class="quiet" id="build-catalogue" type="button">Refresh</button>`;
  }
  $("build-catalogue").addEventListener("click", buildCatalogue);
});

/**
 * Kicks off a rebuild and waits for it.
 *
 * The build is paced slowly on purpose — the store rate-limits — so it runs as
 * a background function and we poll for `builtAt` to move.
 */
const buildCatalogue = () => guard(async () => {
  const button = $("build-catalogue");
  const before = (await api("/catalogue")).builtAt;

  button.disabled = true;
  button.textContent = "Building…";
  await api("/catalogue", { method: "POST", body: JSON.stringify({}) });

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const now = await api("/catalogue");
    if (now.builtAt && now.builtAt !== before) {
      await showCatalogueState();
      if (now.failed?.length) {
        showError(`Indexed ${now.colourCount} colours, but ${now.failed.length} product(s) `
          + `couldn't be read: ${now.failed.map((f) => f.handle).join(", ")}. `
          + `Refreshing again usually picks them up.`);
      }
      return;
    }
  }
  await showCatalogueState();
  showError("The rebuild is taking longer than expected. Reload in a minute to see where it got to.");
});

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
$("close-round").addEventListener("click", () => $("close-dialog").showModal());
$("close-cancel").addEventListener("click", () => $("close-dialog").close());
$("close-confirm").addEventListener("click", confirmClose);
$("reopen-round").addEventListener("click", doReopen);
$("change-name").addEventListener("click", () => askName({ force: true }));
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

renderWhoami();
askName(); // before anything else: everything is filed under it
refresh();
showCatalogueState();
