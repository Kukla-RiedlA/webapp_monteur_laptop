'use strict';

/**
 * Welche Hintergrundschleifen ein KUKpit-Fenster starten darf.
 * Popout-Fenster bedienen nur die Maske. Sync bleibt im Hauptfenster.
 */
function shellLoopsForSearch(search) {
  let raw = String(search || '');
  if (raw.charAt(0) === '?') raw = raw.slice(1);
  const params = new URLSearchParams(raw);
  const on = params.get('popout') !== '1';
  return {
    bootSync: on,
    syncInterval: on,
    connectionProbe: on,
    onlineSync: on,
    jobPoll: on,
  };
}

const api = { shellLoopsForSearch };

if (typeof module === 'object' && module.exports) {
  module.exports = api;
} else {
  const root = typeof globalThis !== 'undefined' ? globalThis : this;
  root.KuklaShellLoops = api;
}
