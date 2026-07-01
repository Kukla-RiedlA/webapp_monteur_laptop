/**
 * PostMessage-Bridge zwischen Electron (Legacy-DOM + app.js) und React-iframe.
 */
(function () {
  'use strict';

  var frame = null;
  var applying = false;

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

  function syncToReact() {
    if (applying) return;
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

  window.serviceprotokollReactBridge = {
    syncToReact: syncToReact,
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
      applyFromReact(data.payload);
      return;
    }

    if (data.type === 'SP_JOB_CHANGE' && data.jobId != null && api && typeof api.selectJob === 'function') {
      api.selectJob(String(data.jobId));
      return;
    }

    if (data.type === 'SP_FAB_CHANGE' && data.fab != null && api && typeof api.selectFab === 'function') {
      api.selectFab(String(data.fab));
      return;
    }

    if (data.type === 'SP_ACTION' && data.action && api && typeof api.triggerAction === 'function') {
      if (data.payload) applyFromReact(data.payload);
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
