(function () {
  'use strict';

  var STORE_KEY = 'kukla_vnc_target';
  var IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
  var REALVNC_MSG = 'Dieser VNC-Server spricht nur das RealVNC-Protokoll. Der eingebaute Viewer kann ihn nicht anzeigen.';
  var rfbCtor = null;
  var active = null;
  var sessionPassword = '';
  var errorTap = null;
  var busy = false;

  function apiBase() {
    if (window.monteurApp && window.monteurApp.apiBase) return String(window.monteurApp.apiBase);
    if (typeof monteurApp !== 'undefined' && monteurApp && monteurApp.apiBase) return String(monteurApp.apiBase);
    return 'http://127.0.0.1:39678';
  }

  function el(id) {
    return document.getElementById(id);
  }

  function setStatus(text) {
    var node = el('vncStatus');
    if (node) node.textContent = text || '';
  }

  function ensureErrorTap() {
    if (console.error && console.error.__kuklaVncTap) return;
    var orig = console.error.bind(console);
    function wrapped() {
      if (typeof errorTap === 'function') {
        try {
          var parts = [];
          for (var i = 0; i < arguments.length; i++) {
            parts.push(arguments[i] == null ? '' : String(arguments[i]));
          }
          errorTap(parts.join(' '));
        } catch (_) { /* Anzeige darf den Log nicht stoppen */ }
      }
      return orig.apply(console, arguments);
    }
    wrapped.__kuklaVncTap = true;
    console.error = wrapped;
  }

  function restoreFields() {
    var host = el('vncHost');
    var port = el('vncPort');
    var label = el('vncLabel');
    if (!host || !port || !label) return;
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (data && data.host) host.value = String(data.host);
      if (data && data.port) port.value = String(data.port);
      if (data && data.label) label.value = String(data.label);
    } catch (_) { /* alte oder leere Merkdaten */ }
  }

  function saveTarget(host, port, label) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        host: host,
        port: String(port),
        label: label || '',
      }));
    } catch (_) { /* Speicher voll oder gesperrt */ }
  }

  async function localApi(path, body) {
    var tech = typeof window.getTechId === 'function' ? window.getTechId() : 0;
    var url = apiBase().replace(/\/+$/, '') + path;
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Technician-Id': String(tech || ''),
      },
      body: JSON.stringify(body || {}),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || !data || data.ok === false) {
      var err = new Error((data && data.error) || 'Anfrage fehlgeschlagen');
      err.code = data && data.code;
      throw err;
    }
    return data;
  }

  async function loadRfb() {
    if (rfbCtor) return rfbCtor;
    var href = new URL('/vendor/novnc/rfb.js?v=20261015-8bit', apiBase().replace(/\/+$/, '') + '/').href;
    var mod = await import(href);
    var ctor = mod.default || mod.RFB || mod;
    if (ctor && typeof ctor !== 'function' && typeof ctor.default === 'function') ctor = ctor.default;
    rfbCtor = ctor;
    if (!rfbCtor) throw new Error('rfb_missing');
    return rfbCtor;
  }

  function unreachable(host, port) {
    return 'Keine Verbindung zu ' + host + ':' + port + '. Prüfen Sie IP, Port und ob die Elektronik eingeschaltet ist.';
  }

  function stopViewer() {
    sessionPassword = '';
    errorTap = null;
    if (!active) {
      setStatus('Nicht verbunden');
      return;
    }
    active.intentional = true;
    var client = active.client;
    active = null;
    try { client.disconnect(); } catch (_) { /* Socket schon zu */ }
    setStatus('Nicht verbunden');
  }

  async function connect() {
    if (busy) return;
    var hostInput = el('vncHost');
    var portInput = el('vncPort');
    var labelInput = el('vncLabel');
    var passwordInput = el('vncPassword');
    var host = hostInput ? hostInput.value.trim() : '';
    var portRaw = portInput ? String(portInput.value).trim() : '';
    var label = labelInput ? labelInput.value.trim() : '';
    var password = passwordInput ? passwordInput.value : '';
    if (!IPV4.test(host)) {
      setStatus('Bitte eine IPv4-Adresse eingeben.');
      return;
    }
    var port = portRaw === '' ? 5900 : Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setStatus('Der Port muss zwischen 1 und 65535 liegen.');
      return;
    }
    if (passwordInput) passwordInput.value = '';
    saveTarget(host, port, label);
    stopViewer();
    busy = true;
    var button = el('btnVncConnect');
    if (button) button.disabled = true;
    setStatus('Verbindung wird aufgebaut …');
    sessionPassword = password;
    var slot = {
      client: null,
      intentional: false,
      connected: false,
      unsupported: false,
      failText: '',
    };
    ensureErrorTap();
    errorTap = function (text) {
      if (/unsupported security types/i.test(text)) slot.unsupported = true;
    };
    try {
      var RFB = await loadRfb();
      var data = await localApi('/api/vnc/session', { host: host, port: port });
      var screen = el('vncScreen');
      if (!screen) throw new Error('screen_missing');
      screen.textContent = '';
      var httpBase = apiBase().replace(/\/+$/, '');
      var wsUrl = httpBase.replace(/^http/i, 'ws') + data.ws_path;
      var client = new RFB(screen, wsUrl, {
        credentials: sessionPassword ? { password: sessionPassword } : {},
        shared: true,
        wsProtocols: ['binary'],
      });
      client.viewOnly = false;
      client.scaleViewport = true;
      client.resizeSession = false;
      client.focusOnClick = true;
      client.background = '#111827';
      slot.client = client;
      active = slot;
      client.addEventListener('connect', function () {
        if (slot.intentional) return;
        slot.connected = true;
        setStatus(label ? ('Verbunden – ' + label) : 'Verbunden');
      });
      client.addEventListener('securityfailure', function (ev) {
        var reason = ev && ev.detail && ev.detail.reason ? String(ev.detail.reason) : '';
        slot.failText = reason;
        if (/unsupported security|realvnc|^ra2/i.test(reason)) slot.unsupported = true;
      });
      client.addEventListener('credentialsrequired', function () {
        if (slot.intentional) return;
        if (sessionPassword && typeof client.sendCredentials === 'function') {
          client.sendCredentials({ password: sessionPassword });
          return;
        }
        slot.failText = 'Der Server verlangt ein VNC-Passwort.';
        setStatus(slot.failText);
        slot.intentional = true;
        try { client.disconnect(); } catch (_) { /* schon zu */ }
      });
      client.addEventListener('disconnect', function (ev) {
        if (active && active.client === client) active = null;
        sessionPassword = '';
        if (!active) errorTap = null;
        if (slot.intentional) return;
        var clean = ev && ev.detail && ev.detail.clean;
        if (slot.connected && clean) {
          setStatus('Nicht verbunden');
          return;
        }
        if (slot.connected) {
          setStatus('Verbindung getrennt.');
          return;
        }
        if (slot.unsupported) {
          setStatus(REALVNC_MSG);
          return;
        }
        if (slot.failText) {
          setStatus(slot.failText.indexOf('Passwort') >= 0 ? slot.failText : ('Verbindung fehlgeschlagen: ' + slot.failText));
          return;
        }
        setStatus(unreachable(host, port));
      });
    } catch (e) {
      sessionPassword = '';
      errorTap = null;
      active = null;
      if (e && (e.code === 'invalid_host' || e.code === 'invalid_port') && e.message) {
        setStatus(e.message);
      } else if (e && e.message === 'rfb_missing') {
        setStatus('VNC-Anzeige konnte nicht geladen werden.');
      } else {
        setStatus(unreachable(host, port));
      }
    } finally {
      busy = false;
      if (button) button.disabled = false;
    }
  }

  function bind() {
    var connectBtn = el('btnVncConnect');
    var disconnectBtn = el('btnVncDisconnect');
    if (connectBtn && !connectBtn.dataset.vncBound) {
      connectBtn.dataset.vncBound = '1';
      connectBtn.addEventListener('click', function () {
        connect();
      });
    }
    if (disconnectBtn && !disconnectBtn.dataset.vncBound) {
      disconnectBtn.dataset.vncBound = '1';
      disconnectBtn.addEventListener('click', function () {
        stopViewer();
      });
    }
    var password = el('vncPassword');
    if (password && !password.dataset.vncBound) {
      password.dataset.vncBound = '1';
      password.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') connect();
      });
    }
  }

  window.stopVncViewer = stopViewer;
  window.openVncTool = function () {
    bind();
    if (!active) restoreFields();
  };

  ensureErrorTap();
  bind();
  restoreFields();
})();
