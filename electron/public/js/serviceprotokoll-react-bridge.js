/**
 * PostMessage-Bridge zwischen Electron (Legacy-DOM + app.js) und React-iframe.
 * Zwei Instanzen: Service (#serviceprotokollReactFrame) und IBN (#inbetriebnahmeReactFrame).
 */
(function () {
  'use strict';

  function createProtokollReactBridge(opts) {
    var frameId = opts.frameId;
    var hostBridgeKey = opts.hostBridgeKey;
    var exportKey = opts.exportKey;
    var hostKind = opts.hostKind;
    var frame = null;
    var applying = false;
    var applyingDepth = 0;
    var pendingFabSwitch = 0;
    var fabSwitchPending = false;
    var jobSwitchPending = false;
    var lastReactPayload = null;
    var ignoreReactUntil = 0;
    var lastAutosave = { text: '', error: false };
    var applyTimer = null;
    var APPLY_IDLE_MS = 450;

    function cancelScheduledApply() {
      if (applyTimer) {
        clearTimeout(applyTimer);
        applyTimer = null;
      }
    }

    function scheduleApplyFromReact(payload) {
      rememberReactPayload(payload);
      cancelScheduledApply();
      applyTimer = setTimeout(function () {
        applyTimer = null;
        if (lastReactPayload) applyFromReact(lastReactPayload);
      }, APPLY_IDLE_MS);
    }

    function applyFromReactNow(payload) {
      cancelScheduledApply();
      if (payload) rememberReactPayload(payload);
      if (lastReactPayload) applyFromReact(lastReactPayload);
    }

    function postAutosaveHint() {
      if (!lastAutosave.text && !lastAutosave.error) return;
      postToReact({
        type: 'SP_AUTOSAVE_STATUS',
        text: lastAutosave.text,
        error: lastAutosave.error,
      });
    }

    function isActiveHost() {
      return window.__kuklaProtokollHostKind === hostKind;
    }

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
      if (!frame) frame = document.getElementById(frameId);
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
      return window[hostBridgeKey] || null;
    }

    function messageFromThisFrame(ev) {
      var f = getFrame();
      return !!(f && f.contentWindow && ev && ev.source === f.contentWindow);
    }

    function syncToReact(force) {
      if (!isActiveHost()) return;
      if (!force && applying) return;
      var api = bridgeApi();
      if (!api || typeof api.pullPayload !== 'function') return;
      var payload = api.pullPayload();
      rememberReactPayload(payload);
      ignoreReactUntil = Date.now() + 900;
      postToReact({ type: 'SP_SYNC_STATE', payload: payload });
      postAutosaveHint();
    }

    function applyFromReact(payload) {
      if (!isActiveHost()) return;
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

    function motorsSignature(motors) {
      return (motors || []).map(function (m) {
        if (!m || typeof m !== 'object') return '';
        return [
          m.bezeichnung || '',
          m.hersteller || '',
          m.type || '',
          m.seriennummer || '',
          m.anlagenstammMotorId || m.anlagenstamm_motor_id || '',
        ].join('\n');
      }).join('||');
    }

    function keepHostMotorsIfStale(payload) {
      if (!payload || !payload.form || Date.now() >= ignoreReactUntil || !lastReactPayload) return payload;
      var hostForm = lastReactPayload.form || {};
      var hostMotors = hostForm.motors;
      if (!Array.isArray(hostMotors) || !hostMotors.length) return payload;
      var incoming = Array.isArray(payload.form.motors) ? payload.form.motors : [];
      if (motorsSignature(incoming) === motorsSignature(hostMotors)) return payload;
      if (incoming.length > hostMotors.length) return payload;
      payload.form.motors = hostMotors;
      return payload;
    }

    function rememberReactPayload(payload) {
      if (payload && typeof payload === 'object') lastReactPayload = payload;
    }

    function flushFromReact() {
      if (!isActiveHost()) return false;
      if (!lastReactPayload) return false;
      var payloadFab = reactPayloadFab(lastReactPayload);
      var hostFab = hostActiveFab();
      if (hostFab && payloadFab && payloadFab !== hostFab) return false;
      applyFromReactNow(lastReactPayload);
      return true;
    }

    var api = {
      syncToReact: syncToReact,
      pushJobs: function (jobs) {
        postToReact({ type: 'SP_JOBS', jobs: Array.isArray(jobs) ? jobs : [] });
      },
      flushFromReact: flushFromReact,
      setAutosaveHint: function (text, isError) {
        lastAutosave = { text: text || '', error: !!isError };
        postToReact({ type: 'SP_AUTOSAVE_STATUS', text: lastAutosave.text, error: lastAutosave.error });
      },
      replayAutosaveHint: function () {
        postAutosaveHint();
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

    window[exportKey] = api;

    window.addEventListener('message', function (ev) {
      var data = ev.data;
      if (!data || typeof data !== 'object') return;
      if (!messageFromThisFrame(ev)) return;
      var host = bridgeApi();

      if (data.type === 'SP_READY') {
        var tries = 0;
        function trySync() {
          if (!isActiveHost()) return;
          var hostApi = bridgeApi();
          if (!hostApi || typeof hostApi.pullPayload !== 'function') {
            if (tries++ < 25) {
              window.setTimeout(trySync, 80);
            }
            return;
          }
          syncToReact(true);
          postAutosaveHint();
        }
        trySync();
        return;
      }

      if (data.type === 'SP_STATE_CHANGE' && data.payload) {
        if (!isActiveHost() || applying || fabSwitchPending || jobSwitchPending) return;
        keepHostWorkStepsIfStale(data.payload);
        keepHostMotorsIfStale(data.payload);
        scheduleApplyFromReact(data.payload);
        return;
      }

      if (data.type === 'SP_JOB_CHANGE' && data.jobId != null && host && typeof host.selectJob === 'function') {
        if (!isActiveHost()) return;
        jobSwitchPending = true;
        lastReactPayload = null;
        applying = true;
        Promise.resolve(host.selectJob(String(data.jobId))).finally(function () {
          applying = false;
          jobSwitchPending = false;
          syncToReact();
        });
        return;
      }

      if (data.type === 'SP_FAB_CHANGE' && data.fab != null && host && typeof host.selectFab === 'function') {
        if (!isActiveHost()) return;
        var switchId = ++pendingFabSwitch;
        applyingDepth += 1;
        applying = true;
        fabSwitchPending = true;
        Promise.resolve(host.selectFab(String(data.fab))).finally(function () {
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

      if (data.type === 'SP_ACTION' && data.action && host && typeof host.triggerAction === 'function') {
        if (!isActiveHost()) return;
        var actionName = String(data.action);
        if (actionName === 'loadMotorsFromMlPdf') {
          cancelScheduledApply();
          host.triggerAction(actionName);
          return;
        }
        if (data.payload) {
          var actionFab = reactPayloadFab(data.payload);
          var actionHostFab = hostActiveFab();
          if (!actionHostFab || !actionFab || actionFab === actionHostFab) {
            keepHostWorkStepsIfStale(data.payload);
            keepHostMotorsIfStale(data.payload);
            applyFromReactNow(data.payload);
          }
        } else {
          flushFromReact();
        }
        host.triggerAction(actionName);
      }
    });

    document.addEventListener('DOMContentLoaded', function () {
      var f = getFrame();
      if (f) {
        f.addEventListener('load', function () {
          window.setTimeout(function () {
            if (isActiveHost()) {
              syncToReact();
              postAutosaveHint();
            }
          }, 80);
        });
      }
    });

    return api;
  }

  window.__kuklaProtokollHostKind = window.__kuklaProtokollHostKind || 'service';

  createProtokollReactBridge({
    frameId: 'serviceprotokollReactFrame',
    hostBridgeKey: 'serviceprotokollBridge',
    exportKey: 'serviceprotokollReactBridge',
    hostKind: 'service',
  });
  createProtokollReactBridge({
    frameId: 'inbetriebnahmeReactFrame',
    hostBridgeKey: 'inbetriebnahmeBridge',
    exportKey: 'inbetriebnahmeReactBridge',
    hostKind: 'ibn',
  });
})();
