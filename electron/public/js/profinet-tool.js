(function () {
  'use strict';

  var DOWNLOAD_URL = 'https://npcap.com/#download';
  var state = {
    npcap: null,
    adapters: [],
    teilnehmer: [],
    links: [],
    selectedMac: '',
  };

  function apiBase() {
    if (typeof monteurApp !== 'undefined' && monteurApp && monteurApp.apiBase) return monteurApp.apiBase;
    if (window.monteurApp && window.monteurApp.apiBase) return window.monteurApp.apiBase;
    return 'http://127.0.0.1:39678';
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function localApi(path, opts) {
    var tech = typeof window.getTechId === 'function' ? window.getTechId() : 0;
    var url = apiBase() + path + (path.indexOf('?') >= 0 ? '&' : '?') + (tech ? 'technician_id=' + tech : '');
    var res = await fetch(url, {
      method: (opts && opts.method) || 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Technician-Id': String(tech || '') },
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || !data || data.ok === false) {
      var err = new Error((data && data.error) || 'Anfrage fehlgeschlagen');
      err.code = data && data.code;
      err.npcap = data && data.npcap;
      throw err;
    }
    return data;
  }

  function ready() {
    return !!(state.npcap && state.npcap.ready);
  }

  function setStatus(text) {
    var el = document.getElementById('profinetStatus');
    if (el) el.textContent = text || '';
  }

  function renderHint() {
    var hint = document.getElementById('profinetHint');
    if (!hint) return;
    if (ready()) {
      hint.hidden = true;
      hint.innerHTML = '';
      return;
    }
    var installed = state.npcap && state.npcap.installed;
    var winpcap = state.npcap && state.npcap.winpcap_mode;
    var extra = (!installed || !winpcap)
      ? ' Beim Installieren den WinPcap-Modus einschalten. '
      : ' ';
    var message = (state.npcap && state.npcap.message)
      || 'Npcap ist nicht installiert. Scan, Topologie, Blinken, Taufen und Umtaufen sind aus.';
    hint.hidden = false;
    hint.innerHTML = '<strong>Profinet braucht Npcap.</strong> '
      + esc(message)
      + extra
      + '<a href="' + DOWNLOAD_URL + '" id="profinetNpcapLink" target="_blank" rel="noopener">https://npcap.com/#download</a>';
  }

  function renderAdapters() {
    var sel = document.getElementById('profinetAdapter');
    if (!sel) return;
    var current = sel.value;
    sel.innerHTML = '';
    if (!state.adapters.length) {
      var empty = document.createElement('option');
      empty.value = '';
      var npcap = state.npcap || {};
      var label = 'Npcap fehlt';
      if (ready()) label = 'Kein Ethernet-Adapter';
      else if (npcap.installed && npcap.winpcap_mode && !npcap.module_ready) label = 'Aufnahmemodul fehlt – KUKpit neu starten';
      else if (npcap.installed && !npcap.winpcap_mode) label = 'WinPcap-Modus fehlt';
      empty.textContent = label;
      sel.appendChild(empty);
      sel.disabled = true;
      return;
    }
    state.adapters.forEach(function (adapter) {
      var opt = document.createElement('option');
      opt.value = adapter.address;
      opt.textContent = adapter.name + ' · ' + adapter.address + ' · ' + adapter.mac;
      opt.setAttribute('data-mac', adapter.mac);
      opt.setAttribute('data-name', adapter.name);
      sel.appendChild(opt);
    });
    sel.disabled = !ready();
    if (current) sel.value = current;
  }

  function selectedAdapter() {
    var sel = document.getElementById('profinetAdapter');
    if (!sel || !sel.selectedOptions.length) return null;
    var opt = sel.selectedOptions[0];
    return {
      name: opt.getAttribute('data-name') || '',
      address: sel.value,
      mac: opt.getAttribute('data-mac') || '',
    };
  }

  function isUnbaptized(row) {
    var name = String((row && row.station_name) || '').trim();
    var ip = String((row && row.ip_address) || '').trim();
    return !name || !ip || ip === '0.0.0.0';
  }

  function renderTopology() {
    var host = document.getElementById('profinetTopo');
    if (!host) return;
    var rows = state.teilnehmer || [];
    if (!rows.length) {
      host.innerHTML = '<p class="muted">Noch kein Scan.</p>';
      return;
    }
    var linked = {};
    (state.links || []).forEach(function (link) {
      if (link.local_mac) linked[String(link.local_mac).toLowerCase()] = true;
      if (link.peer_mac) linked[String(link.peer_mac).toLowerCase()] = true;
    });
    var width = Math.max(640, rows.length * 170);
    var height = (state.links || []).length ? 280 : 150;
    var html = '<svg class="profinet-topo" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Gescannte Profinet-Teilnehmer">';
    var pos = {};
    rows.forEach(function (row, index) {
      var y = (state.links || []).length && linked[String(row.mac).toLowerCase()] ? 64 : ((state.links || []).length ? 200 : 70);
      pos[String(row.mac).toLowerCase()] = { x: 90 + (index % 6) * 160, y: y };
    });
    (state.links || []).forEach(function (link) {
      var a = pos[String(link.local_mac || '').toLowerCase()];
      var b = pos[String(link.peer_mac || '').toLowerCase()];
      if (!a || !b) return;
      html += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="#0e7b5a" stroke-width="2"/>';
    });
    rows.forEach(function (row) {
      var p = pos[String(row.mac).toLowerCase()];
      html += '<g class="profinet-scan-node" data-mac="' + esc(row.mac) + '" style="cursor:pointer">';
      html += '<rect x="' + (p.x - 62) + '" y="' + (p.y - 28) + '" width="124" height="56" rx="10" fill="#eefaf5" stroke="#0e7b5a"/>';
      html += '<text x="' + p.x + '" y="' + (p.y - 4) + '" text-anchor="middle" font-size="12" fill="#1a1a1a">' + esc(row.station_name || row.mac) + '</text>';
      html += '<text x="' + p.x + '" y="' + (p.y + 14) + '" text-anchor="middle" font-size="11" fill="#1a1a1a">' + esc(row.ip_address || '0.0.0.0') + '</text>';
      html += '</g>';
    });
    html += '<text x="12" y="' + ((state.links || []).length ? 176 : 22) + '" font-size="12" fill="#0c6a4d">ohne Verbindung</text>';
    html += '</svg>';
    host.innerHTML = html;
  }

  function renderTable() {
    var body = document.getElementById('profinetBody');
    if (!body) return;
    if (!state.teilnehmer.length) {
      body.innerHTML = '<tr><td colspan="6">Keine Teilnehmer im letzten Scan.</td></tr>';
      return;
    }
    body.innerHTML = state.teilnehmer.map(function (row) {
      return '<tr data-mac="' + esc(row.mac) + '">'
        + '<td>' + esc(row.mac) + '</td>'
        + '<td>' + esc(row.station_name || '') + '</td>'
        + '<td>' + esc(row.ip_address || '') + '</td>'
        + '<td>' + esc(row.subnet_mask || '') + '</td>'
        + '<td>' + esc(row.gateway || '') + '</td>'
        + '<td>' + esc(row.vendor || '') + '</td>'
        + '</tr>';
    }).join('');
  }

  function setActionsEnabled(on) {
    ['btnProfinetScan', 'btnProfinetBlink', 'btnProfinetWrite', 'btnProfinetAssign'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      if (id === 'btnProfinetAssign') {
        el.disabled = false;
        return;
      }
      el.disabled = !on;
    });
    var sel = document.getElementById('profinetAdapter');
    if (sel) sel.disabled = !on || !state.adapters.length;
  }

  async function refreshStatus() {
    try {
      var data = await localApi('/api/profinet/adapters');
      state.npcap = data.npcap;
      state.adapters = data.adapters || [];
    } catch (e) {
      state.npcap = { ready: false, message: e.message, download_url: DOWNLOAD_URL };
      state.adapters = [];
    }
    renderHint();
    renderAdapters();
    setActionsEnabled(ready());
    if (!ready()) setStatus('Funktion aus, bis Npcap im WinPcap-Modus installiert ist.');
    else setStatus('Bereit.');
  }

  function findRow(mac) {
    return (state.teilnehmer || []).find(function (row) {
      return String(row.mac).toLowerCase() === String(mac || '').toLowerCase();
    }) || null;
  }

  function openDialog(mac) {
    var row = findRow(mac);
    if (!row) return;
    state.selectedMac = row.mac;
    var dialog = document.getElementById('profinetDialog');
    if (!dialog) return;
    dialog.hidden = false;
    document.getElementById('profinetDlgMac').textContent = row.mac;
    document.getElementById('profinetDlgIstName').textContent = row.station_name || '(leer)';
    document.getElementById('profinetDlgIstIp').textContent = row.ip_address || '0.0.0.0';
    document.getElementById('profinetDlgName').value = row.station_name || '';
    document.getElementById('profinetDlgIp').value = row.ip_address && row.ip_address !== '0.0.0.0' ? row.ip_address : '';
    document.getElementById('profinetDlgMask').value = row.subnet_mask && row.subnet_mask !== '0.0.0.0' ? row.subnet_mask : '255.255.255.0';
    document.getElementById('profinetDlgGw').value = row.gateway && row.gateway !== '0.0.0.0' ? row.gateway : '';
    var write = document.getElementById('btnProfinetWrite');
    if (write) write.textContent = isUnbaptized(row) ? 'Taufen' : 'Umtaufen';
    var fab = document.getElementById('profinetFab');
    if (fab && !fab.value && window.kuklaProfinetPendingFab) fab.value = window.kuklaProfinetPendingFab;
  }

  function closeDialog() {
    var dialog = document.getElementById('profinetDialog');
    if (dialog) dialog.hidden = true;
  }

  async function scan() {
    if (!ready()) return;
    var adapter = selectedAdapter();
    if (!adapter || !adapter.address) {
      setStatus('Bitte einen Adapter wählen.');
      return;
    }
    setStatus('Scanne …');
    var data = await localApi('/api/profinet/scan', { method: 'POST', body: adapter });
    state.teilnehmer = data.teilnehmer || [];
    state.links = data.links || [];
    renderTopology();
    renderTable();
    setStatus(state.teilnehmer.length + ' Teilnehmer. Leitungen nur, wenn die Nachbarschaft gelesen werden konnte.');
  }

  async function writeDevice() {
    if (!ready()) return;
    var row = findRow(state.selectedMac);
    if (!row) return;
    var name = String(document.getElementById('profinetDlgName').value || '').trim().toLowerCase();
    var ip = String(document.getElementById('profinetDlgIp').value || '').trim();
    var mask = String(document.getElementById('profinetDlgMask').value || '').trim();
    var gw = String(document.getElementById('profinetDlgGw').value || '').trim();
    if (!name) {
      window.alert('Stationsname fehlt.');
      return;
    }
    if (ip && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      window.alert('IP ist ungültig.');
      return;
    }
    var verb = isUnbaptized(row) ? 'Taufen' : 'Umtaufen';
    var text = verb + '?\n\nName: ' + (row.station_name || '(leer)') + ' → ' + name
      + '\nIP: ' + (row.ip_address || '0.0.0.0') + ' → ' + (ip || '0.0.0.0');
    if (!window.confirm(text)) return;
    setStatus(verb + ' …');
    await localApi('/api/profinet/set', {
      method: 'POST',
      body: Object.assign({ mac: row.mac, station_name: name, ip_address: ip, subnet_mask: mask, gateway: gw }, selectedAdapter()),
    });
    setStatus(verb + ' gesendet. Bitte erneut scannen.');
    closeDialog();
  }

  async function blink() {
    if (!ready()) return;
    var row = findRow(state.selectedMac);
    if (!row) return;
    setStatus('Blinken …');
    await localApi('/api/profinet/signal', {
      method: 'POST',
      body: Object.assign({ mac: row.mac }, selectedAdapter()),
    });
    setStatus('Blink-Signal an ' + row.mac + ' gesendet.');
  }

  async function assign() {
    var fab = String((document.getElementById('profinetFab') || {}).value || '').trim();
    var row = findRow(state.selectedMac);
    if (!fab) {
      window.alert('Fabrikationsnummer fehlt.');
      return;
    }
    if (!row) {
      window.alert('Zuerst einen Teilnehmer wählen.');
      return;
    }
    var name = String(document.getElementById('profinetDlgName').value || row.station_name || '').trim();
    var ip = String(document.getElementById('profinetDlgIp').value || row.ip_address || '').trim();
    var mask = String(document.getElementById('profinetDlgMask').value || row.subnet_mask || '').trim();
    var gw = String(document.getElementById('profinetDlgGw').value || row.gateway || '').trim();
    var existing = await localApi('/api/profinet/teilnehmer?fabrikationsnummer=' + encodeURIComponent(fab));
    var list = (existing.teilnehmer || []).filter(function (item) {
      return String(item.mac).toLowerCase() !== row.mac.toLowerCase();
    });
    list.push({
      mac: row.mac,
      station_name: name,
      ip_address: ip,
      subnet_mask: mask,
      gateway: gw,
      vendor: row.vendor || '',
      last_seen_name: row.station_name || '',
      last_seen_ip: row.ip_address || '',
    });
    var body = Object.assign({
      fabrikationsnummer: fab,
      teilnehmer: list,
      links: existing.links || state.links || [],
    }, sessionExtra());
    await localApi('/api/profinet/teilnehmer', { method: 'POST', body: body });
    setStatus('An FN ' + fab + ' gespeichert.');
  }

  function sessionExtra() {
    var extra = {};
    if (typeof window.getDispoBaseUrl === 'function') extra.base_url = window.getDispoBaseUrl() || '';
    if (typeof window.getDispoUsername === 'function') extra.server_username = window.getDispoUsername() || '';
    if (typeof window.getDispoPassword === 'function') extra.server_password = window.getDispoPassword() || '';
    return extra;
  }

  function bind() {
    var scanBtn = document.getElementById('btnProfinetScan');
    if (!scanBtn || scanBtn.getAttribute('data-bound') === '1') return;
    scanBtn.setAttribute('data-bound', '1');
    scanBtn.addEventListener('click', function () {
      scan().catch(function (e) { setStatus(e.message); });
    });
    document.getElementById('btnProfinetWrite').addEventListener('click', function () {
      writeDevice().catch(function (e) { setStatus(e.message); });
    });
    document.getElementById('btnProfinetBlink').addEventListener('click', function () {
      blink().catch(function (e) { setStatus(e.message); });
    });
    document.getElementById('btnProfinetAssign').addEventListener('click', function () {
      assign().catch(function (e) { setStatus(e.message); });
    });
    document.getElementById('btnProfinetDialogClose').addEventListener('click', closeDialog);
    document.getElementById('profinetBody').addEventListener('dblclick', function (ev) {
      var tr = ev.target.closest('tr');
      if (!tr) return;
      openDialog(tr.getAttribute('data-mac'));
    });
    document.getElementById('profinetTopo').addEventListener('dblclick', function (ev) {
      var node = ev.target.closest('.profinet-scan-node');
      if (!node) return;
      openDialog(node.getAttribute('data-mac'));
    });
    var linkHost = document.getElementById('profinetHint');
    if (linkHost) {
      linkHost.addEventListener('click', function (ev) {
        var a = ev.target.closest('a');
        if (!a) return;
        if (window.monteurApp && typeof window.monteurApp.openExternal === 'function') {
          ev.preventDefault();
          window.monteurApp.openExternal(a.href);
        }
      });
    }
  }

  async function open(opts) {
    bind();
    if (opts && opts.fabrikationsnummer) {
      window.kuklaProfinetPendingFab = opts.fabrikationsnummer;
      var fab = document.getElementById('profinetFab');
      if (fab) fab.value = opts.fabrikationsnummer;
    }
    await refreshStatus();
    if (opts && opts.device && opts.mac && !findRow(opts.mac)) {
      state.teilnehmer = state.teilnehmer.concat([opts.device]);
    }
    renderTopology();
    renderTable();
    if (opts && opts.mac) openDialog(opts.mac);
  }

  window.openProfinetTool = function (opts) {
    return open(opts || window.kuklaProfinetPending || {});
  };
  window.openProfinet = function (opts) {
    window.kuklaProfinetPending = opts || {};
    if (typeof window.showView === 'function') return window.showView('tools-profinet');
    return open(opts || {});
  };
  if (window.monteurApp && typeof window.monteurApp.onProfinetOpen === 'function') {
    window.monteurApp.onProfinetOpen(function (opts) {
      window.openProfinet(opts || {});
    });
  }
  try {
    var popQ = new URLSearchParams(window.location.search);
    if (popQ.get('popout') === '1' && popQ.get('view') === 'tools-profinet') {
      open(window.kuklaProfinetPending || {});
    }
  } catch (_) { /* kein Popout */ }
})();
