'use strict';

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp('^' + OCTET + '(?:\\.' + OCTET + '){3}$');
const HOSTNAME = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizeRemoteDir(raw) {
  let text = String(raw == null || raw === '' ? '/' : raw).trim().replace(/\\/g, '/');
  if (text.includes('\0')) throw fail('Ungültiger Pfad.', 'invalid_path');
  if (!text.startsWith('/')) text = '/' + text;
  const parts = [];
  for (const seg of text.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') throw fail('Ungültiger Pfad.', 'invalid_path');
    parts.push(seg);
  }
  return '/' + parts.join('/');
}

function parentRemoteDir(remotePath) {
  const dir = normalizeRemoteDir(remotePath);
  if (dir === '/') return '/';
  const parts = dir.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

function assertRemoteFileName(name) {
  const base = String(name == null ? '' : name).trim();
  if (!base || base === '.' || base === '..') throw fail('Ungültiger Dateiname.', 'invalid_name');
  if (/[\\/\0]/.test(base)) throw fail('Ungültiger Dateiname.', 'invalid_name');
  return base;
}

function parseFtpTarget(input) {
  const src = input && typeof input === 'object' ? input : {};
  const host = String(src.host == null ? '' : src.host).trim();
  if (host.includes('@') || host.includes('://') || host.includes('/')) {
    throw fail('Bitte eine IP-Adresse oder einen Hostnamen eingeben.', 'invalid_host');
  }
  if (!IPV4.test(host) && !HOSTNAME.test(host)) {
    throw fail('Bitte eine IP-Adresse oder einen Hostnamen eingeben.', 'invalid_host');
  }
  const rawPort = src.port;
  const port = rawPort == null || rawPort === '' ? 21 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw fail('Der Port muss zwischen 1 und 65535 liegen.', 'invalid_port');
  }
  let user = String(src.user == null ? '' : src.user).trim();
  if (user.length > 128 || /[\r\n\0]/.test(user)) {
    throw fail('Benutzername ungültig.', 'invalid_user');
  }
  if (!user) user = 'anonymous';
  const password = src.password == null ? '' : String(src.password);
  if (password.length > 256 || /[\r\n\0]/.test(password)) {
    throw fail('Passwort ungültig.', 'invalid_password');
  }
  return {
    host,
    port,
    user,
    password,
    remotePath: normalizeRemoteDir(src.path != null ? src.path : src.remote_path),
  };
}

function publicFtpError(err) {
  const msg = err && err.message ? String(err.message) : 'FTP-Fehler';
  return msg.replace(/pass(?:word)?\s*[=:]\s*\S+/gi, 'password=***').slice(0, 300);
}

module.exports = {
  parseFtpTarget,
  normalizeRemoteDir,
  parentRemoteDir,
  assertRemoteFileName,
  publicFtpError,
};
