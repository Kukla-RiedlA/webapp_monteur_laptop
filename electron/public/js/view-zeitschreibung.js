/**
 * Zeitschreibung — Monatsformular nach Excel-Vorlage.
 */
(function (global) {
  const api = (global.monteurApp && global.monteurApp.apiBase) || 'http://127.0.0.1:39678';
  const MONTH_NAMES = ['', 'Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const HOUR_FIELDS = ['anw', 'montage', 'ue50', 'ue100', 'weg', 'urlaub', 'za_plus', 'za_minus', 'krank'];

  let state = {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    technicianId: 0,
    technicianName: '',
    days: [],
    status: 'draft',
    basePath: '',
    dirty: false,
  };

  function resolveTechId() {
    if (typeof global.getTechId === 'function') return global.getTechId();
    try {
      const tid = localStorage.getItem('monteur_technicianId');
      return tid ? parseInt(tid, 10) : 0;
    } catch (_) {
      return 0;
    }
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }

  function daySum(row) {
    return num(row.anw) + num(row.montage) + num(row.ue50) + num(row.ue100) + num(row.weg) + num(row.urlaub) + num(row.za_minus) + num(row.krank);
  }

  function columnSums(days) {
    const s = { anw: 0, montage: 0, ue50: 0, ue100: 0, weg: 0, urlaub: 0, za_plus: 0, za_minus: 0, krank: 0, day_sum: 0 };
    for (const d of days) {
      for (const f of HOUR_FIELDS) s[f] += num(d[f]);
      s.day_sum += daySum(d);
    }
    return s;
  }

  function gesamtSum(s) {
    return num(s.anw) + num(s.montage) + num(s.ue50) + num(s.ue100) + num(s.weg) - num(s.urlaub) + num(s.za_plus) - num(s.za_minus) - num(s.krank);
  }

  function fmt(n) {
    const v = Math.round(num(n) * 1000) / 1000;
    if (!v) return '';
    return String(v);
  }

  function fmtAlways(n) {
    return String(Math.round(num(n) * 1000) / 1000);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function dateDe(iso) {
    const k = String(iso || '');
    if (k.length < 10) return k;
    return k.slice(8, 10) + '.' + k.slice(5, 7) + '.' + k.slice(0, 4);
  }

  async function jfetch(path, opts) {
    const r = await fetch(api + path, Object.assign({ credentials: 'same-origin' }, opts || {}));
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + r.status);
    return data;
  }

  function yearOptions() {
    const y = new Date().getFullYear();
    let html = '';
    for (let yr = y - 5; yr <= y + 2; yr++) {
      html += `<option value="${yr}"${state.year === yr ? ' selected' : ''}>${yr}</option>`;
    }
    return html;
  }

  function monthOptions() {
    let html = '';
    for (let m = 1; m <= 12; m++) {
      html += `<option value="${m}"${state.month === m ? ' selected' : ''}>${MONTH_NAMES[m]}</option>`;
    }
    return html;
  }

  function readDaysFromDom(host) {
    const rows = [];
    host.querySelectorAll('tr[data-day-date]').forEach(function (tr) {
      const day = { day_date: tr.getAttribute('data-day-date'), weekday: tr.getAttribute('data-weekday') || '', holiday_label: tr.getAttribute('data-holiday') || '' };
      HOUR_FIELDS.forEach(function (f) {
        const inp = tr.querySelector('input[data-field="' + f + '"]');
        day[f] = inp ? num(inp.value) : 0;
      });
      const bem = tr.querySelector('input[data-field="bemerkung"]');
      day.bemerkung = bem ? String(bem.value || '') : '';
      day.day_sum = daySum(day);
      rows.push(day);
    });
    return rows;
  }

  function recomputeDom(host) {
    host.querySelectorAll('tr[data-day-date]').forEach(function (tr) {
      const row = {};
      HOUR_FIELDS.forEach(function (f) {
        const inp = tr.querySelector('input[data-field="' + f + '"]');
        row[f] = inp ? num(inp.value) : 0;
      });
      const cell = tr.querySelector('[data-day-sum]');
      if (cell) cell.textContent = fmt(daySum(row));
    });
    const days = readDaysFromDom(host);
    const sums = columnSums(days);
    const g = gesamtSum(sums);
    const set = function (key, val) {
      const el = host.querySelector('[data-sum="' + key + '"]');
      if (el) el.textContent = fmtAlways(val);
    };
    HOUR_FIELDS.forEach(function (f) { set(f, sums[f]); });
    set('day_sum', sums.day_sum);
    set('gesamt', g);
  }

  function renderTable() {
    const sums = columnSums(state.days);
    const g = gesamtSum(sums);
    let body = '';
    state.days.forEach(function (d) {
      body += `<tr data-day-date="${escapeHtml(d.day_date)}" data-weekday="${escapeHtml(d.weekday)}" data-holiday="${escapeHtml(d.holiday_label || '')}">
        <td>${escapeHtml(dateDe(d.day_date))}</td>
        <td>${escapeHtml(d.weekday)}</td>
        <td class="zs-holiday">${escapeHtml(d.holiday_label || '')}</td>
        ${HOUR_FIELDS.map(function (f) {
          return `<td><input type="number" step="0.25" min="0" class="zs-input" data-field="${f}" value="${d[f] ? escapeHtml(String(d[f])) : ''}"></td>`;
        }).join('')}
        <td class="zs-sum" data-day-sum>${escapeHtml(fmt(daySum(d)))}</td>
        <td><input type="text" class="zs-input zs-bemerkung" data-field="bemerkung" value="${escapeHtml(d.bemerkung || '')}"></td>
      </tr>`;
    });
    return `<div class="zs-table-wrap"><table class="zs-table">
      <thead><tr>
        <th>Datum</th><th>Tag</th><th>Feiert.</th><th>Anw.</th><th>Montage</th><th>Ü/50%</th><th>Ü/100%</th>
        <th>Weg</th><th>Urlaub</th><th>ZA+</th><th>ZA−</th><th>Krank</th><th>Summe</th><th>Bemerkung</th>
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <th>Gesamt</th><th data-sum="gesamt">${escapeHtml(fmtAlways(g))}</th><th></th>
        ${HOUR_FIELDS.map(function (f) { return `<th data-sum="${f}">${escapeHtml(fmtAlways(sums[f]))}</th>`; }).join('')}
        <th data-sum="day_sum">${escapeHtml(fmtAlways(sums.day_sum))}</th><th></th>
      </tr></tfoot>
    </table></div>`;
  }

  function renderShell() {
    return `<div class="page-zeitschreibung">
      <div class="sp-v2-topbar"><h1 class="sp-v2-page-title">Zeitschreibung</h1></div>
      <div class="zs-toolbar">
        <label>Jahr <select id="zsYear">${yearOptions()}</select></label>
        <label>Monat <select id="zsMonth">${monthOptions()}</select></label>
        <span class="zs-tech-name" id="zsTechName">${escapeHtml(state.technicianName)}</span>
        <span class="zs-status" id="zsStatus">Status: ${escapeHtml(state.status)}</span>
      </div>
      <div class="zs-path-row">
        <label class="zs-path-label">Zeitaufzeichnungen-Ordner
          <input type="text" id="zsBasePath" class="zs-path-input" value="${escapeHtml(state.basePath)}" placeholder="z. B. …\\Zeitaufzeichnungen" readonly>
        </label>
        <button type="button" class="btn btn-ghost" id="zsChoosePath">Ordner wählen</button>
      </div>
      <div class="zs-actions">
        <button type="button" class="btn" id="zsSave">Speichern</button>
        <button type="button" class="btn btn-primary" id="zsSubmit">Freigeben (PDF)</button>
        <span class="zs-msg" id="zsMsg" aria-live="polite"></span>
      </div>
      ${renderTable()}
    </div>`;
  }

  function bind(host) {
    host.querySelector('#zsYear').addEventListener('change', async function (e) {
      state.year = parseInt(e.target.value, 10);
      await reload(host);
    });
    host.querySelector('#zsMonth').addEventListener('change', async function (e) {
      state.month = parseInt(e.target.value, 10);
      await reload(host);
    });
    host.querySelector('#zsSave').addEventListener('click', function () { save(host, false); });
    host.querySelector('#zsSubmit').addEventListener('click', function () { save(host, true); });
    host.querySelector('#zsChoosePath').addEventListener('click', function () { choosePath(host); });
    host.querySelectorAll('.zs-input').forEach(function (inp) {
      inp.addEventListener('input', function () {
        state.dirty = true;
        recomputeDom(host);
      });
    });
  }

  async function choosePath(host) {
    try {
      const picker =
        (global.monteurApp && typeof global.monteurApp.chooseDienstreiseBasePath === 'function'
          ? global.monteurApp.chooseDienstreiseBasePath
          : null) ||
        (global.electronAPI && typeof global.electronAPI.chooseDienstreiseBasePath === 'function'
          ? global.electronAPI.chooseDienstreiseBasePath
          : null);
      if (!picker) {
        setMsg(host, 'Ordnerdialog nicht verfügbar. Bitte App neu starten.', true);
        return;
      }
      const p = await picker();
      if (!p) return;
      await jfetch('/api/zeitschreibung/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ basePath: p }),
      });
      state.basePath = p;
      const inp = host.querySelector('#zsBasePath');
      if (inp) inp.value = p;
      setMsg(host, 'Ordner gespeichert.', false);
    } catch (e) {
      setMsg(host, e.message || String(e), true);
    }
  }

  function setMsg(host, text, isErr) {
    const el = host.querySelector('#zsMsg');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = isErr ? '#b00020' : '';
  }

  async function save(host, submit) {
    try {
      state.days = readDaysFromDom(host);
      const body = {
        technician_id: state.technicianId,
        year: state.year,
        month: state.month,
        days: state.days,
      };
      const path = submit ? '/api/zeitschreibung/submit' : '/api/zeitschreibung/save';
      setMsg(host, submit ? 'Freigabe…' : 'Speichern…', false);
      const data = await jfetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      state.status = data.status || (submit ? 'submitted' : 'draft');
      state.dirty = false;
      const st = host.querySelector('#zsStatus');
      if (st) st.textContent = 'Status: ' + state.status;
      setMsg(host, submit ? ('Freigegeben. PDF: ' + (data.pdf_path || '')) : 'Gespeichert.', false);
    } catch (e) {
      setMsg(host, e.message || String(e), true);
    }
  }

  async function reload(host) {
    const data = await jfetch(
      '/api/zeitschreibung?technician_id=' + encodeURIComponent(state.technicianId) +
      '&year=' + encodeURIComponent(state.year) +
      '&month=' + encodeURIComponent(state.month),
    );
    state.days = data.days || [];
    state.status = data.status || 'draft';
    state.technicianName = data.technician_name || state.technicianName;
    state.basePath = (data.config && data.config.basePath) || state.basePath || '';
    host.innerHTML = renderShell();
    bind(host);
  }

  async function load(hostEl) {
    const host = typeof hostEl === 'string' ? document.querySelector(hostEl) : hostEl;
    if (!host) return;
    state.technicianId = resolveTechId();
    if (!state.technicianId) {
      host.innerHTML = '<p class="muted">Kein Techniker angemeldet.</p>';
      return;
    }
    host.innerHTML = '<p class="muted">Lade Zeitschreibung…</p>';
    try {
      await reload(host);
    } catch (e) {
      host.innerHTML = '<p class="muted">' + escapeHtml(e.message || String(e)) + '</p>';
    }
  }

  global.monteurZeitschreibung = { load: load };
})(typeof window !== 'undefined' ? window : globalThis);
