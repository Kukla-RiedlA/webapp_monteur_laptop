'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function sleepSync(ms) {
  const end = Date.now() + Number(ms) || 0;
  while (Date.now() < end) {
    /* OneDrive/Excel-Sperre: kurz warten */
  }
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

/**
 * Schreibt data nach destPath, ohne destPath vorher zu löschen.
 * So sieht OneDrive ein Überschreiben statt einer Papierkorb-Löschung.
 * Die vollständige Datei liegt zuerst im System-Temp (nicht im OneDrive-Ordner).
 *
 * @param {string} destPath
 * @param {Buffer|string|Uint8Array} data
 * @param {{ maxRetries?: number }} [opts]
 * @returns {string} destPath
 */
function replaceFileWithoutUnlink(destPath, data, opts) {
  const dest = String(destPath || '').trim();
  if (!dest) throw new Error('Zielpfad fehlt.');
  const maxRetries = opts && opts.maxRetries != null ? Number(opts.maxRetries) : 3;
  const retries = Number.isFinite(maxRetries) && maxRetries > 0 ? maxRetries : 3;
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const ext = path.extname(dest) || '.bin';
  const tmp = path.join(
    os.tmpdir(),
    'kukla-put-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) + ext,
  );
  fs.writeFileSync(tmp, buf);
  let lastErr = null;
  try {
    for (let i = 0; i < retries; i++) {
      try {
        fs.copyFileSync(tmp, dest);
        return dest;
      } catch (e) {
        lastErr = e;
        if (isRetryableFsError(e) && i < retries - 1) {
          sleepSync(400 * (i + 1));
          continue;
        }
        try {
          fs.writeFileSync(dest, buf);
          return dest;
        } catch (e2) {
          lastErr = e2;
          if (isRetryableFsError(e2) && i < retries - 1) {
            sleepSync(400 * (i + 1));
            continue;
          }
          const busy = isRetryableFsError(e2);
          throw new Error(
            busy
              ? 'Datei ist gesperrt (z. B. durch OneDrive-Sync oder geöffnetes Excel). Bitte schließen und erneut versuchen.'
              : e2 && e2.message
                ? e2.message
                : String(e2),
          );
        }
      }
    }
    const busy = isRetryableFsError(lastErr);
    throw new Error(
      busy
        ? 'Datei ist gesperrt (z. B. durch OneDrive-Sync oder geöffnetes Excel). Bitte schließen und erneut versuchen.'
        : lastErr && lastErr.message
          ? lastErr.message
          : 'Datei konnte nicht geschrieben werden.',
    );
  } finally {
    unlinkQuiet(tmp);
  }
}

module.exports = {
  replaceFileWithoutUnlink,
};
