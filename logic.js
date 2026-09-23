/* Meal Prep — the sums. Macros per meal and per portion, the shopping list, and
 * a day's totals. No DOM and no storage here: app.js draws the screens, and
 * tests/logic.test.mjs runs this file in Node.
 *
 * Units: an ingredient is weighed in g, measured in ml, or counted ("each").
 * Label macros are per 100 g, per 100 ml, or per item. Pack size uses the same
 * unit: 2000 for a 2 kg pack, 12 for a box of eggs.
 */
(function (root) {
  "use strict";

  const MACROS = ["kcal", "protein", "carbs", "fat"];
  // Meal headings, in the order the Meals tab shows them.
  const CATEGORIES = ["Breakfast", "Mains", "Bowls", "Burritos & wraps", "Pasta", "Sandwiches & pizza", "Soups & bakes",
    "Sides", "Desserts & snacks", "Shakes & drinks", "Sauces", "Other"];

  /** Meals grouped under their headings, in heading order, A–Z within each.
   *  A meal with no heading, or one this app doesn't know, goes under Other. */
  function groupMeals(meals) {
    const groups = new Map(CATEGORIES.map((c) => [c, []]));
    for (const meal of meals) {
      groups.get(CATEGORIES.includes(meal.category) ? meal.category : "Other").push(meal);
    }
    return [...groups.entries()]
      .filter(([, list]) => list.length)
      .map(([category, list]) => ({ category, meals: list.sort((a, b) => a.name.localeCompare(b.name)) }));
  }
  const UNITS = ["g", "ml", "each"];

  const zero = () => ({ kcal: 0, protein: 0, carbs: 0, fat: 0 });

  /** How many "label amounts" a quantity is: 1.6 kg of chicken is 16 lots of 100 g. */
  function labelFactor(unit, amount) {
    return unit === "each" ? amount : amount / 100;
  }

  /** The product to use for an ingredient: the named shop's, else the usual shop's,
   *  else whichever one was saved. Null when no shop has one. */
  function productFor(ingredient, shop) {
    const products = ingredient.products || {};
    return products[shop] || products[ingredient.usualShop]
      || Object.values(products)[0] || null;
  }

  /** Whole meal totals, from each ingredient's usual-shop label.
   *  `missing` names any ingredient that has no label saved, so the screen can
   *  say the total is short rather than quietly showing too few calories. */
  function mealTotals(meal, ingredientsById) {
    const total = zero();
    const missing = [];
    for (const line of meal.lines || []) {
      const ingredient = ingredientsById[line.ingredientId];
      const product = ingredient && productFor(ingredient, ingredient.usualShop);
      if (!product) {
        missing.push(ingredient ? ingredient.name : "a deleted food");
        continue;
      }
      const factor = labelFactor(ingredient.unit, Number(line.amount) || 0);
      for (const m of MACROS) total[m] += (Number(product[m]) || 0) * factor;
    }
    return { ...total, missing };
  }

  function perPortion(totals, portions) {
    const n = Number(portions) > 0 ? Number(portions) : 1;
    const out = zero();
    for (const m of MACROS) out[m] = totals[m] / n;
    return out;
  }

  /** Always round up: you cannot buy 0.8 of a pack. The small tolerance stops
   *  floating-point dust (2000.0000001 g) buying a whole extra pack. */
  function packsNeeded(need, packSize) {
    if (!(packSize > 0)) return null;
    return Math.max(0, Math.ceil(need / packSize - 1e-9));
  }

  /** The shopping list for a prep.
   *  prepItems: [{ mealId, batches }] — batches is how many times you make it.
   *  shopOverride: { ingredientId: shop } for this list only.
   *  Returns [{ shop, items: [...] }], one group per shop, in shop order. */
  function shoppingList(prepItems, mealsById, ingredientsById, shopOverride = {}, shops = []) {
    const need = new Map();
    for (const item of prepItems) {
      const meal = mealsById[item.mealId];
      const batches = Number(item.batches) || 0;
      if (!meal || batches <= 0) continue;
      for (const line of meal.lines || []) {
        if (!ingredientsById[line.ingredientId]) continue;
        const amount = (Number(line.amount) || 0) * batches;
        need.set(line.ingredientId, (need.get(line.ingredientId) || 0) + amount);
      }
    }

    const groups = new Map();
    for (const [ingredientId, amount] of need) {
      if (amount <= 0) continue;
      const ingredient = ingredientsById[ingredientId];
      const shop = shopOverride[ingredientId] || ingredient.usualShop || "Any shop";
      const product = (ingredient.products || {})[shop] || null;
      const packSize = product ? Number(product.pack) || 0 : 0;
      const packs = packsNeeded(amount, packSize);
      const item = {
        ingredientId,
        name: ingredient.name,
        unit: ingredient.unit,
        shop,
        need: amount,
        packSize: packSize || null,
        packs,
        buy: packs === null ? amount : packs * packSize,
        spare: packs === null ? 0 : packs * packSize - amount,
        noProduct: !product,
      };
      if (!groups.has(shop)) groups.set(shop, []);
      groups.get(shop).push(item);
    }

    const order = (shop) => {
      const i = shops.indexOf(shop);
      return i === -1 ? shops.length : i;
    };
    return [...groups.entries()]
      .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
      .map(([shop, items]) => ({
        shop,
        items: items.sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }

  /** Adds saved everyday items (toilet roll, milk…) to a shopping list.
   *  extras: { itemId: quantity }. savedById: { id: { name, shop } }.
   *  Every row gets a `key` so ticking works the same for both kinds. */
  function addExtras(groups, extras, savedById, shops = []) {
    const byShop = new Map(groups.map((g) => [g.shop, g.items.map((i) => ({
      ...i, kind: "ingredient", key: i.ingredientId,
    }))]));
    for (const [itemId, qty] of Object.entries(extras || {})) {
      const saved = savedById[itemId];
      if (!saved || !(qty > 0)) continue;
      const shop = saved.shop || "Any shop";
      if (!byShop.has(shop)) byShop.set(shop, []);
      byShop.get(shop).push({ kind: "extra", key: `x:${itemId}`, itemId, name: saved.name, shop, qty });
    }
    const order = (shop) => {
      const i = shops.indexOf(shop);
      return i === -1 ? shops.length : i;
    };
    return [...byShop.entries()]
      .filter(([, items]) => items.length)
      .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
      .map(([shop, items]) => ({ shop, items: items.sort((a, b) => a.name.localeCompare(b.name)) }));
  }

  /** Totals for one day of eaten portions. Each record carries the macros it had
   *  when it was logged, so editing a meal later never rewrites what you ate. */
  function dayTotals(eaten, date) {
    const total = zero();
    for (const e of eaten) {
      if (e.date !== date) continue;
      for (const m of MACROS) total[m] += (Number(e[m]) || 0);
    }
    return total;
  }

  /** "1.6 kg", "400 g", "1.5 L", "6". */
  function formatAmount(amount, unit) {
    const trim = (n) => String(Math.round(n * 100) / 100);
    if (unit === "each") return trim(amount);
    if (amount >= 1000) return `${trim(amount / 1000)} ${unit === "ml" ? "L" : "kg"}`;
    return `${Math.round(amount)} ${unit}`;
  }

  /** A pack size from a label string: "2 kg" → {2000, g}, "1.5L" → {1500, ml},
   *  "4 x 125g" → {500, g}. Null when it can't tell. */
  function parseQuantity(text) {
    if (typeof text !== "string") return null;
    const t = text.toLowerCase().replace(",", ".");
    const scale = { kg: [1000, "g"], g: [1, "g"], l: [1000, "ml"], cl: [10, "ml"], ml: [1, "ml"] };
    const multi = t.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g|ml|cl|l)\b/);
    if (multi) {
      const [f, unit] = scale[multi[3]];
      return { amount: Number(multi[1]) * Number(multi[2]) * f, unit };
    }
    const single = t.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|cl|l)\b/);
    if (!single) return null;
    const [f, unit] = scale[single[2]];
    return { amount: Number(single[1]) * f, unit };
  }

  /** Reads an Open Food Facts product into what a food needs. Everything it
   *  couldn't find is listed in `missing`, so the screen can say what to check.
   *  Returns null when the barcode isn't in the database. */
  function fromOpenFoodFacts(response) {
    if (!response || response.status !== 1 || !response.product) return null;
    const p = response.product;
    const n = p.nutriments || {};
    const value = (key) => {
      const v = Number(n[key]);
      return Number.isFinite(v) && v >= 0 ? Math.round(v * 10) / 10 : null;
    };
    let kcal = value("energy-kcal_100g");
    if (kcal === null && value("energy_100g") !== null) {
      kcal = Math.round(value("energy_100g") / 4.184); // kJ to kcal
    }
    const out = {
      name: (p.product_name_en || p.product_name || "").trim(),
      brand: (p.brands || "").split(",")[0].trim(),
      kcal,
      protein: value("proteins_100g"),
      carbs: value("carbohydrates_100g"),
      fat: value("fat_100g"),
      pack: null,
      unit: null,
    };
    const qty = Number(p.product_quantity);
    const qtyUnit = String(p.product_quantity_unit || "").toLowerCase();
    if (qty > 0 && (qtyUnit === "g" || qtyUnit === "ml")) {
      out.pack = qty;
      out.unit = qtyUnit;
    } else {
      const parsed = parseQuantity(p.quantity);
      if (parsed) { out.pack = parsed.amount; out.unit = parsed.unit; }
    }
    out.missing = ["kcal", "protein", "carbs", "fat", "pack"].filter((k) => out[k] === null);
    if (!out.name) out.missing.unshift("name");
    return out;
  }

  /** Which shop a scanned product probably came from, by its brand. */
  function guessShop(brand, shops) {
    const b = String(brand || "").toLowerCase();
    return shops.find((s) => b.includes(s.toLowerCase())) || null;
  }

  /** Adds a file of meals (and the foods they use) to what's already saved.
   *  Anything with an id that's already here is left alone, so a food you've
   *  since scanned, or a meal you've edited, keeps your version. Returns the
   *  new state and what was added; `state` itself isn't changed. */
  function mergeMeals(state, pack, skip = new Set()) {
    const fail = (msg) => { throw new Error(`Those meals can't be added: ${msg}`); };
    if (!pack || pack.app !== "meal-prep" || pack.kind !== "meals") fail("it isn't a Meal Prep meals file");
    if (pack.v !== 1) fail(`it is version ${pack.v}, and this app reads version 1`);
    if (!Array.isArray(pack.ingredients) || !Array.isArray(pack.meals)) fail("it has no meals in it");
    for (const ing of pack.ingredients) {
      if (!ing.id || typeof ing.name !== "string" || !UNITS.includes(ing.unit)) fail("a food is incomplete");
    }
    const foodIds = new Set([...state.ingredients, ...pack.ingredients].map((i) => i.id));
    for (const meal of pack.meals) {
      if (!meal.id || typeof meal.name !== "string" || !Array.isArray(meal.lines)) fail("a meal is incomplete");
      if (meal.lines.some((l) => !foodIds.has(l.ingredientId))) fail(`${meal.name} uses a food that isn't in the file`);
    }

    const haveFood = new Set(state.ingredients.map((i) => i.id));
    const haveMeal = new Set(state.meals.map((m) => m.id));
    // `skip`: ids added before and since deleted, so they don't come back.
    const newFoods = pack.ingredients.filter((i) => !haveFood.has(i.id) && !skip.has(i.id));
    const newMeals = pack.meals.filter((m) => !haveMeal.has(m.id) && !skip.has(m.id));
    const shops = [...state.shops];
    for (const s of pack.shops || []) if (!shops.includes(s)) shops.push(s);
    // Meals added before headings existed get their heading; one you've set is kept.
    const packCategory = new Map(pack.meals.map((m) => [m.id, m.category]));
    const kept = state.meals.map((m) => (!m.category && packCategory.get(m.id)
      ? { ...m, category: packCategory.get(m.id) } : m));
    return {
      state: { ...state, shops, ingredients: [...state.ingredients, ...newFoods], meals: [...kept, ...newMeals] },
      added: { foods: newFoods.length, meals: newMeals.length },
      addedIds: [...newFoods, ...newMeals].map((x) => x.id),
      filled: kept.filter((m, i) => m !== state.meals[i]).length,
      kept: { foods: pack.ingredients.length - newFoods.length, meals: pack.meals.length - newMeals.length },
    };
  }

  /** Checks a backup file before it replaces anything on the phone. */
  function validateBackup(data) {
    const fail = (msg) => { throw new Error(`That backup can't be used: ${msg}`); };
    if (!data || typeof data !== "object") fail("it isn't a Meal Prep backup");
    if (data.app !== "meal-prep") fail("it isn't a Meal Prep backup");
    if (data.kind === "meals") fail("it's a file of meals. Use \"Add meals from a file\" instead, which keeps what you have");
    if (data.v !== 1) fail(`it is version ${data.v}, and this app reads version 1`);
    for (const key of ["ingredients", "meals", "eaten"]) {
      if (!Array.isArray(data[key])) fail(`${key} is missing`);
    }
    for (const ing of data.ingredients) {
      if (!ing.id || typeof ing.name !== "string") fail("a food has no id or name");
      if (!UNITS.includes(ing.unit)) fail(`${ing.name} has an unknown unit`);
    }
    for (const meal of data.meals) {
      if (!meal.id || typeof meal.name !== "string") fail("a meal has no id or name");
      if (!Array.isArray(meal.lines)) fail(`${meal.name} has no ingredient list`);
    }
    return data;
  }

  root.MealLogic = {
    MACROS, UNITS, CATEGORIES, groupMeals, labelFactor, productFor, mealTotals, perPortion, packsNeeded,
    shoppingList, addExtras, dayTotals, formatAmount, validateBackup,
    parseQuantity, fromOpenFoodFacts, guessShop, mergeMeals,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
