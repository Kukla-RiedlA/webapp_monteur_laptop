'use strict';

/**
 * Hover-Vorschau (JPEG-Cache neben dem Jobordner, nicht im Beleg-Ordner).
 * Abschalten: process.env.KUKLA_FILE_PREVIEW_HOVER=0
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function jobFilesRoot(cacheRoot, jobId) {
  return path.join(String(cacheRoot || ''), String(jobId));
}

const MAX_EDGE = 1100;
const JPEG_Q = 80;
const PDF_TIMEOUT_MS = 4000;
const CACHE_DIR = '.kukla_file_previews';
const MEM_JPEG_MAX = 48;
const memJpeg = new Map();
const inflightJpeg = new Map();
let pdftoppmCached = undefined;

function previewHoverEnabled() {
  const v = String(process.env.KUKLA_FILE_PREVIEW_HOVER || '').trim().toLowerCase();
  if (v === '0' || v === 'off' || v === 'false' || v === 'no') return false;
  return true;
}

function extOf(filename) {
  return path.extname(String(filename || '')).replace(/^\./, '').toLowerCase();
}

function isRaster(filename) {
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(extOf(filename));
}

function isPdf(filename) {
  return extOf(filename) === 'pdf';
}

function isSupported(filename) {
  return isRaster(filename) || isPdf(filename);
}

function sanitizeBase(name) {
  return String(name || 'file').replace(/[^A-Za-z0-9._-]+/g, '_') || 'file';
}

function previewPaths(originalPath) {
  const real = originalPath;
  const bucketDir = path.dirname(real);
  const jobDir = path.dirname(bucketDir);
  const bucket = path.basename(bucketDir);
  if (!bucket || bucket === CACHE_DIR) return null;
  let mtime = 0;
  try {
    mtime = Math.floor(fs.statSync(real).mtimeMs) || 0;
  } catch (_) {
    return null;
  }
  const dir = path.join(jobDir, CACHE_DIR, bucket);
  const base = path.join(dir, `${sanitizeBase(path.basename(real))}.${mtime}`);
  return { dir, jpg: `${base}.jpg`, txt: `${base}.txt` };
}

function deleteForOriginal(originalPath) {
  const p = previewPaths(originalPath);
  if (p) {
    for (const f of [p.jpg, p.txt]) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (_) {}
    }
    return;
  }
  try {
    const bucketDir = path.dirname(originalPath);
    const dir = path.join(path.dirname(bucketDir), CACHE_DIR, path.basename(bucketDir));
    const prefix = sanitizeBase(path.basename(originalPath));
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(prefix + '.')) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch (_) {}
      }
    }
  } catch (_) {}
}

function writeRasterJpeg(srcPath, destJpg) {
  let img = null;
  try {
    const nativeImage = require('electron').nativeImage;
    img = nativeImage.createFromPath(srcPath);
    if (img.isEmpty()) {
      img = nativeImage.createFromBuffer(fs.readFileSync(srcPath));
    }
  } catch (_) {
    img = null;
  }
  if (img && !img.isEmpty()) {
    const size = img.getSize();
    const w = size.width || 0;
    const h = size.height || 0;
    if (w > 0 && h > 0) {
      const scale = Math.min(MAX_EDGE / w, MAX_EDGE / h, 1);
      const tw = Math.max(1, Math.round(w * scale));
      const resized = scale < 1 ? img.resize({ width: tw, quality: 'better' }) : img;
      const buf = resized.toJPEG(JPEG_Q);
      if (buf && buf.length) {
        const tmp = destJpg + '.tmp';
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, destJpg);
        if (fs.existsSync(destJpg)) return true;
      }
    }
  }
  const ext = extOf(srcPath);
  if (ext === 'jpg' || ext === 'jpeg') {
    try {
      fs.copyFileSync(srcPath, destJpg);
      return fs.existsSync(destJpg);
    } catch (_) {}
  }
  return false;
}

function findPdftoppm() {
  if (pdftoppmCached !== undefined) return pdftoppmCached;
  const cands = [
    'C:\\Program Files\\Git\\usr\\bin\\pdftoppm.exe',
    'C:\\Program Files\\poppler\\Library\\bin\\pdftoppm.exe',
    'C:\\poppler\\Library\\bin\\pdftoppm.exe',
    '/usr/bin/pdftoppm',
  ];
  const pathDirs = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    cands.push(path.join(dir, process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm'));
  }
  for (const b of cands) {
    try {
      if (b && fs.existsSync(b)) {
        pdftoppmCached = b;
        return b;
      }
    } catch (_) {}
  }
  pdftoppmCached = '';
  return '';
}

function writePdfJpeg(srcPath, destJpg) {
  return new Promise((resolve) => {
    const bin = findPdftoppm();
    if (!bin) return resolve(false);
    const os = require('os');
    const prefix = path.join(os.tmpdir(), 'kuklapv' + Math.random().toString(16).slice(2, 10));
    const args = ['-f', '1', '-l', '1', '-jpeg', '-scale-to', String(MAX_EDGE), srcPath, prefix];
    let done = false;
    const cleanupTmp = () => {
      try {
        const dir = path.dirname(prefix);
        const base = path.basename(prefix);
        for (const name of fs.readdirSync(dir)) {
          if (name.startsWith(base)) {
            try {
              fs.unlinkSync(path.join(dir, name));
            } catch (_) {}
          }
        }
      } catch (_) {}
    };
    const finish = (ok) => {
      if (done) return;
      done = true;
      cleanupTmp();
      resolve(ok);
    };
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (_) {
      return finish(false);
    }
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
      finish(false);
    }, PDF_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(t);
      let src = prefix + '-1.jpg';
      if (!fs.existsSync(src)) {
        try {
          const dir = path.dirname(prefix);
          const base = path.basename(prefix);
          const hit = fs.readdirSync(dir).find((n) => n.startsWith(base) && n.endsWith('.jpg'));
          if (hit) src = path.join(dir, hit);
        } catch (_) {}
      }
      if (code === 0 && src && fs.existsSync(src)) {
        try {
          fs.copyFileSync(src, destJpg);
          cleanupTmp();
          done = true;
          resolve(true);
          return;
        } catch (_) {}
      }
      finish(false);
    });
    child.on('error', () => {
      clearTimeout(t);
      finish(false);
    });
  });
}

async function ensureSidecar(originalPath) {
  if (!previewHoverEnabled()) return null;
  if (!originalPath || !fs.existsSync(originalPath)) return null;
  const name = path.basename(originalPath);
  if (!isSupported(name)) return null;
  const p = previewPaths(originalPath);
  if (!p) return null;
  try {
    if (fs.existsSync(p.jpg) && fs.statSync(p.jpg).size > 32) return p.jpg;
  } catch (_) {}
  fs.mkdirSync(p.dir, { recursive: true });
  let ok = false;
  if (isRaster(name)) {
    try {
      ok = writeRasterJpeg(originalPath, p.jpg);
    } catch (_) {
      ok = false;
    }
  } else if (isPdf(name)) {
    try {
      ok = await writePdfJpeg(originalPath, p.jpg);
    } catch (_) {
      ok = false;
    }
  }
  if (ok && fs.existsSync(p.jpg)) return p.jpg;
  try {
    if (fs.existsSync(p.jpg)) fs.unlinkSync(p.jpg);
  } catch (_) {}
  return null;
}

function generateInBackground(originalPath) {
  if (!previewHoverEnabled()) return;
  setImmediate(() => {
    ensureSidecar(originalPath).catch(() => {});
  });
}

function sendJpeg(res, jpgPath) {
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=120');
  res.setHeader('X-Kukla-File-Preview', '1');
  res.sendFile(path.resolve(jpgPath));
}

function sendJpegBuffer(res, buf) {
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=120');
  res.setHeader('X-Kukla-File-Preview', '1');
  res.send(buf);
}

function isJpegBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length > 32 && buf[0] === 0xff && buf[1] === 0xd8;
}

function remoteCacheJpg(cacheRoot, jobId, key) {
  if (!cacheRoot || !jobId || !key) return '';
  return path.join(jobFilesRoot(cacheRoot, jobId), CACHE_DIR, '_remote', `${sanitizeBase(key)}.jpg`);
}

function tryExistingJpg(jpgPath) {
  try {
    if (jpgPath && fs.existsSync(jpgPath) && fs.statSync(jpgPath).size > 32) return jpgPath;
  } catch (_) {}
  return null;
}

function writeJpgAtomic(destJpg, buf) {
  if (!destJpg || !isJpegBuffer(buf)) return false;
  try {
    fs.mkdirSync(path.dirname(destJpg), { recursive: true });
    const tmp = destJpg + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, destJpg);
    return fs.existsSync(destJpg);
  } catch (_) {
    return false;
  }
}

function memGetJpeg(url) {
  if (!url || !memJpeg.has(url)) return null;
  const buf = memJpeg.get(url);
  memJpeg.delete(url);
  memJpeg.set(url, buf);
  return buf;
}

function memSetJpeg(url, buf) {
  if (!url || !isJpegBuffer(buf)) return;
  if (memJpeg.has(url)) memJpeg.delete(url);
  memJpeg.set(url, buf);
  while (memJpeg.size > MEM_JPEG_MAX) {
    const first = memJpeg.keys().next().value;
    memJpeg.delete(first);
  }
}

function existingLocalSidecar(originalPath) {
  if (!originalPath || !fs.existsSync(originalPath)) return null;
  const p = previewPaths(originalPath);
  return p ? tryExistingJpg(p.jpg) : null;
}

async function fetchRemoteJpeg(dispoProxy, urlPath) {
  if (!dispoProxy || typeof dispoProxy.fetchDispo !== 'function' || !urlPath) return null;
  const hit = memGetJpeg(urlPath);
  if (hit) return hit;
  if (inflightJpeg.has(urlPath)) return inflightJpeg.get(urlPath);
  const work = (async () => {
    try {
      const { res } = await dispoProxy.fetchDispo(urlPath, {
        method: 'GET',
        timeoutMs: 25000,
        onlyActiveBase: true,
      });
      if (!res || !res.ok) {
        console.warn('[file-preview] Dispo HTTP', res && res.status, urlPath);
        return null;
      }
      const ct = String(res.headers.get('content-type') || '').toLowerCase();
      if (ct && !ct.includes('image/jpeg') && !ct.includes('image/jpg') && !ct.includes('octet-stream')) {
        console.warn('[file-preview] Dispo kein JPEG', ct, urlPath);
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!isJpegBuffer(buf)) {
        console.warn('[file-preview] Dispo Antwort ist kein JPEG', urlPath);
        return null;
      }
      memSetJpeg(urlPath, buf);
      return buf;
    } catch (err) {
      console.warn('[file-preview] Dispo-Fetch fehlgeschlagen', urlPath, err && err.message ? err.message : err);
      return null;
    }
  })();
  inflightJpeg.set(urlPath, work);
  try {
    return await work;
  } finally {
    inflightJpeg.delete(urlPath);
  }
}

function sendMeta(res, previewable, text) {
  res.status(previewable ? 200 : 415).json({
    ok: previewable,
    previewable,
    text: text || '',
  });
}

function readTextSidecar(originalPath) {
  const p = previewPaths(originalPath);
  if (!p || !fs.existsSync(p.txt)) return '';
  try {
    return fs.readFileSync(p.txt, 'utf8');
  } catch (_) {
    return '';
  }
}

async function handlePreviewRequest(res, originalPath, wantMeta, remote) {
  if (!previewHoverEnabled()) {
    res.status(204).end();
    return;
  }
  const remoteOpts = remote && typeof remote === 'object' ? remote : null;
  const cacheJpg = remoteOpts && remoteOpts.cacheJpg ? String(remoteOpts.cacheJpg) : '';
  const remoteUrl = remoteOpts && remoteOpts.url ? String(remoteOpts.url) : '';

  const localSidecar = existingLocalSidecar(originalPath);
  if (localSidecar) {
    if (wantMeta) {
      sendMeta(res, true, readTextSidecar(originalPath));
      return;
    }
    sendJpeg(res, localSidecar);
    return;
  }
  const cachedRemote = tryExistingJpg(cacheJpg);
  if (cachedRemote) {
    if (wantMeta) {
      sendMeta(res, true, '');
      return;
    }
    sendJpeg(res, cachedRemote);
    return;
  }
  const memHit = remoteUrl ? memGetJpeg(remoteUrl) : null;
  if (memHit) {
    if (wantMeta) {
      sendMeta(res, true, '');
      return;
    }
    sendJpegBuffer(res, memHit);
    return;
  }

  if (wantMeta) {
    sendMeta(res, true, '');
    return;
  }

  /* Lokale Datei schon da: JPEG hier erzeugen. Originale werden nicht über WAN geholt. */
  if (originalPath && fs.existsSync(originalPath) && isSupported(path.basename(originalPath))) {
    try {
      const jpg = await ensureSidecar(originalPath);
      if (jpg) {
        sendJpeg(res, jpg);
        return;
      }
    } catch (err) {
      console.warn('[file-preview] lokale Erzeugung fehlgeschlagen', originalPath, err && err.message);
    }
  }

  if (remoteOpts && remoteOpts.proxy && remoteUrl) {
    const buf = await fetchRemoteJpeg(remoteOpts.proxy, remoteUrl);
    if (buf) {
      if (originalPath && fs.existsSync(originalPath) && isSupported(path.basename(originalPath))) {
        const p = previewPaths(originalPath);
        if (p) writeJpgAtomic(p.jpg, buf);
      }
      if (cacheJpg) writeJpgAtomic(cacheJpg, buf);
      sendJpegBuffer(res, buf);
      return;
    }
  }

  res.status(404).json({ ok: false, previewable: false, error: 'preview_unavailable' });
}

module.exports = {
  previewHoverEnabled,
  isSupported,
  ensureSidecar,
  generateInBackground,
  deleteForOriginal,
  handlePreviewRequest,
  remoteCacheJpg,
  jobFilesRoot,
};
