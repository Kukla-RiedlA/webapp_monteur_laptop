/**
 * electron-updater: Feed vom Dispo-Server (generic), UX per Plan, TLS wie Dispo-Proxys.
 */
const { app, dialog } = require('electron');
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
let allowInsecureTls = false;
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

function writeUserAppConfig(patch) {
  try {
    const userConfigPath = path.join(app.getPath('userData'), 'app_config.json');
    const cur = readJsonFileSafe(userConfigPath) || {};
    Object.assign(cur, patch);
    fs.writeFileSync(userConfigPath, JSON.stringify(cur, null, 2), 'utf8');
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

function normalizeFeedBase(dispoBase) {
  const base = (dispoBase || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return base + '/api/laptop_release_feed.php/';
}

function applyInsecureTlsToProcess(on) {
  if (on) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
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
  if (feedBaseUrl) return feedBaseUrl;
  const userCfg = readJsonFileSafe(path.join(app.getPath('userData'), 'app_config.json'));
  const fromCfg =
    userCfg && typeof userCfg.laptopUpdateFeedBase === 'string' ? userCfg.laptopUpdateFeedBase.trim() : '';
  if (fromCfg) return fromCfg.endsWith('/') ? fromCfg : fromCfg + '/';
  return '';
}

function applyFeedUrl(url) {
  const u = (url || '').trim();
  if (!u) return false;
  feedBaseUrl = u.endsWith('/') ? u : u + '/';
  applyInsecureTlsToProcess(allowInsecureTls);
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
      latestVersionLabel = String(info.version);
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
  allowInsecureTls = !!insecureTls;
  const feed = normalizeFeedBase(dispoBase);
  if (!feed) return { ok: false, error: 'empty_base' };
  writeUserAppConfig({
    laptopUpdateFeedBase: feed,
    laptopUpdateCheckUrl: '',
  });
  feedBaseUrl = feed;
  applyInsecureTlsToProcess(allowInsecureTls);
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

module.exports = {
  initLaptopUpdater,
  setUpdateFeedFromDispoBase,
  checkForUpdatesNow,
  startDownload,
  installUpdateNow: () => {
    autoUpdater.quitAndInstall(false, true);
  },
  readAppVersionLabel,
};
