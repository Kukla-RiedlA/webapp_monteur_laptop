'use strict';

const crypto = require('crypto');

/** Voller SHA-256 nur bis hier. Darüber der Größen-Platzhalter, ohne die Datei zu lesen. */
const HASH_FULL_READ_MAX_BYTES = 64 * 1024 * 1024;

/** SHA-256, sonst leer. Größen-Platzhalter und Uhrzeiten zählen nicht als Inhalt. */
function normContentSha(value) {
  const s = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(s) ? s : '';
}

/**
 * true = lokale Datei entspricht der Dispo, nicht erneut laden.
 * Inhalt (SHA-256) geht vor. Fehlt er, entscheidet die Größe. Die Änderungszeit zählt nicht.
 * @param {{ size?: number, sha256?: string } | null} local
 * @param {{ size?: number|null, sha256?: string|null } | null} remote
 */
function remoteFileAlreadyLocal(local, remote) {
  if (!local) return false;
  const localSha = normContentSha(local.sha256);
  const remoteSha = normContentSha(remote && remote.sha256);
  if (localSha && remoteSha) return localSha === remoteSha;
  const remoteSize = remote && remote.size != null ? Number(remote.size) : NaN;
  const localSize = Number(local.size);
  if (Number.isFinite(remoteSize) && Number.isFinite(localSize)) return localSize === remoteSize;
  return false;
}

/**
 * true = Datei zur Dispo hochladen.
 * Andere Größe oder anderer gespeicherter Inhalt. Nur eine neue Uhrzeit löst keinen Upload aus.
 * @param {{ size?: number, sha256?: string } | null} cached
 * @param {{ size?: number, sha256?: string } | null} current
 */
function localFileNeedsPush(cached, current) {
  if (!cached) return true;
  const cachedSize = Number(cached.size);
  const currentSize = Number(current && current.size);
  if (!Number.isFinite(currentSize) || cachedSize !== currentSize) return true;
  const cachedSha = normContentSha(cached.sha256);
  const currentSha = normContentSha(current && current.sha256);
  if (cachedSha && currentSha) return cachedSha !== currentSha;
  return false;
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes || Buffer.alloc(0)).digest('hex');
}

/** Gleicher Platzhalter wie bisher in sha256File: kein Vollesen. */
function contentShaPlaceholder(size, mtimeMs) {
  const n = Number(size) || 0;
  const m = Math.floor(Number(mtimeMs) || 0);
  return 'size:' + n + ':mtime:' + m;
}

/**
 * Über 64 MiB: Platzhalter, readBytes wird nicht aufgerufen.
 * Sonst SHA-256 der von readBytes gelieferten Bytes. Keine Datei: ''.
 * @param {{ size?: number, mtimeMs?: number, isFile?: boolean } | null} stat
 * @param {() => Buffer} readBytes
 */
function contentShaForFileStat(stat, readBytes) {
  if (!stat || stat.isFile === false) return '';
  const size = Number(stat.size) || 0;
  if (size > HASH_FULL_READ_MAX_BYTES) return contentShaPlaceholder(size, stat.mtimeMs);
  return sha256Hex(readBytes());
}

module.exports = {
  HASH_FULL_READ_MAX_BYTES,
  normContentSha,
  remoteFileAlreadyLocal,
  localFileNeedsPush,
  sha256Hex,
  contentShaPlaceholder,
  contentShaForFileStat,
};
