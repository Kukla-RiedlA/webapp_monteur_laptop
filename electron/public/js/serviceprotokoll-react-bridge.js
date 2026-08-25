/**
 * PostMessage-Bridge zwischen Electron (Legacy-DOM + app.js) und React-iframe.
 */
(function () {
  'use strict';

  var frame = null;
  var applying = false;
  var applyingDepth = 0;
  var pendingFabSwitch = 0;
  var fabSwitchPending = false;
  var jobSwitchPending = false;
  /** Letzter React-State (u. a. Abschluss-Status Justiert) – Quelle vor Speichern. */
  var lastReactPayload = null;
  var ignoreReactUntil = 0;

  function reactPayloadFab(payload) {
    if (!payload || !payload.form) return '';
    return String(payload.form.activeFab || '').trim();
  }

  function hostActiveFab() {
    var api = bridgeApi();
    if (!api || typeof api.getActiveFab !== 'function') return '';
    try {
      return String(api.getActiveFab() || '').trim();
    } catch (e) {
      return '';
    }
  }

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
    var payload = api.pullPayload();
    // Host-Änderungen (z. B. Katalog-Übernehmen) müssen der Flush-Quelle entsprechen,
    // sonst überschreibt ein veralteter React-State die neuen Arbeitsschritte.
    rememberReactPayload(payload);
    ignoreReactUntil = Date.now() + 900;
    postToReact({ type: 'SP_SYNC_STATE', payload: payload });
  }

  function applyFromReact(payload) {
    var api = bridgeApi();
    if (!api || typeof api.applyPayload !== 'function') return;
    applyingDepth += 1;
    applying = true;
    try {
      api.applyPayload(payload);
    } finally {
      applyingDepth -= 1;
      applying = applyingDepth > 0;
    }
  }

  function workStepsSignature(steps) {
    return (steps || []).map(function (s) {
      return String((s.labelDe || s.bezeichnung_de || '') + '\n' + (s.labelEn || s.bezeichnung_en || '') + '\n' + (s.label || '')).trim().toLowerCase();
    }).join('||');
  }

  function keepHostWorkStepsIfStale(payload) {
    if (!payload || Date.now() >= ignoreReactUntil || !lastReactPayload) return payload;
    var hostSteps = lastReactPayload.workSteps;
    if (!Array.isArray(hostSteps) || !hostSteps.length) return payload;
    var incoming = payload.workSteps || [];
    if (workStepsSignature(incoming) === workStepsSignature(hostSteps)) return payload;
    if (incoming.length > hostSteps.length) return payload;
    payload.workSteps = hostSteps;
    return payload;
  }

  function rememberReactPayload(payload) {
    if (payload && typeof payload === 'object') lastReactPayload = payload;
  }

  function flushFromReact() {
    if (!lastReactPayload) return false;
    var payloadFab = reactPayloadFab(lastReactPayload);
    var hostFab = hostActiveFab();
    if (hostFab && payloadFab && payloadFab !== hostFab) return false;
    applyFromReact(lastReactPayload);
    return true;
  }

  window.serviceprotokollReactBridge = {
    syncToReact: syncToReact,
    flushFromReact: flushFromReact,
    setAutosaveHint: function (text, isError) {
      postToReact({ type: 'SP_AUTOSAVE_STATUS', text: text || '', error: !!isError });
    },
    getLastPayload: function () {
      return lastReactPayload;
    },
    beginJobSwitch: function () {
      jobSwitchPending = true;
      lastReactPayload = null;
    },
    endJobSwitch: function () {
      jobSwitchPending = false;
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
      if (applying || fabSwitchPending || jobSwitchPending) return;
      keepHostWorkStepsIfStale(data.payload);
      rememberReactPayload(data.payload);
      applyFromReact(data.payload);
      return;
    }

    if (data.type === 'SP_JOB_CHANGE' && data.jobId != null && api && typeof api.selectJob === 'function') {
      jobSwitchPending = true;
      lastReactPayload = null;
      applying = true;
      Promise.resolve(api.selectJob(String(data.jobId))).finally(function () {
        applying = false;
        jobSwitchPending = false;
        syncToReact();
      });
      return;
    }

    if (data.type === 'SP_FAB_CHANGE' && data.fab != null && api && typeof api.selectFab === 'function') {
      var switchId = ++pendingFabSwitch;
      applyingDepth += 1;
      applying = true;
      fabSwitchPending = true;
      Promise.resolve(api.selectFab(String(data.fab))).finally(function () {
        if (switchId !== pendingFabSwitch) return;
        applyingDepth -= 1;
        applying = applyingDepth > 0;
        syncToReact(true);
        window.setTimeout(function () {
          if (switchId !== pendingFabSwitch) return;
          fabSwitchPending = false;
          syncToReact(true);
        }, 80);
      });
      return;
    }

    if (data.type === 'SP_ACTION' && data.action && api && typeof api.triggerAction === 'function') {
      if (data.payload) {
        var actionFab = reactPayloadFab(data.payload);
        var actionHostFab = hostActiveFab();
        if (!actionHostFab || !actionFab || actionFab === actionHostFab) {
          keepHostWorkStepsIfStale(data.payload);
          rememberReactPayload(data.payload);
          applyFromReact(data.payload);
        }
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
