'use strict';

const { session } = require('electron');

const WANTED_LANGUAGES = ['de', 'en-GB'];

/**
 * Aktiviert Chromium-Rechtschreibung mit DE + en-GB (soweit verfügbar).
 * Einmal pro App-Start auf defaultSession aufrufen.
 */
function configureSpellCheckerSession() {
  const ses = session.defaultSession;
  if (!ses) return [];

  try {
    ses.setSpellCheckerEnabled(true);
  } catch (e) {
    console.warn('[spellcheck] setSpellCheckerEnabled:', e && e.message ? e.message : e);
  }

  let available = [];
  try {
    available = Array.isArray(ses.availableSpellCheckerLanguages)
      ? ses.availableSpellCheckerLanguages.slice()
      : [];
  } catch (_) {
    available = [];
  }

  const langs = [];
  for (const code of WANTED_LANGUAGES) {
    if (available.includes(code) && !langs.includes(code)) langs.push(code);
  }
  // Fallback-Aliase, falls Chromium nur Region-Codes listet
  if (!langs.includes('de') && available.includes('de-DE')) langs.unshift('de-DE');
  if (!langs.includes('en-GB') && available.includes('en-GB')) langs.push('en-GB');

  if (!langs.length) {
    console.warn(
      '[spellcheck] gewünschte Sprachen nicht verfügbar:',
      WANTED_LANGUAGES.join(', '),
      '| available:',
      available.slice(0, 20).join(', ') || '(leer)',
    );
    return [];
  }

  try {
    ses.setSpellCheckerLanguages(langs);
    console.log('[spellcheck] languages:', langs.join(', '));
  } catch (e) {
    console.warn('[spellcheck] setSpellCheckerLanguages:', e && e.message ? e.message : e);
  }
  return langs;
}

module.exports = { configureSpellCheckerSession, WANTED_LANGUAGES };
