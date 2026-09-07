'use strict';

const crypto = require('crypto');
const path = require('path');

/** @type {Map<string, { sourcePath: string, viewPath: string, title: string, created: number, lastSavedPath?: string }>} */
const sessions = new Map();

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function pruneExpired() {
  const now = Date.now();
  for (const [id, row] of sessions.entries()) {
    if (!row || now - (row.created || 0) > SESSION_TTL_MS) sessions.delete(id);
  }
}

function createPdfAnnotatorSession(opts) {
  pruneExpired();
  const rawSource = String((opts && opts.sourcePath) || '').trim();
  if (!rawSource) return null;
  const sourcePath = path.normalize(rawSource);
  const rawView = String((opts && opts.viewPath) || sourcePath).trim();
  const viewPath = path.normalize(rawView || sourcePath) || sourcePath;
  const title = String((opts && opts.title) || path.basename(sourcePath) || 'PDF').trim() || 'PDF';
  const id = crypto.randomBytes(12).toString('hex');
  sessions.set(id, { sourcePath, viewPath, title, created: Date.now() });
  return id;
}

function getPdfAnnotatorSession(id) {
  pruneExpired();
  const key = String(id || '').trim();
  if (!key) return null;
  return sessions.get(key) || null;
}

function dropPdfAnnotatorSession(id) {
  const key = String(id || '').trim();
  if (key) sessions.delete(key);
}

module.exports = {
  createPdfAnnotatorSession,
  getPdfAnnotatorSession,
  dropPdfAnnotatorSession,
};
