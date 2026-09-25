/* Meal Prep — the screens.
 *
 * Needs no server. Everything is saved on this phone in localStorage under one
 * key; the Today tab downloads a backup file and reads one back. The sums live
 * in logic.js so they can be tested without a browser.
 *
 * Foods   — ingredients, with each shop's label macros and pack size
 * Meals   — saved recipes: ingredients, weights, portions, where it came from
 * Shopping list — tap meals to add them; the list is split by shop and
 *           rounded up to whole packs
 * Today   — portions eaten, and the day's totals
 */

"use strict";

const L = globalThis.MealLogic;
const STORE = "mealprep:v1";
const DEFAULT_SHOPS = ["Aldi", "Morrisons"];
// Seasonings live here: no pack, and the list says "check you have" rather than "buy".
const CUPBOARD = "Cupboard";
const SEARCH_FROM = 12; // more meals than this and the pickers start with a search box
const DEFAULT_PORTIONS = 10;
const UNIT_LABEL = { g: "Grams (weighed)", ml: "Millilitres (poured)", each: "Items (counted)" };
const PER_LABEL = { g: "per 100 g", ml: "per 100 ml", each: "per item" };
const MACRO_NAMES = { kcal: "kcal", protein: "protein", carbs: "carbs", fat: "fat" };

/* ---------------------------------------------------------------- state */

function blank() {
  return {
    app: "meal-prep",
    v: 1,
    shops: [...DEFAULT_SHOPS],
    ingredients: [],
    meals: [],
    saved: [], // everyday items, not tied to a meal: { id, name, shop }
    prep: { items: {}, extras: {}, shopOverride: {}, ticked: {} },
    eaten: [],
    builtInSeen: [], // ids of built-in meals and foods already added once
  };
}

let state = (() => {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return blank();
    const saved = JSON.parse(raw);
    return { ...blank(), ...saved, prep: { ...blank().prep, ...(saved.prep || {}) } };
  } catch { return blank(); }
})();

function save({ fromSync = false } = {}) {
  try { localStorage.setItem(STORE, JSON.stringify(state)); }
  catch { toast("Couldn't save on this phone. Storage is full or blocked."); }
  // Every change is sent to the other devices a moment later (not when the
  // change itself came from them).
  if (!fromSync && typeof scheduleSync === "function") scheduleSync();
}

const ui = { tab: "meals", edit: null, day: localDate(new Date()), openGroups: new Set() };
// Remembered across restarts: if the phone closes the app mid-shop, it reopens on the list.
try { ui.tab = localStorage.getItem("mealprep:tab") || "meals"; } catch { /* private mode */ }

/* ---------------------------------------------------------------- helpers */

/** Build an element. Text always goes in as text, never as HTML. */
function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "value") node.value = v;
    else if (k === "checked") node.checked = true;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function localDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDay(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localDate(d);
}

function prettyDay(iso) {
  const today = localDate(new Date());
  if (iso === today) return "Today";
  if (iso === shiftDay(today, -1)) return "Yesterday";
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-GB",
    { weekday: "short", day: "numeric", month: "short" });
}

/** A number from a text box, or null when it's blank or not a number. */
function num(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const buyShops = () => state.shops.filter((s) => s !== CUPBOARD);

/** A search box that hides cards whose data-name doesn't match, without
 *  redrawing the screen (so the keyboard stays up). `always` keeps the cards
 *  that should show with an empty search. Headings (.group-head) hide when
 *  nothing under them shows, unless `keepHeads` and the search is empty.
 *  The returned element's refresh() re-applies the current search. */
function searchBox(placeholder, container, always = () => true, keepHeads = false) {
  const apply = (q) => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    let head = null;
    let headShown = 0;
    const closeHead = () => {
      if (!head) return;
      head.hidden = headShown === 0 && !(keepHeads && !words.length);
      head.classList.toggle("searching", words.length > 0);
    };
    for (const card of container.children) {
      // Headings hide when nothing under them matches.
      if (card.classList.contains("group-head")) {
        closeHead();
        head = card;
        headShown = 0;
        continue;
      }
      const name = card.dataset.name || "";
      const hit = words.length ? words.every((w) => name.includes(w)) : always(card);
      card.hidden = !hit;
      if (hit) { shown++; headShown++; }
    }
    closeHead();
    empty.hidden = shown > 0 || !words.length;
  };
  const empty = h("p", { class: "faint", text: "Nothing matches.", hidden: true });
  const input = h("input", { type: "search", placeholder, "aria-label": placeholder, autocomplete: "off",
    oninput: (e) => apply(e.target.value) });
  setTimeout(() => apply(""), 0);
  const box = h("div", { class: "stack", style: "margin-bottom:12px" }, input, empty);
  box.refresh = () => apply(input.value);
  return box;
}

/** A heading over one group of meals. With `toggle`, tapping it opens or closes the group. */
function groupHead(category, count, toggle) {
  const open = !toggle || ui.openGroups.has(category);
  return h(toggle ? "button" : "div", {
    class: `group-head${open ? " open" : ""}`,
    type: toggle ? "button" : null,
    "data-group": category,
    "aria-expanded": toggle ? String(open) : null,
    onclick: toggle ? (e) => {
      if (ui.openGroups.has(category)) ui.openGroups.delete(category); else ui.openGroups.add(category);
      e.currentTarget.classList.toggle("open");
      e.currentTarget.setAttribute("aria-expanded", String(ui.openGroups.has(category)));
      toggle();
    } : null,
  }, h("span", { text: category }), h("span", { class: "faint", text: String(count) }));
}

const round = (n) => Math.round(n);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clone = (x) => JSON.parse(JSON.stringify(x));
const byName = (a, b) => a.name.localeCompare(b.name);
const ingredientsById = () => Object.fromEntries(state.ingredients.map((i) => [i.id, i]));
const mealsById = () => Object.fromEntries(state.meals.map((m) => [m.id, m]));

let toastTimer = null;
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function macroGrid(m) {
  return h("div", { class: "macros" },
    h("div", { class: "macro" }, h("b", { text: round(m.kcal) }), h("span", { text: "kcal" })),
    h("div", { class: "macro" }, h("b", { text: `${round(m.protein)} g` }), h("span", { text: "protein" })),
    h("div", { class: "macro" }, h("b", { text: `${round(m.carbs)} g` }), h("span", { text: "carbs" })),
    h("div", { class: "macro" }, h("b", { text: `${round(m.fat)} g` }), h("span", { text: "fat" })));
}

function field(labelText, input) {
  return h("div", null, h("label", { text: labelText }), input);
}

function safeLink(url) {
  return /^https:\/\//i.test(url || "") ? url : null;
}

function sourceText(source) {
  if (!source || !source.kind) return "";
  if (source.kind === "book") {
    return [source.title || "Book", source.page ? `page ${source.page}` : ""].filter(Boolean).join(", ");
  }
  if (source.title) return source.title;
  if (source.kind === "youtube") return "YouTube";
  try { return new URL(source.url).hostname.replace(/^www\./, ""); } catch { return "Website"; }
}

/* ---------------------------------------------------------------- barcode */

const LOOKUP_URL = "https://world.openfoodfacts.org/api/v2/product/";
const LOOKUP_FIELDS = "product_name,product_name_en,brands,quantity,product_quantity,product_quantity_unit,nutriments";
const LOOKUP_WAIT_MS = 8000;

/** Opens the camera and resolves with a barcode, or null if cancelled. Chrome
 *  on Android reads barcodes itself (BarcodeDetector). Where it can't, or the
 *  camera is refused, the same screen takes the number typed in. */
function scanBarcode() {
  return new Promise((resolve) => {
    let stream = null;
    let timer = null;
    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      overlay.remove();
      resolve(code);
    };

    const video = h("video", { playsinline: true, muted: true, autoplay: true });
    const status = h("p", { class: "muted", text: "Starting the camera…" });
    const typed = h("input", { inputmode: "numeric", placeholder: "Or type the barcode number",
      autocomplete: "off", onkeydown: (e) => { if (e.key === "Enter") useTyped(); } });
    const useTyped = () => {
      const code = typed.value.replace(/\D/g, "");
      if (code.length < 8) return toast("A barcode is 8 to 13 numbers.");
      finish(code);
    };
    const overlay = h("div", { class: "scanner", role: "dialog", "aria-label": "Scan a barcode" },
      h("div", { class: "scanner-in stack" },
        h("h2", { text: "Scan the barcode", style: "margin:0" }),
        h("div", { class: "scanner-view" }, video, h("div", { class: "scanner-aim" })),
        status,
        h("div", { class: "row" }, h("div", { class: "grow" }, typed),
          h("button", { onclick: useTyped }, "Look up")),
        h("button", { class: "block", onclick: () => finish(null) }, "Cancel")));
    document.body.append(overlay);

    if (!("BarcodeDetector" in window) || !navigator.mediaDevices) {
      status.textContent = "This browser can't read barcodes. Type the number under the bars.";
      video.parentElement.hidden = true;
      return;
    }
    const detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => {
        if (finished) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        video.srcObject = s;
        status.textContent = "Hold the barcode inside the box.";
        timer = setInterval(async () => {
          if (video.readyState < 2) return;
          try {
            const found = await detector.detect(video);
            if (found.length) finish(found[0].rawValue);
          } catch { /* a frame it couldn't read; try the next */ }
        }, 250);
      })
      .catch(() => {
        status.textContent = "The camera isn't available. Type the number under the bars.";
        video.parentElement.hidden = true;
      });
  });
}

/** Looks a barcode up in Open Food Facts. Resolves with the product, with null
 *  when it isn't there, and throws when there's no signal. */
async function lookUp(code) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_WAIT_MS);
  try {
    const res = await fetch(`${LOOKUP_URL}${encodeURIComponent(code)}.json?fields=${LOOKUP_FIELDS}`,
      { signal: controller.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`lookup ${res.status}`);
    return L.fromOpenFoodFacts(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/** Puts a looked-up product into one shop's label on a food being edited. */
function applyScan(d, shop, code, found) {
  const others = Object.entries(d.products).some(([s, p]) => s !== shop && p && p.kcal !== undefined && p.kcal !== "");
  if (found.unit && found.unit !== d.unit) {
    if (others) {
      d.products[shop] = { ...(d.products[shop] || {}), barcode: code };
      if (!d.name) d.name = found.name;
      return toast(`That product is sold by ${found.unit === "ml" ? "volume" : "weight"}, `
        + `but this food is measured in ${UNIT_LABEL[d.unit].toLowerCase()}. Fill the label in by hand.`);
    }
    d.unit = found.unit;
  }
  const label = { barcode: code };
  for (const key of [...L.MACROS, "pack"]) {
    if (found[key] !== null) label[key] = String(found[key]);
  }
  d.products[shop] = label;
  if (!d.name.trim()) d.name = found.name;
  d.scanned = { ...(d.scanned || {}), [shop]: found.missing };
}

async function scanInto(d, shop) {
  const code = await scanBarcode();
  if (!code) return;
  toast("Looking it up…");
  try {
    const found = await lookUp(code);
    if (!found) {
      d.products[shop] = { ...(d.products[shop] || {}), barcode: code };
      toast("That product isn't in the database. Type it in from the packet.");
    } else {
      applyScan(d, shop, code, found);
    }
  } catch {
    toast("Couldn't look it up with no signal. Type it in from the packet.");
  }
  render();
}

/** Scan from the Foods list: opens a food you already have with that barcode,
 *  or starts a new one filled in from the lookup. */
async function scanNewFood() {
  const code = await scanBarcode();
  if (!code) return;
  const known = state.ingredients.find((i) =>
    Object.values(i.products || {}).some((p) => p.barcode === code));
  if (known) {
    toast(`You already have this: ${known.name}.`);
    return openFood(clone(known));
  }
  toast("Looking it up…");
  let found = null;
  let message = "That product isn't in the database. Type it in from the packet.";
  try {
    found = await lookUp(code);
  } catch {
    message = "Couldn't look it up with no signal. Type it in from the packet.";
  }
  const d = newFood();
  const shop = (found && L.guessShop(found.brand, state.shops)) || state.shops[0];
  d.usualShop = shop;
  if (found) applyScan(d, shop, code, found);
  else d.products[shop] = { barcode: code };
  openFood(d);
  if (!found) toast(message);
}

/* ---------------------------------------------------------------- foods */

function newFood() {
  return { id: uid(), name: "", unit: "g", usualShop: state.shops[0], products: {} };
}

function renderFoods(app) {
  if (ui.edit && ui.edit.kind === "food") return foodEditor(app, ui.edit.draft);

  app.append(
    h("div", { class: "row between" },
      h("h1", { text: "Foods" }),
      h("div", { class: "row" },
        h("button", { class: "small", onclick: scanNewFood }, "Scan"),
        h("button", { class: "primary small", onclick: () => openFood(newFood()) }, "Add food"))),
    h("p", { class: "muted", text: "Scan the barcode, or type it in from the packet label. You only do each one once." }));

  if (!state.ingredients.length) {
    app.append(h("div", { class: "empty", text: "No foods yet. Start with the ones in your usual meals." }));
    return;
  }
  const cards = h("div");
  for (const ing of [...state.ingredients].sort(byName)) {
    const p = L.productFor(ing, ing.usualShop);
    const detail = p
      ? `${round(p.kcal)} kcal · ${p.protein} g protein ${PER_LABEL[ing.unit]}`
        + (p.pack ? ` · pack ${L.formatAmount(p.pack, ing.unit)}` : "")
      : "No label saved yet";
    cards.append(h("div", { class: "card tap", "data-name": `${ing.name} ${ing.note || ""}`.toLowerCase(),
      onclick: () => openFood(clone(ing)) },
      h("div", { class: "row between" },
        h("h3", { text: ing.name }),
        h("span", { class: "pill", text: ing.usualShop })),
      h("div", { class: p ? "faint" : "faint warn", text: detail }),
      ing.estimated && ing.usualShop !== CUPBOARD
        ? h("div", { class: "faint warn", text: "Typical values. Scan the packet to check." }) : null));
  }
  if (state.ingredients.length > SEARCH_FROM) app.append(searchBox("Search foods", cards));
  app.append(cards);
}

function openFood(draft, returnTo = null) {
  ui.edit = { kind: "food", draft, returnTo };
  ui.tab = "foods";
  render();
}

function foodEditor(app, d) {
  const isNew = !state.ingredients.some((i) => i.id === d.id);
  const bind = (key) => (e) => { d[key] = e.target.value; };

  const unitSelect = h("select", {
    onchange: (e) => { d.unit = e.target.value; render(); },
  }, L.UNITS.map((u) => h("option", { value: u, selected: d.unit === u }, UNIT_LABEL[u])));

  const shopSelect = h("select", { onchange: bind("usualShop") },
    state.shops.map((s) => h("option", { value: s, selected: d.usualShop === s }, s)));

  app.append(
    h("h1", { text: isNew ? "New food" : d.name || "Food" }),
    h("div", { class: "card stack" },
      field("Name", h("input", { value: d.name, placeholder: "Chicken breast", oninput: bind("name"), autocomplete: "off" })),
      h("div", { class: "grid2" },
        field("Measured in", unitSelect),
        field("Usually bought at", shopSelect)),
      d.note ? h("p", { class: "faint", text: `Recipe swap: ${d.note}` }) : null,
      h("div", null, h("label", { text: "Allergy warning" }),
        h("div", { class: "row", style: "flex-wrap:wrap" }, ALLERGENS.map((a) => h("label", { class: "row check" },
          h("input", { type: "checkbox", checked: (d.allergens || []).includes(a),
            onchange: (e) => {
              const set = new Set(d.allergens || []);
              if (e.target.checked) set.add(a); else set.delete(a);
              d.allergens = [...set];
            } }),
          `Contains ${a}`)))),
      d.estimated && d.usualShop !== CUPBOARD
        ? h("p", { class: "pill warn", text: "These are typical UK values, not from your packet. Scan the barcode "
          + "or type in the label to replace them." }) : null));

  // Seasonings have one label and no pack; everything else has a label per shop.
  const labelShops = d.usualShop === CUPBOARD ? [CUPBOARD] : buyShops();
  for (const shop of labelShops) {
    if (shop === CUPBOARD) {
      const p = d.products[shop] || {};
      const set = (key) => (e) => { d.products[shop] = { ...(d.products[shop] || {}), [key]: e.target.value }; };
      const box = (key) => h("input", { inputmode: "decimal", value: p[key] ?? "", oninput: set(key) });
      app.append(h("div", { class: "card stack" },
        h("div", { class: "row between" }, h("h3", { text: "Label" }),
          h("span", { class: "faint", text: PER_LABEL[d.unit] })),
        h("div", { class: "grid4" }, field("kcal", box("kcal")), field("Protein g", box("protein")),
          field("Carbs g", box("carbs")), field("Fat g", box("fat"))),
        h("p", { class: "faint", text: "Cupboard items go on the list as \"check you have\", not \"buy\"." })));
      continue;
    }
    const p = d.products[shop] || {};
    const set = (key) => (e) => {
      d.products[shop] = { ...(d.products[shop] || {}), [key]: e.target.value };
      d.touched = true;
    };
    const box = (key) => h("input", { inputmode: "decimal", value: p[key] ?? "", oninput: set(key) });
    app.append(h("div", { class: "card stack" },
      h("div", { class: "row between" },
        h("h3", { text: `${shop} label` }),
        h("span", { class: "faint", text: PER_LABEL[d.unit] })),
      h("button", { class: "small", onclick: () => scanInto(d, shop) },
        p.barcode ? `Scan again (barcode ${p.barcode})` : `Scan the ${shop} barcode`),
      d.scanned && d.scanned[shop]
        ? h("p", { class: "pill warn", text: d.scanned[shop].length
          ? `Filled in from Open Food Facts. Missing: ${d.scanned[shop].join(", ")}. Check it against the packet.`
          : "Filled in from Open Food Facts. Check it against the packet before saving." })
        : null,
      h("div", { class: "grid4" },
        field("kcal", box("kcal")),
        field("Protein g", box("protein")),
        field("Carbs g", box("carbs")),
        field("Fat g", box("fat"))),
      field(d.unit === "each" ? "Items in a pack" : `Pack size in ${d.unit} (2 kg = 2000)`, box("pack")),
      h("p", { class: "faint", text: `Leave blank if you don't buy it at ${shop}.` })));
  }

  app.append(h("div", { class: "stack" },
    h("button", { class: "primary block", onclick: () => saveFood(d) }, "Save"),
    h("button", { class: "block", onclick: closeFood }, "Cancel"),
    isNew ? null : h("button", { class: "block danger", onclick: () => deleteFood(d) }, "Delete food")));
}

function cleanProducts(products) {
  const out = {};
  for (const [shop, p] of Object.entries(products || {})) {
    const clean = {};
    for (const key of [...L.MACROS, "pack"]) {
      const n = num(p[key]);
      if (n !== null && n >= 0) clean[key] = n;
    }
    if (Object.keys(clean).length) {
      for (const m of L.MACROS) clean[m] = clean[m] ?? 0;
      if (p.barcode) clean.barcode = String(p.barcode);
      out[shop] = clean;
    }
  }
  return out;
}

function saveFood(d) {
  const name = d.name.trim();
  if (!name) return toast("Give the food a name.");
  const products = cleanProducts(d.products);
  const usual = products[d.usualShop];
  if (!usual || num(d.products[d.usualShop]?.kcal) === null) {
    return toast(`Fill in the ${d.usualShop} label, as that's where you usually buy it.`);
  }
  const food = { id: d.id, name, unit: d.unit, usualShop: d.usualShop, products };
  if (d.note) food.note = d.note;
  food.allergens = d.allergens || [];
  // Typical values stay marked until the label is scanned or typed in.
  if (d.estimated && !d.scanned && !d.touched) food.estimated = true;
  const i = state.ingredients.findIndex((x) => x.id === d.id);
  if (i === -1) state.ingredients.push(food); else state.ingredients[i] = food;
  save();
  toast(`${name} saved.`);
  const back = ui.edit.returnTo;
  if (back) {
    if (back.line) back.line.ingredientId = food.id;
    ui.edit = back.edit;
    ui.tab = "meals";
  } else {
    ui.edit = null;
  }
  render();
}

function closeFood() {
  const back = ui.edit && ui.edit.returnTo;
  ui.edit = back ? back.edit : null;
  if (back) ui.tab = "meals";
  render();
}

function deleteFood(d) {
  const usedIn = state.meals.filter((m) => m.lines.some((l) => l.ingredientId === d.id));
  if (usedIn.length) {
    return toast(`Used in ${usedIn.map((m) => m.name).join(", ")}. Take it out of those meals first.`);
  }
  if (!confirm(`Delete ${d.name || "this food"}?`)) return;
  state.ingredients = state.ingredients.filter((i) => i.id !== d.id);
  delete state.prep.shopOverride[d.id];
  delete state.prep.ticked[d.id];
  save();
  ui.edit = null;
  render();
}

/* ---------------------------------------------------------------- meals */

function newMeal() {
  return { id: uid(), name: "", portions: DEFAULT_PORTIONS, source: { kind: "" }, lines: [] };
}

function renderMeals(app) {
  if (ui.edit && ui.edit.kind === "meal") return mealEditor(app, ui.edit.draft);

  app.append(h("div", { class: "row between" },
    h("h1", { text: "Meals" }),
    h("div", { class: "row" },
      h("button", { class: "small", onclick: () => { ui.linkForm = !ui.linkForm; render(); } }, "Save a link"),
      h("button", { class: "primary small", onclick: () => openMeal(newMeal()) }, "Add meal"))));
  if (ui.linkForm) app.append(linkForm());

  if (!state.meals.length) {
    app.append(h("div", { class: "empty" },
      h("p", { text: "No meals yet." }),
      h("p", { text: state.ingredients.length
        ? "Add one from your book or a video."
        : "Add the foods first, in the Foods tab, then build a meal from them." })));
    return;
  }
  const foods = ingredientsById();
  const cards = h("div");
  const groups = L.groupMeals([...state.meals]);
  // A long list starts with the headings closed; tap one to open it.
  const many = state.meals.length > SEARCH_FROM;
  let box = null;
  for (const group of groups) {
    if (groups.length > 1) cards.append(groupHead(group.category, group.meals.length, many ? () => box.refresh() : null));
    for (const meal of group.meals) cards.append(mealCard(meal, foods, group.category));
  }
  if (many) {
    box = searchBox("Search meals", cards, (card) => ui.openGroups.has(card.dataset.group), true);
    app.append(box);
  }
  app.append(cards);
}

function mealCard(meal, foods, category) {
  const totals = L.mealTotals(meal, foods);
  const link = meal.source && ["youtube", "web"].includes(meal.source.kind) && safeLink(meal.source.url);
  return h("div", { class: "card tap", "data-name": meal.name.toLowerCase(), "data-group": category,
    onclick: () => openMeal(clone(meal)) },
    h("div", { class: "row between" },
      h("h3", { text: meal.name }),
      meal.lines.length ? h("span", { class: "faint", text: `${meal.portions} portions` }) : null),
    allergyBadge(meal, foods),
    sourceText(meal.source) ? h("div", { class: "faint" },
      link ? h("a", { href: link, target: "_blank", rel: "noopener",
        onclick: (e) => e.stopPropagation() }, meal.source.kind === "youtube" ? `${sourceText(meal.source)} (video)` : sourceText(meal.source))
        : sourceText(meal.source),
      safeLink(meal.source.page) ? [" · ", h("a", { href: meal.source.page, target: "_blank", rel: "noopener",
        onclick: (e) => e.stopPropagation() }, "recipe page")] : null) : null,
    mealNotes(meal),
    ...(meal.lines.length ? [
      h("div", { class: "faint", text: "Per portion" }),
      macroGrid(L.perPortion(totals, meal.portions)),
      hisLine(meal),
      totals.missing.length
        ? h("p", { class: "faint warn", text: `Short: no label for ${totals.missing.join(", ")}.` }) : null,
      h("button", { class: "small", style: "margin-top:10px",
        onclick: (e) => { e.stopPropagation(); addToList(meal); } },
        state.prep.items[meal.id] ? `On the list ×${state.prep.items[meal.id]} · add another` : "Add to shopping list"),
    ] : [h("p", { class: "faint", text: "Link only. Tap to add the ingredients and get macros and a shopping list." })]));
}

const ALLERGENS = ["peanuts", "tree nuts"];

/** A red warning when a meal uses a food flagged with an allergen. */
function allergyBadge(meal, foods = ingredientsById()) {
  const found = L.mealAllergens(meal, foods);
  if (!found.length) return null;
  return h("div", { class: "allergy", role: "note", text: `⚠ Contains ${found.join(" and ")}` });
}

/** Notes added when a recipe was converted: a peanut oil swap, nuts to leave off, adjusted portions. */
function mealNotes(meal) {
  if (!meal.notes || !meal.notes.length) return null;
  return h("ul", { class: "notes" }, meal.notes.map((n) => h("li", { text: n })));
}

/** The recipe author's own per-portion numbers, for comparing with the UK version. */
function hisLine(meal) {
  if (!meal.his || !meal.his[0]) return null;
  const [kcal, protein] = meal.his;
  return h("div", { class: "faint", style: "margin-top:6px",
    text: `Recipe says ${round(kcal)} kcal${protein ? ` · ${round(protein)} g protein` : ""}` });
}

function openMeal(draft) {
  ui.edit = { kind: "meal", draft };
  ui.tab = "meals";
  render();
}

function mealTotalsBox(d) {
  const foods = ingredientsById();
  const totals = L.mealTotals(d, foods);
  return h("div", { class: "card", id: "meal-totals" },
    h("div", { class: "row between" },
      h("h3", { text: "Per portion" }),
      h("span", { class: "faint", text: `${num(d.portions) || "?"} portions` })),
    macroGrid(L.perPortion(totals, num(d.portions))),
    h("div", { class: "faint", style: "margin-top:8px" },
      `Whole batch: ${round(totals.kcal)} kcal, ${round(totals.protein)} g protein`),
    totals.missing.length
      ? h("p", { class: "faint warn", text: `Short: no label for ${totals.missing.join(", ")}.` }) : null);
}

function refreshTotals(d) {
  const old = document.getElementById("meal-totals");
  if (old) old.replaceWith(mealTotalsBox(d));
}

function mealEditor(app, d) {
  const isNew = !state.meals.some((m) => m.id === d.id);
  d.source = d.source || { kind: "" };
  const foods = [...state.ingredients].sort(byName);

  const sourceKind = h("select", {
    onchange: (e) => { d.source.kind = e.target.value; render(); },
  },
    h("option", { value: "", selected: !d.source.kind }, "Nowhere / my own"),
    h("option", { value: "book", selected: d.source.kind === "book" }, "A book"),
    h("option", { value: "youtube", selected: d.source.kind === "youtube" }, "A YouTube video"),
    h("option", { value: "web", selected: d.source.kind === "web" }, "A website"));

  const sourceFields = d.source.kind === "book"
    ? h("div", { class: "grid2" },
      field("Book", h("input", { value: d.source.title || "", oninput: (e) => { d.source.title = e.target.value; } })),
      field("Page", h("input", { inputmode: "numeric", value: d.source.page || "",
        oninput: (e) => { d.source.page = e.target.value; } })))
    : ["youtube", "web"].includes(d.source.kind)
      ? h("div", { class: "stack" },
        field("Video link", h("input", { type: "url", value: d.source.url || "", placeholder: "https://youtube.com/…",
          oninput: (e) => { d.source.url = e.target.value.trim(); } })),
        field("Channel or video name (optional)", h("input", { value: d.source.title || "",
          oninput: (e) => { d.source.title = e.target.value; } })))
      : null;

  app.append(
    h("h1", { text: isNew ? "New meal" : d.name || "Meal" }),
    allergyBadge(d),
    mealNotes(d),
    h("div", { class: "card stack" },
      field("Name", h("input", { value: d.name, placeholder: "Chicken rice bowl", autocomplete: "off",
        oninput: (e) => { d.name = e.target.value; } })),
      field("Portions it makes", h("input", { inputmode: "numeric", value: d.portions,
        oninput: (e) => { d.portions = e.target.value; refreshTotals(d); } })),
      field("Type", h("select", { onchange: (e) => { d.category = e.target.value; } },
        L.CATEGORIES.map((c) => h("option", { value: c, selected: (d.category || "Other") === c }, c)))),
      field("Where it's from", sourceKind),
      sourceFields));

  const lines = h("div", { class: "card stack" }, h("h3", { text: "Ingredients" }));
  if (!foods.length) {
    lines.append(h("p", { class: "muted", text: "No foods saved yet. Add one below." }));
  }
  d.lines.forEach((line, index) => {
    const food = state.ingredients.find((i) => i.id === line.ingredientId);
    const select = h("select", {
      onchange: (e) => { line.ingredientId = e.target.value; render(); },
    },
      h("option", { value: "", selected: !line.ingredientId }, "Pick a food"),
      foods.map((f) => h("option", { value: f.id, selected: f.id === line.ingredientId }, f.name)));
    lines.append(h("div", { class: "line" },
      select,
      h("div", { class: "row" },
        h("input", { inputmode: "decimal", value: line.amount ?? "", style: "width:110px",
          "aria-label": "Amount",
          oninput: (e) => { line.amount = num(e.target.value); refreshTotals(d); } }),
        h("span", { class: "grow faint", text: food ? (food.unit === "each" ? "items" : food.unit) : "" }),
        h("button", { class: "small", "aria-label": "Remove",
          onclick: () => { d.lines.splice(index, 1); render(); } }, "Remove")),
      line.us ? h("div", { class: "faint", text: `Recipe: ${line.us}` }) : null));
  });
  lines.append(h("div", { class: "grid2" },
    h("button", { disabled: !foods.length,
      onclick: () => { d.lines.push({ ingredientId: "", amount: null }); render(); } }, "Add ingredient"),
    h("button", {
      onclick: () => {
        const line = { ingredientId: "", amount: null };
        d.lines.push(line);
        openFood(newFood(), { edit: ui.edit, line });
      },
    }, "New food")));

  app.append(lines, mealTotalsBox(d), hisLine(d) ? h("div", { class: "card" }, hisLine(d)) : null,
    h("div", { class: "stack" },
    h("button", { class: "primary block", onclick: () => saveMeal(d) }, "Save meal"),
    h("button", { class: "block", onclick: () => { ui.edit = null; render(); } }, "Cancel"),
    isNew ? null : h("button", { class: "block danger", onclick: () => deleteMeal(d) }, "Delete meal")));
}

function saveMeal(d) {
  if (["youtube", "web"].includes(d.source.kind) && d.source.url && !safeLink(d.source.url)) {
    return toast("The link should start with https://");
  }
  const link = ["youtube", "web"].includes(d.source.kind) ? safeLink(d.source.url) : null;
  // With a link, the name can be left blank: it's taken from the link.
  const name = d.name.trim() || (link ? L.nameFromLink(link) : "");
  if (!name) return toast("Add a link to the recipe, or a name and ingredients.");
  const portions = num(d.portions);
  if (!(portions > 0)) return toast("Portions must be more than 0.");
  const lines = d.lines
    .filter((l) => l.ingredientId && num(l.amount) > 0)
    .map((l) => ({ ingredientId: l.ingredientId, amount: num(l.amount), ...(l.us ? { us: l.us } : {}) }));
  // A link on its own is enough ("save it for later"); otherwise ingredients are needed.
  if (!lines.length && !link) return toast("Add at least one ingredient, or a link to the recipe.");
  const category = !lines.length && (!d.category || d.category === "Other") ? "To try" : (d.category || "Other");
  const meal = { id: d.id, name, category, portions, source: d.source, lines };
  if (d.notes && d.notes.length) meal.notes = d.notes;
  if (d.his) meal.his = d.his;
  const i = state.meals.findIndex((m) => m.id === d.id);
  if (i === -1) state.meals.push(meal); else state.meals[i] = meal;
  save();
  ui.edit = null;
  toast(`${name} saved.`);
  render();
}

/** Paste a link (and optionally a name) to keep a recipe for later. */
function linkForm() {
  const url = h("input", { type: "url", placeholder: "Paste the recipe or video link", autocomplete: "off",
    "aria-label": "Recipe link" });
  const name = h("input", { placeholder: "Name (optional, taken from the link)", autocomplete: "off",
    "aria-label": "Name" });
  const go = () => { if (saveLink(url.value, name.value)) { ui.linkForm = false; render(); } };
  setTimeout(() => url.focus(), 0);
  return h("div", { class: "card stack" },
    h("h3", { text: "Save a recipe for later" }), url, name,
    h("div", { class: "grid2" },
      h("button", { class: "primary", onclick: go }, "Save"),
      h("button", { onclick: () => { ui.linkForm = false; render(); } }, "Cancel")),
    h("p", { class: "faint", text: "Tip: in YouTube or Chrome, tap Share → Meal Prep to save a link without copying it." }));
}

/** Saves a recipe link as a meal with no ingredients yet, under "To try". */
function saveLink(text, typedName = "") {
  const url = L.findLink(text);
  if (!url || !safeLink(url)) return toast("That doesn't look like a web link (it should start with https://).");
  const existing = state.meals.find((m) => m.source && m.source.url === url);
  if (existing) return toast(`Already saved: ${existing.name}.`);
  const kind = /youtu\.?be/i.test(url) ? "youtube" : "web";
  const name = typedName.trim() || L.nameFromLink(url);
  state.meals.push({ id: uid(), name, category: "To try", portions: DEFAULT_PORTIONS,
    source: { kind, url, title: "" }, lines: [] });
  save();
  ui.openGroups.add("To try");
  toast(`Saved "${name}" under To try.`);
  return true;
}

function deleteMeal(d) {
  if (!confirm(`Delete ${d.name || "this meal"}? Portions you've already logged are kept.`)) return;
  state.meals = state.meals.filter((m) => m.id !== d.id);
  delete state.prep.items[d.id];
  save();
  ui.edit = null;
  render();
}

/* ---------------------------------------------------------------- shopping list */

/** Tapping a meal adds one batch of it to the list; − takes one off. */
function setBatches(mealId, n) {
  if (n > 0) state.prep.items[mealId] = n; else delete state.prep.items[mealId];
  save();
}

function addToList(meal) {
  setBatches(meal.id, (state.prep.items[meal.id] || 0) + 1);
  toast(`${meal.name} added to the shopping list.`);
  render();
}

function mealPicker(app) {
  const many = state.meals.length > SEARCH_FROM;
  app.append(h("p", { class: "muted", text: many
    ? "Search for a meal and tap it to add its ingredients. Tap again for another batch."
    : "Tap a meal to add its ingredients. Tap again for another batch." }));
  let portions = 0;
  const cards = h("div");
  // Link-only meals have nothing to buy yet.
  const groups = L.groupMeals(state.meals.filter((m) => m.lines.length));
  for (const group of groups) {
    if (groups.length > 1) cards.append(groupHead(group.category, group.meals.length, null));
    for (const meal of group.meals) {
      const batches = state.prep.items[meal.id] || 0;
      portions += batches * meal.portions;
      cards.append(h("div", {
        class: `card tap row pick${batches ? " on" : ""}`,
        role: "button",
        "data-name": meal.name.toLowerCase(),
        "data-on": batches ? "1" : null,
        "aria-label": `Add ${meal.name}`,
        onclick: () => { setBatches(meal.id, batches + 1); render(); },
      },
        h("div", { class: "grow" },
          h("h3", { text: meal.name }),
          allergyBadge(meal),
          h("div", { class: "faint", text: batches
            ? `${batches === 1 ? "1 batch" : `${batches} batches`} · ${batches * meal.portions} portions`
            : `${meal.portions} portions a batch` })),
        batches
          ? h("div", { class: "stepper" },
            h("button", { "aria-label": `One fewer ${meal.name}`,
              onclick: (e) => { e.stopPropagation(); setBatches(meal.id, batches - 1); render(); } }, "−"),
            h("b", { text: batches }))
          : h("span", { class: "pill", text: "+ Add" })));
    }
  }
  // With a long list, only meals already on the list show until you search.
  if (many) app.append(searchBox("Search meals to add", cards, (card) => card.dataset.on === "1"));
  app.append(cards);
  if (portions) app.append(h("p", { class: "faint", text: `${portions} portions in total.` }));
}

function clearList() {
  if (!confirm("Clear the shopping list and start a new prep?")) return;
  state.prep = blank().prep;
  save();
  render();
}

/* Everyday items: saved once with a shop, one tap puts them on the list. */

function setExtra(itemId, qty) {
  if (qty > 0) state.prep.extras[itemId] = qty;
  else {
    delete state.prep.extras[itemId];
    delete state.prep.ticked[`x:${itemId}`];
  }
  save();
  render();
}

function savedPicker(app) {
  const saved = [...state.saved].sort(byName);
  const name = h("input", { placeholder: "Toilet roll, milk, bin bags…", autocomplete: "off",
    "aria-label": "New item", onkeydown: (e) => { if (e.key === "Enter") addNew(); } });
  const shop = h("select", { "aria-label": "Shop" },
    buyShops().map((s) => h("option", { value: s }, s)));
  const addNew = () => {
    const text = name.value.trim();
    if (!text) return toast("Type the item first.");
    let item = state.saved.find((s) => s.name.toLowerCase() === text.toLowerCase());
    if (!item) {
      item = { id: uid(), name: text, shop: shop.value };
      state.saved.push(item);
    }
    toast(`${item.name} saved and added.`);
    setExtra(item.id, (state.prep.extras[item.id] || 0) + 1);
  };

  app.append(h("h2", { text: "Everyday items" }),
    h("p", { class: "muted", text: "Not in a meal? Save it once, then tap it to add it." }));
  if (saved.length) {
    app.append(h("div", { class: "chips" }, saved.map((item) => {
      const qty = state.prep.extras[item.id] || 0;
      return ui.manageSaved
        ? h("button", { class: "chip", "aria-label": `Delete ${item.name}`,
          onclick: () => {
            if (!confirm(`Delete ${item.name} from your saved items?`)) return;
            state.saved = state.saved.filter((s) => s.id !== item.id);
            setExtra(item.id, 0);
          } }, `✕ ${item.name}`)
        : h("button", { class: `chip${qty ? " on" : ""}`, "aria-label": `Add ${item.name}`,
          onclick: () => setExtra(item.id, qty + 1) }, qty ? `${item.name} ×${qty}` : `+ ${item.name}`);
    })));
  }
  app.append(h("div", { class: "card stack", style: "margin-top:10px" },
    name,
    h("div", { class: "row" }, h("div", { class: "grow" }, shop),
      h("button", { class: "primary", onclick: addNew }, "Save and add"))));
  if (saved.length) {
    app.append(h("button", { class: "small", style: "margin-top:10px",
      onclick: () => { ui.manageSaved = !ui.manageSaved; render(); } },
    ui.manageSaved ? "Done" : "Edit saved items"));
  }
}

function buyText(item) {
  if (item.shop === CUPBOARD) return `Check you have ${L.formatAmount(item.need, item.unit)}`;
  if (item.packs === null) return `Buy ${L.formatAmount(item.need, item.unit)}`;
  const size = L.formatAmount(item.packSize, item.unit);
  if (item.unit === "each") return `Buy ${item.packs} pack${item.packs === 1 ? "" : "s"} of ${size}`;
  return item.packs === 1 ? `Buy 1 pack (${size})` : `Buy ${item.packs} packs of ${size}`;
}

/** The whole list: meal ingredients plus everyday items, grouped by shop. */
function currentList() {
  const items = Object.entries(state.prep.items).map(([mealId, batches]) => ({ mealId, batches }));
  const groups = L.shoppingList(items, mealsById(), ingredientsById(), state.prep.shopOverride, state.shops);
  const savedById = Object.fromEntries(state.saved.map((s) => [s.id, s]));
  return L.addExtras(groups, state.prep.extras, savedById, state.shops);
}

function rowText(item) {
  return item.kind === "extra" ? (item.qty > 1 ? `×${item.qty}` : "") : buyText(item).replace(/^Buy /, "");
}

function tick(key, on) {
  if (on) state.prep.ticked[key] = true; else delete state.prep.ticked[key];
  save();
  render();
}

function listRow(item) {
  const children = [h("div", { class: "item-name", text: item.name })];
  if (item.kind === "extra") {
    children.push(h("div", { class: "row", style: "margin-top:6px" },
      h("div", { class: "stepper" },
        h("button", { class: "small", "aria-label": `One fewer ${item.name}`,
          onclick: () => setExtra(item.itemId, item.qty - 1) }, "−"),
        h("b", { text: item.qty }),
        h("button", { class: "small", "aria-label": `One more ${item.name}`,
          onclick: () => setExtra(item.itemId, item.qty + 1) }, "+"))));
  } else {
    const ing = ingredientsById()[item.ingredientId];
    const extra = item.packs === null ? [] : [`Need ${L.formatAmount(item.need, item.unit)}`];
    if (item.spare > 0) extra.push(`${L.formatAmount(item.spare, item.unit)} spare`);
    children.push(
      h("div", { text: buyText(item) }),
      extra.length ? h("div", { class: "faint", text: extra.join(" · ") }) : null,
      item.noProduct
        ? h("div", { class: "pill warn", text: `No ${item.shop} pack saved, so this is the amount only` }) : null,
      item.shop === CUPBOARD ? null : h("select", {
        "aria-label": `Shop for ${item.name}`,
        onchange: (e) => {
          if (e.target.value === ing.usualShop) delete state.prep.shopOverride[item.ingredientId];
          else state.prep.shopOverride[item.ingredientId] = e.target.value;
          save();
          render();
        },
      }, buyShops().map((s) => h("option", { value: s, selected: s === item.shop }, `Buy at ${s}`))));
  }
  return h("div", { class: "card item" },
    h("input", { type: "checkbox", "aria-label": `Got ${item.name}`, onchange: () => tick(item.key, true) }),
    h("div", { class: "grow" }, children));
}

function renderList(app) {
  app.append(h("h1", { text: "Shopping list" }));
  const groups = currentList();
  const all = groups.flatMap((g) => g.items);
  const inBasket = all.filter((i) => state.prep.ticked[i.key]);

  if (!all.length) {
    app.append(h("p", { class: "muted", text: "Nothing on the list yet. Add meals or everyday items below." }));
  } else {
    if (inBasket.length === all.length) {
      app.append(h("div", { class: "card", style: "text-align:center" }, h("h3", { text: "Everything's in the basket." })));
    }
    for (const group of groups) {
      const left = group.items.filter((i) => !state.prep.ticked[i.key]);
      if (!left.length) continue;
      app.append(h("div", { class: "shop-head" },
        h("h2", { text: group.shop, style: "margin:0" }),
        h("span", { class: "faint", text: `${left.length} to ${group.shop === CUPBOARD ? "check" : "get"}` })));
      for (const item of left) app.append(listRow(item));
    }

    if (inBasket.length) {
      app.append(h("details", { class: "basket", open: ui.basketOpen || null,
        ontoggle: (e) => { ui.basketOpen = e.target.open; } },
      h("summary", { text: `In the basket (${inBasket.length})` }),
      inBasket.map((item) => h("div", { class: "row basket-row" },
        h("span", { class: "grow" }, h("s", { text: item.name }),
          h("span", { class: "faint", text: ` · ${item.shop}` })),
        h("button", { class: "small", "aria-label": `Put ${item.name} back on the list`,
          onclick: () => tick(item.key, false) }, "Put back")))));
    }

    app.append(h("div", { class: "stack", style: "margin-top:16px" },
      h("button", { class: "primary block", onclick: shareList }, "Share list"),
      h("button", { class: "block danger", onclick: clearList }, "Clear list")));
  }

  app.append(h("h2", { text: "Meals" }));
  if (state.meals.length) mealPicker(app);
  else app.append(h("p", { class: "muted", text: "Save a meal in the Meals tab, then tap it here." }));
  savedPicker(app);
}

async function shareList() {
  const lines = [];
  for (const group of currentList()) {
    const left = group.items.filter((i) => !state.prep.ticked[i.key]);
    if (!left.length) continue;
    lines.push(group.shop.toUpperCase());
    for (const item of left) {
      const detail = rowText(item);
      lines.push(`• ${item.name}${detail ? `: ${detail}` : ""}`);
    }
    lines.push("");
  }
  if (!lines.length) return toast("Nothing left to buy.");
  const text = lines.join("\n").trim();
  try {
    if (navigator.share) await navigator.share({ title: "Shopping list", text });
    else { await navigator.clipboard.writeText(text); toast("List copied."); }
  } catch (err) {
    if (err && err.name !== "AbortError") toast("Couldn't share the list.");
  }
}

/* ---------------------------------------------------------------- today */

function renderToday(app) {
  const day = ui.day;
  const eatenToday = state.eaten.filter((e) => e.date === day);

  app.append(
    h("div", { class: "row between" },
      h("button", { class: "small", "aria-label": "Day before", onclick: () => { ui.day = shiftDay(day, -1); render(); } }, "‹"),
      h("h1", { text: prettyDay(day), style: "margin:0" }),
      h("button", { class: "small", "aria-label": "Day after", onclick: () => { ui.day = shiftDay(day, 1); render(); } }, "›")),
    h("div", { class: "card", style: "margin-top:12px" },
      h("h3", { text: "Eaten" }),
      macroGrid(L.dayTotals(state.eaten, day))));

  if (state.meals.length) {
    const log = { mealId: state.meals.slice().sort(byName)[0].id, portions: 1 };
    const count = h("b", { text: "1" });
    const step = (delta) => {
      log.portions = Math.max(0.5, log.portions + delta);
      count.textContent = String(log.portions);
    };
    app.append(h("div", { class: "card stack" },
      h("h3", { text: "Log a portion" }),
      h("select", { "aria-label": "Meal", onchange: (e) => { log.mealId = e.target.value; } },
        [...state.meals].sort(byName).map((m) => h("option", { value: m.id }, m.name))),
      h("div", { class: "row between" },
        h("div", { class: "stepper" },
          h("button", { "aria-label": "Half less", onclick: () => step(-0.5) }, "−"),
          count,
          h("button", { "aria-label": "Half more", onclick: () => step(0.5) }, "+")),
        h("button", { class: "primary", onclick: () => logPortion(log) }, "Add"))));
  }

  if (eatenToday.length) {
    app.append(h("h2", { text: "Logged" }));
    for (const e of eatenToday) {
      app.append(h("div", { class: "card row" },
        h("div", { class: "grow" },
          h("div", { class: "item-name", text: e.mealName }),
          h("div", { class: "faint",
            text: `${e.portions} portion${e.portions === 1 ? "" : "s"} · ${round(e.kcal)} kcal · ${round(e.protein)} g protein` })),
        h("button", { class: "small", "aria-label": "Remove", onclick: () => removeEaten(e.id) }, "✕")));
    }
  } else if (!state.meals.length) {
    app.append(h("div", { class: "empty", text: "Save a meal and you can log portions of it here." }));
  }

  renderSync(app);
  renderData(app);
}

function logPortion(log) {
  const meal = state.meals.find((m) => m.id === log.mealId);
  if (!meal) return;
  const each = L.perPortion(L.mealTotals(meal, ingredientsById()), meal.portions);
  const record = { id: uid(), date: ui.day, mealId: meal.id, mealName: meal.name, portions: log.portions };
  for (const m of L.MACROS) record[m] = Math.round(each[m] * log.portions * 10) / 10;
  state.eaten.push(record);
  save();
  toast(`${meal.name} logged.`);
  render();
}

function removeEaten(id) {
  state.eaten = state.eaten.filter((e) => e.id !== id);
  save();
  render();
}

/* ---------------------------------------------------------------- your data */

/* ---------------------------------------------------------------- sync
 * The phone and the tablet share one copy online (Supabase project
 * "meal-prep"). A household is a long random code; the database only shows a
 * device the rows for the code it sends. The sums are in logic.js
 * (changesToSend, applyFromServer) and tested there. */

const SYNC_URL = "https://amjlcpeinqonwgnppghu.supabase.co/rest/v1/docs";
const SYNC_KEY = "sb_publishable_kpmQWHX9oaGcSePAX3gzNg_mdtWqMyk"; // public by design; the code is the secret
const SYNC_STORE = "mealprep:sync";
const SYNC_EVERY_MS = 30000;
const EPOCH = "1970-01-01T00:00:00Z";

let sync = (() => {
  try { return { cursor: EPOCH, known: {}, ...(JSON.parse(localStorage.getItem(SYNC_STORE)) || {}) }; }
  catch { return { cursor: EPOCH, known: {} }; }
})();
const syncUi = { busy: false, status: "", timer: null };

function saveSync() {
  try { localStorage.setItem(SYNC_STORE, JSON.stringify(sync)); } catch { /* storage full or blocked */ }
}

/** A new household code: 32 letters and digits, without look-alikes (0/O, 1/l). */
function newHouseholdCode() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => chars[b % chars.length]).join("");
}
const tidyCode = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const showCode = (c) => c.match(/.{1,4}/g).join("-");

function scheduleSync(delay = 2500) {
  if (!sync.household) return;
  clearTimeout(syncUi.timer);
  syncUi.timer = setTimeout(syncNow, delay);
}

async function syncFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { apikey: SYNC_KEY, "x-household": sync.household, "Content-Type": "application/json",
      ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`sync ${res.status}`);
  return res;
}

async function syncNow() {
  if (!sync.household || syncUi.busy) return;
  if (!navigator.onLine) { syncUi.status = "offline"; return; }
  syncUi.busy = true;
  try {
    // 1. Fetch what the other device changed.
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const q = `?select=key,value,deleted,updated_at&updated_at=gt.${encodeURIComponent(sync.cursor)}`
        + `&order=updated_at.asc,key.asc&limit=500&offset=${offset}`;
      const page = await (await syncFetch(SYNC_URL + q)).json();
      rows.push(...page);
      if (page.length < 500) break;
    }
    if (rows.length) {
      const out = L.applyFromServer(state, sync.known, rows);
      state = out.state;
      sync.known = out.known;
      sync.cursor = rows[rows.length - 1].updated_at;
      save({ fromSync: true });
      saveSync();
      // Don't redraw under someone's fingers.
      const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
      if (out.applied && !ui.edit && !typing) render();
    }
    // 2. Send what this device changed.
    const changes = L.changesToSend(state, sync.known);
    for (let i = 0; i < changes.length; i += 200) {
      const chunk = changes.slice(i, i + 200);
      await syncFetch(SYNC_URL, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(chunk.map((c) => ({ household: sync.household, key: c.key, value: c.value, deleted: c.deleted }))),
      });
      for (const c of chunk) {
        if (c.deleted) delete sync.known[c.key]; else sync.known[c.key] = L.fingerprint(c.value);
      }
      saveSync();
    }
    sync.lastOk = new Date().toISOString();
    syncUi.status = "ok";
    saveSync();
  } catch {
    syncUi.status = navigator.onLine ? "error" : "offline";
  } finally {
    syncUi.busy = false;
    const el = document.getElementById("sync-status");
    if (el) el.textContent = syncStatusText();
  }
}

function syncStatusText() {
  if (syncUi.status === "offline") return "No signal. Changes are kept and sent when you're back online.";
  if (syncUi.status === "error") return "Couldn't reach the sync server just now. It will try again.";
  if (!sync.lastOk) return "Not synced yet.";
  const mins = Math.round((Date.now() - Date.parse(sync.lastOk)) / 60000);
  return mins < 1 ? "Synced just now." : `Synced ${plural(mins, "minute")} ago.`;
}

function startSyncing(code) {
  sync = { household: code, cursor: EPOCH, known: {} };
  saveSync();
  syncUi.status = "";
  toast("Syncing started. Your data is combined with the other device's.");
  render();
  syncNow().then(render);
}

function stopSyncing() {
  if (!confirm("Stop syncing on this device? Everything stays on this device; it just stops sharing.")) return;
  sync = { cursor: EPOCH, known: {} };
  saveSync();
  render();
}

function renderSync(app) {
  const card = h("div", { class: "card stack" });
  app.append(h("h2", { text: "Sync with your other devices" }), card);
  if (!sync.household) {
    const input = h("input", { placeholder: "Paste the household code", autocomplete: "off", "aria-label": "Household code" });
    card.append(
      h("p", { class: "muted", text: "Share meals, links, the shopping list and ticks between the phone and the tablet." }),
      h("button", { class: "primary block", onclick: () => startSyncing(newHouseholdCode()) },
        "Start syncing (on the first device)"),
      h("p", { class: "faint", text: "Already started on the other device? Enter its code:" }),
      input,
      h("button", { class: "block", onclick: () => {
        const code = tidyCode(input.value);
        if (code.length < 24) return toast("That code looks too short. It's 32 letters and numbers.");
        startSyncing(code);
      } }, "Join"));
    return;
  }
  const link = `${location.origin}${location.pathname}?join=${sync.household}`;
  const codeText = h("code", { class: "code", text: showCode(sync.household), hidden: !syncUi.showCode });
  card.append(
    h("p", { id: "sync-status", text: syncStatusText() }),
    h("div", { class: "grid2" },
      h("button", { onclick: () => { syncUi.status = ""; syncNow(); toast("Syncing…"); } }, "Sync now"),
      h("button", { onclick: async () => {
        try {
          if (navigator.share) await navigator.share({ title: "Join our Meal Prep", text: link });
          else { await navigator.clipboard.writeText(link); toast("Join link copied."); }
        } catch { /* cancelled */ }
      } }, "Send join link")),
    h("button", { class: "small", onclick: () => { syncUi.showCode = !syncUi.showCode; render(); } },
      syncUi.showCode ? "Hide code" : "Show household code"),
    codeText,
    h("p", { class: "faint", text: "Anyone with this code or link can see and change your meals and lists, so only send it to your own devices." }),
    h("button", { class: "small danger", onclick: stopSyncing }, "Stop syncing on this device"));
}

function renderData(app) {
  const fileInput = h("input", { type: "file", accept: "application/json,.json", hidden: true,
    onchange: (e) => importBackup(e.target.files[0]) });
  const mealsInput = h("input", { type: "file", accept: "application/json,.json", hidden: true,
    onchange: (e) => addMealsFile(e.target.files[0]) });
  app.append(
    h("h2", { text: "Your data" }),
    h("div", { class: "card stack" },
      h("p", { class: "muted",
        text: `${plural(state.ingredients.length, "food")}, ${plural(state.meals.length, "meal")}, `
          + `${plural(state.eaten.length, "portion")} logged. `
          + "It's saved on this phone only, so download a backup now and then." }),
      h("div", { class: "grid2" },
        h("button", { onclick: exportBackup }, "Download backup"),
        h("button", { onclick: () => fileInput.click() }, "Load backup")),
      fileInput,
      h("button", { onclick: () => mealsInput.click() }, "Add meals from a file"),
      mealsInput,
      h("p", { class: "faint", text: "Adds a set of meals and their foods. Anything you already have is kept as it is." }),
      h("div", { class: "row between" },
        h("span", { class: "faint", text: `Shops: ${state.shops.join(", ")}` }),
        h("button", { class: "small", onclick: addShop }, "Add shop"))));
}

function exportBackup() {
  const data = { ...state, exported: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `meal-prep-backup-${localDate(new Date())}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importBackup(file) {
  if (!file) return;
  try {
    const data = L.validateBackup(JSON.parse(await file.text()));
    if (!confirm(`Replace everything on this phone with this backup? `
      + `(${data.ingredients.length} foods, ${data.meals.length} meals)`)) return;
    const { exported, ...rest } = data;
    state = { ...blank(), ...rest, prep: { ...blank().prep, ...(rest.prep || {}) } };
    save();
    toast("Backup loaded.");
    render();
  } catch (err) {
    toast(err instanceof SyntaxError ? "That file isn't a backup." : err.message);
  }
}

async function addMealsFile(file) {
  if (!file) return;
  try {
    const out = L.mergeMeals(state, JSON.parse(await file.text()));
    if (!out.added.meals && !out.added.foods) return toast("You already have all of those meals.");
    state = out.state;
    save();
    toast(`Added ${plural(out.added.meals, "meal")} and ${plural(out.added.foods, "food")}.`
      + (out.kept.meals || out.kept.foods ? " Ones you already had were kept as they are." : ""));
    render();
  } catch (err) {
    toast(err instanceof SyntaxError ? "That file isn't a meals file." : err.message);
  }
}

function addShop() {
  const name = (prompt("Shop name") || "").trim();
  if (!name) return;
  if (state.shops.some((s) => s.toLowerCase() === name.toLowerCase())) return toast(`${name} is already there.`);
  state.shops.push(name);
  save();
  render();
}

/* ---------------------------------------------------------------- shell */

const SCREENS = { meals: renderMeals, foods: renderFoods, list: renderList, today: renderToday };

function render() {
  const app = document.getElementById("app");
  app.replaceChildren();
  if (!SCREENS[ui.tab]) ui.tab = "meals";
  SCREENS[ui.tab](app);
  for (const b of document.querySelectorAll("#tabs button")) {
    if (b.dataset.tab === ui.tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  try { localStorage.setItem("mealprep:tab", ui.tab); } catch { /* private mode */ }
}

/** The Cooking for Gains meals ship with the app (meals-data.json, made by
 *  cookingforgains/build.js). Each open adds any not yet added. Ones you
 *  already have are kept, and ones you deleted stay deleted. */
async function loadBuiltInMeals() {
  try {
    const res = await fetch("meals-data.json");
    if (!res.ok) return;
    const out = L.mergeMeals(state, await res.json(), new Set(state.builtInSeen || []));
    if (!out.addedIds.length && !out.filled) return;
    state = { ...out.state, builtInSeen: [...(state.builtInSeen || []), ...out.addedIds] };
    save();
    if (out.added.meals) toast(`Added ${plural(out.added.meals, "Cooking for Gains meal")}.`);
    if (!ui.edit) render();
  } catch { /* offline on first open, or no file: try again next time */ }
}

document.getElementById("tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("button")?.dataset.tab;
  if (!tab) return;
  if (ui.edit && ui.edit.kind !== { meals: "meal", foods: "food" }[tab]) {
    if (!confirm("Leave without saving?")) return;
    ui.edit = null;
  }
  ui.tab = tab;
  window.scrollTo(0, 0);
  render();
});

/* Share → Meal Prep (Android): the phone opens the app with ?title=&text=&url=.
 * YouTube puts the link in "text" and the video title in "title". */
(() => {
  const params = new URLSearchParams(location.search);
  if (!params.has("url") && !params.has("text")) return;
  const text = `${params.get("url") || ""} ${params.get("text") || ""}`;
  const title = (params.get("title") || "").trim();
  ui.tab = "meals";
  history.replaceState(null, "", location.pathname);
  setTimeout(() => { if (saveLink(text, title)) render(); }, 0);
})();

/* Join link: ?join=<code> opens the app ready to join that household. */
(() => {
  const code = tidyCode(new URLSearchParams(location.search).get("join"));
  if (!code) return;
  history.replaceState(null, "", location.pathname);
  if (code.length < 24 || code === sync.household) return;
  setTimeout(() => {
    if (confirm("Join this household? Meals, links and the shopping list will be shared with the other device.")) {
      ui.tab = "today";
      startSyncing(code);
    }
  }, 300);
})();

render();

loadBuiltInMeals().then(() => syncNow());
setInterval(() => { if (document.visibilityState === "visible") syncNow(); }, SYNC_EVERY_MS);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncNow(); });
window.addEventListener("online", () => { syncUi.status = ""; syncNow(); });
