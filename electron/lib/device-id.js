'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

function deviceIdPath(dbDir) {
  return path.join(dbDir, 'monteur_device_id.json');
}

function getOrCreateDeviceId(dbDir) {
  const p = deviceIdPath(dbDir);
  try {
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const id = String((j && j.device_id) || '').trim();
      if (id && /^[A-Za-z0-9._:-]+$/.test(id) && id.length <= 64) return id;
    }
  } catch (_) {}
  const id =
    'lap-' +
    crypto.randomBytes(16).toString('hex') +
    '-' +
    String(process.pid || 0);
  try {
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          device_id: id,
          created_at: new Date().toISOString(),
          hostname: os.hostname(),
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (_) {}
  return id;
}

function defaultDisplayName() {
  try {
    return String(os.hostname() || 'Monteur-Laptop').slice(0, 255);
  } catch (_) {
    return 'Monteur-Laptop';
  }
}

module.exports = {
  getOrCreateDeviceId,
  defaultDisplayName,
  deviceIdPath,
};
