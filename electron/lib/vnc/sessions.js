'use strict';

const crypto = require('crypto');

const TTL_MS = 60 * 1000;
const sessions = new Map();

function prune(now) {
  const t = now || Date.now();
  for (const [id, row] of sessions) {
    if (row.used || t - row.createdAt > TTL_MS) sessions.delete(id);
  }
}

function createSession(host, port) {
  prune();
  const id = crypto.randomBytes(24).toString('hex');
  sessions.set(id, {
    host: String(host),
    port: Number(port),
    createdAt: Date.now(),
    used: false,
  });
  return id;
}

function takeSession(id) {
  prune();
  const key = String(id || '');
  const row = sessions.get(key);
  if (!row || row.used) return null;
  row.used = true;
  sessions.delete(key);
  return { host: row.host, port: row.port };
}

function resetForTests() {
  sessions.clear();
}

module.exports = {
  createSession,
  takeSession,
  resetForTests,
};
