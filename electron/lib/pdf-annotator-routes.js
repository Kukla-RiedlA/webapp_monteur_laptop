'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { getPdfAnnotatorSession } = require('./pdf-annotator-sessions');
const { flattenPdfMarkup, suggestedAnnotatedPath } = require('./pdf-flatten-markup');

function pdfjsPackageDir() {
  try {
    return path.dirname(require.resolve('pdfjs-dist/package.json'));
  } catch (_) {
    return path.join(__dirname, '..', 'node_modules', 'pdfjs-dist');
  }
}

function pdfjsBuildDir() {
  return path.join(pdfjsPackageDir(), 'build');
}

function mountPdfjsStatic(app, urlPath, folderName) {
  const dir = path.join(pdfjsPackageDir(), folderName);
  if (!fs.existsSync(dir)) return;
  app.use(urlPath, express.static(dir, {
    maxAge: '1d',
    index: false,
    setHeaders(res, filePath) {
      if (/\.mjs$/i.test(filePath)) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      if (/\.wasm$/i.test(filePath)) res.setHeader('Content-Type', 'application/wasm');
    },
  }));
}

async function pickSavePath(session, defaultPath) {
  try {
    const { dialog, BrowserWindow } = require('electron');
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showSaveDialog(win || undefined, {
      title: 'Kommentierte PDF speichern',
      defaultPath: defaultPath || suggestedAnnotatedPath(session.sourcePath),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return '';
    return String(result.filePath);
  } catch (_) {
    return '';
  }
}

function registerPdfAnnotatorRoutes(app, opts) {
  const listReiseDirs = opts && typeof opts.listReiseDirs === 'function'
    ? opts.listReiseDirs
    : function () { return []; };

  function destOpts() {
    return { reiseDirs: listReiseDirs() || [] };
  }

  function destForSession(session) {
    return session.lastSavedPath || suggestedAnnotatedPath(session.sourcePath, destOpts());
  }

  mountPdfjsStatic(app, '/vendor/pdfjs', 'build');
  mountPdfjsStatic(app, '/vendor/pdfjs-cmaps', 'cmaps');
  mountPdfjsStatic(app, '/vendor/pdfjs-fonts', 'standard_fonts');
  mountPdfjsStatic(app, '/vendor/pdfjs-wasm', 'wasm');

  app.get('/api/pdf-annotator/session/:id', (req, res) => {
    const session = getPdfAnnotatorSession(req.params.id);
    if (!session) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json({
      ok: true,
      title: session.title,
      fileName: path.basename(session.sourcePath),
      suggestedName: path.basename(destForSession(session)),
    });
  });

  app.get('/api/pdf-annotator/file/:id', (req, res) => {
    const session = getPdfAnnotatorSession(req.params.id);
    if (!session) return res.status(404).json({ ok: false, error: 'not_found' });
    const filePath = session.viewPath || session.sourcePath;
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: 'file_missing' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.sendFile(path.resolve(filePath), (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ ok: false, error: 'read_failed' });
      }
    });
  });

  app.post('/api/pdf-annotator/save', async (req, res) => {
    try {
      const id = String((req.body && req.body.id) || '').trim();
      const session = getPdfAnnotatorSession(id);
      if (!session) return res.status(404).json({ ok: false, error: 'not_found' });
      let destPath = destForSession(session);
      if (req.body && req.body.saveAs) {
        destPath = await pickSavePath(session, destForSession(session));
        if (!destPath) return res.json({ ok: false, cancelled: true });
      }
      const sourcePath = session.viewPath && fs.existsSync(session.viewPath)
        ? session.viewPath
        : session.sourcePath;
      await flattenPdfMarkup({
        sourcePath,
        destPath,
        markup: req.body && req.body.markup,
      });
      session.lastSavedPath = destPath;
      return res.json({
        ok: true,
        path: destPath,
        fileName: path.basename(destPath),
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e && e.message ? e.message : String(e),
      });
    }
  });
}

module.exports = { registerPdfAnnotatorRoutes, pdfjsBuildDir, pdfjsPackageDir };
