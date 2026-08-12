/**
 * PostMessage-Bridge zwischen Electron (Legacy-DOM + app.js) und React-iframe.
 */
(function () {
  'use strict';

  var frame = null;
  var applying = false;
  var pendingFabSwitch = 0;
  var fabSwitchPending = false;
  /** Letzter React-State (u. a. Abschluss-Status Justiert) – Quelle vor Speichern. */
  var lastReactPayload = null;

  function getFrame() {
    if (!frame) frame = document.getElementById('serviceprotokollReactFrame');
    return frame;
  }

  function postToReact(msg) {
    var f = getFrame();
    if (!f || !f.contentWindow) return;
    try {
      f.contentWindow.postMessage(msg, '*');
    } catch (e) {
      console.warn('[SP-Bridge] postMessage fehlgeschlagen', e);
    }
  }

  function bridgeApi() {
    return window.serviceprotokollBridge || null;
  }

  function syncToReact(force) {
    if (!force && applying) return;
    var api = bridgeApi();
    if (!api || typeof api.pullPayload !== 'function') return;
    postToReact({ type: 'SP_SYNC_STATE', payload: api.pullPayload() });
  }

  function applyFromReact(payload) {
    var api = bridgeApi();
    if (!api || typeof api.applyPayload !== 'function') return;
    applying = true;
    try {
      api.applyPayload(payload);
    } finally {
      applying = false;
    }
  }

  function rememberReactPayload(payload) {
    if (payload && typeof payload === 'object') lastReactPayload = payload;
  }

  function flushFromReact() {
    if (!lastReactPayload) return false;
    applyFromReact(lastReactPayload);
    return true;
  }

  window.serviceprotokollReactBridge = {
    syncToReact: syncToReact,
    flushFromReact: flushFromReact,
    getLastPayload: function () {
      return lastReactPayload;
    },
  };

  window.addEventListener('message', function (ev) {
    var data = ev.data;
    if (!data || typeof data !== 'object') return;
    var api = bridgeApi();

    if (data.type === 'SP_READY') {
      syncToReact();
      return;
    }

    if (data.type === 'SP_STATE_CHANGE' && data.payload) {
      rememberReactPayload(data.payload);
      if (applying || fabSwitchPending) return;
      applyFromReact(data.payload);
      return;
    }

    if (data.type === 'SP_JOB_CHANGE' && data.jobId != null && api && typeof api.selectJob === 'function') {
      applying = true;
      Promise.resolve(api.selectJob(String(data.jobId))).finally(function () {
        applying = false;
        syncToReact();
      });
      return;
    }

    if (data.type === 'SP_FAB_CHANGE' && data.fab != null && api && typeof api.selectFab === 'function') {
      var switchId = ++pendingFabSwitch;
      applying = true;
      fabSwitchPending = true;
      Promise.resolve(api.selectFab(String(data.fab))).finally(function () {
        if (switchId !== pendingFabSwitch) return;
        applying = false;
        syncToReact(true);
        fabSwitchPending = false;
      });
      return;
    }

    if (data.type === 'SP_ACTION' && data.action && api && typeof api.triggerAction === 'function') {
      if (data.payload) {
        rememberReactPayload(data.payload);
        applyFromReact(data.payload);
      } else {
        flushFromReact();
      }
      api.triggerAction(String(data.action));
    }
  });

  document.addEventListener('DOMContentLoaded', function () {
    var f = getFrame();
    if (f) {
      f.addEventListener('load', function () {
        window.setTimeout(syncToReact, 80);
      });
    }
  });
})();
