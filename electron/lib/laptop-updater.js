/**
 * electron-updater: Feed vom Dispo-Server (generic), UX per Plan, TLS wie Dispo-Proxys.
 */
const { app, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let mainWindowGetter = () => null;
let updateHintDialogShown = false;
let sessionUpdatePromptShown = false;
let lastCheckWasManual = false;
let pendingInstallOnQuit = false;
let latestVersionLabel = '';
let feedBaseUrl = '';
let allowInsecureTls = true;
let certificateVerifyProcInstalled = false;
const trustedInsecureHosts = new Set();
let feedCheckDebounce = null;
let periodicCheckTimer = null;
let updateCheckInFlight = null;
let lastAutoCheckStartedAt = 0;
let lastFeedScheduledCheckAt = 0;

const AUTO_CHECK_AFTER_FEED_MS = 2000;
const PERIODIC_UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;
const MIN_AUTO_UPDATE_CHECK_MS = 30 * 60 * 1000;

function readJsonFileSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch (e) {
    return null;
  }
}

/** Gleicher Speicherort wie server.js (userData/db) + Legacy userData/app_config.json. */
function userAppConfigPaths() {
  const root = app.getPath('userData');
  return [path.join(root, 'db', 'app_config.json'), path.join(root, 'app_config.json')];
}

function readMergedUserAppConfig() {
  const merged = {};
  for (const p of userAppConfigPaths()) {
    const part = readJsonFileSafe(p);
    if (part) Object.assign(merged, part);
  }
  return merged;
}

function writeUserAppConfig(patch) {
  try {
    const paths = userAppConfigPaths();
    for (const userConfigPath of paths) {
      const dir = path.dirname(userConfigPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const cur = readJsonFileSafe(userConfigPath) || {};
      Object.assign(cur, patch);
      fs.writeFileSync(userConfigPath, JSON.stringify(cur, null, 2), 'utf8');
    }
  } catch (e) {
    console.warn('[laptop-updater] app_config write:', e && e.message ? e.message : e);
  }
}

function readAppVersionLabel() {
  try {
    const file = path.join(__dirname, '..', 'version.json');
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    const v = data && typeof data.version === 'string' ? data.version.trim() : '';
    return v || 'V 0.000';
  } catch (e) {
    return 'V 0.000';
  }
}

/** SemVer aus latest.yml (z. B. 1.4.61) → Kukla-Label wie version.json (V 1.004.061). */
function formatUpdateVersionLabel(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const kukla = s.match(/^\s*V\s+(\d+)\.(\d{3})\.(\d{3})\s*$/i);
  if (kukla) return `V ${kukla[1]}.${kukla[2]}.${kukla[3]}`;
  const semver = s.replace(/^\s*[vV]\s*/, '');
  const m = semver.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return s.startsWith('V') ? s : `V ${s}`;
  const maj = m[1];
  const rel = String(parseInt(m[2], 10)).padStart(3, '0');
  const pat = String(parseInt(m[3], 10)).padStart(3, '0');
  return `V ${maj}.${rel}.${pat}`;
}

function normalizeFeedBase(dispoBase) {
  const base = (dispoBase || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return base + '/api/laptop_release_feed.php/';
}

function isPrivateLanHost(hostname) {
  const h = (hostname || '').toString().trim().toLowerCase();
  if (!h || h === 'localhost' || h === '127.0.0.1') return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

function rememberInsecureHostsFromUrl(url) {
  const raw = (url || '').toString().trim();
  if (!raw) return;
  try {
    const u = new URL(raw.includes('://') ? raw : 'https://' + raw.replace(/^\/+/, ''));
    if (u.hostname) trustedInsecureHosts.add(u.hostname.toLowerCase());
  } catch (_) {
    /* ignore */
  }
}

function shouldTrustCertificate(hostname) {
  const h = (hostname || '').toLowerCase();
  if (!h) return false;
  if (trustedInsecureHosts.has(h)) return true;
  if (isPrivateLanHost(h)) return true;
  if (/\.kukla\.co\.at$/i.test(h) || h === 'kukla.co.at') return true;
  return false;
}

function installCertificateVerifyProc() {
  if (certificateVerifyProcInstalled || !session || !session.defaultSession) return;
  certificateVerifyProcInstalled = true;
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const host = (request && request.hostname) || '';
    // Whitelist-Hosts oder (bei leerem Hostname) insecure-TLS: akzeptieren.
    // Electron liefert hostname manchmal leer — dann trotzdem insecure erlauben.
    if (shouldTrustCertificate(host) || (allowInsecureTls && !host)) {
      callback(0);
      return;
    }
    if (allowInsecureTls) {
      callback(0);
      return;
    }
    callback(-3);
  });
}

function isInsecureTlsAllowed() {
  return !!allowInsecureTls;
}

/** Selbstsigniertes Dispo-HTTPS (Kukla-Standard) — vor jedem Update-Check. */
function ensureUpdaterTlsReady(feedUrl) {
  allowInsecureTls = true;
  if (feedUrl) rememberInsecureHostsFromUrl(feedUrl);
  if (feedBaseUrl) rememberInsecureHostsFromUrl(feedBaseUrl);
  applyInsecureTlsToProcess(true);
  installCertificateVerifyProc();
}

function applyInsecureTlsToProcess(on) {
  allowInsecureTls = !!on;
  if (on) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    installCertificateVerifyProc();
  } else if (process.env.KUKLA_DISP_TLS_INSECURE !== '1') {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  }
}

function downloadProgressPayload(progress) {
  if (!progress || typeof progress !== 'object') {
    return { percent: 0 };
  }
  const transferred = Number(progress.transferred);
  const total = Number(progress.total);
  let percent = null;
  if (typeof progress.percent === 'number' && Number.isFinite(progress.percent)) {
    percent = Math.round(progress.percent);
  } else if (Number.isFinite(transferred) && Number.isFinite(total) && total > 0) {
    percent = Math.round((transferred / total) * 100);
  }
  return {
    percent: percent != null ? percent : 0,
    transferred: Number.isFinite(transferred) ? transferred : null,
    total: Number.isFinite(total) ? total : null,
    bytesPerSecond: progress.bytesPerSecond != null ? Math.round(progress.bytesPerSecond) : null,
  };
}

function sendStatus(state, extra) {
  const payload = Object.assign(
    {
      state,
      installedVersion: readAppVersionLabel(),
      latestVersion: latestVersionLabel,
    },
    extra || {},
  );
  const win = mainWindowGetter();
  if (win && !win.isDestroyed()) {
    win.webContents.send('laptop:update-status', payload);
  }
}

function buildFeedUrl() {
  if (feedBaseUrl) {
    ensureUpdaterTlsReady(feedBaseUrl);
    return feedBaseUrl;
  }
  const userCfg = readMergedUserAppConfig();
  const fromCfg =
    userCfg && typeof userCfg.laptopUpdateFeedBase === 'string' ? userCfg.laptopUpdateFeedBase.trim() : '';
  if (fromCfg) {
    const feed = fromCfg.endsWith('/') ? fromCfg : fromCfg + '/';
    ensureUpdaterTlsReady(feed);
    return feed;
  }
  return '';
}

function applyFeedUrl(url) {
  const u = (url || '').trim();
  if (!u) return false;
  feedBaseUrl = u.endsWith('/') ? u : u + '/';
  ensureUpdaterTlsReady(feedBaseUrl);
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: feedBaseUrl,
  });
  return true;
}

function shouldShowUpdateAvailableDialog() {
  if (updateHintDialogShown) return false;
  return lastCheckWasManual || !sessionUpdatePromptShown;
}

async function showUpdateAvailableDialog() {
  if (!shouldShowUpdateAvailableDialog()) return;
  updateHintDialogShown = true;
  sessionUpdatePromptShown = true;
  const installed = readAppVersionLabel();
  const btn = await dialog.showMessageBox(mainWindowGetter() || undefined, {
    type: 'info',
    buttons: ['Jetzt aktualisieren', 'Später'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update verfügbar',
    message: 'Eine neuere Version der Monteur WebApp ist auf dem Server verfügbar.',
    detail:
      'Installiert: ' +
      installed +
      '\nNeu: ' +
      (latestVersionLabel || 'unbekannt') +
      '\n\nDas Update wird nur nach Ihrer Bestätigung heruntergeladen.',
  });
  if (btn && btn.response === 0) {
    await startDownload();
  }
}

async function showUpdateReadyDialog() {
  const installed = readAppVersionLabel();
  const btn = await dialog.showMessageBox(mainWindowGetter() || undefined, {
    type: 'info',
    buttons: ['Jetzt installieren', 'Beim Beenden installieren', 'Später'],
    defaultId: 0,
    cancelId: 2,
    title: 'Update bereit',
    message: 'Das Update wurde heruntergeladen und kann jetzt installiert werden.',
    detail:
      'Die App wird kurz geschlossen. Der Installationsassistent startet automatisch.\n\nInstalliert: ' +
      installed +
      '\nNeu: ' +
      (latestVersionLabel || 'unbekannt'),
  });
  if (btn.response === 0) {
    pendingInstallOnQuit = false;
    autoUpdater.quitAndInstall(false, true);
  } else if (btn.response === 1) {
    pendingInstallOnQuit = true;
    autoUpdater.autoInstallOnAppQuit = true;
    sendStatus('ready', { installOnQuit: true });
  }
}

async function startDownload() {
  if (!buildFeedUrl()) {
    sendStatus('error', { message: 'Keine Dispo-Basis-URL für Updates.' });
    return;
  }
  sendStatus('downloading', { percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    sendStatus('error', { message: e && e.message ? e.message : String(e) });
    await dialog.showMessageBox(mainWindowGetter() || undefined, {
      type: 'warning',
      buttons: ['OK'],
      title: 'Update fehlgeschlagen',
      message: 'Das Update konnte nicht geladen werden.',
      detail:
        (e && e.message ? e.message : String(e)) +
        '\n\nPrüfen Sie die Verbindung zur Dispo und ob ein Release aktiv ist.',
    });
  }
}

function initLaptopUpdater(opts) {
  if (!app.isPackaged) return;

  mainWindowGetter = opts.getMainWindow || (() => null);
  ensureUpdaterTlsReady();

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Unter Windows feuert download-progress bei Differential-Updates oft nicht (bleibt 0 %).
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.logger = null;

  autoUpdater.on('update-not-available', () => {
    latestVersionLabel = '';
    sendStatus('not-available');
  });

  autoUpdater.on('update-available', (info) => {
    if (info && info.version) {
      latestVersionLabel = formatUpdateVersionLabel(info.version);
    }
    sendStatus('available');
    showUpdateAvailableDialog().catch((e) => {
      console.warn('[laptop-updater] dialog:', e && e.message ? e.message : e);
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendStatus('downloading', downloadProgressPayload(progress));
  });

  autoUpdater.on('update-downloaded', () => {
    sendStatus('ready');
    showUpdateReadyDialog();
  });

  autoUpdater.on('error', (err) => {
    console.warn('[laptop-updater]', err && err.message ? err.message : err);
    sendStatus('error', { message: err && err.message ? err.message : String(err) });
  });

  const existingFeed = buildFeedUrl();
  if (existingFeed) {
    applyFeedUrl(existingFeed);
    scheduleCheckAfterFeedSet();
  }
  schedulePeriodicUpdateChecks();
}

function schedulePeriodicUpdateChecks() {
  if (!app.isPackaged) return;
  if (periodicCheckTimer) return;
  periodicCheckTimer = setInterval(() => {
    checkForUpdatesNow({ source: 'periodic' }).catch((e) => {
      console.warn('[laptop-updater] periodic:', e && e.message ? e.message : e);
    });
  }, PERIODIC_UPDATE_CHECK_MS);
}

function scheduleCheckAfterFeedSet() {
  if (!app.isPackaged) return;
  const now = Date.now();
  if (lastFeedScheduledCheckAt > 0 && now - lastFeedScheduledCheckAt < MIN_AUTO_UPDATE_CHECK_MS) return;
  lastFeedScheduledCheckAt = now;
  if (feedCheckDebounce) clearTimeout(feedCheckDebounce);
  feedCheckDebounce = setTimeout(() => {
    feedCheckDebounce = null;
    checkForUpdatesNow({ source: 'feed' }).catch((e) => {
      console.warn('[laptop-updater] after feed:', e && e.message ? e.message : e);
    });
  }, AUTO_CHECK_AFTER_FEED_MS);
}

function setUpdateFeedFromDispoBase(dispoBase, insecureTls) {
  if (!app.isPackaged) return { ok: false, skipped: true };
  const feed = normalizeFeedBase(dispoBase);
  if (!feed) return { ok: false, error: 'empty_base' };
  rememberInsecureHostsFromUrl(feed);
  rememberInsecureHostsFromUrl(dispoBase);
  writeUserAppConfig({
    laptopUpdateFeedBase: feed,
    laptopUpdateCheckUrl: '',
    laptopUpdateAllowInsecureTls: true,
    acceptSelfSignedDispoTls: true,
  });
  feedBaseUrl = feed;
  ensureUpdaterTlsReady(feed);
  applyFeedUrl(feed);
  scheduleCheckAfterFeedSet();
  schedulePeriodicUpdateChecks();
  return { ok: true, feed };
}

async function checkForUpdatesNow(opts) {
  opts = opts && typeof opts === 'object' ? opts : {};
  if (!app.isPackaged) return { ok: false, skipped: true };
  if (!applyFeedUrl(buildFeedUrl())) {
    return { ok: false, error: 'no_feed' };
  }
  if (updateCheckInFlight) return { ok: false, skipped: true, reason: 'check_in_flight' };
  lastCheckWasManual = !!opts.manual;
  if (opts.manual) {
    updateHintDialogShown = false;
  } else {
    const now = Date.now();
    if (lastAutoCheckStartedAt > 0 && now - lastAutoCheckStartedAt < MIN_AUTO_UPDATE_CHECK_MS) {
      return { ok: false, skipped: true, reason: 'auto_check_throttled' };
    }
    lastAutoCheckStartedAt = now;
  }
  sendStatus('checking', { manual: !!opts.manual });
  updateCheckInFlight = autoUpdater.checkForUpdates();
  try {
    const result = await updateCheckInFlight;
    return { ok: true, result };
  } catch (e) {
    sendStatus('error', { message: e && e.message ? e.message : String(e) });
    return { ok: false, error: e && e.message ? e.message : String(e) };
  } finally {
    updateCheckInFlight = null;
  }
}

function trustCertificateForUrl(url) {
  try {
    const u = new URL(url.includes('://') ? url : 'https://' + url.replace(/^\/+/, ''));
    return shouldTrustCertificate(u.hostname);
  } catch (_) {
    return false;
  }
}

module.exports = {
  initLaptopUpdater,
  setUpdateFeedFromDispoBase,
  checkForUpdatesNow,
  startDownload,
  installUpdateNow: () => {
    autoUpdater.quitAndInstall(false, true);
  },
  readAppVersionLabel,
  formatUpdateVersionLabel,
  trustCertificateForUrl,
  isInsecureTlsAllowed,
};
