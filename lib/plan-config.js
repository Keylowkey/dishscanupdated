// lib/plan-config.js — the numbers behind "Choose for Me" meal plans.
//
// Tune these here; nothing else needs to change. The app reads them from
// GET /api/meal-plan?config=1, so the minimum shown under the budget field is
// always the one the server enforces.
//
// Reference: USDA Food Plans, Cost of Food report for August 2026. The Thrifty
// Food Plan (the cheapest of the four) is $58.50–$73.60 a week for an adult
// aged 20–50, about $2.80–$3.50 per meal over 21 meals. The Low-Cost and
// Moderate plans run roughly $3.00–$4.40 per meal.
// https://www.fns.usda.gov/research/cnpp/usda-food-plans/cost-food-monthly-reports

export const PLAN_CONFIG = {
  version: 1,

  // Least we'll plan for, in USD, per person for one standard meal. Just
  // under the Thrifty Food Plan average, since that plan is itself the floor.
  minCostPerMeal: 2.75,

  // Shown as "comfortable" under the budget field. Low-Cost to Liberal plans.
  comfortableCostPerMeal: [3.5, 6.0],

  // A breakfast or a snack costs less than a dinner. The three main meals
  // average to 1.0, so "3 meals a day" means 3 × the per-meal figure.
  mealWeights: { breakfast: 0.8, lunch: 1.0, dinner: 1.2, snack: 0.4 },

  // Plan lengths in days. Monthly is four weeks, generated a week at a time.
  periods: { daily: 1, weekly: 7, monthly: 28 },

  maxHousehold: 12,
  maxBudget: 20000,
  referenceNote: 'USDA Thrifty Food Plan, Aug 2026: $58.50–$73.60 a week per adult'
};

export const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];

// Weighted meals per person per day for the chosen slots.
function slotWeight(meals, cfg = PLAN_CONFIG) {
  return (Array.isArray(meals) ? meals : [])
    .filter(m => cfg.mealWeights[m] != null)
    .reduce((s, m) => s + cfg.mealWeights[m], 0);
}

/** The least a plan can cost, rounded up to the next whole dollar. */
export function minimumBudget({ period, household, meals }, cfg = PLAN_CONFIG) {
  const days = cfg.periods[period] || 0;
  const people = Math.max(1, Math.min(cfg.maxHousehold, parseInt(household, 10) || 1));
  return Math.ceil(days * people * slotWeight(meals, cfg) * cfg.minCostPerMeal);
}

/** The comfortable range, rounded to the nearest $5. */
export function comfortableRange({ period, household, meals }, cfg = PLAN_CONFIG) {
  const days = cfg.periods[period] || 0;
  const people = Math.max(1, Math.min(cfg.maxHousehold, parseInt(household, 10) || 1));
  const base = days * people * slotWeight(meals, cfg);
  const r5 = (n) => Math.max(5, Math.round(n / 5) * 5);
  return [r5(base * cfg.comfortableCostPerMeal[0]), r5(base * cfg.comfortableCostPerMeal[1])];
}

/**
 * Validate a plan request. Returns { ok: true } or { ok: false, error, minimum }.
 * The same rules run in the app before anything is sent.
 */
export function validatePlanRequest(prefs, cfg = PLAN_CONFIG) {
  const p = prefs || {};
  if (!cfg.periods[p.period]) return { ok: false, error: 'Choose a plan length.' };
  const people = parseInt(p.household, 10);
  if (!(people >= 1 && people <= cfg.maxHousehold)) return { ok: false, error: 'Choose how many people to plan for.' };
  if (!slotWeight(p.meals, cfg)) return { ok: false, error: 'Choose at least one meal a day.' };
  const budget = Number(p.budget);
  if (!(budget > 0) || budget > cfg.maxBudget) return { ok: false, error: 'Enter your budget.' };
  const minimum = minimumBudget(p, cfg);
  if (budget < minimum) {
    return { ok: false, minimum, error: `This plan needs a budget of at least $${minimum}.` };
  }
  return { ok: true, minimum };
}
