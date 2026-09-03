'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function sleep(ms) {
  const n = Number(ms);
  const wait = Number.isFinite(n) && n > 0 ? n : 0;
  return new Promise((resolve) => setTimeout(resolve, wait));
}

function isRetryableFsError(err) {
  const code = err && err.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || err.errno === -4082;
}

function unlinkQuiet(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {
    /* Temp-Datei */
  }
}

function busyError(err) {
  const busy = isRetryableFsError(err);
  return new Error(
    busy
      ? 'Datei ist gesperrt (z. B. durch OneDrive-Sync oder geöffnetes Excel). Bitte schließen und erneut versuchen.'
      : err && err.message
        ? err.message
        : 'Datei konnte nicht geschrieben werden.',
  );
}

/**
 * Schreibt data nach destPath, ohne destPath vorher zu löschen.
 * So sieht OneDrive ein Überschreiben statt einer Papierkorb-Löschung.
 * Die vollständige Datei liegt zuerst im System-Temp (nicht im OneDrive-Ordner).
 * Wartet bei Sperren asynchron — kein Busy-Wait auf dem Event-Loop.
 *
 * @param {string} destPath
 * @param {Buffer|string|Uint8Array} data
 * @param {{ maxRetries?: number }} [opts]
 * @returns {Promise<string>} destPath
 */
async function replaceFileWithoutUnlink(destPath, data, opts) {
  const dest = String(destPath || '').trim();
  if (!dest) throw new Error('Zielpfad fehlt.');
  const maxRetries = opts && opts.maxRetries != null ? Number(opts.maxRetries) : 3;
  const retries = Number.isFinite(maxRetries) && maxRetries > 0 ? maxRetries : 3;
  const dir = path.dirname(dest);
  await fs.promises.mkdir(dir, { recursive: true });

  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const ext = path.extname(dest) || '.bin';
  const tmp = path.join(
    os.tmpdir(),
    'kukla-put-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) + ext,
  );
  await fs.promises.writeFile(tmp, buf);
  let lastErr = null;
  try {
    for (let i = 0; i < retries; i++) {
      try {
        await fs.promises.copyFile(tmp, dest);
        return dest;
      } catch (e) {
        lastErr = e;
        if (isRetryableFsError(e) && i < retries - 1) {
          await sleep(400 * (i + 1));
          continue;
        }
        try {
          await fs.promises.writeFile(dest, buf);
          return dest;
        } catch (e2) {
          lastErr = e2;
          if (isRetryableFsError(e2) && i < retries - 1) {
            await sleep(400 * (i + 1));
            continue;
          }
          throw busyError(e2);
        }
      }
    }
    throw busyError(lastErr);
  } finally {
    unlinkQuiet(tmp);
  }
}

module.exports = {
  replaceFileWithoutUnlink,
};
