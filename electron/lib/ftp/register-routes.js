'use strict';

const { parseFtpTarget, assertRemoteFileName, publicFtpError } = require('./validate');
const { listFtpDirectory, downloadFtpFiles } = require('./client');
const { isParameterListBuffer } = require('./classify');
const { listLocalDirectory, saveLocalFile } = require('./local-dir');

const MAX_FILES = 40;

function wantsAnlagenstamm(body) {
  const flag = body && body.save_to_anlagenstamm;
  return flag === true || flag === 1 || flag === '1';
}

function registerFtpRoutes(app, deps) {
  const assignParameterList = deps && deps.assignParameterList;

  app.post('/api/ftp/local-list', (req, res) => {
    try {
      const listed = listLocalDirectory(req.body && req.body.path);
      res.json({ ok: true, path: listed.path, parent: listed.parent, entries: listed.entries });
    } catch (err) {
      res.status(400).json({ ok: false, error: publicFtpError(err) });
    }
  });

  app.post('/api/ftp/list', async (req, res) => {
    try {
      const target = parseFtpTarget(req.body || {});
      const entries = await listFtpDirectory(target);
      res.json({ ok: true, path: target.remotePath, entries });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: publicFtpError(err),
        code: (err && err.code) || 'ftp_failed',
      });
    }
  });

  app.post('/api/ftp/download', async (req, res) => {
    try {
      const body = req.body || {};
      const target = parseFtpTarget(body);
      const rawNames = Array.isArray(body.names) ? body.names : [];
      if (!rawNames.length) {
        return res.status(400).json({ ok: false, error: 'Keine Dateien ausgewählt.' });
      }
      if (rawNames.length > MAX_FILES) {
        return res.status(400).json({ ok: false, error: 'Zu viele Dateien auf einmal.' });
      }
      const names = rawNames.map((name) => assertRemoteFileName(name));
      const saveToAnlagenstamm = wantsAnlagenstamm(body);
      const localDir = body.local_dir != null ? String(body.local_dir) : '';
      const jobId = parseInt(body.job_id != null ? body.job_id : body.jobId, 10);
      const downloaded = await downloadFtpFiles(target, names);
      const files = [];
      for (const item of downloaded) {
        if (!item.ok) {
          files.push({ name: item.name, ok: false, error: item.error || 'Download fehlgeschlagen' });
          continue;
        }
        if (!item.buffer || !item.buffer.length) {
          files.push({ name: item.name, ok: false, error: 'Datei ist leer.' });
          continue;
        }
        try {
          const isParam = isParameterListBuffer(item.name, item.buffer);
          if (isParam && saveToAnlagenstamm) {
            if (!jobId) {
              files.push({ name: item.name, ok: false, kind: 'parameterliste', error: 'Bitte einen Auftrag wählen.' });
              continue;
            }
            const assigned = await assignParameterList(req, {
              jobId,
              filename: item.name,
              buffer: item.buffer,
              remotePath: target.remotePath,
            });
            files.push({
              name: item.name,
              ok: !!(assigned && assigned.ok),
              kind: 'parameterliste',
              destination: 'anlagenstamm',
              fab: assigned && assigned.fab_used != null ? String(assigned.fab_used) : '',
              saved_path: assigned && assigned.savedCsv ? assigned.savedCsv : '',
              saved_pdf: assigned && assigned.savedPdf ? assigned.savedPdf : '',
              error: assigned && assigned.ok ? undefined : (assigned && assigned.error) || 'Zuordnung fehlgeschlagen',
            });
            continue;
          }
          if (!localDir.trim()) {
            files.push({
              name: item.name,
              ok: false,
              kind: isParam ? 'parameterliste' : 'datei',
              error: 'Bitte links einen Ordner wählen.',
            });
            continue;
          }
          const saved = saveLocalFile(localDir, item.name, item.buffer);
          files.push({
            name: item.name,
            ok: true,
            kind: isParam ? 'parameterliste' : 'datei',
            destination: 'lokal',
            saved_path: saved.path,
          });
        } catch (fileErr) {
          files.push({ name: item.name, ok: false, error: publicFtpError(fileErr) });
        }
      }
      res.json({ ok: true, path: target.remotePath, files });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: publicFtpError(err),
        code: (err && err.code) || 'ftp_failed',
      });
    }
  });
}

module.exports = { registerFtpRoutes, MAX_FILES };
