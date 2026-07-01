'use strict';

/** Kurz gecachter Dispo-Erreichbarkeitsstand (vom Ping-Endpunkt gesetzt). */
let lastPing = { online: true, at: 0, localStats: null };

function setDispoPingResult(result) {
  lastPing = {
    online: !!result.online,
    at: Date.now(),
    localStats: result.localStats || null,
  };
}

function isDispoOnline(maxAgeMs = 45000) {
  if (!lastPing.at) return false;
  if (Date.now() - lastPing.at > maxAgeMs) return lastPing.online;
  return lastPing.online;
}

function shouldPreferLocalCache() {
  return !isDispoOnline();
}

function getLastLocalStats() {
  return lastPing.localStats;
}

module.exports = {
  setDispoPingResult,
  isDispoOnline,
  shouldPreferLocalCache,
  getLastLocalStats,
};
