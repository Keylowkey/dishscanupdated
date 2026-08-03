// lib/i18n-data.js — language metadata shared by the app and the API layer.
// Kept separate from index.html so the server can validate a language code
// without parsing the whole frontend.

export const LANGS = {
  en: { name: 'English',  native: 'English',  dir: 'ltr', aiName: 'English' },
  es: { name: 'Spanish',  native: 'Español',  dir: 'ltr', aiName: 'Spanish' },
  fr: { name: 'French',   native: 'Français', dir: 'ltr', aiName: 'French' },
  de: { name: 'German',   native: 'Deutsch',  dir: 'ltr', aiName: 'German' },
  hi: { name: 'Hindi',    native: 'हिन्दी',    dir: 'ltr', aiName: 'Hindi' },
  ar: { name: 'Arabic',   native: 'العربية',   dir: 'rtl', aiName: 'Arabic' }
};

export function isLang(code) {
  return Object.prototype.hasOwnProperty.call(LANGS, code);
}

// One line appended to an AI prompt so generated content comes back translated.
// Names of dishes stay recognisable; measurements stay in the units the recipe
// uses so quantities don't drift.
export function languageInstruction(code) {
  if (!code || code === 'en' || !isLang(code)) return '';
  const l = LANGS[code];
  return `\n\nIMPORTANT — LANGUAGE: Write ALL human-readable text in your JSON response in ${l.aiName}. ` +
    `This includes the dish name, ingredient names, quantities, equipment names, cooking steps, notes, ` +
    `swap descriptions, dietary and difficulty labels, and any explanation text. ` +
    `Keep the JSON keys themselves in English exactly as specified. Keep numeric values numeric. ` +
    `Use the measurement words natural to ${l.aiName}. Do not add any commentary about the translation.`;
}
