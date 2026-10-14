'use strict';

const crypto = require('crypto');
const vault = require('./credential-vault');

const TYPES = {
  reisepass: 'Reisepass',
  visum_eta_esta: 'Visum/ETA/ESTA',
  vignette: 'Vignette',
  fuehrerschein: 'Führerschein',
  oebb_vorteilskarte: 'ÖBB Vorteilskarte',
};

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_safe_key (
      id INTEGER PRIMARY KEY,
      sealed TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS technician_documents (
      local_id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER,
      public_id TEXT NOT NULL,
      technician_id INTEGER NOT NULL,
      doc_type TEXT NOT NULL,
      payload_cipher BLOB NOT NULL,
      payload_iv BLOB NOT NULL,
      payload_tag BLOB NOT NULL,
      file_cipher BLOB,
      file_iv BLOB,
      file_tag BLOB,
      file_mime TEXT,
      preview_cipher BLOB,
      preview_iv BLOB,
      preview_tag BLOB,
      dirty INTEGER NOT NULL DEFAULT 1,
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );
  `);
}

function deviceKey(db) {
  ensureSchema(db);
  const row = db.prepare('SELECT sealed FROM doc_safe_key WHERE id = 1').get();
  if (row && row.sealed) {
    const plain = vault.unsealPassword(row.sealed);
    if (!plain) throw new Error('device_key_unavailable');
    return Buffer.from(plain, 'base64');
  }
  if (!vault.encryptionAvailable()) throw new Error('device_key_unavailable');
  const key = crypto.randomBytes(32);
  const sealed = vault.sealPassword(key.toString('base64'));
  if (!sealed) throw new Error('device_key_unavailable');
  db.prepare('INSERT INTO doc_safe_key (id, sealed) VALUES (1, ?)').run(sealed);
  return key;
}

function aad(publicId, technicianId, part) {
  return Buffer.from('local:' + publicId + ':' + technicianId + ':' + part, 'utf8');
}

function encryptPart(key, plain, publicId, technicianId, part) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(publicId, technicianId, part));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { cipher: ct, iv, tag: cipher.getAuthTag() };
}

function decryptPart(key, row, part) {
  const cipher = row[part + '_cipher'];
  const iv = row[part + '_iv'];
  const tag = row[part + '_tag'];
  if (!cipher || !iv || !tag) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad(row.public_id, row.technician_id, part));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cipher), decipher.final()]);
}

function sniff(buf) {
  if (!buf || buf.length < 8 || buf.length > 8 * 1024 * 1024) return null;
  if (buf.slice(0, 4).toString('utf8') === '%PDF') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

function publicMeta(row, payload) {
  return {
    id: row.local_id,
    server_id: row.server_id || null,
    public_id: row.public_id,
    technician_id: row.technician_id,
    doc_type: row.doc_type,
    doc_type_label: TYPES[row.doc_type] || row.doc_type,
    title: payload.title || '',
    document_number: payload.document_number || '',
    holder_name: payload.holder_name || '',
    country: payload.country || '',
    valid_for: payload.valid_for || '',
    issuer: payload.issuer || '',
    issued_on: payload.issued_on || '',
    valid_until: payload.valid_until || '',
    notes: payload.notes || '',
    original_filename: payload.original_filename || '',
    file_mime: row.file_mime || '',
    has_file: !!row.file_cipher,
    has_preview: !!row.preview_cipher,
    reminder_enabled: !!payload.reminder_enabled,
    reminder_days_before: payload.reminder_days_before || 30,
    updated_at: row.updated_at || '',
    dirty: !!row.dirty,
  };
}

function readPayload(db, row) {
  const key = deviceKey(db);
  const buf = decryptPart(key, row, 'payload');
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return null;
  }
}

function listLocal(db, technicianId) {
  ensureSchema(db);
  const rows = db.prepare(
    'SELECT * FROM technician_documents WHERE technician_id = ? AND deleted = 0 ORDER BY local_id DESC'
  ).all(technicianId);
  const out = [];
  for (const row of rows) {
    const payload = readPayload(db, row);
    if (payload) out.push(publicMeta(row, payload));
  }
  return out;
}

function getRow(db, localId, technicianId) {
  return db.prepare(
    'SELECT * FROM technician_documents WHERE local_id = ? AND technician_id = ?'
  ).get(localId, technicianId);
}

function saveLocal(db, technicianId, fields, fileBuf) {
  if (!TYPES[fields.doc_type]) throw new Error('doc_type');
  const key = deviceKey(db);
  const existing = fields.id ? getRow(db, parseInt(fields.id, 10), technicianId) : null;
  if (fields.id && !existing) throw new Error('not_found');
  if (existing && existing.deleted) throw new Error('not_found');
  const prev = existing ? readPayload(db, existing) : {};
  function pickText(key, maxLen) {
    var raw;
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      raw = fields[key] == null ? '' : String(fields[key]);
    } else {
      raw = prev && prev[key] != null ? String(prev[key]) : '';
    }
    raw = raw.trim();
    if (maxLen && raw.length > maxLen) raw = raw.slice(0, maxLen);
    return raw;
  }
  const payload = {
    title: pickText('title', 240),
    document_number: pickText('document_number', 240),
    holder_name: pickText('holder_name', 240),
    country: pickText('country', 240),
    valid_for: pickText('valid_for', 16).toUpperCase(),
    issuer: pickText('issuer', 240),
    issued_on: pickText('issued_on', 10),
    valid_until: pickText('valid_until', 10),
    notes: pickText('notes', 240),
    original_filename: String((fields.original_filename || prev.original_filename || '')).slice(0, 240),
    reminder_enabled: fields.reminder_enabled === true || fields.reminder_enabled === 1 || fields.reminder_enabled === '1',
    reminder_days_before: Math.min(365, Math.max(1, parseInt(fields.reminder_days_before || prev.reminder_days_before || 30, 10) || 30)),
  };
  let mime = existing ? existing.file_mime : null;
  if (fileBuf && fileBuf.length) {
    mime = sniff(fileBuf);
    if (!mime) throw new Error('file_type');
    if (!payload.original_filename) payload.original_filename = mime === 'application/pdf' ? 'dokument.pdf' : 'dokument.jpg';
  }
  const publicId = existing ? existing.public_id : crypto.randomBytes(16).toString('hex');
  const enc = encryptPart(key, Buffer.from(JSON.stringify(payload), 'utf8'), publicId, technicianId, 'payload');
  const now = new Date().toISOString();
  if (!existing) {
    let fileEnc = null;
    if (fileBuf && mime) fileEnc = encryptPart(key, fileBuf, publicId, technicianId, 'file');
    const info = db.prepare(`
      INSERT INTO technician_documents (
        server_id, public_id, technician_id, doc_type,
        payload_cipher, payload_iv, payload_tag,
        file_cipher, file_iv, file_tag, file_mime,
        dirty, deleted, updated_at
      ) VALUES (NULL,?,?,?,?,?,?,?,?,?,?,1,0,?)
    `).run(
      publicId, technicianId, fields.doc_type,
      enc.cipher, enc.iv, enc.tag,
      fileEnc ? fileEnc.cipher : null,
      fileEnc ? fileEnc.iv : null,
      fileEnc ? fileEnc.tag : null,
      mime,
      now
    );
    return publicMeta(getRow(db, info.lastInsertRowid, technicianId), payload);
  }
  if (fileBuf && mime) {
    const fileEnc = encryptPart(key, fileBuf, publicId, technicianId, 'file');
    db.prepare(`
      UPDATE technician_documents SET
        doc_type = ?, payload_cipher = ?, payload_iv = ?, payload_tag = ?,
        file_cipher = ?, file_iv = ?, file_tag = ?, file_mime = ?,
        preview_cipher = NULL, preview_iv = NULL, preview_tag = NULL,
        dirty = 1, updated_at = ?
      WHERE local_id = ? AND technician_id = ?
    `).run(
      fields.doc_type, enc.cipher, enc.iv, enc.tag,
      fileEnc.cipher, fileEnc.iv, fileEnc.tag, mime,
      now, existing.local_id, technicianId
    );
  } else {
    db.prepare(`
      UPDATE technician_documents SET
        doc_type = ?, payload_cipher = ?, payload_iv = ?, payload_tag = ?,
        dirty = 1, updated_at = ?
      WHERE local_id = ? AND technician_id = ?
    `).run(fields.doc_type, enc.cipher, enc.iv, enc.tag, now, existing.local_id, technicianId);
  }
  return publicMeta(getRow(db, existing.local_id, technicianId), payload);
}

function deleteLocal(db, technicianId, localId) {
  const row = getRow(db, localId, technicianId);
  if (!row) return false;
  db.prepare('UPDATE technician_documents SET deleted = 1, dirty = 1, updated_at = ? WHERE local_id = ? AND technician_id = ?')
    .run(new Date().toISOString(), localId, technicianId);
  return true;
}

function readFile(db, technicianId, localId, part) {
  const row = getRow(db, localId, technicianId);
  if (!row || row.deleted) return null;
  const key = deviceKey(db);
  const buf = decryptPart(key, row, part);
  if (!buf) return null;
  const payload = readPayload(db, row) || {};
  return {
    buf,
    mime: part === 'preview' ? 'image/jpeg' : (row.file_mime || 'application/octet-stream'),
    filename: payload.original_filename || 'dokument',
  };
}

function storeServerDoc(db, technicianId, doc, fileBuf, previewBuf) {
  const key = deviceKey(db);
  const publicId = String(doc.public_id || '');
  if (!publicId) return;
  const payload = {
    title: doc.title || '',
    document_number: doc.document_number || '',
    holder_name: doc.holder_name || '',
    country: doc.country || '',
    valid_for: doc.valid_for || '',
    issuer: doc.issuer || '',
    issued_on: doc.issued_on || '',
    valid_until: doc.valid_until || '',
    notes: doc.notes || '',
    original_filename: doc.original_filename || '',
    reminder_enabled: !!doc.reminder_enabled,
    reminder_days_before: doc.reminder_days_before || 30,
  };
  const enc = encryptPart(key, Buffer.from(JSON.stringify(payload), 'utf8'), publicId, technicianId, 'payload');
  const fileEnc = fileBuf && fileBuf.length ? encryptPart(key, fileBuf, publicId, technicianId, 'file') : null;
  const prevEnc = previewBuf && previewBuf.length ? encryptPart(key, previewBuf, publicId, technicianId, 'preview') : null;
  const existing = db.prepare(
    'SELECT local_id FROM technician_documents WHERE public_id = ? AND technician_id = ?'
  ).get(publicId, technicianId);
  const now = doc.updated_at || new Date().toISOString();
  if (!existing) {
    db.prepare(`
      INSERT INTO technician_documents (
        server_id, public_id, technician_id, doc_type,
        payload_cipher, payload_iv, payload_tag,
        file_cipher, file_iv, file_tag, file_mime,
        preview_cipher, preview_iv, preview_tag,
        dirty, deleted, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?)
    `).run(
      doc.id || null, publicId, technicianId, doc.doc_type,
      enc.cipher, enc.iv, enc.tag,
      fileEnc ? fileEnc.cipher : null, fileEnc ? fileEnc.iv : null, fileEnc ? fileEnc.tag : null,
      doc.file_mime || null,
      prevEnc ? prevEnc.cipher : null, prevEnc ? prevEnc.iv : null, prevEnc ? prevEnc.tag : null,
      now
    );
    return;
  }
  db.prepare(`
    UPDATE technician_documents SET
      server_id = ?, doc_type = ?,
      payload_cipher = ?, payload_iv = ?, payload_tag = ?,
      file_cipher = COALESCE(?, file_cipher),
      file_iv = COALESCE(?, file_iv),
      file_tag = COALESCE(?, file_tag),
      file_mime = COALESCE(?, file_mime),
      preview_cipher = COALESCE(?, preview_cipher),
      preview_iv = COALESCE(?, preview_iv),
      preview_tag = COALESCE(?, preview_tag),
      dirty = 0, deleted = 0, updated_at = ?
    WHERE local_id = ? AND technician_id = ?
  `).run(
    doc.id || null, doc.doc_type,
    enc.cipher, enc.iv, enc.tag,
    fileEnc ? fileEnc.cipher : null, fileEnc ? fileEnc.iv : null, fileEnc ? fileEnc.tag : null,
    doc.file_mime || null,
    prevEnc ? prevEnc.cipher : null, prevEnc ? prevEnc.iv : null, prevEnc ? prevEnc.tag : null,
    now, existing.local_id, technicianId
  );
}

async function fetchBuf(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

async function syncWithServer(db, technicianId, baseUrl, authHeader) {
  ensureSchema(db);
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base || !authHeader || !authHeader.Authorization) return { ok: false, error: 'offline' };
  const headers = Object.assign({ Accept: 'application/json' }, authHeader);
  const dirty = db.prepare(
    'SELECT * FROM technician_documents WHERE technician_id = ? AND dirty = 1'
  ).all(technicianId);
  for (const row of dirty) {
    if (row.deleted) {
      if (row.server_id) {
        await fetch(base + '/api/doc_safe.php', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
          body: JSON.stringify({ action: 'delete', id: row.server_id, technician_id: technicianId }),
        });
      }
      db.prepare('DELETE FROM technician_documents WHERE local_id = ? AND technician_id = ?').run(row.local_id, technicianId);
      continue;
    }
    const payload = readPayload(db, row) || {};
    const file = row.file_cipher ? decryptPart(deviceKey(db), row, 'file') : null;
    const body = Object.assign({}, payload, {
      action: 'save',
      technician_id: technicianId,
      doc_type: row.doc_type,
      id: row.server_id || undefined,
      public_id: row.public_id,
    });
    if (file) body.file_base64 = file.toString('base64');
    const res = await fetch(base + '/api/doc_safe.php', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.ok && data.document) {
      const saved = data.document;
      db.prepare('UPDATE technician_documents SET server_id = ?, dirty = 0 WHERE local_id = ? AND technician_id = ?')
        .run(saved.id, row.local_id, technicianId);
      if (!row.server_id && saved.public_id && saved.public_id !== row.public_id) {
        storeServerDoc(db, technicianId, saved, file, null);
        db.prepare('DELETE FROM technician_documents WHERE local_id = ? AND technician_id = ? AND public_id = ?')
          .run(row.local_id, technicianId, row.public_id);
      }
    }
  }
  const listRes = await fetch(base + '/api/doc_safe.php?technician_id=' + encodeURIComponent(String(technicianId)), { headers });
  const list = await listRes.json().catch(() => ({}));
  if (!list || !list.ok) return { ok: false, error: list && list.error ? list.error : 'sync' };
  const seen = new Set();
  for (const doc of list.documents || []) {
    seen.add(String(doc.public_id));
    const local = db.prepare(
      'SELECT * FROM technician_documents WHERE public_id = ? AND technician_id = ?'
    ).get(doc.public_id, technicianId);
    if (local && local.dirty) continue;
    let fileBuf = null;
    let previewBuf = null;
    if (doc.has_file) {
      fileBuf = await fetchBuf(base + '/api/doc_safe.php?part=file&id=' + doc.id, headers);
    }
    if (doc.has_preview) {
      previewBuf = await fetchBuf(base + '/api/doc_safe.php?part=preview&id=' + doc.id, headers);
    }
    storeServerDoc(db, technicianId, doc, fileBuf, previewBuf);
  }
  const locals = db.prepare(
    'SELECT local_id, public_id, dirty FROM technician_documents WHERE technician_id = ? AND deleted = 0'
  ).all(technicianId);
  for (const row of locals) {
    if (!row.dirty && row.public_id && !seen.has(String(row.public_id))) {
      db.prepare('DELETE FROM technician_documents WHERE local_id = ?').run(row.local_id);
    }
  }
  return { ok: true };
}

module.exports = {
  TYPES,
  ensureSchema,
  listLocal,
  saveLocal,
  deleteLocal,
  readFile,
  syncWithServer,
};
