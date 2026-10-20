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
// plus the staples worth buying once), then each day's full details in
// parallel, each told the week's staples to reuse. Monthly plans are four
// week requests. The budget is re-checked here, not just in the app.
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

function brief(p, costs) {
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
  if (costs) lines.push(`Budget: about $${costs.perDay.toFixed(2)} a day for the household. Aim for roughly ` +
    Object.entries(costs.perSlot).map(([s, c]) => `$${c.toFixed(2)} per ${s}`).join(', ') +
    `. Use realistic US grocery prices.`);
  return lines.join('\n');
}

function budgetShares(p, dayCount) {
  const totalDays = PLAN_CONFIG.periods[p.period];
  const weights = PLAN_CONFIG.mealWeights;
  const wsum = p.meals.reduce((s, m) => s + weights[m], 0) || 1;
  const perDay = p.budget / totalDays;
  const perSlot = {};
  p.meals.forEach(m => { perSlot[m] = perDay * weights[m] / wsum; });
  return { perDay, perSlot, week: perDay * dayCount };
}

async function ask(key, prompt, maxTokens, temperature) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) throw new Error('AI ' + r.status + ': ' + (await r.text()).slice(0, 160));
  const data = await r.json();
  let text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  text = text.replace(/```json|```/g, '').trim();
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('No JSON in AI response');
  return JSON.parse(text.slice(a, b + 1));
}

// Coerce one meal into the shape the app relies on.
function cleanMeal(m, slot) {
  m = m || {};
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : d);
  const ings = (Array.isArray(m.ingredients) ? m.ingredients : []).slice(0, 18).map(i => {
    i = i || {};
    const name = clip(i.name, 60).trim();
    return {
      key: clip(i.key || name, 40).toLowerCase().trim() || name.toLowerCase(),
      name,
      qty: num(i.qty, 1),
      unit: clip(i.unit, 16).toLowerCase().trim(),
      section: SECTIONS.includes(i.section) ? i.section : 'other',
      cost: Math.round(num(i.cost) * 100) / 100
    };
  }).filter(i => i.name);
  return {
    slot: MEAL_SLOTS.includes(m.slot) ? m.slot : slot,
    name: clip(m.name, 80).trim() || 'Meal',
    description: clip(m.description, 160).trim(),
    prepMinutes: Math.round(num(m.prepMinutes, 30)),
    difficulty: clip(m.difficulty, 16),
    calories: Math.round(num(m.calories)),
    protein_g: Math.round(num(m.protein_g)),
    carbs_g: Math.round(num(m.carbs_g)),
    fat_g: Math.round(num(m.fat_g)),
    cost: Math.round(num(m.cost, ings.reduce((s, i) => s + i.cost, 0)) * 100) / 100,
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

const MEAL_SHAPE = `{"slot":"dinner","name":"Dish name","description":"One appetising line.","prepMinutes":30,"difficulty":"Easy","calories":550,"protein_g":35,"carbs_g":50,"fat_g":18,"cost":9.40,"ingredients":[{"key":"chicken thigh","name":"Boneless chicken thighs","qty":1.5,"unit":"lb","section":"meat-seafood","cost":5.25}]}`;

const MEAL_RULES = `Rules for each meal:
- calories, protein_g, carbs_g, fat_g are PER SERVING (one person).
- cost is the estimated grocery cost of the ingredients used, for the WHOLE household, in USD.
- ingredients: 4-12 items with quantities for the WHOLE household. "key" is the plain singular grocery item in lower case ("onion", "chicken thigh", "olive oil") so the same item matches across meals. unit is one of: each, lb, oz, g, kg, cup, tbsp, tsp, ml, l, clove, can, bunch, slice, pinch. section is one of: ${SECTIONS.join(', ')}. cost is the cost of the amount used.
- Skip water, and assume salt and pepper are already at home.`;

async function outlineWeek(key, p, costs, labels, locked, avoid, lang) {
  const lockedText = locked.length
    ? '\nThese meals are already chosen and must stay exactly as they are (plan the others around them):\n' +
      locked.map(l => `- day ${l.day} ${l.slot}: ${l.name}`).join('\n')
    : '';
  const prompt = `You are a meal planner for a home-cooking app. Plan ${labels.length} day(s): ${labels.map((l, i) => `day ${i} = ${l}`).join(', ')}.
Meals each day: ${p.meals.join(', ')}.

${brief(p, costs)}
${lockedText}
${avoid.length ? '\nDo not repeat these dishes, already used elsewhere in the plan: ' + avoid.slice(0, 60).join('; ') + '.' : ''}

Make the days varied but practical: reuse ingredients across the plan where it makes sense (a roast chicken becomes tomorrow's lunch, one bag of spinach covers three meals) so less is wasted and the budget goes further. No dish twice.

Respond ONLY with JSON, no markdown:
{"staples":["key ingredients bought once and reused across several meals"],"days":[{"day":0,"meals":[{"slot":"breakfast","name":"Dish name","description":"One appetising line."}]}]}` + languageInstruction(lang);
  return ask(key, prompt, 2500, 0.8);
}

async function detailDay(key, p, costs, label, dayPlan, staples, lang) {
  const prompt = `You are a chef and grocery-cost estimator for a home-cooking app. Write the details for ${label}'s meals.

${brief(p, costs)}

Meals to detail (keep each name):
${dayPlan.map(m => `- ${m.slot}: ${m.name} — ${m.description || ''}`).join('\n')}

Staples bought for the whole plan — use the same ones where they fit: ${staples.slice(0, 25).join(', ') || 'none'}.

${MEAL_RULES}

Respond ONLY with JSON, no markdown: {"meals":[${MEAL_SHAPE}]}` + languageInstruction(lang);
  const out = await ask(key, prompt, 3200, 0.3);
  const bySlot = {};
  (out.meals || []).forEach(m => { if (m && m.slot) bySlot[m.slot] = m; });
  return dayPlan.map((m, i) => cleanMeal(bySlot[m.slot] || (out.meals || [])[i] || { name: m.name }, m.slot));
}

async function oneMeal(key, p, costs, label, slot, dayMeals, avoid, lang) {
  const prompt = `You are a chef and grocery-cost estimator for a home-cooking app. Suggest ONE new ${slot} for ${label}.

${brief(p, costs)}

Other meals that day: ${dayMeals.join('; ') || 'none'}.
Must be different from: ${avoid.slice(0, 80).join('; ') || 'nothing'}.

${MEAL_RULES}

Respond ONLY with JSON, no markdown: ${MEAL_SHAPE.replace('"dinner"', '"' + slot + '"')}` + languageInstruction(lang);
  return cleanMeal(await ask(key, prompt, 1500, 0.9), slot);
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
    if (action === 'swap') {
      const slot = MEAL_SLOTS.includes(body.slot) ? body.slot : 'dinner';
      const label = clip(body.dayLabel, 30) || 'that day';
      const costs = budgetShares(prefs, 1);
      let meal = await oneMeal(KEY, prefs, costs, label, slot, list(body.dayMeals, 6, 80), avoid, lang);
      if (allergyHit(meal, prefs.allergies)) meal = await oneMeal(KEY, prefs, costs, label, slot, list(body.dayMeals, 6, 80), avoid.concat(meal.name), lang);
      if (allergyHit(meal, prefs.allergies)) return res.status(502).json({ error: 'Could not find a safe swap. Try again.' });
      return res.status(200).json({ meal });
    }

    // ── A week (or a day) ──
    const dayCount = Math.max(1, Math.min(7, parseInt(body.dayCount, 10) || 1));
    const labels = (Array.isArray(body.dayLabels) ? body.dayLabels : []).slice(0, dayCount).map(l => clip(l, 30));
    while (labels.length < dayCount) labels.push('Day ' + (labels.length + 1));
    const costs = budgetShares(prefs, dayCount);
    const locked = (Array.isArray(body.locked) ? body.locked : [])
      .filter(l => l && l.meal && Number.isInteger(l.day) && l.day >= 0 && l.day < dayCount && MEAL_SLOTS.includes(l.slot))
      .slice(0, 28)
      .map(l => ({ day: l.day, slot: l.slot, name: clip(l.meal.name, 80), meal: cleanMeal(l.meal, l.slot) }));

    const outline = await outlineWeek(KEY, prefs, costs, labels, locked, avoid, lang);
    const staples = list(outline.staples, 30, 40);

    const days = await Promise.all(labels.map(async (label, d) => {
      const planned = ((outline.days || []).find(x => x && x.day === d) || (outline.days || [])[d] || {}).meals || [];
      const lockedHere = locked.filter(l => l.day === d);
      const want = prefs.meals.map(slot => {
        if (lockedHere.find(l => l.slot === slot)) return null;
        const m = planned.find(x => x && x.slot === slot) || {};
        return { slot, name: clip(m.name, 80) || `${slot} for ${label}`, description: clip(m.description, 160) };
      }).filter(Boolean);

      let detailed = want.length ? await detailDay(KEY, prefs, costs, label, want, staples, lang) : [];
      // A dish that slips an allergen in gets replaced, never shipped.
      detailed = await Promise.all(detailed.map(async m => {
        if (!allergyHit(m, prefs.allergies)) return m;
        const fresh = await oneMeal(KEY, prefs, costs, label, m.slot, [], avoid.concat(m.name), lang);
        return allergyHit(fresh, prefs.allergies) ? null : fresh;
      }));

      const meals = prefs.meals.map(slot =>
        (lockedHere.find(l => l.slot === slot) || {}).meal || detailed.find(m => m && m.slot === slot) || null
      ).filter(Boolean);
      return { day: d, meals };
    }));

    return res.status(200).json({ days, staples });
  } catch (e) {
    console.error('meal-plan error:', e);
    return res.status(502).json({ error: 'Could not build your plan. Please try again.' });
  }
}
