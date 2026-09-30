// lib/recipe-extras.js — fields every generated recipe carries beyond the
// original schema, shared so the photo, search and import endpoints can't
// drift apart.
//
//   ingredients[].makeable   true only when a home cook can realistically make
//                            that ingredient themselves. Drives the "Make"
//                            button, which used to appear on everything,
//                            including chicken and apples.
//
//   cookingEquipment         the main heating appliance plus alternatives the
//                            user can switch to. "compromise" alternatives get
//                            a warning that the dish won't turn out the same.

// Dropped into each prompt's example JSON so the model sees the shape.
export const MAKEABLE_EXAMPLE = '"makeable":false';
export const COOKING_EQUIPMENT_EXAMPLE =
  '"cookingEquipment":{"primary":"Cast-iron skillet","emoji":"🍳","alternatives":' +
  '[{"name":"Air fryer","emoji":"🌀","fit":"compromise","note":"Cooks it through evenly but won\'t build the same seared crust."}]}';

export const EXTRA_RULES = `
- makeable: true ONLY when a home cook could realistically make this ingredient from simpler ingredients in an ordinary kitchen. Examples that are makeable: butter, ghee, cheeses such as ricotta, paneer, mozzarella or cream cheese, yogurt, sauces, dressings, mayonnaise, aioli, pesto, salsa, hummus, stock or broth, dough, fresh pasta, bread, tortillas, breadcrumbs, spice blends and rubs, marinades, jam, syrups, nut butters, plant milks, whipped cream, buttermilk. Set false for any raw or basic product: meat, poultry, seafood, eggs, fruit, vegetables, fresh herbs, grains, rice, flour, sugar, salt, single spices, oils, vinegar, water, milk, cream. When unsure, use false.
- cookingEquipment.primary: the ONE main heating appliance this recipe is built around, such as a skillet, oven, grill, air fryer, slow cooker, pressure cooker, wok, stockpot or deep fryer. It must also appear in the equipment list.
- cookingEquipment.alternatives: 0 to 3 other heating appliances a home cook could reasonably use instead. Consider the appliances people commonly own, especially an air fryer, oven, grill, stovetop pan, slow cooker and pressure cooker, and include any that would genuinely work, even as a compromise. fit is "good" when the result is essentially the same, and "compromise" when it works but texture, flavour or doneness noticeably differs. note is one short sentence to the cook explaining that difference. Use an empty array when there is no sensible substitute, such as a no-cook dish.`;

// Coerce whatever the model returned into the shape the app relies on.
// Anything malformed is dropped rather than passed through half-formed.
export function normalizeRecipeExtras(r) {
  if (!r || typeof r !== 'object') return r;

  if (Array.isArray(r.ingredients)) {
    r.ingredients.forEach(i => {
      if (i && typeof i === 'object') i.makeable = i.makeable === true;
    });
  }

  const ce = r.cookingEquipment;
  const primary = ce && typeof ce.primary === 'string' ? ce.primary.trim() : '';
  if (!primary) {
    delete r.cookingEquipment;
    return r;
  }
  const seen = new Set([primary.toLowerCase()]);
  r.cookingEquipment = {
    primary,
    emoji: typeof ce.emoji === 'string' && ce.emoji ? ce.emoji : '🍳',
    alternatives: (Array.isArray(ce.alternatives) ? ce.alternatives : [])
      .filter(a => {
        const n = a && typeof a.name === 'string' ? a.name.trim().toLowerCase() : '';
        if (!n || seen.has(n)) return false;
        seen.add(n);
        return true;
      })
      .slice(0, 3)
      .map(a => ({
        name: a.name.trim(),
        emoji: typeof a.emoji === 'string' && a.emoji ? a.emoji : '🍳',
        fit: a.fit === 'good' ? 'good' : 'compromise',
        note: typeof a.note === 'string' ? a.note.trim().slice(0, 200) : ''
      }))
  };
  return r;
}
