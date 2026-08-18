'use strict';

/**
 * Passwort at-rest: Electron safeStorage (Windows DPAPI). Nie Klartext in JSON-Dateien.
 */

function getSafeStorage() {
  try {
    const { safeStorage } = require('electron');
    return safeStorage && typeof safeStorage.encryptString === 'function' ? safeStorage : null;
  } catch (_) {
    return null;
  }
}

function encryptionAvailable() {
  const ss = getSafeStorage();
  try {
    return !!(ss && ss.isEncryptionAvailable && ss.isEncryptionAvailable());
  } catch (_) {
    return false;
  }
}

function sealPassword(plain) {
  const p = plain == null ? '' : String(plain);
  if (p === '') return '';
  const ss = getSafeStorage();
  if (!ss || !encryptionAvailable()) return '';
  try {
    return Buffer.from(ss.encryptString(p)).toString('base64');
  } catch (_) {
    return '';
  }
}

function unsealPassword(enc) {
  const raw = enc == null ? '' : String(enc);
  if (raw === '') return '';
  const ss = getSafeStorage();
  if (!ss || !encryptionAvailable()) return '';
  try {
    return ss.decryptString(Buffer.from(raw, 'base64'));
  } catch (_) {
    return '';
  }
}

/**
 * Liest Passwort aus Session-Objekt. Migriert Klartext -> enc.
 * @returns {{ password: string, record: object, migrated: boolean, persistFailed: boolean }}
 */
function takePasswordFromRecord(record) {
  const rec = record && typeof record === 'object' ? { ...record } : {};
  let password = '';
  let migrated = false;
  let persistFailed = false;

  if (rec.dispo_password_enc) {
    password = unsealPassword(rec.dispo_password_enc);
  }
  const plain = rec.dispo_password != null ? String(rec.dispo_password) : '';
  if (!password && plain) {
    password = plain;
    migrated = true;
  }

  delete rec.dispo_password;
  delete rec.serverPassword;

  if (password) {
    const enc = sealPassword(password);
    if (enc) {
      rec.dispo_password_enc = enc;
    } else {
      delete rec.dispo_password_enc;
      persistFailed = true;
    }
  } else {
    delete rec.dispo_password_enc;
  }

  return { password, record: rec, migrated, persistFailed };
}

function attachSealedPassword(record, password) {
  const rec = record && typeof record === 'object' ? { ...record } : {};
  delete rec.dispo_password;
  delete rec.serverPassword;
  const p = password == null ? '' : String(password);
  if (!p) {
    delete rec.dispo_password_enc;
    return { record: rec, persistFailed: false };
  }
  const enc = sealPassword(p);
  if (!enc) {
    delete rec.dispo_password_enc;
    return { record: rec, persistFailed: true };
  }
  rec.dispo_password_enc = enc;
  return { record: rec, persistFailed: false };
}

function stripPasswordFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  delete out.dispo_password;
  delete out.serverPassword;
  delete out.dispo_password_enc;
  delete out.password;
  return out;
}

module.exports = {
  encryptionAvailable,
  sealPassword,
  unsealPassword,
  takePasswordFromRecord,
  attachSealedPassword,
  stripPasswordFields,
};
