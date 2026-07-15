'use strict';

const POSTAL_CODE_MAX_LENGTH = 32;

function postalCodeSanitize(zip) {
  if (!zip) return '';
  let z = String(zip).trim();
  z = z.replace(/[^\p{L}\p{N}\s-]+/gu, '');
  z = z.replace(/\s{2,}/g, ' ').trim();
  if (z.length > POSTAL_CODE_MAX_LENGTH) z = z.slice(0, POSTAL_CODE_MAX_LENGTH);
  return z;
}

function postalCodeNormalize(zip, country) {
  let z = postalCodeSanitize(zip);
  if (!z) return '';
  const cc = (country || '').toUpperCase().slice(0, 2);
  if (cc === 'CA' || /^[A-Z]\d[A-Z][ -]?\d[A-Z]\d$/i.test(z)) {
    const c = z.replace(/[\s-]/g, '').toUpperCase();
    if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(c)) return c.slice(0, 3) + ' ' + c.slice(3);
  }
  if (cc === 'GB' || cc === 'UK' || /^[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}$/i.test(z)) {
    return z.replace(/\s+/g, ' ').toUpperCase();
  }
  if (cc === 'NL' || /^\d{4}\s?[A-Z]{2}$/i.test(z)) {
    const n = z.replace(/\s/g, '').toUpperCase();
    if (/^\d{4}[A-Z]{2}$/.test(n)) return n.slice(0, 4) + ' ' + n.slice(4);
  }
  if (/^\d+$/.test(z) || /^\d{5}-\d{4}$/.test(z)) return z;
  return z.toUpperCase();
}

module.exports = { POSTAL_CODE_MAX_LENGTH, postalCodeSanitize, postalCodeNormalize };
