'use strict';

const Busboy = require('busboy');

/**
 * Parst multipart/form-data (FormData aus anlagenstamm.js).
 */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = [];
    const bb = Busboy({ headers: req.headers });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (d) => chunks.push(d));
      stream.on('end', () => {
        files.push({
          field: name,
          filename: info.filename,
          mimeType: info.mimeType,
          buffer: Buffer.concat(chunks),
        });
      });
    });
    bb.on('field', (name, val) => {
      fields[name] = val;
    });
    bb.on('close', () => resolve({ fields, files }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

module.exports = { parseMultipart };
