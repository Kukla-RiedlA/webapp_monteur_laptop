/**
 * Offline-Anlagenstamm — Layout/Styles wie dispo/anlagenstamm.php (Cache-Liste).
 */
(function (global) {
  const api = (global.monteurApp && global.monteurApp.apiBase) || 'http://127.0.0.1:39678';

  const COLUMNS = [
    { key: 'fabrikationsnummer', label: 'F.N.', filterId: 'filterFn', always: true },
    { key: 'type', label: 'Type', filterId: 'filterType', always: true },
    { key: 'leistung', label: 'Leistung', filterId: 'filterLeistung', col: 'leistung', defaultOn: true },
    { key: 'ted', label: 'TED / Mechanik', filterId: 'filterTed', always: true, virtual: true },
    { key: 'pn_root', label: 'PROJEKTE NEU', filterId: 'filterPnRoot', always: true, virtual: true },
    { key: 'nenngeschwindigkeit', label: 'v', filterId: 'filterV', col: 'nenngeschwindigkeit' },
    { key: 'kraftaufnehmer', label: 'Kraftaufnehmer', filterId: 'filterKraftaufnehmer', col: 'kraftaufnehmer', defaultOn: true },
    { key: 'dms_nr', label: 'DMS Nr.', filterId: 'filterDmsNr', col: 'dms_nr' },
    { key: 'tacho', label: 'Tacho', filterId: 'filterTacho', col: 'tacho', defaultOn: true },
    { key: 'elektronik', label: 'Elektronik', filterId: 'filterElektronik', col: 'elektronik', defaultOn: true },
    { key: 'material', label: 'Material', filterId: 'filterMaterial', col: 'material', defaultOn: true },
    { key: 'position', label: 'Position', filterId: 'filterPosition', col: 'position' },
    { key: 'aktueller_kunde', label: 'Letzter Kunde', filterId: 'filterAktuellerKunde', col: 'aktueller_kunde', defaultOn: true },
    { key: 'letzter_besuch', label: 'Letzter Besuch', filterId: 'filterLetzterBesuch', col: 'letzter_besuch', defaultOn: true },
    { key: 'geliefert_ueber', label: 'Geliefert über', filterId: 'filterGeliefertUeber', col: 'geliefert_ueber', defaultOn: true },
    { key: 'projekt', label: 'Projekt', filterId: 'filterProjekt', col: 'projekt', defaultOn: true },
    { key: 'bemerkungen', label: 'Bemerkungen', filterId: 'filterBemerkungen', col: 'bemerkungen' },
  ];

  const COL_TOGGLE_LABELS = {
    leistung: 'Leistung',
    nenngeschwindigkeit: 'v',
    kraftaufnehmer: 'Kraftaufnehmer',
    dms_nr: 'DMS Nr.',
    tacho: 'Tacho',
    elektronik: 'Elektronik',
    material: 'Material',
    position: 'Position',
    aktueller_kunde: 'Letzter Kunde',
    letzter_besuch: 'Letzter Besuch',
    geliefert_ueber: 'Geliefert über',
    projekt: 'Projekt',
    bemerkungen: 'Bemerkungen',
  };

  let state = {
    host: null,
    rows: [],
    page: 1,
    pageSize: 100,
    totalCount: 0,
    colVisible: {},
    filters: {},
  };

  function escAttr(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escCell(s) {
    if (s == null || s === '') return '—';
    return escAttr(s);
  }

  function cellVal(row, col) {
    if (col.virtual) return '—';
    if (col.key === 'aktueller_kunde') return row.aktueller_kunde || row.kunde || '';
    return row[col.key] != null ? row[col.key] : '';
  }

  async function jfetch(path, opts) {
    const r = await fetch(api + path, opts);
    return r.json();
  }

  function initColVisible() {
    const vis = {};
    COLUMNS.forEach(function (col) {
      if (col.col) vis[col.col] = col.defaultOn !== false;
    });
    state.colVisible = vis;
  }

  function buildShell() {
    let colPanel = '<div class="anlagen-column-panel" aria-label="Spalten ein- und ausblenden">';
    colPanel += '<div class="anlagen-column-panel-title">Spalten einblenden</div><div class="anlagen-column-panel-grid">';
    Object.keys(COL_TOGGLE_LABELS).forEach(function (colKey) {
      const checked = state.colVisible[colKey] !== false ? ' checked' : '';
      colPanel +=
        '<label class="anlagen-col-label"><input type="checkbox" class="anlagen-col-toggle" data-anlagen-col-toggle="' +
        colKey +
        '"' +
        checked +
        '> ' +
        escCell(COL_TOGGLE_LABELS[colKey]) +
        '</label>';
    });
    colPanel += '</div></div>';

    let headRow = '<tr>';
    COLUMNS.forEach(function (col) {
      const attr = col.col ? ' data-anlagen-col="' + col.col + '"' : '';
      const hidden = col.col && state.colVisible[col.col] === false ? ' class="anlagen-col-hidden"' : '';
      headRow += '<th' + attr + hidden + '><div class="headcell-wrap">' + escCell(col.label) + '</div></th>';
    });
    headRow += '<th>Aktionen</th></tr>';

    let filterRow = '<tr class="filter-row">';
    COLUMNS.forEach(function (col) {
      const attr = col.col ? ' data-anlagen-col="' + col.col + '"' : '';
      const hidden = col.col && state.colVisible[col.col] === false ? ' class="anlagen-col-hidden"' : '';
      const ph = col.label;
      filterRow +=
        '<th' +
        attr +
        hidden +
        '><input type="text" data-filter-key="' +
        col.key +
        '" placeholder="' +
        escAttr(ph) +
        '" autocomplete="off" value="' +
        escAttr(state.filters[col.key] || '') +
        '"></th>';
    });
    filterRow +=
      '<th><button type="button" class="btn btn-secondary" id="btnApplyFilter" style="font-size:11px;padding:4px 8px">Filter anwenden</button></th></tr>';

    return (
      '<div class="page">' +
      '<div class="anlagen-page-head">' +
      '<div class="anlagen-page-head-left">' +
      '<h2>Anlagenstamm</h2>' +
      '</div>' +
      colPanel +
      '</div>' +
      '<div class="anlagen-table-scroll">' +
      '<table id="anlagenstammTable">' +
      '<thead>' +
      headRow +
      filterRow +
      '</thead>' +
      '<tbody id="anlagenOfflineBody"></tbody>' +
      '</table></div>' +
      '<div class="anlagen-pagination">' +
      '<button type="button" class="btn btn-secondary" id="pagePrev" title="Zur Tabellenoberkante scrollen">Nach oben</button>' +
      '<span id="pageInfo" class="muted">0 geladen</span>' +
      '<button type="button" class="btn btn-secondary" id="pageNext" title="Nächsten Block nachladen">Mehr laden</button>' +
      '<label style="margin:0 0 0 8px">Blockgröße</label>' +
      '<select id="pageSize">' +
      '<option value="100">100</option>' +
      '<option value="250">250</option>' +
      '<option value="500">500</option>' +
      '</select>' +
      '</div></div>'
    );
  }

  function rowMatchesFilters(row) {
    const f = state.filters;
    return COLUMNS.every(function (col) {
      const q = (f[col.key] || '').trim().toLowerCase();
      if (!q) return true;
      const val = String(cellVal(row, col) || '').toLowerCase();
      return val.indexOf(q) >= 0;
    });
  }

  function renderBody() {
    const tbody = state.host.querySelector('#anlagenOfflineBody');
    const info = state.host.querySelector('#pageInfo');
    if (!tbody) return;
    const filtered = state.rows.filter(rowMatchesFilters);
    let html = '';
    filtered.forEach(function (r) {
      html += '<tr>';
      COLUMNS.forEach(function (col) {
        const attr = col.col ? ' data-anlagen-col="' + col.col + '"' : '';
        const hidden = col.col && state.colVisible[col.col] === false ? ' class="anlagen-col-hidden"' : '';
        html += '<td' + attr + hidden + '>' + escCell(cellVal(r, col)) + '</td>';
      });
      html += '<td class="actions-cell muted" style="font-size:11px">Offline</td></tr>';
    });
    tbody.innerHTML = html || '<tr><td colspan="' + (COLUMNS.length + 1) + '" class="muted">Keine Treffer</td></tr>';
    if (info) {
      info.textContent =
        filtered.length + ' angezeigt · ' + state.rows.length + ' geladen · ' + (state.totalCount || '?') + ' gesamt';
    }
  }

  function applyColumnVisibility() {
    if (!state.host) return;
    state.host.querySelectorAll('[data-anlagen-col]').forEach(function (el) {
      const col = el.getAttribute('data-anlagen-col');
      if (state.colVisible[col] === false) el.classList.add('anlagen-col-hidden');
      else el.classList.remove('anlagen-col-hidden');
    });
  }

  function bindEvents() {
    const host = state.host;
    host.querySelectorAll('.anlagen-col-toggle').forEach(function (cb) {
      cb.addEventListener('change', function () {
        const col = cb.getAttribute('data-anlagen-col-toggle');
        state.colVisible[col] = cb.checked;
        applyColumnVisibility();
      });
    });
    host.querySelectorAll('.filter-row input[data-filter-key]').forEach(function (inp) {
      inp.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          collectFilters();
          renderBody();
        }
      });
    });
    const btnFilter = host.querySelector('#btnApplyFilter');
    if (btnFilter) {
      btnFilter.addEventListener('click', function () {
        collectFilters();
        renderBody();
      });
    }
    const pagePrev = host.querySelector('#pagePrev');
    if (pagePrev) {
      pagePrev.addEventListener('click', function () {
        const sc = host.querySelector('.anlagen-table-scroll');
        if (sc) sc.scrollTop = 0;
      });
    }
    const pageNext = host.querySelector('#pageNext');
    if (pageNext) {
      pageNext.addEventListener('click', function () {
        if (state.rows.length < state.totalCount) {
          state.page += 1;
          fetchPage(true);
        }
      });
    }
    const pageSizeSel = host.querySelector('#pageSize');
    if (pageSizeSel) {
      pageSizeSel.value = String(state.pageSize);
      pageSizeSel.addEventListener('change', function () {
        state.pageSize = parseInt(pageSizeSel.value, 10) || 100;
        state.page = 1;
        state.rows = [];
        fetchPage(false);
      });
    }
  }

  function collectFilters() {
    const f = {};
    state.host.querySelectorAll('.filter-row input[data-filter-key]').forEach(function (inp) {
      f[inp.getAttribute('data-filter-key')] = inp.value;
    });
    state.filters = f;
  }

  async function fetchPage(append) {
    const data = await jfetch(
      '/api/anlagenstamm/list?page=' + state.page + '&page_size=' + state.pageSize
    );
    const batch = data.rows || data.data || [];
    state.totalCount = data.total_count != null ? data.total_count : batch.length;
    if (append) state.rows = state.rows.concat(batch);
    else state.rows = batch;
    renderBody();
  }

  async function load(host) {
    if (!host) return;
    state.host = host;
    if (!Object.keys(state.colVisible).length) initColVisible();
    host.innerHTML = buildShell();
    bindEvents();
    state.page = 1;
    state.rows = [];
    await fetchPage(false);
  }

  global.monteurAnlagenstammOffline = { load };
})(window);
