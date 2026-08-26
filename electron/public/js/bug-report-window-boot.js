(function () {
  'use strict';
  var api = typeof monteurApp !== 'undefined' ? monteurApp.apiBase : 'http://127.0.0.1:39678';
  var name = '';
  try {
    name = String(localStorage.getItem('monteur_fullName') || localStorage.getItem('monteur_serverUsername') || '').trim();
  } catch (_) {}

  window.KUKLA_BUG_REPORT = {
    app_client: 'laptop',
    app_version: '',
    actor_name: name,
    can_resolve: false,
    endpoints: {
      list: '/api/bug_report/list',
      get: '/api/bug_report/get',
      create: '/api/bug_report/create',
      comment: '/api/bug_report/comment',
      status: '/api/bug_report/set-status',
      screenshot: '/api/bug_report/screenshot',
    },
    setAlwaysOnTop: function (on) {
      if (window.monteurApp && typeof window.monteurApp.setBugReportAlwaysOnTop === 'function') {
        return window.monteurApp.setBugReportAlwaysOnTop(!!on);
      }
    },
    readClipboardImage: function () {
      if (window.monteurApp && typeof window.monteurApp.readClipboardImage === 'function') {
        return window.monteurApp.readClipboardImage();
      }
      return Promise.resolve('');
    },
  };

  fetch(api + '/api/version')
    .then(function (r) { return r.json(); })
    .then(function (h) {
      window.KUKLA_BUG_REPORT.app_version = (h && h.version) || '';
      var verEl = document.querySelector('[data-br-version]');
      if (verEl) {
        var v = window.KUKLA_BUG_REPORT.app_version;
        verEl.value = v ? (v + ' · Laptop') : 'Laptop';
      }
    })
    .catch(function () {});

  fetch(api + '/api/bug_report/list')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.actor_name) window.KUKLA_BUG_REPORT.actor_name = d.actor_name;
      if (typeof d.can_resolve === 'boolean') window.KUKLA_BUG_REPORT.can_resolve = d.can_resolve;
      var nameEl = document.querySelector('[data-br-actor]');
      if (nameEl && window.KUKLA_BUG_REPORT.actor_name) nameEl.value = window.KUKLA_BUG_REPORT.actor_name;
    })
    .catch(function () {});
})();
