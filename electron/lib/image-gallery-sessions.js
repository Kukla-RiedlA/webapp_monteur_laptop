'use strict';

const crypto = require('crypto');

/** @type {Map<string, { images: object[], created: number }>} */
const sessions = new Map();

const SESSION_TTL_MS = 30 * 60 * 1000;

function pruneExpired() {
  const now = Date.now();
  for (const [id, row] of sessions.entries()) {
    if (!row || now - (row.created || 0) > SESSION_TTL_MS) sessions.delete(id);
  }
}

function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const url = String(item.url || '').trim();
      if (!url) return null;
      const label = String(item.label || item.title || item.name || '').trim();
      const thumbUrl = String(item.thumbUrl || item.thumb || '').trim();
      return thumbUrl ? { url, label, thumbUrl } : { url, label };
    })
    .filter(Boolean);
}

function createImageGallerySession(images) {
  pruneExpired();
  const list = normalizeImages(images);
  if (!list.length) return null;
  const id = crypto.randomBytes(12).toString('hex');
  sessions.set(id, { images: list, created: Date.now() });
  return id;
}

function getImageGallerySession(id) {
  pruneExpired();
  const key = String(id || '').trim();
  if (!key) return null;
  const row = sessions.get(key);
  if (!row) return null;
  return { images: row.images || [] };
}

module.exports = {
  createImageGallerySession,
  getImageGallerySession,
};
