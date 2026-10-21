'use strict';

/**
 * Passwort at-rest: Electron safeStorage (Windows DPAPI). Nie Klartext in JSON-Dateien.
 */

/** Klartext-Passwort-Keys in Session-/Job-/Draft-JSON (nie persistieren). */
const PASSWORD_PLAIN_KEYS = [
  'dispo_password',
  'dispoPassword',
  'serverPassword',
  'server_password',
  'password',
];

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

  for (const k of PASSWORD_PLAIN_KEYS) delete rec[k];

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
  for (const k of PASSWORD_PLAIN_KEYS) delete rec[k];
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
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = { ...obj };
  for (const k of PASSWORD_PLAIN_KEYS) delete out[k];
  delete out.dispo_password_enc;
  delete out.cookies;
  delete out.cookies_enc;
  return out;
}

/**
 * Entfernt Klartext-Passwortfelder aus einem JSON-String (flach, Top-Level).
 * @returns {{ text: string, changed: boolean }}
 */
function scrubPasswordFieldsInJson(text) {
  const raw = text == null ? '' : String(text);
  if (!raw) return { text: raw, changed: false };
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (_) {
    return { text: raw, changed: false };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { text: raw, changed: false };
  }
  let changed = false;
  const out = { ...obj };
  for (const k of PASSWORD_PLAIN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, k)) {
      delete out[k];
      changed = true;
    }
  }
  if (!changed) return { text: raw, changed: false };
  return { text: JSON.stringify(out), changed: true };
}

/**
 * Scrubt payload_json-Spalten in einer Tabelle (best effort, idempotent).
 * @returns {number} Anzahl geänderter Zeilen
 */
function scrubPasswordColumnsInTable(db, tableName, columnName) {
  if (!db || !tableName || !columnName) return 0;
  const likeParts = PASSWORD_PLAIN_KEYS.map(() => `${columnName} LIKE ?`).join(' OR ');
  const likeArgs = PASSWORD_PLAIN_KEYS.map((k) => `%"${k}"%`);
  let rows;
  try {
    rows = db
      .prepare(`SELECT rowid AS _rid, ${columnName} AS _json FROM ${tableName} WHERE ${likeParts}`)
      .all(...likeArgs);
  } catch (_) {
    return 0;
  }
  if (!rows || !rows.length) return 0;
  let n = 0;
  const upd = db.prepare(`UPDATE ${tableName} SET ${columnName} = ? WHERE rowid = ?`);
  for (const row of rows) {
    const scrubbed = scrubPasswordFieldsInJson(row._json);
    if (!scrubbed.changed) continue;
    try {
      upd.run(scrubbed.text, row._rid);
      n += 1;
    } catch (_) {
      /* ignore single row */
    }
  }
  return n;
}

/**
 * Einmaliger Voll-Scrub (Marker in kukla_security_scrub), danach nur noch No-Op.
 * @returns {number}
 */
function scrubPasswordColumnsInTableOnce(db, tableName, columnName, flagKey) {
  if (!db || !tableName || !columnName || !flagKey) return 0;
  try {
    if (typeof db.exec === 'function') {
      db.exec(
        `CREATE TABLE IF NOT EXISTS kukla_security_scrub (
          key TEXT PRIMARY KEY,
          done_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
      );
    } else if (db.prepare) {
      db.prepare(
        `CREATE TABLE IF NOT EXISTS kukla_security_scrub (
          key TEXT PRIMARY KEY,
          done_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
      ).run();
    }
    const done = db.prepare('SELECT 1 AS ok FROM kukla_security_scrub WHERE key = ?').get(flagKey);
    if (done) return 0;
  } catch (_) {
    /* ohne Marker-Tabelle trotzdem scrubben */
  }
  const n = scrubPasswordColumnsInTable(db, tableName, columnName);
  try {
    db.prepare(
      `INSERT OR REPLACE INTO kukla_security_scrub (key, done_at) VALUES (?, datetime('now'))`,
    ).run(flagKey);
  } catch (_) {
    /* ignore */
  }
  return n;
}

function takeCookiesFromRecord(record) {
  const rec = record && typeof record === 'object' ? { ...record } : {};
  let cookies = null;
  let migrated = false;
  if (rec.cookies_enc) {
    const json = unsealPassword(rec.cookies_enc);
    if (json) {
      try {
        cookies = JSON.parse(json);
      } catch (_) {
        cookies = null;
      }
    }
  }
  if (rec.cookies != null) {
    if (!cookies) cookies = rec.cookies;
    migrated = true;
  }
  delete rec.cookies;
  if (cookies != null) {
    const enc = sealPassword(JSON.stringify(cookies));
    if (enc) rec.cookies_enc = enc;
    else delete rec.cookies_enc;
  } else {
    delete rec.cookies_enc;
  }
  return { cookies, record: rec, migrated };
}

function attachSealedCookies(record, cookies) {
  const rec = record && typeof record === 'object' ? { ...record } : {};
  delete rec.cookies;
  if (cookies == null) {
    delete rec.cookies_enc;
    return { record: rec, persistFailed: false };
  }
  const enc = sealPassword(JSON.stringify(cookies));
  if (!enc) {
    delete rec.cookies_enc;
    return { record: rec, persistFailed: true };
  }
  rec.cookies_enc = enc;
  return { record: rec, persistFailed: false };
}

module.exports = {
  PASSWORD_PLAIN_KEYS,
  encryptionAvailable,
  sealPassword,
  unsealPassword,
  takePasswordFromRecord,
  attachSealedPassword,
  takeCookiesFromRecord,
  attachSealedCookies,
  stripPasswordFields,
  scrubPasswordFieldsInJson,
  scrubPasswordColumnsInTable,
  scrubPasswordColumnsInTableOnce,
};
