// /api/meal-plan.js — "Choose for Me" meal plans.
//
// GET  ?config=1                       → PLAN_CONFIG (budget rules for the app)
// POST { action: 'week',  prefs, startDay, dayCount, dayLabels, locked, avoid }
//                                      → { days: [{ day, meals: [Meal] }] }
// POST { action: 'swap',  prefs, day, slot, dayMeals, avoid }  → { meal: Meal }
// POST { action: 'prefs_get' }         → { prefs }     (signed in)
// POST { action: 'prefs_save', prefs } → { ok: true }  (signed in)
//
// A week is made in two steps so it fits in one request and still shares
// ingredients across days: first an outline (every dish name for the week,
// plus the staples worth buying once), then every meal's card and priced
// ingredients at the same time, each told the staples to reuse. A meal's
// cost is the sum of its ingredient prices. Monthly plans are four week
// requests. The budget is re-checked here, not just in the app.
//
// Meal = { slot, name, description, prepMinutes, difficulty, calories,
//          protein_g, carbs_g, fat_g, cost, ingredients: [Ingredient] }
// Ingredient = { key, name, qty, unit, section, cost } for the whole household.

import { guard } from '../lib/guard.js';
import { verifyToken } from '../lib/auth.js';
import { languageInstruction } from '../lib/i18n-data.js';
import { PLAN_CONFIG, MEAL_SLOTS, validatePlanRequest } from '../lib/plan-config.js';

const MODEL = 'claude-sonnet-4-5';
const SECTIONS = ['produce', 'meat-seafood', 'dairy-eggs', 'bakery', 'pantry', 'spices', 'frozen', 'beverages', 'other'];

// Kept in step with ALLERGENS in index.html: anything matching is rejected.
// `not` lists look-alikes that are safe for that allergy (coconut milk is
// not dairy, eggplant is not egg), removed before matching.
const ALLERGEN_WORDS = {
  nuts: { has: ['almond', 'walnut', 'pecan', 'cashew', 'pistachio', 'hazelnut', 'macadamia', 'peanut', 'pine nut',
                'nut butter', 'praline', 'marzipan', 'nutella', 'chestnut', ' nut ', ' nuts '],
          not: ['butternut', 'coconut', 'nutmeg', 'nut-free', 'peanut-free', 'water chestnut', 'doughnut', 'donut'] },
  dairy: { has: ['milk', 'butter', 'cheese', 'cream', 'yogurt', 'yoghurt', 'ghee', 'custard', 'whey', 'casein',
                 'paneer', 'ricotta', 'mozzarella', 'parmesan', 'cheddar', 'feta', 'mascarpone'],
           not: ['coconut milk', 'coconut cream', 'almond milk', 'oat milk', 'soy milk', 'rice milk', 'cashew milk',
                 'peanut butter', 'almond butter', 'nut butter', 'sunflower butter', 'seed butter', 'cocoa butter',
                 'apple butter', 'butternut', 'butter bean', 'cream of tartar', 'dairy-free', 'dairy free', 'vegan'] },
  eggs: { has: ['egg', 'mayonnaise', 'mayo', 'meringue', 'aioli', 'albumin', 'custard'],
          not: ['eggplant', 'egg-free', 'egg free', 'vegan mayo'] },
  gluten: { has: ['flour', 'wheat', 'bread', 'pasta', 'noodle', 'barley', 'rye', 'breadcrumb', 'panko', 'cracker',
                  'crouton', 'tortilla', 'pita', 'soy sauce', 'seitan', 'semolina', 'couscous', 'farro', 'bulgur',
                  'biscuit', 'dough', 'naan'],
            not: ['gluten-free', 'gluten free', 'rice flour', 'almond flour', 'coconut flour', 'oat flour', 'corn tortilla',
                  'rice noodle', 'rice paper', 'buckwheat', 'chickpea flour', 'cassava flour', 'tapioca flour',
                  'cornflour', 'corn flour', 'potato flour'] },
  shellfish: { has: ['shrimp', 'prawn', 'crab', 'lobster', 'clam', 'mussel', 'oyster', 'scallop', 'crawfish', 'crayfish',
                     'squid', 'calamari', 'octopus', 'shellfish'],
               not: ['oyster mushroom', 'imitation crab-free'] },
  soy: { has: ['soy', 'soya', 'tofu', 'edamame', 'tempeh', 'miso', 'tamari'],
         not: ['soy-free', 'soy free'] }
};

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const list = (v, max, n) => (Array.isArray(v) ? v : []).map(x => clip(x, n).trim()).filter(Boolean).slice(0, max);

function cleanPrefs(p) {
  p = p || {};
  return {
    period: PLAN_CONFIG.periods[p.period] ? p.period : 'weekly',
    goal: clip(p.goal, 40),
    household: Math.max(1, Math.min(PLAN_CONFIG.maxHousehold, parseInt(p.household, 10) || 1)),
    meals: list(p.meals, 4, 12).filter(m => MEAL_SLOTS.includes(m)),
    diets: list(p.diets, 8, 20),
    allergies: list(p.allergies, 6, 12).filter(a => ALLERGEN_WORDS[a]),
    time: clip(p.time, 20),
    skill: clip(p.skill, 20),
    cuisines: list(p.cuisines, 12, 30),
    avoid: list(p.avoid, 20, 40),
    budget: Math.max(0, Math.min(PLAN_CONFIG.maxBudget, Number(p.budget) || 0))
  };
}

const GOALS = {
  'weight-loss': 'losing weight: filling, high-protein, high-fibre meals in a moderate calorie deficit (about 1,500–1,800 kcal a day for an adult)',
  'muscle-gain': 'building muscle: high protein (about 30–45 g per main meal) with enough calories to support training',
  'maintenance': 'maintaining weight: balanced meals around 2,000–2,300 kcal a day for an adult',
  'eat-healthier': 'eating healthier: whole foods, vegetables at most meals, less processed food and added sugar',
  'save-money': 'saving money: inexpensive staples, batch-friendly dishes, leftovers turned into new meals',
  'family-friendly': 'family-friendly meals: familiar flavours children enjoy, not too spicy, easy to share'
};
const DIETS = {
  vegetarian: 'vegetarian (no meat, poultry or fish)',
  vegan: 'vegan (no animal products at all, including dairy, eggs and honey)',
  halal: 'halal (no pork or pork products, no alcohol, halal meat only)',
  keto: 'keto (very low carb: no bread, pasta, rice, potatoes, sugar or most fruit)',
  'gluten-free': 'gluten-free (no wheat, barley, rye or regular pasta/bread)',
  'dairy-free': 'dairy-free (no milk, cheese, butter, cream or yogurt)'
};
const TIMES = { quick: 'quick meals: under 20 minutes total', balanced: 'most meals under 45 minutes', any: 'any cooking time' };

function brief(p) {
  const lines = [];
  lines.push(`Household: ${p.household} ${p.household === 1 ? 'person' : 'people'}. Every quantity and cost is for the whole household.`);
  if (GOALS[p.goal]) lines.push(`Goal: ${GOALS[p.goal]}.`);
  const d = p.diets.map(x => DIETS[x]).filter(Boolean);
  if (d.length) lines.push(`Diet — follow strictly: ${d.join('; ')}.`);
  if (p.allergies.length) lines.push(`ALLERGIES — never use any ingredient containing: ${p.allergies.join(', ')}. This is a safety requirement.`);
  if (p.avoid.length) lines.push(`Never use these ingredients: ${p.avoid.join(', ')}.`);
  if (TIMES[p.time]) lines.push(`Cooking time: ${TIMES[p.time]}.`);
  if (p.skill) lines.push(`Cooking skill: ${p.skill}.`);
  if (p.cuisines.length) lines.push(`Favourite cuisines (lean towards these, with variety): ${p.cuisines.join(', ')}.`);
  return lines.join('\n');
}

// Per-meal targets. The AI is told what each meal may cost and how many
// calories it should have, then prices each ingredient; a meal's cost is
// always the sum of those prices, never a number the AI picked to look right.
const KCAL_PER_DAY = { 'weight-loss': 1650, 'muscle-gain': 2600, 'maintenance': 2200, 'eat-healthier': 2000, 'save-money': 2100, 'family-friendly': 2000 };
function mealTargets(p) {
  const w = PLAN_CONFIG.mealWeights;
  const daily = KCAL_PER_DAY[p.goal] || 2100;
  // Calories are a share of a whole day, so planning only dinner still
  // gives a dinner-sized dinner. Money is spread over the meals planned.
  const kcalBase = (w.breakfast + w.lunch + w.dinner) + (p.meals.includes('snack') ? w.snack : 0);
  const costBase = p.meals.reduce((s, m) => s + w[m], 0) || 1;
  const perDay = p.budget / PLAN_CONFIG.periods[p.period];
  const t = {};
  p.meals.forEach(m => {
    t[m] = { kcal: Math.round(daily * w[m] / kcalBase / 10) * 10, cost: Math.round(perDay * w[m] / costBase * 100) / 100 };
  });
  return { perDay, slots: t };
}

async function ask(key, prompt, maxTokens, temperature) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content: prompt }] })
    });
    // Busy or rate-limited: one short wait, then give up (the app retries too).
    if ((r.status === 429 || r.status === 529 || r.status >= 500) && attempt < 1) {
      await new Promise(res => setTimeout(res, 1500));
      continue;
    }
    if (!r.ok) throw new Error('AI ' + r.status + ': ' + (await r.text()).slice(0, 160));
    const data = await r.json();
    let text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    text = text.replace(/```json|```/g, '').trim();
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a === -1 || b === -1) throw new Error('No JSON in AI response');
    return JSON.parse(text.slice(a, b + 1));
  }
}

// One spelling per grocery item, so "tomatoes" and "tomato" are one line.
// Keys are only for matching; the shopper sees the ingredient's name.
function singular(w) {
  if (w.length <= 3 || /(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (/(ch|sh|x|zz|o)es$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}
function canonKey(k) {
  const words = String(k || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  words[words.length - 1] = singular(words[words.length - 1]);
  return words.join(' ').slice(0, 40);
}

// Coerce one meal into the shape the app relies on.
function cleanMeal(m, slot, household, kcalTarget) {
  m = m || {};
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : d);
  const ings = (Array.isArray(m.ingredients) ? m.ingredients : []).slice(0, 18).map(i => {
    i = i || {};
    const name = clip(i.name, 60).trim();
    return {
      key: canonKey(i.key || name) || canonKey(name),
      name,
      qty: num(i.qty, 1),
      unit: clip(i.unit, 16).toLowerCase().trim(),
      section: SECTIONS.includes(i.section) ? i.section : 'other',
      cost: Math.round(num(i.cost) * 100) / 100,
      kcal: num(i.kcal), p: num(i.p), c: num(i.c), f: num(i.f)
    };
  }).filter(i => i.name);
  // Nutrition per serving is added up from the ingredients when they carry
  // it (new meals always do); otherwise the meal's own figures stand.
  const people = Math.max(1, household || 1);
  const sum = k => ings.reduce((s, i) => s + i[k], 0);
  const fromIngs = sum('kcal') > 0;
  // Portions the AI sized well off target (a whole can of beans for one)
  // are scaled to it: amounts, prices and nutrition together, so the meal
  // stays consistent and the grocery list buys what's actually cooked.
  if (fromIngs && kcalTarget) {
    const ratio = kcalTarget / (sum('kcal') / people);
    if (ratio < 0.8 || ratio > 1.25) {
      const f = Math.max(0.5, Math.min(1.6, ratio));
      ings.forEach(i => {
        i.qty = Math.round(i.qty * f * 100) / 100;
        i.cost = Math.round(i.cost * f * 100) / 100;
        ['kcal', 'p', 'c', 'f'].forEach(k => { i[k] *= f; });
      });
    }
  }
  const per = (k, own) => Math.round(fromIngs ? sum(k) / people : num(own));
  const nutrition = { calories: per('kcal', m.calories), protein_g: per('p', m.protein_g), carbs_g: per('c', m.carbs_g), fat_g: per('f', m.fat_g) };
  ings.forEach(i => { delete i.kcal; delete i.p; delete i.c; delete i.f; });
  return {
    slot: MEAL_SLOTS.includes(m.slot) ? m.slot : slot,
    name: clip(m.name, 80).trim() || 'Meal',
    description: clip(m.description, 160).trim(),
    prepMinutes: Math.round(num(m.prepMinutes, 30)),
    difficulty: clip(m.difficulty, 16),
    ...nutrition,
    cost: Math.round(ings.reduce((s, i) => s + i.cost, 0) * 100) / 100,
    ingredients: ings
  };
}

// Does this meal break an allergy? Checks ingredients, which is where an
// allergen actually is (a dish name can mislead either way).
function allergyHit(meal, allergies) {
  for (const a of allergies) {
    const rule = ALLERGEN_WORDS[a];
    for (const ing of meal.ingredients) {
      let text = ' ' + (ing.name + ' ' + ing.key).toLowerCase().replace(/[^a-z\- ]+/g, ' ') + ' ';
      // "gluten-free pasta", "dairy-free cheese": labelled safe for this one.
      if (new RegExp('\\b(' + a + '|' + a.replace(/s$/, '') + ')[- ]free\\b').test(text)) continue;
      rule.not.forEach(x => { text = text.split(x).join(' '); });
      if (rule.has.some(w => text.includes(w))) return a;
    }
  }
  return null;
}

const MEAL_SHAPE = `{"slot":"dinner","name":"Dish name","description":"One appetising line.","prepMinutes":30,"difficulty":"Easy","ingredients":[{"key":"chicken thigh","name":"Boneless chicken thighs","qty":1.5,"unit":"lb","section":"meat-seafood","cost":5.25,"kcal":1430,"p":136,"c":0,"f":95}]}`;

const MEAL_RULES = `Rules:
- ingredients: 4-12 items with quantities for the WHOLE household. "key" is the plain singular grocery item in lower case ("onion", "chicken thigh", "olive oil") so the same item matches across meals. unit is one of: each, lb, oz, g, kg, cup, tbsp, tsp, ml, l, clove, can, bunch, slice, pinch. section is one of: ${SECTIONS.join(', ')}.
- cost of each ingredient: a realistic average US supermarket price for the amount used (a share of the pack for oils, spices and staples), in USD. Every ingredient has its own cost, including staples used in other meals too; nothing is free.
- kcal, p, c, f of each ingredient: calories and grams of protein, carbs and fat in the amount listed (for the whole household), from standard nutrition data. Choose amounts so a serving lands near the calorie target.
- Skip water, and assume salt and pepper are already at home.`;

function targetLine(p, t, slot) {
  const x = t.slots[slot];
  return `Targets for this ${slot}: ${Math.round(x.kcal * 0.9)}–${Math.round(x.kcal * 1.1)} kcal per serving, and ingredients for all ${p.household} costing about $${(x.cost * 0.9).toFixed(2)} in total (never more than $${x.cost.toFixed(2)}).
Amounts are for exactly ${p.household} serving${p.household === 1 ? '' : 's'}: size each portion to the calorie range, and use part of a pack when a whole one is too much (0.5 can, 0.25 lb).`;
}

// Step 1: every dish name for the period, plus staples to buy once.
async function outlineWeek(key, p, t, labels, locked, avoid, lang) {
  const lockedText = locked.length
    ? '\nThese meals are already chosen and stay as they are (plan the others around them):\n' +
      locked.map(l => `- day ${l.day} ${l.slot}: ${l.name}`).join('\n')
    : '';
  const prompt = `You are a meal planner for a home-cooking app. Plan ${labels.length} day(s): ${labels.map((l, i) => `day ${i} = ${l}`).join(', ')}.
Meals each day: ${p.meals.join(', ')}.

${brief(p)}
Budget: $${t.perDay.toFixed(2)} a day for the whole household (${p.meals.map(m => `about $${t.slots[m].cost.toFixed(2)} per ${m}`).join(', ')}), so pick dishes that can really be made for that at US supermarket prices.
Calories per person: ${p.meals.map(m => `about ${t.slots[m].kcal} per ${m}`).join(', ')}.
${lockedText}
${avoid.length ? '\nDo not repeat these dishes, already used elsewhere in the plan: ' + avoid.slice(0, 60).join('; ') + '.' : ''}

Make the days varied but practical: reuse ingredients across the plan where it makes sense (a roast chicken becomes tomorrow's lunch, one bag of spinach covers three meals) so less is wasted and the budget goes further. No dish twice.

Respond ONLY with JSON, no markdown. Dish names only:
{"staples":["ingredients bought once and used in several meals"],"days":[{"day":0,"meals":{"breakfast":"Dish name","dinner":"Dish name"}}]}` + languageInstruction(lang);
  return ask(key, prompt, 1600, 0.8);
}

// Step 2: one meal's card and ingredients. Run for every meal at once.
async function detailMeal(key, p, t, label, slot, name, staples, lang) {
  const prompt = `You are a chef and grocery-cost estimator for a home-cooking app. Write the meal card for this ${slot} on ${label}: "${name}". Keep the dish name.

${brief(p)}
${targetLine(p, t, slot)}
Staples bought for the whole plan; use them where they fit: ${staples.slice(0, 25).join(', ') || 'none'}.

${MEAL_RULES}

Respond ONLY with JSON, no markdown: ${MEAL_SHAPE.replace('"dinner"', '"' + slot + '"')}` + languageInstruction(lang);
  return cleanMeal(await ask(key, prompt, 1800, 0.3), slot, p.household, t.slots[slot].kcal);
}

// A new dish for one slot (swaps, and replacing one that broke an allergy).
async function oneMeal(key, p, t, label, slot, dayMeals, avoid, lang) {
  const prompt = `You are a chef and grocery-cost estimator for a home-cooking app. Suggest ONE new ${slot} for ${label}.

${brief(p)}
${targetLine(p, t, slot)}
Other meals that day: ${dayMeals.join('; ') || 'none'}.
Must be different from: ${avoid.slice(0, 80).join('; ') || 'nothing'}.

${MEAL_RULES}

Respond ONLY with JSON, no markdown: ${MEAL_SHAPE.replace('"dinner"', '"' + slot + '"')}` + languageInstruction(lang);
  return cleanMeal(await ask(key, prompt, 1800, 0.9), slot, p.household, t.slots[slot].kcal);
}

async function savePrefs(uid, prefs) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/user_profiles?id=eq.${encodeURIComponent(uid)}`, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal'
    },
    body: JSON.stringify({ meal_prefs: prefs })
  });
  return r.ok;
}
async function loadPrefs(uid) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/user_profiles?select=meal_prefs&id=eq.${encodeURIComponent(uid)}`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
  });
  const rows = r.ok ? await r.json() : [];
  return (rows[0] && rows[0].meal_prefs) || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return res.status(200).json({ config: PLAN_CONFIG });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const action = body.action;
  const lang = body.lang;

  // Saved questionnaire answers live on the profile (service key: the column
  // has no client grant, like the calorie goal).
  if (action === 'prefs_get' || action === 'prefs_save') {
    const token = body.access_token || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const uid = token ? await verifyToken(token) : null;
    if (!uid) return res.status(401).json({ error: 'Please sign in.' });
    try {
      if (action === 'prefs_get') return res.status(200).json({ prefs: await loadPrefs(uid) });
      const ok = await savePrefs(uid, cleanPrefs(body.prefs));
      return ok ? res.status(200).json({ ok: true }) : res.status(502).json({ error: 'Could not save your answers.' });
    } catch (e) {
      return res.status(500).json({ error: 'Server error' });
    }
  }

  if (action !== 'week' && action !== 'swap') return res.status(400).json({ error: 'Unknown action' });

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'Server not configured' });

  const prefs = cleanPrefs(body.prefs);
  const check = validatePlanRequest(prefs);
  if (!check.ok) return res.status(400).json({ error: check.error, minimum: check.minimum });

  // A month is four week requests; swaps are one each.
  const me = await guard(req, res, { bucket: 'meal-plan', max: 60 });
  if (!me) return;

  const avoid = list(body.avoid, 120, 80);

  try {
    const t = mealTargets(prefs);
    if (action === 'swap') {
      const slot = prefs.meals.includes(body.slot) ? body.slot : prefs.meals[0];
      const label = clip(body.dayLabel, 30) || 'that day';
      const dayMeals = list(body.dayMeals, 6, 80);
      let meal = await oneMeal(KEY, prefs, t, label, slot, dayMeals, avoid, lang);
      if (allergyHit(meal, prefs.allergies)) meal = await oneMeal(KEY, prefs, t, label, slot, dayMeals, avoid.concat(meal.name), lang);
      if (allergyHit(meal, prefs.allergies)) return res.status(502).json({ error: 'Could not find a safe swap. Try again.' });
      return res.status(200).json({ meal });
    }

    // ── A week (or a day) ──
    const dayCount = Math.max(1, Math.min(7, parseInt(body.dayCount, 10) || 1));
    const labels = (Array.isArray(body.dayLabels) ? body.dayLabels : []).slice(0, dayCount).map(l => clip(l, 30));
    while (labels.length < dayCount) labels.push('Day ' + (labels.length + 1));
    const locked = (Array.isArray(body.locked) ? body.locked : [])
      .filter(l => l && l.meal && Number.isInteger(l.day) && l.day >= 0 && l.day < dayCount && MEAL_SLOTS.includes(l.slot))
      .slice(0, 28)
      .map(l => ({ day: l.day, slot: l.slot, name: clip(l.meal.name, 80), meal: cleanMeal(l.meal, l.slot, prefs.household) }));

    const outline = await outlineWeek(KEY, prefs, t, labels, locked, avoid, lang);
    const staples = list(outline.staples, 30, 40);
    const used = new Set(avoid.map(n => n.toLowerCase()));

    // Every meal of the week is written at the same time. One that fails or
    // slips an allergen in comes back empty; the app offers "Find a meal".
    const days = await Promise.all(labels.map(async (label, d) => {
      const od = (outline.days || []).find(x => x && x.day === d) || (outline.days || [])[d] || {};
      const named = od.meals || {};
      const meals = await Promise.all(prefs.meals.map(async slot => {
        const lockedMeal = locked.find(l => l.day === d && l.slot === slot);
        if (lockedMeal) return lockedMeal.meal;
        const raw = Array.isArray(named) ? (named.find(x => x && x.slot === slot) || {}).name : named[slot];
        const name = clip(raw, 80).trim();
        try {
          let m = name
            ? await detailMeal(KEY, prefs, t, label, slot, name, staples, lang)
            : await oneMeal(KEY, prefs, t, label, slot, [], [...used], lang);
          if (allergyHit(m, prefs.allergies)) m = await oneMeal(KEY, prefs, t, label, slot, [], [...used, m.name], lang);
          return allergyHit(m, prefs.allergies) ? null : m;
        } catch (e) {
          console.warn('meal-plan meal failed:', slot, label, e.message);
          return null;
        }
      }));
      return { day: d, meals: meals.filter(Boolean) };
    }));
    if (!days.some(d => d.meals.length)) throw new Error('every meal failed');

    return res.status(200).json({ days, staples });
  } catch (e) {
    console.error('meal-plan error:', e);
    return res.status(502).json({ error: 'Could not build your plan. Please try again.' });
  }
}
