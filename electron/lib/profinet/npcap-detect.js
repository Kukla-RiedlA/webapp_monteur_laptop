'use strict';

const fs = require('fs');
const path = require('path');

const DOWNLOAD_URL = 'https://npcap.com/#download';

function detectNpcap() {
  const base = {
    installed: false,
    winpcap_mode: false,
    module_ready: false,
    ready: false,
    download_url: DOWNLOAD_URL,
    message: '',
  };
  if (process.platform !== 'win32') {
    base.message = 'Profinet-Scan läuft nur unter Windows mit installiertem Npcap (WinPcap-Modus).';
    return base;
  }
  const root = process.env.SystemRoot || 'C:\\Windows';
  const npcapDll = path.join(root, 'System32', 'Npcap', 'wpcap.dll');
  const compatDll = path.join(root, 'System32', 'wpcap.dll');
  base.installed = fs.existsSync(npcapDll) || fs.existsSync(compatDll);
  base.winpcap_mode = fs.existsSync(compatDll);
  if (base.winpcap_mode) {
    try {
      require('cap');
      base.module_ready = true;
    } catch (e) {
      base.module_ready = false;
      base.module_error = e && e.message ? String(e.message) : String(e);
    }
  }
  base.ready = base.installed && base.winpcap_mode && base.module_ready;
  if (!base.installed) {
    base.message = 'Npcap ist nicht installiert. Scan, Topologie, Blinken, Taufen und Umtaufen sind aus. Beim Installieren den WinPcap-Modus einschalten.';
  } else if (!base.winpcap_mode) {
    base.message = 'Npcap ist installiert, der WinPcap-Modus fehlt. Bitte Npcap erneut installieren und den WinPcap-Modus einschalten.';
  } else if (!base.module_ready) {
    base.message = 'Npcap ist vorhanden, das Aufnahmemodul in KUKpit ist nicht geladen. Scan und Taufen bleiben aus.';
  }
  return base;
}

module.exports = { detectNpcap, DOWNLOAD_URL };
