(function () {
  'use strict';

  var DOWNLOAD_URL = 'https://npcap.com/#download';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function currentFab() {
    var input = document.getElementById('formFab');
    if (input && String(input.value || '').trim()) return String(input.value).trim();
    var top = document.getElementById('akteTopbarFn');
    var text = top ? String(top.textContent || '').trim() : '';
    if (!text || text === 'Anlage' || text === 'Neue Anlage') return '';
    return text;
  }

  function cacheKey(fab) {
    return 'kukla_profinet_' + fab;
  }

  function readCache(fab) {
    try {
      var raw = localStorage.getItem(cacheKey(fab));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(fab, data) {
    try {
      localStorage.setItem(cacheKey(fab), JSON.stringify(data));
    } catch (e) { /* Speicher voll oder privat */ }
  }

  function sessionExtra() {
    var extra = {};
    if (typeof window.getDispoBaseUrl === 'function') extra.base_url = window.getDispoBaseUrl() || '';
    if (typeof window.getDispoUsername === 'function') extra.server_username = window.getDispoUsername() || '';
    if (typeof window.getDispoPassword === 'function') extra.server_password = window.getDispoPassword() || '';
    return extra;
  }

  function hostOf(root) {
    var scope = root || document;
    return scope.querySelector('[data-profinet-akte]');
  }

  function layout(teilnehmer, links) {
    var byMac = {};
    (teilnehmer || []).forEach(function (row) {
      if (row && row.mac) byMac[String(row.mac).toLowerCase()] = row;
    });
    var linked = {};
    (links || []).forEach(function (link) {
      if (link.local_mac) linked[String(link.local_mac).toLowerCase()] = true;
      if (link.peer_mac) linked[String(link.peer_mac).toLowerCase()] = true;
    });
    return { byMac: byMac, linked: linked };
  }

  function nodeLabel(row) {
    var name = row && (row.station_name || row.name) ? (row.station_name || row.name) : '';
    var ip = row && row.ip_address ? row.ip_address : '';
    var mac = row && row.mac ? row.mac : '';
    return [name || mac || 'Teilnehmer', ip].filter(Boolean).join('\n');
  }

  function renderSvg(teilnehmer, links) {
    var rows = teilnehmer || [];
    var edges = links || [];
    if (!rows.length && !edges.length) {
      return '<p class="muted">Noch keine Teilnehmer an dieser Fabrikationsnummer.</p>';
    }
    var info = layout(rows, edges);
    var unlinked = rows.filter(function (row) {
      return !info.linked[String(row.mac || '').toLowerCase()];
    });
    var width = Math.max(640, rows.length * 170);
    var height = edges.length ? 280 : 160;
    var html = '<svg class="profinet-topo" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Profinet-Topologie">';
    var pos = {};
    rows.forEach(function (row, index) {
      var x = 90 + (index % 6) * 160;
      var y = edges.length && info.linked[String(row.mac || '').toLowerCase()] ? 70 : (edges.length ? 210 : 70);
      pos[String(row.mac || '').toLowerCase()] = { x: x, y: y };
    });
    edges.forEach(function (link) {
      var a = pos[String(link.local_mac || '').toLowerCase()];
      var b = pos[String(link.peer_mac || '').toLowerCase()];
      if (!a || !b) return;
      html += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="#0e7b5a" stroke-width="2"/>';
    });
    rows.forEach(function (row) {
      var p = pos[String(row.mac || '').toLowerCase()];
      if (!p) return;
      var label = nodeLabel(row).split('\n');
      html += '<g class="profinet-node" data-mac="' + esc(row.mac) + '" style="cursor:pointer">';
      html += '<rect x="' + (p.x - 62) + '" y="' + (p.y - 28) + '" width="124" height="56" rx="10" fill="#eefaf5" stroke="#0e7b5a"/>';
      html += '<text x="' + p.x + '" y="' + (p.y - 6) + '" text-anchor="middle" font-size="12" fill="#1a1a1a">' + esc(label[0] || '') + '</text>';
      html += '<text x="' + p.x + '" y="' + (p.y + 12) + '" text-anchor="middle" font-size="11" fill="#1a1a1a">' + esc(label[1] || '') + '</text>';
      html += '</g>';
    });
    if (unlinked.length && edges.length) {
      html += '<text x="16" y="188" font-size="12" fill="#0c6a4d">ohne Verbindung</text>';
    } else if (!edges.length && rows.length) {
      html += '<text x="16" y="24" font-size="12" fill="#0c6a4d">ohne Verbindung</text>';
    }
    html += '</svg>';
    return html;
  }

  function renderTable(teilnehmer) {
    var rows = teilnehmer || [];
    var html = '<div class="profinet-table-wrap"><table class="profinet-table"><thead><tr>';
    html += '<th>MAC</th><th>Name</th><th>IP</th><th>Maske</th><th>Gateway</th><th>Hersteller</th>';
    html += '</tr></thead><tbody>';
    if (!rows.length) {
      html += '<tr><td colspan="6">Keine Teilnehmer gespeichert.</td></tr>';
    }
    rows.forEach(function (row) {
      html += '<tr data-mac="' + esc(row.mac) + '">';
      html += '<td>' + esc(row.mac) + '</td>';
      html += '<td>' + esc(row.station_name || '') + '</td>';
      html += '<td>' + esc(row.ip_address || '') + '</td>';
      html += '<td>' + esc(row.subnet_mask || '') + '</td>';
      html += '<td>' + esc(row.gateway || '') + '</td>';
      html += '<td>' + esc(row.vendor || '') + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  function paint(host, data, note) {
    if (!host) return;
    host.innerHTML = ''
      + (note ? '<p class="muted">' + esc(note) + '</p>' : '')
      + '<div class="profinet-topo-wrap">' + renderSvg(data.teilnehmer, data.links) + '</div>'
      + renderTable(data.teilnehmer)
      + '<div style="margin-top:0.75rem"><button type="button" class="btn btn-primary" data-profinet-add>Teilnehmer anlegen</button></div>';
    host._profinetData = data;
  }

  async function load(root) {
    var host = hostOf(root);
    if (!host) return;
    var fab = currentFab();
    if (!fab) {
      paint(host, { teilnehmer: [], links: [] }, 'Zuerst eine Fabrikationsnummer eintragen.');
      return;
    }
    host.innerHTML = '<p class="muted">Lade Bussystem …</p>';
    var cached = readCache(fab);
    try {
      var res = await fetch('/api/anlagenstamm_profinet.php?fabrikationsnummer=' + encodeURIComponent(fab), {
        headers: { Accept: 'application/json' },
      });
      var data = await res.json();
      if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || 'Laden fehlgeschlagen');
      writeCache(fab, data);
      paint(host, data, '');
    } catch (e) {
      if (cached && cached.teilnehmer) {
        paint(host, cached, 'Offline: zuletzt gespeicherte Teilnehmer.');
      } else {
        paint(host, { teilnehmer: [], links: [] }, e && e.message ? e.message : 'Laden fehlgeschlagen');
      }
    }
  }

  function blankRow() {
    return {
      mac: '',
      station_name: '',
      ip_address: '',
      subnet_mask: '255.255.255.0',
      gateway: '',
      vendor: '',
      last_seen_name: '',
      last_seen_ip: '',
    };
  }

  function openEditor(host, row) {
    var data = host._profinetData || { teilnehmer: [], links: [] };
    var existing = document.getElementById('profinetSollDialog');
    if (existing) existing.remove();
    var dialog = document.createElement('div');
    dialog.id = 'profinetSollDialog';
    dialog.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:80;display:flex;align-items:center;justify-content:center;padding:1rem;';
    dialog.innerHTML = ''
      + '<form class="card" style="width:min(520px,100%);margin:0">'
      + '<h2 style="margin-top:0">Soll-Werte</h2>'
      + '<p class="muted">Scan, Blinken, Taufen und Umtaufen nur in KUKpit unter Tools → Profinet, und nur mit Npcap. Download: <a href="' + DOWNLOAD_URL + '" target="_blank" rel="noopener">npcap.com</a></p>'
      + '<div class="form-group"><label>MAC</label><input name="mac" required value="' + esc(row.mac || '') + '"></div>'
      + '<div class="form-group"><label>Stationsname</label><input name="station_name" value="' + esc(row.station_name || '') + '"></div>'
      + '<div class="form-group"><label>IP</label><input name="ip_address" value="' + esc(row.ip_address || '') + '"></div>'
      + '<div class="form-group"><label>Maske</label><input name="subnet_mask" value="' + esc(row.subnet_mask || '') + '"></div>'
      + '<div class="form-group"><label>Gateway</label><input name="gateway" value="' + esc(row.gateway || '') + '"></div>'
      + '<div style="display:flex;gap:0.5rem;flex-wrap:wrap">'
      + '<button type="submit" class="btn btn-primary">Speichern</button>'
      + '<button type="button" class="btn btn-ghost" data-close>Abbrechen</button>'
      + '</div></form>';
    document.body.appendChild(dialog);
    dialog.querySelector('[data-close]').addEventListener('click', function () { dialog.remove(); });
    dialog.addEventListener('click', function (ev) { if (ev.target === dialog) dialog.remove(); });
    dialog.querySelector('form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var form = ev.target;
      var next = {
        mac: String(form.mac.value || '').trim().toLowerCase(),
        station_name: String(form.station_name.value || '').trim(),
        ip_address: String(form.ip_address.value || '').trim(),
        subnet_mask: String(form.subnet_mask.value || '').trim(),
        gateway: String(form.gateway.value || '').trim(),
        vendor: row.vendor || '',
        last_seen_name: row.last_seen_name || '',
        last_seen_ip: row.last_seen_ip || '',
        last_written_at: row.last_written_at || '',
      };
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(next.mac)) {
        window.alert('MAC im Format aa:bb:cc:dd:ee:ff.');
        return;
      }
      var list = (data.teilnehmer || []).filter(function (item) {
        return String(item.mac || '').toLowerCase() !== String(row.mac || '').toLowerCase()
          && String(item.mac || '').toLowerCase() !== next.mac;
      });
      list.push(next);
      save(host, list, data.links || []).then(function (ok) { if (ok) dialog.remove(); });
    });
  }

  async function save(host, teilnehmer, links) {
    var fab = currentFab();
    if (!fab) {
      window.alert('Fabrikationsnummer fehlt.');
      return false;
    }
    var payload = Object.assign({
      fabrikationsnummer: fab,
      teilnehmer: teilnehmer,
      links: links || [],
    }, sessionExtra());
    var local = { ok: true, fabrikationsnummer: fab, teilnehmer: teilnehmer, links: links || [], local_only: true };
    writeCache(fab, local);
    try {
      var res = await fetch('/api/anlagenstamm_profinet.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      var data = await res.json();
      if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || 'Speichern fehlgeschlagen');
      await load(host && host.closest ? host.closest('.akte-panel') || document : document);
      return true;
    } catch (e) {
      paint(host, local, 'Lokal gespeichert. Sync folgt, sobald die Verbindung steht. ' + (e && e.message ? e.message : ''));
      return true;
    }
  }

  function onActivate(target) {
    var mac = target && target.getAttribute ? target.getAttribute('data-mac') : '';
    if (!mac) return;
    var host = target.closest('[data-profinet-akte]');
    if (!host || !host._profinetData) return;
    var row = (host._profinetData.teilnehmer || []).find(function (item) {
      return String(item.mac || '').toLowerCase() === mac.toLowerCase();
    }) || { mac: mac };
    var fab = currentFab();
    if (typeof window.openProfinet === 'function') {
      window.openProfinet({ fabrikationsnummer: fab, mac: mac, device: row });
      return;
    }
    if (window.monteurApp && typeof window.monteurApp.openProfinet === 'function') {
      window.monteurApp.openProfinet({ fabrikationsnummer: fab, mac: mac, device: row });
      return;
    }
    openEditor(host, row);
  }

  document.addEventListener('click', function (ev) {
    var tab = ev.target && ev.target.closest ? ev.target.closest('[data-akte-tab="bussystem"]') : null;
    if (tab) {
      var root = tab.closest('form, .akte-page, .popup-form-window') || document;
      load(root);
      return;
    }
    var add = ev.target && ev.target.closest ? ev.target.closest('[data-profinet-add]') : null;
    if (add) {
      var host = add.closest('[data-profinet-akte]');
      if (host) openEditor(host, blankRow());
    }
  });

  document.addEventListener('dblclick', function (ev) {
    var node = ev.target && ev.target.closest ? ev.target.closest('.profinet-node, .profinet-table tbody tr') : null;
    if (!node || !node.closest('[data-profinet-akte]')) return;
    onActivate(node);
  });

  window.kuklaProfinetAkte = { load: load };
})();
