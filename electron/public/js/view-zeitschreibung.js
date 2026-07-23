/**
 * Zeitschreibung — Monatsformular nach Excel-Vorlage.
 */
(function (global) {
  const api = (global.monteurApp && global.monteurApp.apiBase) || 'http://127.0.0.1:39678';
  const MONTH_NAMES = ['', 'Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const WEEKDAY_LONG = {
    Mo: 'Montag', Di: 'Dienstag', Mi: 'Mittwoch', Do: 'Donnerstag',
    Fr: 'Freitag', Sa: 'Samstag', So: 'Sonntag',
  };
  const HOUR_FIELDS = ['anw', 'montage', 'ue50', 'ue100', 'weg', 'urlaub', 'za_plus', 'za_minus', 'krank'];
  const FIELD_META = {
    anw: { short: 'Anw. (h)', title: 'Anwesenheit in Stunden', spoken: 'Anwesenheit' },
    montage: { short: 'Montage (h)', title: 'Montagezeit in Stunden', spoken: 'Montagezeit' },
    ue50: { short: 'Ü 50 % (h)', title: 'Überstunden mit 50 % Zuschlag', spoken: 'Überstunden 50 %' },
    ue100: { short: 'Ü 100 % (h)', title: 'Überstunden mit 100 % Zuschlag', spoken: 'Überstunden 100 %' },
    weg: { short: 'Weg (h)', title: 'Wegzeit in Stunden', spoken: 'Wegzeit' },
    urlaub: { short: 'Urlaub (h)', title: 'Urlaub in Stunden', spoken: 'Urlaub' },
    za_plus: { short: 'ZA + (h)', title: 'Aufbau Zeitguthaben', spoken: 'Zeitguthaben' },
    za_minus: { short: 'ZA − (h)', title: 'Verbrauch Zeitguthaben', spoken: 'Zeitausgleich' },
    krank: { short: 'Krank / Arzt (h)', title: 'Krank / Arzt in Stunden', spoken: 'Krank / Arzt' },
    bemerkung: { short: 'Bemerkung', title: 'Bemerkung', spoken: 'Bemerkung' },
  };
  const ACTIVE_IDLE = 'Klicken Sie in ein Feld, um Stunden einzutragen.';

  let state = {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    technicianId: 0,
    technicianName: '',
    days: [],
    status: 'draft',
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

  function hourEff(row, f) {
    const lk = 'lohn_' + f;
    if (row[lk] != null && row[lk] !== '') return num(row[lk]);
    return num(row[f]);
  }

  function daySum(row) {
    return num(row.anw) + num(row.montage) + num(row.ue50) + num(row.ue100) + num(row.weg) + num(row.urlaub) + num(row.za_minus) + num(row.krank);
  }

  function daySumEff(row) {
    return hourEff(row, 'anw') + hourEff(row, 'montage') + hourEff(row, 'ue50') + hourEff(row, 'ue100') + hourEff(row, 'weg') + hourEff(row, 'urlaub') + hourEff(row, 'za_minus') + hourEff(row, 'krank');
  }

  function columnSums(days) {
    const s = { anw: 0, montage: 0, ue50: 0, ue100: 0, weg: 0, urlaub: 0, za_plus: 0, za_minus: 0, krank: 0, day_sum: 0 };
    for (const d of days) {
      for (const f of HOUR_FIELDS) s[f] += hourEff(d, f);
      s.day_sum += daySumEff(d);
    }
    return s;
  }

  function korrLabel(d, field) {
    const k = d && d.korrekturen && d.korrekturen[field];
    if (k && k.label) return String(k.label);
    // Fallback ohne Server-Label: Original → Override
    if (field === 'bemerkung') {
      if (d.lohn_bemerkung == null) return '';
      const from = String(d.bemerkung || '') || '–';
      const to = String(d.lohn_bemerkung) || '–';
      return from + ' → ' + to + ' (Lohn)';
    }
    const lk = 'lohn_' + field;
    if (d[lk] == null || d[lk] === '') return '';
    const from = num(d[field]);
    const to = num(d[lk]);
    const fmtN = function (n) {
      if (Math.abs(n - Math.round(n)) < 0.0001) return String(Math.round(n));
      return String(Math.round(n * 1000) / 1000).replace('.', ',');
    };
    return fmtN(from) + ' → ' + fmtN(to) + ' (Lohn)';
  }

  function hasLohnOverride(d, field) {
    if (field === 'bemerkung') return d.lohn_bemerkung != null;
    return d['lohn_' + field] != null && d['lohn_' + field] !== '';
  }

  function bemerkungEff(d) {
    if (d.lohn_bemerkung != null) return String(d.lohn_bemerkung);
    return String(d.bemerkung || '');
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

  function dateLongDe(iso, weekdayCode) {
    const k = String(iso || '');
    if (k.length < 10) return k;
    const day = parseInt(k.slice(8, 10), 10);
    const month = parseInt(k.slice(5, 7), 10);
    const wd = WEEKDAY_LONG[weekdayCode] || weekdayCode || '';
    const monthName = MONTH_NAMES[month] || String(month);
    return (wd ? wd + ', ' : '') + day + '. ' + monthName;
  }

  function fieldSpoken(field) {
    return (FIELD_META[field] && FIELD_META[field].spoken) || field;
  }

  function ariaLabelFor(field, weekdayCode, iso) {
    return fieldSpoken(field) + ' am ' + dateLongDe(iso, weekdayCode);
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
      const locked = tr.getAttribute('data-lohn-gesperrt') === '1';
      const day = {
        day_date: tr.getAttribute('data-day-date'),
        weekday: tr.getAttribute('data-weekday') || '',
        holiday_label: tr.getAttribute('data-holiday') || '',
        lohn_gesperrt: locked ? 1 : 0,
      };
      HOUR_FIELDS.forEach(function (f) {
        const inp = tr.querySelector('input[data-field="' + f + '"]');
        // Nur bei aktiver Sperre Original aus data-monteur (Effektivwert steht im Input)
        if (locked && inp && inp.getAttribute('data-monteur') != null) {
          day[f] = num(inp.getAttribute('data-monteur'));
        } else {
          day[f] = inp ? num(inp.value) : 0;
        }
      });
      const bem = tr.querySelector('input[data-field="bemerkung"]');
      if (locked && bem && bem.getAttribute('data-monteur') != null) {
        day.bemerkung = String(bem.getAttribute('data-monteur') || '');
      } else {
        day.bemerkung = bem ? String(bem.value || '') : '';
      }
      day.day_sum = daySum(day);
      rows.push(day);
    });
    return rows;
  }

  function summeAlertClass(daySumValue) {
    const v = num(daySumValue);
    if (v > 12.01) return ' zs-sum-high';
    if (v > 10) return ' zs-sum-warn';
    return '';
  }

  function recomputeDom(host) {
    host.querySelectorAll('tr[data-day-date]').forEach(function (tr) {
      const locked = tr.getAttribute('data-lohn-gesperrt') === '1';
      const row = {};
      HOUR_FIELDS.forEach(function (f) {
        const inp = tr.querySelector('input[data-field="' + f + '"]');
        if (locked && inp && inp.getAttribute('data-lohn-eff') != null) {
          row['lohn_' + f] = num(inp.getAttribute('data-lohn-eff'));
          row[f] = num(inp.getAttribute('data-monteur'));
        } else {
          row[f] = inp ? num(inp.value) : 0;
        }
      });
      const sumVal = daySumEff(row);
      const cell = tr.querySelector('[data-day-sum]');
      if (cell) {
        cell.textContent = fmt(sumVal);
        cell.classList.remove('zs-sum-high', 'zs-sum-warn');
        const alertCls = summeAlertClass(sumVal).trim();
        if (alertCls) cell.classList.add(alertCls);
      }
    });
    const days = readDaysFromDom(host);
    // Für Fußzeile: sichtbare Effektivwerte aus Inputs (bei Lock inkl. Override-Attr)
    const visible = [];
    host.querySelectorAll('tr[data-day-date]').forEach(function (tr) {
      const locked = tr.getAttribute('data-lohn-gesperrt') === '1';
      const row = { day_date: tr.getAttribute('data-day-date') };
      HOUR_FIELDS.forEach(function (f) {
        const inp = tr.querySelector('input[data-field="' + f + '"]');
        if (locked && inp && inp.getAttribute('data-lohn-eff') != null) {
          row[f] = num(inp.getAttribute('data-lohn-eff'));
        } else if (inp && inp.getAttribute('data-lohn-eff') != null && inp.getAttribute('data-has-korr') === '1') {
          row[f] = num(inp.getAttribute('data-lohn-eff'));
        } else {
          row[f] = inp ? num(inp.value) : 0;
        }
      });
      visible.push(row);
    });
    const sums = columnSums(visible.length ? visible : days);
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
      var locked = !!Number(d.lohn_gesperrt);
      var rowClass = '';
      if (String(d.holiday_label || '').trim()) rowClass = ' zs-row-holiday';
      else if (d.weekday === 'So') rowClass = ' zs-row-so';
      else if (d.weekday === 'Sa') rowClass = ' zs-row-sa';
      if (locked) rowClass += ' zs-row-locked';
      var sumVal = daySumEff(d);
      var sumCls = summeAlertClass(sumVal);
      var statusCell = locked
        ? '<td class="zs-col-status" data-col="status" title="Von Lohnbuchhaltung gesperrt"><img class="zs-lock-check-icon" src="icons/circle-check-green.svg" alt="Gesperrt" width="16" height="16"></td>'
        : '<td class="zs-col-status zs-dash" data-col="status">–</td>';
      var bemOrig = String(d.bemerkung || '');
      var bemShow = locked ? bemerkungEff(d) : bemOrig;
      var bemLabel = korrLabel(d, 'bemerkung');
      var bemAria = ariaLabelFor('bemerkung', d.weekday, d.day_date);
      body += `<tr class="${rowClass.trim()}" data-day-date="${escapeHtml(d.day_date)}" data-weekday="${escapeHtml(d.weekday)}" data-holiday="${escapeHtml(d.holiday_label || '')}" data-lohn-gesperrt="${locked ? '1' : '0'}">
        <td class="zs-sticky-tag" data-col="tag">${escapeHtml(dateDe(d.day_date))}</td>
        <td class="zs-sticky-wt" data-col="wt">${escapeHtml(d.weekday)}</td>
        <td class="zs-holiday zs-sticky-holiday zs-sep-after" data-col="feiertag">${escapeHtml(d.holiday_label || '')}</td>
        ${HOUR_FIELDS.map(function (f) {
          var monteurVal = num(d[f]);
          var eff = hourEff(d, f);
          var label = korrLabel(d, f);
          var hasKorr = hasLohnOverride(d, f) || !!label;
          var showVal = locked ? eff : monteurVal;
          var display = showVal ? escapeHtml(String(showVal)) : '';
          var tip = label ? ` title="${escapeHtml(label)}"` : '';
          var sep = (f === 'weg' || f === 'krank') ? ' zs-sep-after' : '';
          var aria = escapeHtml(ariaLabelFor(f, d.weekday, d.day_date));
          return `<td class="zs-col-hour${hasKorr ? ' zs-corrected' : ''}${sep}" data-col="${f}"><div class="zs-hour-cell">
            <input type="number" step="0.25" min="0" class="zs-input zs-hour${hasKorr ? ' is-corrected' : ''}" data-field="${f}" data-col="${f}" data-monteur="${escapeHtml(String(monteurVal))}" data-lohn-eff="${escapeHtml(String(eff))}" data-has-korr="${hasKorr ? '1' : '0'}" value="${display}" aria-label="${aria}"${tip}${locked ? ' disabled' : ''}>
          </div></td>`;
        }).join('')}
        <td class="zs-sum zs-sep-after${sumCls}" data-col="summe" data-day-sum>${escapeHtml(fmt(sumVal))}</td>
        <td class="zs-col-bemerkung${bemLabel ? ' zs-corrected' : ''}" data-col="bemerkung"><div class="zs-bem-cell">
          <input type="text" class="zs-input zs-bemerkung${bemLabel ? ' is-corrected' : ''}" data-field="bemerkung" data-col="bemerkung" data-monteur="${escapeHtml(bemOrig)}" value="${escapeHtml(bemShow)}" aria-label="${escapeHtml(bemAria)}"${bemLabel ? ` title="${escapeHtml(bemLabel)}"` : ''}${locked ? ' disabled' : ''}>
        </div></td>
        ${statusCell}
      </tr>`;
    });
    return `<div class="zs-active-bar is-idle" id="zsActiveBar" aria-live="polite">
      <span class="zs-active-bar-label">Aktive Eingabe:</span>
      <span class="zs-active-bar-text" id="zsActiveField">${escapeHtml(ACTIVE_IDLE)}</span>
    </div>
    <div class="zs-table-wrap"><table class="zs-table">
      <thead>
        <tr class="zs-head-groups">
          <th class="zs-sticky-tag" colspan="3" scope="colgroup">Datum</th>
          <th colspan="5" scope="colgroup">Arbeits- und Reisezeit</th>
          <th colspan="4" scope="colgroup">Abwesenheit und Zeitkonto</th>
          <th colspan="1" scope="colgroup">Ergebnis</th>
          <th colspan="2" scope="colgroup">Informationen</th>
        </tr>
        <tr class="zs-head-cols">
          <th class="zs-sticky-tag" data-col="tag" title="Kalendertag">Tag</th>
          <th class="zs-sticky-wt" data-col="wt" title="Wochentag">WT</th>
          <th class="zs-sticky-holiday zs-sep-after" data-col="feiertag" title="Feiertag">Feiertag</th>
          ${HOUR_FIELDS.map(function (f) {
            var m = FIELD_META[f];
            var sep = (f === 'weg' || f === 'krank') ? ' zs-sep-after' : '';
            return `<th class="zs-col-hour${sep}" data-col="${f}" title="${escapeHtml(m.title)}">${escapeHtml(m.short)}</th>`;
          }).join('')}
          <th class="zs-col-sum zs-sep-after" data-col="summe" title="Tagessumme in Stunden">Summe (h)</th>
          <th data-col="bemerkung" title="Bemerkung">Bemerkung</th>
          <th class="zs-col-status" data-col="status" title="Sperrstatus">Status</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <th class="zs-sticky-tag" scope="row">Gesamt</th>
        <th class="zs-sticky-wt" data-sum="gesamt">${escapeHtml(fmtAlways(g))}</th>
        <th class="zs-sticky-holiday zs-sep-after"></th>
        ${HOUR_FIELDS.map(function (f) {
          var sep = (f === 'weg' || f === 'krank') ? ' zs-sep-after' : '';
          return `<th class="zs-col-hour${sep}" data-sum="${f}">${escapeHtml(fmtAlways(sums[f]))}</th>`;
        }).join('')}
        <th class="zs-col-sum zs-sep-after" data-sum="day_sum">${escapeHtml(fmtAlways(sums.day_sum))}</th>
        <th></th><th class="zs-col-status"></th>
      </tr></tfoot>
    </table></div>`;
  }

  function renderShell() {
    return `<div class="page-zeitschreibung zs-sp-page">
      <div class="zs-sp-col">
        <div class="sp-v2-topbar zs-sp-topbar">
          <h1 class="sp-v2-page-title">
            <img class="sp-v2-icon" src="icons/calendar-green.svg" alt="" aria-hidden="true">
            Zeitschreibung
          </h1>
        </div>

        <section class="sp-v2-section" aria-labelledby="zsSecZeitraumTitle">
          <header class="sp-v2-section-head" id="zsSecZeitraumTitle">
            <span class="sp-v2-num">1</span>
            <img class="sp-v2-icon" src="icons/calendar-green.svg" alt="" aria-hidden="true">
            Zeitraum
          </header>
          <div class="sp-v2-section-body">
            <div class="sp-v2-grid-3">
              <label class="sp-v2-field">
                <span>Jahr</span>
                <select id="zsYear">${yearOptions()}</select>
              </label>
              <label class="sp-v2-field">
                <span>Monat</span>
                <select id="zsMonth">${monthOptions()}</select>
              </label>
              <div class="sp-v2-field">
                <span>Monteur / Status</span>
                <div class="zs-meta-line" style="margin-top:0.35rem">
                  <span class="zs-tech-name" id="zsTechName">${escapeHtml(state.technicianName)}</span>
                  <span class="zs-status" id="zsStatus">Status: ${escapeHtml(state.status)}</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="sp-v2-section" aria-labelledby="zsSecExportTitle">
          <header class="sp-v2-section-head" id="zsSecExportTitle">
            <span class="sp-v2-num">2</span>
            <img class="sp-v2-icon" src="icons/save-green.svg" alt="" aria-hidden="true">
            Speichern &amp; Freigabe
          </header>
          <div class="sp-v2-section-body">
            <div class="zs-actions" style="margin-top:0">
              <button type="button" class="btn" id="zsSave">Speichern</button>
              <button type="button" class="btn btn-primary" id="zsSubmit">Freigeben (PDF)</button>
              <span class="zs-msg" id="zsMsg" aria-live="polite"></span>
            </div>
          </div>
        </section>

        <section class="sp-v2-section" aria-labelledby="zsSecTabelleTitle">
          <header class="sp-v2-section-head" id="zsSecTabelleTitle">
            <span class="sp-v2-num">3</span>
            <img class="sp-v2-icon" src="icons/clipboard-check-green.svg" alt="" aria-hidden="true">
            Monatstabelle
          </header>
          <div class="sp-v2-section-body">
            ${renderTable()}
          </div>
        </section>
      </div>
    </div>`;
  }

  function setActiveFieldInfo(host, inp) {
    const bar = host.querySelector('#zsActiveBar');
    const text = host.querySelector('#zsActiveField');
    if (!bar || !text) return;
    if (!inp) {
      bar.classList.add('is-idle');
      text.textContent = ACTIVE_IDLE;
      return;
    }
    const tr = inp.closest('tr[data-day-date]');
    if (!tr) {
      bar.classList.add('is-idle');
      text.textContent = ACTIVE_IDLE;
      return;
    }
    const field = inp.getAttribute('data-field') || inp.getAttribute('data-col') || '';
    const spoken = fieldSpoken(field);
    const line = dateLongDe(tr.getAttribute('data-day-date'), tr.getAttribute('data-weekday')) + ' – ' + spoken;
    bar.classList.remove('is-idle');
    text.textContent = line;
  }

  function clearColActive(host) {
    host.querySelectorAll('.zs-col-active').forEach(function (el) {
      el.classList.remove('zs-col-active');
    });
  }

  function setColActive(host, col) {
    clearColActive(host);
    if (!col) return;
    host.querySelectorAll('[data-col="' + col + '"]').forEach(function (el) {
      el.classList.add('zs-col-active');
    });
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
    host.querySelectorAll('.zs-input').forEach(function (inp) {
      inp.addEventListener('input', function () {
        state.dirty = true;
        recomputeDom(host);
      });
      inp.addEventListener('focusin', function () {
        setActiveFieldInfo(host, inp);
        setColActive(host, inp.getAttribute('data-col') || inp.getAttribute('data-field'));
      });
      inp.addEventListener('focusout', function () {
        // delay: Tab zu nächstem Feld innerhalb derselben Tabelle
        setTimeout(function () {
          const active = document.activeElement;
          if (!active || !host.contains(active) || !active.classList.contains('zs-input')) {
            setActiveFieldInfo(host, null);
            clearColActive(host);
          }
        }, 0);
      });
    });
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
      if (!Array.isArray(state.days) || !state.days.length) {
        setMsg(host, 'Keine Tageszeilen zum Speichern.', true);
        return;
      }
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
      try {
        await reload(host);
      } catch (_) {
        const st = host.querySelector('#zsStatus');
        if (st) st.textContent = 'Status: ' + state.status;
      }
      if (submit) {
        let msg = 'Freigegeben. PDF: ' + (data.pdf_path || '');
        if (data.synced) msg += ' · an Dispo übertragen';
        else if (data.sync_pending) msg += ' · Sync ausstehend (beim nächsten sync_push)';
        setMsg(host, msg, false);
      } else {
        let msg = 'Gespeichert';
        if (data.synced) msg += ' und an Dispo übertragen.';
        else if (data.sync_pending) msg += '. Sync ausstehend (offline oder beim nächsten sync_push).';
        else msg += '.';
        setMsg(host, msg, false);
      }
    } catch (e) {
      var msg = e.message || String(e);
      if (/Zeitaufzeichnungen-Ordner|Basispfad|NO_BASE_PATH/i.test(msg)) {
        msg = 'Bitte unter Einstellungen den Speicherort Zeitaufzeichnungen-Ordner festlegen.';
      }
      setMsg(host, msg, true);
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
