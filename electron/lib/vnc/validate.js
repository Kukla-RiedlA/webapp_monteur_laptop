'use strict';

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp('^' + OCTET + '(?:\\.' + OCTET + '){3}$');

function parseVncTarget(input) {
  const src = input || {};
  const host = String(src.host == null ? '' : src.host).trim();
  if (!IPV4.test(host)) {
    const err = new Error('Bitte eine IPv4-Adresse eingeben.');
    err.code = 'invalid_host';
    throw err;
  }
  const rawPort = src.port;
  const port = rawPort == null || rawPort === '' ? 5900 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const err = new Error('Der Port muss zwischen 1 und 65535 liegen.');
    err.code = 'invalid_port';
    throw err;
  }
  return { host, port };
}

module.exports = { parseVncTarget };
