'use strict';

const { Writable } = require('stream');
const { Client } = require('basic-ftp');
const { publicFtpError } = require('./validate');

const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 20000;

function downloadOne(client, name) {
  const chunks = [];
  let size = 0;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        cb(new Error('Datei ist größer als 25 MB.'));
        return;
      }
      chunks.push(chunk);
      cb();
    },
  });
  return client.downloadTo(sink, name).then(() => Buffer.concat(chunks));
}

async function withFtpClient(target, fn) {
  const client = new Client(TIMEOUT_MS);
  client.ftp.verbose = false;
  try {
    await client.access({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      secure: false,
    });
    return await fn(client);
  } catch (err) {
    const wrapped = new Error(publicFtpError(err));
    wrapped.code = (err && err.code) || 'ftp_failed';
    throw wrapped;
  } finally {
    client.close();
  }
}

async function listFtpDirectory(target) {
  return withFtpClient(target, async (client) => {
    await client.cd(target.remotePath);
    const items = await client.list();
    const entries = [];
    for (const item of items || []) {
      const name = item && item.name ? String(item.name) : '';
      if (!name || name === '.' || name === '..') continue;
      entries.push({
        name,
        type: item.isDirectory ? 'dir' : 'file',
        size: Number(item.size) || 0,
      });
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'de');
    });
    return entries;
  });
}

async function downloadFtpFiles(target, names) {
  return withFtpClient(target, async (client) => {
    await client.cd(target.remotePath);
    const out = [];
    for (const name of names) {
      try {
        const buffer = await downloadOne(client, name);
        out.push({ name, ok: true, buffer });
      } catch (err) {
        out.push({ name, ok: false, error: publicFtpError(err) });
      }
    }
    return out;
  });
}

module.exports = {
  MAX_BYTES,
  listFtpDirectory,
  downloadFtpFiles,
};
