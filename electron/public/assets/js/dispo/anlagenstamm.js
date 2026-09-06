/**
 * Anlagenstamm-Seite: Tabelle laden, Modal Neu/Bearbeiten, Löschen, Spalten-Sichtbarkeit.
 */
const tableBody = document.getElementById('tableBody');
const emptyMsg = document.getElementById('emptyMsg');
const formModal = document.getElementById('formModal');
const anlagenForm = document.getElementById('anlagenForm');

const ANLAGENSTAMM_TOGGLE_COLS = ['leistung', 'nenngeschwindigkeit', 'kraftaufnehmer', 'dms_nr', 'tacho', 'elektronik', 'material', 'position', 'aktueller_kunde', 'letzter_besuch', 'geliefert_ueber', 'projekt', 'bemerkungen'];
const ANLAGENSTAMM_COLS_STORAGE_KEY = 'anlagenstamm_visible_cols_v2';
const ANLAGENSTAMM_DEFAULT_VISIBLE_COLS = {
  leistung: true,
  nenngeschwindigkeit: false,
  kraftaufnehmer: true,
  dms_nr: false,
  tacho: true,
  elektronik: true,
  material: true,
  position: false,
  aktueller_kunde: true,
  letzter_besuch: true,
  geliefert_ueber: true,
  projekt: true,
  bemerkungen: false
};
const anlagenReadOnly = typeof window.ANLAGENSTAMM_READ_ONLY !== 'undefined' && window.ANLAGENSTAMM_READ_ONLY;
/** Abstand zum unteren Rand des Scroll-Containers: vorher nächsten API-Block laden */
const INFINITE_SCROLL_PREFETCH_PX = 1200;
/** FN-Fokus: längeres Debounce, weniger DB-Last beim Tippen */
const FN_FOCUS_DEBOUNCE_MS = 450;
const FILTER_DEBOUNCE_MS = 180;
/** TED/PN-Extras: Chunk-Größe (POST), vermeidet zu lange GET-URLs */
const ANLAGEN_EXTRAS_CHUNK_SIZE = 50;

/** Spaltenindex → Daten-Key für Sortierung (API-Daten) */
const SORT_COLUMN_KEYS = ['fabrikationsnummer','type','leistung','ted_mechanik','pn_root_name','nenngeschwindigkeit','kraftaufnehmer','dms_nr','tacho','elektronik','material','position','aktueller_kunde','letzter_besuch','geliefert_ueber','projekt','bemerkungen'];
/** Aktuelle Sortierung: { col: number, dir: 1 | -1 } oder null */
let currentSort = null;

function anlagenstammTypeHasBehaelterNenninhalt(type) {
  var t = String(type || '').toUpperCase().replace(/\s+/g, '');
  if (!t) return false;
  if (/^D-?DW(?:$|[^A-Z])/.test(t)) return true;
  if (/V-?DG-?1(?:$|[^0-9])/.test(t)) return true;
  return false;
}

function anlagenstammSyncBehaelterNenninhaltVisibility() {
  var typeEl = document.getElementById('formType');
  var wrap = document.getElementById('formBehaelterNenninhaltWrap');
  if (!wrap) return;
  wrap.hidden = !anlagenstammTypeHasBehaelterNenninhalt(typeEl && typeEl.value);
}

const pnTreeCache = new Map();
const FILTER_PARAM_BY_COL = [
  'filter_fn',
  'filter_type',
  'filter_leistung',
  'filter_ted',
  'filter_pn_root',
  'filter_v',
  'filter_kraftaufnehmer',
  'filter_dms_nr',
  'filter_tacho',
  'filter_elektronik',
  'filter_material',
  'filter_position',
  'filter_aktueller_kunde',
  'filter_letzter_besuch',
  'filter_geliefert_ueber',
  'filter_projekt',
  'filter_bemerkungen'
];
let pageState = {
  /** Nächste zu ladende Server-Seite (1-basiert); nach erfolgreichem Chunk +1 */
  page: 1,
  pageSize: 300,
  totalCount: 0,
  totalPages: 1
};

let listState = {
  isLoading: false,
  hasMore: true,
  requestToken: 0,
  loadedCount: 0,
  /** FN-Fokus: Zielzeile nach Voll-DB-Suche */
  fnFocusTarget: null,
  omitFnFilter: false,
  fnFocusJump: false,
  fnFocusMinLoadedPage: 1,
  extrasRequestId: 0,
  /** FNs, für die TED/PN noch geladen werden sollen (Set). */
  extrasFabQueue: null,
  extrasDrainPromise: null
};

function readAnlagenColumnVisibilityFromStorage() {
  try {
    const raw = localStorage.getItem(ANLAGENSTAMM_COLS_STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    return o;
  } catch (e) {
    return null;
  }
}

function writeAnlagenColumnVisibilityToStorage(map) {
  try {
    localStorage.setItem(ANLAGENSTAMM_COLS_STORAGE_KEY, JSON.stringify(map));
  } catch (e) { /* ignore */ }
}

function applyAnlagenColumnVisibility() {
  const tbl = document.getElementById('anlagenstammTable');
  if (!tbl) return;
  const map = {};
  document.querySelectorAll('.anlagen-col-toggle[data-anlagen-col-toggle]').forEach(function (cb) {
    const key = cb.getAttribute('data-anlagen-col-toggle');
    if (key) map[key] = cb.checked;
  });
  writeAnlagenColumnVisibilityToStorage(map);
  ANLAGENSTAMM_TOGGLE_COLS.forEach(function (key) {
    const show = map[key] !== false;
    tbl.querySelectorAll('[data-anlagen-col="' + key + '"]').forEach(function (el) {
      el.style.display = show ? '' : 'none';
    });
  });
}

function initAnlagenColumnPanel() {
  const panel = document.getElementById('anlagenColumnPanel');
  if (!panel || panel.dataset.colPanelBound === '1') return;
  panel.dataset.colPanelBound = '1';
  const saved = readAnlagenColumnVisibilityFromStorage();
  if (saved) {
    document.querySelectorAll('.anlagen-col-toggle[data-anlagen-col-toggle]').forEach(function (cb) {
      const key = cb.getAttribute('data-anlagen-col-toggle');
      if (key && Object.prototype.hasOwnProperty.call(saved, key)) {
        cb.checked = !!saved[key];
      }
    });
  } else {
    document.querySelectorAll('.anlagen-col-toggle[data-anlagen-col-toggle]').forEach(function (cb) {
      const key = cb.getAttribute('data-anlagen-col-toggle');
      if (key && Object.prototype.hasOwnProperty.call(ANLAGENSTAMM_DEFAULT_VISIBLE_COLS, key)) {
        cb.checked = !!ANLAGENSTAMM_DEFAULT_VISIBLE_COLS[key];
      }
    });
  }
  document.querySelectorAll('.anlagen-col-toggle[data-anlagen-col-toggle]').forEach(function (cb) {
    cb.addEventListener('change', applyAnlagenColumnVisibility);
  });
  applyAnlagenColumnVisibility();
}

/** Relativer API-Pfad (z. B. /dispo/api/… wenn die Seite unter /dispo/ liegt). */
function anlagenstammApiUrl(path) {
  var p = String(path || '').replace(/^\//, '');
  var loc = window.location.pathname;
  var lastSlash = loc.lastIndexOf('/');
  var base = lastSlash >= 0 ? loc.substring(0, lastSlash + 1) : '/';
  return base + p;
}

function anlagenstammApiHeaders(extra) {
  var h = Object.assign({}, extra || {});
  try {
    var tid = localStorage.getItem('monteur_technicianId');
    if (tid) h['X-Technician-Id'] = String(tid);
  } catch (_) { /* ignore */ }
  return h;
}

function anlagenstammFetch(url, opts) {
  opts = opts || {};
  var headers = anlagenstammApiHeaders(opts.headers || {});
  return fetch(url, Object.assign({}, opts, { headers: headers }));
}

/** JSON-API-Antwort robust parsen (BOM/HTML-Fehlerseiten abfangen). */
function anlagenstammParseJsonResponse(response, text) {
  var body = String(text || '').replace(/^\uFEFF/, '').trim();
  if (body.charAt(0) === '<') {
    return {
      ok: false,
      data: {
        success: false,
        error: 'Server lieferte HTML statt JSON (HTTP ' + response.status + '). '
          + (response.status === 413 ? 'Datei evtl. zu gross.' : body.substring(0, 180))
      }
    };
  }
  try {
    return { ok: response.ok, data: JSON.parse(body) };
  } catch (e) {
    return {
      ok: false,
      data: {
        success: false,
        error: 'Ungültige Antwort (HTTP ' + response.status + '): '
          + (body !== '' ? body.substring(0, 220) : '(leerer Antworttext – evtl. Speicher-/Timeout-Fehler auf dem Server)')
      }
    };
  }
}

function normalizeFabKeyedMap(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

function fabDigitsOnly(fab) {
  var d = String(fab || '').replace(/\D/g, '');
  if (!d) return '';
  var n = parseInt(d, 10);
  return n > 0 ? String(n) : '';
}

function mapLookupFab(map, fab) {
  if (!map || fab === '') return undefined;
  if (map[fab] != null) return map[fab];
  if (map[String(fab)] != null) return map[String(fab)];
  if (!isNaN(Number(fab)) && map[Number(fab)] != null) return map[Number(fab)];
  var digits = fabDigitsOnly(fab);
  if (digits) {
    if (map[digits] != null) return map[digits];
    if (map[Number(digits)] != null) return map[Number(digits)];
    var fnKey = 'FN' + digits;
    if (map[fnKey] != null) return map[fnKey];
    for (var k in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
      if (fabDigitsOnly(k) === digits) return map[k];
    }
  }
  return undefined;
}

function finalizePendingExtrasCells(onlyFabSet) {
  var tb = document.getElementById('tableBody');
  if (!tb) return;
  tb.querySelectorAll('tr[data-id]').forEach(function (tr) {
    var fab = (tr.getAttribute('data-fab') || '').trim();
    if (!fab) return;
    if (onlyFabSet && onlyFabSet.size > 0 && !onlyFabSet.has(fab)) return;
    if (tr.getAttribute('data-extras-loaded') === '1') return;
    var cells = tr.cells;
    if (!cells || cells.length < 5) return;
    var tedCell = cells[3];
    var pnCell = cells[4];
    if (tedCell && tedCell.getAttribute('data-extras') === 'ted') {
      tedCell.innerHTML = tedExcelCellHtml([]);
      tedCell.removeAttribute('data-extras');
    }
    if (pnCell && pnCell.getAttribute('data-extras') === 'pn') {
      pnCell.innerHTML = '<span class="muted">—</span>';
      pnCell.removeAttribute('data-extras');
    }
    tr.setAttribute('data-extras-loaded', '1');
  });
}

function applyExtrasMapsToTable(pnMap, tedMap, onlyFabSet) {
  var tb = document.getElementById('tableBody');
  if (!tb) return;
  tb.querySelectorAll('tr[data-id]').forEach(function (tr) {
    if (tr.getAttribute('data-extras-loaded') === '1') return;
    var cells = tr.cells;
    if (!cells || cells.length < 5) return;
    var fab = (tr.getAttribute('data-fab') || (cells[0] ? cells[0].textContent : '') || '').trim();
    if (!fab) return;
    if (onlyFabSet && onlyFabSet.size > 0 && !onlyFabSet.has(fab)) return;
    var tedList = mapLookupFab(tedMap, fab);
    var pnVal = mapLookupFab(pnMap, fab);
    var tedCell = cells[3];
    var pnCell = cells[4];
    var tedDone = !tedCell || tedCell.getAttribute('data-extras') !== 'ted';
    var pnDone = !pnCell || pnCell.getAttribute('data-extras') !== 'pn';
    if (tedCell && tedCell.getAttribute('data-extras') === 'ted') {
      tedCell.innerHTML = tedExcelCellHtml(Array.isArray(tedList) ? tedList : []);
      tedCell.removeAttribute('data-extras');
      tedDone = true;
    }
    if (pnCell && pnCell.getAttribute('data-extras') === 'pn') {
      var pn = String(pnVal != null ? pnVal : '').trim();
      if (pn) {
        pnCell.innerHTML = '<a href="#" class="pn-root-link" data-fab="' + escapeAttr(fab) + '">' + escapeHtml(pn) + '</a>';
      } else {
        pnCell.innerHTML = '<span class="muted">—</span>';
      }
      pnCell.removeAttribute('data-extras');
      pnDone = true;
    }
    if (tedDone && pnDone) tr.setAttribute('data-extras-loaded', '1');
  });
  if (window.dispoDesktopAnlagenstamm && window.dispoDesktopAnlagenstamm.bindTedLinks) {
    window.dispoDesktopAnlagenstamm.bindTedLinks(tb);
  }
}

function fetchAnlagenTableExtrasChunk(fabChunk) {
  return fetch(anlagenstammApiUrl('api/anlagenstamm_list_extras.php'), {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fabs: fabChunk })
  })
    .then(function (r) {
      if (!r.ok) throw new Error('extras http ' + r.status);
      return r.text();
    })
    .then(function (text) {
      var s = String(text || '').replace(/^\uFEFF/, '').trim();
      if (s.charAt(0) === '<') throw new Error('extras html not json');
      var data = JSON.parse(s);
      if (!data || !data.success) throw new Error('extras not success');
      return {
        pnMap: normalizeFabKeyedMap(data.pn_by_fab),
        tedMap: normalizeFabKeyedMap(data.ted_by_fab)
      };
    });
}

/** TED + PROJEKTE-NEU für sichtbare FNs (gechunked, eine Warteschlange – kein Abbruch bei „Mehr laden“). */
function loadAnlagenTableExtras(fabList) {
  const list = Array.isArray(fabList) ? fabList.map(function (v) { return String(v || '').trim(); }).filter(Boolean) : [];
  if (list.length === 0) return Promise.resolve();
  if (!document.getElementById('tableBody')) return Promise.resolve();

  if (!listState.extrasFabQueue) {
    listState.extrasFabQueue = new Set();
  }
  list.forEach(function (fab) {
    listState.extrasFabQueue.add(fab);
  });
  return drainAnlagenTableExtrasQueue();
}

function drainAnlagenTableExtrasQueue() {
  if (listState.extrasDrainPromise) {
    return listState.extrasDrainPromise;
  }
  const extrasToken = listState.extrasRequestId;

  listState.extrasDrainPromise = (function runDrain() {
    function nextChunk() {
      if (extrasToken !== listState.extrasRequestId) {
        return Promise.resolve();
      }
      const queue = listState.extrasFabQueue;
      if (!queue || queue.size === 0) {
        return Promise.resolve();
      }
      const chunk = [];
      queue.forEach(function (fab) {
        if (chunk.length < ANLAGEN_EXTRAS_CHUNK_SIZE) {
          chunk.push(fab);
        }
      });
      chunk.forEach(function (fab) {
        queue.delete(fab);
      });
      if (chunk.length === 0) {
        return Promise.resolve();
      }
      const fabSet = new Set(chunk);
      return fetchAnlagenTableExtrasChunk(chunk)
        .then(function (maps) {
          if (extrasToken !== listState.extrasRequestId) return;
          applyExtrasMapsToTable(maps.pnMap, maps.tedMap, fabSet);
        })
        .then(nextChunk);
    }

    return nextChunk()
      .then(function () {
        if (extrasToken !== listState.extrasRequestId) return;
        if (listState.extrasFabQueue && listState.extrasFabQueue.size > 0) {
          return drainAnlagenTableExtrasQueue();
        }
        finalizePendingExtrasCells(null);
        updateSortButtonsUI();
        window.requestAnimationFrame(function () {
          maybePrefetchNextPage();
        });
      })
      .catch(function (err) {
        if (extrasToken !== listState.extrasRequestId) return;
        console.warn('[Anlagenstamm Extras]', err);
        finalizePendingExtrasCells(null);
        updateSortButtonsUI();
      })
      .finally(function () {
        if (listState.extrasDrainPromise && extrasToken === listState.extrasRequestId) {
          listState.extrasDrainPromise = null;
        }
      });
  })();

  return listState.extrasDrainPromise;
}

function tedExcelCellHtml(tedList) {
  const list = Array.isArray(tedList) ? tedList : [];
  if (list.length === 0) return escapeHtml('—');
  const viewBase = anlagenstammApiUrl('api/mechanik_ted_excel_view.php');
  const dlBase = anlagenstammApiUrl('api/mechanik_ted_excel_download.php');
  return '<div class="ted-excel-cell">' + list.map(function (t) {
    const name = escapeHtml(t.file_name || '');
    const rel = t.rel_path || '';
    const viewUrl = viewBase + '?rel_path=' + encodeURIComponent(rel);
    const dlUrl = dlBase + '?rel_path=' + encodeURIComponent(rel);
    const warn = t.fn_matches_filename === false || t.fn_matches_filename === 0 ? ' <span class="ted-fn-warn" title="FN nicht im Dateinamen gefunden">⚠</span>' : '';
    let dt = '';
    if (t.file_mtime) {
      const d = new Date(t.file_mtime);
      if (!isNaN(d.getTime())) {
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        dt = ' ' + day + '.' + month + '.' + d.getFullYear();
      }
    }
    return '<div class="ted-excel-line"><a href="' + escapeAttr(viewUrl) + '" target="_blank" rel="noopener" class="ted-view-link">' + name + '</a>'
      + ' <a href="' + escapeAttr(dlUrl) + '" class="ted-dl-link muted" title="Herunterladen">↓</a>'
      + '<span class="muted">' + escapeHtml(dt) + '</span>' + warn + '</div>';
  }).join('') + '</div>';
}

function readFilterFn() {
  const el = document.getElementById('filterFn');
  return el ? String(el.value || '').trim() : '';
}

function clearAnlagenRowFocus() {
  if (!tableBody) return;
  tableBody.querySelectorAll('tr.anlagenstamm-row-focus').forEach(function (tr) {
    tr.classList.remove('anlagenstamm-row-focus');
  });
}

function buildFocusQueryParams() {
  const qs = new URLSearchParams();
  const tbl = document.getElementById('anlagenstammTable');
  if (!tbl) return qs;
  const inputs = tbl.querySelectorAll('.filter-row input[type="text"]');
  for (let i = 0; i < inputs.length && i < FILTER_PARAM_BY_COL.length; i++) {
    if (FILTER_PARAM_BY_COL[i] === 'filter_fn') continue;
    const v = String(inputs[i].value || '').trim();
    if (!v) continue;
    qs.set(FILTER_PARAM_BY_COL[i], v);
  }
  const q = readFilterFn();
  if (q) qs.set('q', q);
  qs.set('page_size', String(pageState.pageSize || 300));
  return qs;
}

function scrollAnlagenRowIntoView(tr) {
  const scrollEl = getAnlagenTableScrollEl();
  if (!scrollEl || !tr) return;
  const thead = scrollEl.querySelector('thead');
  const anchorBottom = thead ? thead.getBoundingClientRect().bottom : scrollEl.getBoundingClientRect().top;
  const trTop = tr.getBoundingClientRect().top;
  scrollEl.scrollTop += trTop - anchorBottom;
}

function applyFnRowFocus(targetId) {
  if (!tableBody || !targetId) return;
  clearAnlagenRowFocus();
  const tr = tableBody.querySelector('tr[data-id="' + String(targetId) + '"]');
  if (!tr) return;
  tr.classList.add('anlagenstamm-row-focus');
  window.requestAnimationFrame(function () {
    window.requestAnimationFrame(function () {
      scrollAnlagenRowIntoView(tr);
      try {
        tr.focus({ preventScroll: true });
      } catch (e) { /* ignore */ }
    });
  });
}

function setFnFocusPageInfo(match, fab) {
  const pageInfo = document.getElementById('pageInfo');
  if (!pageInfo) return;
  if (match === 'exact') {
    pageInfo.textContent = 'Fokus: ' + fab + ' (exakt)';
  } else if (match === 'previous') {
    pageInfo.textContent = 'Fokus: ' + fab + ' (vorherige FN)';
  } else if (match === 'none') {
    pageInfo.textContent = 'FN nicht gefunden';
  }
}

function resolveFnFocus() {
  const qs = buildFocusQueryParams();
  return fetch(anlagenstammApiUrl('api/anlagenstamm_fn_focus.php') + '?' + qs.toString(), {
    credentials: 'same-origin',
    cache: 'no-store'
  }).then(function (r) { return r.json(); });
}

function loadList() {
  listState.requestToken += 1;
  listState.isLoading = false;
  listState.hasMore = true;
  listState.loadedCount = 0;
  listState.fnFocusTarget = null;
  listState.omitFnFilter = false;
  pageState.page = 1;
  pageState.totalPages = 1;
  if (tableBody) tableBody.innerHTML = '';
  clearAnlagenRowFocus();
  listState.extrasRequestId = (listState.extrasRequestId || 0) + 1;
  listState.extrasFabQueue = new Set();
  listState.extrasDrainPromise = null;
  if (emptyMsg) emptyMsg.style.display = 'none';
  updatePagingUi();
  return loadNextListPage();
}

/** Eine Listen-Seite direkt laden (FN-Sprung, ohne Seiten 1..N). */
function loadListAtPage(targetPage, token) {
  if (token !== listState.requestToken) return Promise.resolve();
  targetPage = Math.max(1, Number(targetPage) || 1);
  listState.isLoading = true;
  listState.fnFocusJump = true;
  updatePagingUi();
  const qs = buildListQueryParams(targetPage);
  return fetch(anlagenstammApiUrl('api/anlagenstamm_list.php') + '?' + qs.toString(), {
    credentials: 'same-origin',
    cache: 'no-store'
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (token !== listState.requestToken) return;
      if (!data || !data.success || !Array.isArray(data.data)) return;
      renderListRows(data.data, { append: false });
      const respPage = Number(data.page || targetPage);
      pageState.pageSize = Number(data.page_size || pageState.pageSize || 300);
      pageState.totalCount = Number(data.total_count || 0);
      pageState.totalPages = Number(data.total_pages || 1);
      pageState.page = respPage + 1;
      listState.loadedCount = data.data.length;
      listState.hasMore = respPage < pageState.totalPages;
      listState.fnFocusMinLoadedPage = respPage;
      updatePagingUi();
      const focus = listState.fnFocusTarget;
      if (focus && focus.id) applyFnRowFocus(focus.id);
      const fabs = data.data.map(function (r) {
        return String(r.fabrikationsnummer || '').trim();
      }).filter(Boolean);
      loadAnlagenTableExtras(fabs);
    })
    .catch(function () {
      if (emptyMsg && listState.loadedCount === 0) emptyMsg.style.display = '';
    })
    .finally(function () {
      if (token !== listState.requestToken) return;
      listState.isLoading = false;
      listState.fnFocusJump = false;
      updatePagingUi();
    });
}

function fnFocusFlow() {
  const fnQ = readFilterFn();
  if (!fnQ) {
    listState.omitFnFilter = false;
    return loadList();
  }
  listState.requestToken += 1;
  const token = listState.requestToken;
  listState.omitFnFilter = true;
  listState.fnFocusTarget = null;
  clearAnlagenRowFocus();
  if (tableBody) tableBody.innerHTML = '';
  listState.isLoading = false;
  listState.hasMore = true;
  listState.loadedCount = 0;
  pageState.page = 1;
  pageState.totalPages = 1;
  if (emptyMsg) emptyMsg.style.display = 'none';
  currentSort = { col: 0, dir: 1 };
  updateSortButtonsUI();
  updatePagingUi();
  const pageInfo = document.getElementById('pageInfo');
  if (pageInfo) pageInfo.textContent = 'Suche FN…';

  return resolveFnFocus().then(function (focusData) {
    if (token !== listState.requestToken) return;
    if (!focusData || !focusData.success) {
      if (pageInfo) pageInfo.textContent = 'FN-Suche fehlgeschlagen';
      return loadList();
    }
    if (focusData.match === 'none') {
      setFnFocusPageInfo('none', fnQ);
      if (emptyMsg) emptyMsg.style.display = '';
      listState.omitFnFilter = false;
      return;
    }
    listState.fnFocusTarget = {
      id: focusData.id,
      rowIndex: Number(focusData.row_index || 0),
      match: focusData.match,
      fab: String(focusData.fabrikationsnummer || '')
    };
    setFnFocusPageInfo(focusData.match, listState.fnFocusTarget.fab);
    const targetPage = Math.max(1, Number(focusData.target_page || 1));
    return loadListAtPage(targetPage, token);
  }).catch(function () {
    if (token !== listState.requestToken) return;
    listState.omitFnFilter = false;
    if (pageInfo) pageInfo.textContent = 'FN-Suche fehlgeschlagen';
    return loadList();
  });
}

function loadNextListPage() {
  if (listState.isLoading || !listState.hasMore) return Promise.resolve();
  const token = listState.requestToken;
  const requestPage = Number(pageState.page || 1);
  listState.isLoading = true;
  updatePagingUi();
  const qs = buildListQueryParams(requestPage);
  return fetch(anlagenstammApiUrl('api/anlagenstamm_list.php') + '?' + qs.toString(), { credentials: 'same-origin', cache: 'no-store' })
    .then(r => r.json())
    .then(data => {
      if (token !== listState.requestToken) return;
      if (!data || !data.success || !Array.isArray(data.data)) return;
      const append = listState.loadedCount > 0;
      renderListRows(data.data, { append: append });
      const respPage = Number(data.page || requestPage);
      pageState.pageSize = Number(data.page_size || pageState.pageSize || 100);
      pageState.totalCount = Number(data.total_count || 0);
      pageState.totalPages = Number(data.total_pages || 1);
      pageState.page = respPage + 1;
      listState.loadedCount += data.data.length;
      listState.hasMore = respPage < pageState.totalPages;
      updatePagingUi();
      const fabs = data.data.map(r => String(r.fabrikationsnummer || '').trim()).filter(Boolean);
      loadAnlagenTableExtras(fabs);
    })
    .catch(function () {
      if (emptyMsg && listState.loadedCount === 0) emptyMsg.style.display = '';
    })
    .finally(function () {
      if (token !== listState.requestToken) return;
      listState.isLoading = false;
      updatePagingUi();
      if (!listState.fnFocusJump) scheduleFillViewport(token);
    });
}

function buildListQueryParams(pageNumber) {
  const qs = new URLSearchParams();
  qs.set('page', String(pageNumber || 1));
  qs.set('page_size', String(pageState.pageSize || 100));
  if (listState.omitFnFilter) {
    qs.set('omit_fn_filter', '1');
    qs.set('sort_col', 'fabrikationsnummer');
    qs.set('sort_dir', 'asc');
  } else if (currentSort && typeof currentSort.col === 'number') {
    const key = SORT_COLUMN_KEYS[currentSort.col];
    if (key) {
      qs.set('sort_col', key);
      qs.set('sort_dir', currentSort.dir === -1 ? 'desc' : 'asc');
    }
  }
  const tbl = document.getElementById('anlagenstammTable');
  if (tbl) {
    const inputs = tbl.querySelectorAll('.filter-row input[type="text"]');
    for (let i = 0; i < inputs.length && i < FILTER_PARAM_BY_COL.length; i++) {
      if (listState.omitFnFilter && FILTER_PARAM_BY_COL[i] === 'filter_fn') continue;
      const v = String(inputs[i].value || '').trim();
      if (!v) continue;
      qs.set(FILTER_PARAM_BY_COL[i], v);
    }
  }
  return qs;
}

function renderListRows(rows, options) {
  const append = !!(options && options.append);
  const readOnly = typeof window.ANLAGENSTAMM_READ_ONLY !== 'undefined' && window.ANLAGENSTAMM_READ_ONLY;
  if (tableBody) {
    const html = rows.map(row => `
    <tr data-id="${row.id}" data-fab="${escapeAttr(row.fabrikationsnummer || '')}" tabindex="-1">
      <td>${escapeHtml(row.fabrikationsnummer)}</td>
      <td>${displayTruncForTable(row.type, 25)}</td>
      <td data-anlagen-col="leistung">${escapeHtml(row.leistung || '—')}</td>
      <td class="ted-col" data-extras="ted"><span class="muted anlagen-extras-pending">…</span></td>
      <td class="pn-col" data-extras="pn"><span class="muted anlagen-extras-pending">…</span></td>
      <td data-anlagen-col="nenngeschwindigkeit">${escapeHtml(row.nenngeschwindigkeit || '—')}</td>
      <td data-anlagen-col="kraftaufnehmer">${escapeHtml(row.kraftaufnehmer || '—')}</td>
      <td data-anlagen-col="dms_nr">${escapeHtml(row.dms_nr || '—')}</td>
      <td data-anlagen-col="tacho">${escapeHtml(row.tacho || '—')}</td>
      <td data-anlagen-col="elektronik">${escapeHtml(row.elektronik || '—')}</td>
      <td data-anlagen-col="material">${escapeHtml(row.material || '—')}</td>
      <td data-anlagen-col="position">${escapeHtml(row.position || '—')}</td>
      <td data-anlagen-col="aktueller_kunde">${escapeHtml(row.aktueller_kunde || '—')}</td>
      <td data-anlagen-col="letzter_besuch">${formatDate(row.letzter_besuch)}</td>
      <td data-anlagen-col="geliefert_ueber">${displayTruncForTable(row.geliefert_ueber, 20)}</td>
      <td data-anlagen-col="projekt">${escapeHtml(row.projekt || '—')}</td>
      <td data-anlagen-col="bemerkungen">${escapeHtml(row.bemerkungen || '—')}</td>
      <td class="actions-cell">
        ${readOnly ? '–' : `<button type="button" class="btn btn-secondary btn-edit" data-id="${row.id}">Bearbeiten</button>`}
      </td>
    </tr>
  `).join('');
    if (append) {
      tableBody.insertAdjacentHTML('beforeend', html);
    } else {
      tableBody.innerHTML = html;
    }
  }
  if (emptyMsg) {
    const hasAnyRows = !!(tableBody && tableBody.querySelector('tr[data-id]'));
    emptyMsg.style.display = hasAnyRows ? 'none' : '';
  }
  applyAnlagenColumnVisibility();
}

function getAnlagenTableScrollEl() {
  const tbl = document.getElementById('anlagenstammTable');
  return tbl ? tbl.closest('.anlagen-table-scroll') : null;
}

function anlagenScrollDistanceToBottom(el) {
  if (!el) return 0;
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function maybePrefetchNextPage() {
  const el = getAnlagenTableScrollEl();
  if (!el || listState.isLoading || !listState.hasMore) return;
  if (anlagenScrollDistanceToBottom(el) <= INFINITE_SCROLL_PREFETCH_PX) {
    loadNextListPage();
  }
}

function scheduleFillViewport(token, retry) {
  if (token !== listState.requestToken) return;
  const el = getAnlagenTableScrollEl();
  if (!el || listState.isLoading || !listState.hasMore) return;
  if (el.clientHeight < 80) {
    const n = Number(retry || 0);
    if (n >= 12) return;
    window.requestAnimationFrame(function () {
      scheduleFillViewport(token, n + 1);
    });
    return;
  }
  const pageSize = Number(pageState.pageSize || 300);
  const loadedPages = pageSize > 0 ? Math.ceil((listState.loadedCount || 0) / pageSize) : 1;
  if (loadedPages >= 2) return;
  if (anlagenScrollDistanceToBottom(el) > INFINITE_SCROLL_PREFETCH_PX) return;
  loadNextListPage()
    .then(function () {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () {
          scheduleFillViewport(token);
        });
      });
    });
}

function initAnlagenInfiniteScroll() {
  const el = getAnlagenTableScrollEl();
  if (!el || el.dataset.anlagenInfiniteBound === '1') return;
  el.dataset.anlagenInfiniteBound = '1';
  let ticking = false;
  el.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      ticking = false;
      maybePrefetchNextPage();
    });
  }, { passive: true });
}

function updatePagingUi() {
  const countEl = document.getElementById('anlagenCount');
  const pageInfo = document.getElementById('pageInfo');
  const pagePrev = document.getElementById('pagePrev');
  const pageNext = document.getElementById('pageNext');
  const pageSizeEl = document.getElementById('pageSize');
  const loaded = Number(listState.loadedCount || 0);
  const total = Number(pageState.totalCount || 0);
  if (countEl) {
    countEl.textContent = total > 0
      ? (String(loaded) + ' von ' + String(total) + ' Anlage(n) geladen')
      : (String(loaded) + ' Anlage(n)');
  }
  if (pageInfo) {
    if (listState.isLoading) {
      pageInfo.textContent = 'Lade…';
    } else if (!listState.hasMore && loaded > 0) {
      pageInfo.textContent = 'Alle Zeilen geladen';
    } else if (listState.hasMore) {
      pageInfo.textContent = 'Scrollen lädt nach';
    } else {
      pageInfo.textContent = '';
    }
  }
  if (pagePrev) pagePrev.disabled = false;
  if (pageNext) pageNext.disabled = listState.isLoading || !listState.hasMore;
  if (pageSizeEl) pageSizeEl.value = String(pageState.pageSize || 100);
}

function escapeHtml(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** Listen-Tabelle: max. maxLen Zeichen, Tooltip mit vollem Text (wie PHP anlagenstamm_display_trunc_cell). */
function displayTruncForTable(s, maxLen) {
  if (s == null) return escapeHtml('—');
  const str = String(s);
  if (str === '') return '';
  const chars = Array.from(str);
  if (chars.length <= maxLen) return escapeHtml(str);
  const short = chars.slice(0, maxLen).join('') + '…';
  return '<span title="' + escapeAttr(str) + '">' + escapeHtml(short) + '</span>';
}
function formatDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return escapeHtml(String(s));
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return day + '.' + month + '.' + year;
}

function pnNodeChildren(n) {
  if (!n) return [];
  if (Array.isArray(n.children)) return n.children;
  if (Array.isArray(n.items)) return n.items;
  if (Array.isArray(n.nodes)) return n.nodes;
  return [];
}

function pnNodeType(n) {
  if (!n) return '';
  const t = String(n.type || n.kind || n.node_type || '').toLowerCase();
  if (t === 'file') return 'file';
  if (t === 'dir' || t === 'folder' || t === 'directory') return 'dir';
  return pnNodeChildren(n).length > 0 ? 'dir' : (n.rel || n.path ? 'file' : '');
}

function pnNodeName(n) {
  if (!n) return '';
  const name = n.name || n.label || n.basename || n.filename || n.file || '';
  if (name) return String(name);
  const p = String(n.rel || n.path || '');
  const segs = p.replace(/\\/g, '/').split('/');
  return segs[segs.length - 1] || p;
}

function pnRasterImageByName(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m ? m[1] : '';
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext);
}

function pnEnsureProjekteNeuImageLightbox() {
  const id = 'kuklaPnImageLightbox';
  let el = document.getElementById(id);
  if (el) return el;
  el = document.createElement('div');
  el.id = id;
  el.className = 'kukla-pn-lightbox';
  el.style.display = 'none';
  el.innerHTML = '<div class="kukla-pn-lightbox-backdrop"></div><div class="kukla-pn-lightbox-inner"><button type="button" class="kukla-pn-lightbox-close" aria-label="Schließen">&times;</button><img class="kukla-pn-lightbox-img" alt="" /></div>';
  document.body.appendChild(el);
  const img = el.querySelector('.kukla-pn-lightbox-img');
  function closeLb() {
    el.style.display = 'none';
    if (img) img.removeAttribute('src');
  }
  el.querySelector('.kukla-pn-lightbox-backdrop').addEventListener('click', closeLb);
  el.querySelector('.kukla-pn-lightbox-close').addEventListener('click', closeLb);
  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape' && el.style.display === 'flex') closeLb();
  });
  return el;
}

function pnProjekteNeuDownloadQuery(fab, rel) {
  var q =
    'fabrikationsnummer=' +
    encodeURIComponent(fab) +
    '&fab=' +
    encodeURIComponent(fab) +
    '&source=projekte_neu&path=' +
    encodeURIComponent(rel);
  try {
    var tid = localStorage.getItem('monteur_technicianId');
    if (tid) q += '&technician_id=' + encodeURIComponent(String(tid));
  } catch (_) { /* ignore */ }
  return q;
}

function pnBuildGalleryImages(fab, nodes) {
  if (!window.MonteurImageGallery) return [];
  return window.MonteurImageGallery.collectRasterFilesFromTree(nodes, function (_n, name, rel) {
    const hrefBase = '/api/anlagenstamm_file_download.php?' + pnProjekteNeuDownloadQuery(fab, rel);
    return {
      url: hrefBase + '&inline=1',
      thumbUrl: hrefBase + '&thumb=1&thumb_max=256&prefer_cache=1',
      label: name || rel,
    };
  });
}

function pnOpenProjekteNeuImageLightbox(url, title, galleryImages, galleryIndex) {
  if (window.MonteurImageGallery && Array.isArray(galleryImages) && galleryImages.length) {
    window.MonteurImageGallery.open(galleryImages, galleryIndex != null ? galleryIndex : 0, {
      title: title,
      fallback: function (item) {
        pnOpenProjekteNeuImageLightboxSingle((item && item.url) || url, title);
      },
    });
    return;
  }
  pnOpenProjekteNeuImageLightboxSingle(url, title);
}

function pnOpenProjekteNeuImageLightboxSingle(url, title) {
  const el = pnEnsureProjekteNeuImageLightbox();
  const img = el.querySelector('.kukla-pn-lightbox-img');
  if (img) {
    img.alt = title || '';
    img.src = url;
  }
  el.style.display = 'flex';
}

function renderPnModalTree(fab, nodes, target) {
  target.innerHTML = '';
  if (!Array.isArray(nodes) || nodes.length === 0) {
    target.innerHTML = '<p class="muted" style="margin:0">Keine Einträge gefunden.</p>';
    return;
  }
  const galleryImages = pnBuildGalleryImages(fab, nodes);
  const buildList = function(list) {
    const ul = document.createElement('ul');
    ul.className = 'anlagen-pn-tree-ul';
    list.forEach(function(node) {
      const nodeType = pnNodeType(node);
      if (!nodeType) return;
      const li = document.createElement('li');
      if (nodeType === 'dir') {
        const details = document.createElement('details');
        details.open = false;
        const summary = document.createElement('summary');
        summary.textContent = pnNodeName(node) || '(Ordner)';
        details.appendChild(summary);
        const children = pnNodeChildren(node);
        if (children.length > 0) details.appendChild(buildList(children));
        li.appendChild(details);
      } else {
        const rel = String(node.rel || node.path || '');
        const label = pnNodeName(node) || '(Datei)';
        const hrefBase = '/api/anlagenstamm_file_download.php?' + pnProjekteNeuDownloadQuery(fab, rel);
        const wrap = document.createElement('div');
        wrap.className = 'anlagen-pn-file-row';
        if (pnRasterImageByName(label)) {
          const thumb = document.createElement('img');
          thumb.className = 'anlagen-pn-thumb anlagen-pn-thumb-pending';
          thumb.alt = label;
          thumb.setAttribute('data-pn-href-base', hrefBase);
          thumb.setAttribute('data-pn-label', label);
          if (window.kuklaAnlagenThumbLoader) {
            thumb.setAttribute('data-thumb-src', window.kuklaAnlagenThumbLoader.thumbUrlFromHrefBase(hrefBase));
          }
          wrap.appendChild(thumb);
        } else {
          const ic = document.createElement('span');
          ic.className = 'anlagen-pn-file-icon';
          ic.setAttribute('aria-hidden', 'true');
          ic.textContent = '\uD83D\uDCC4';
          wrap.appendChild(ic);
        }
        const link = document.createElement('a');
        link.href = hrefBase;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = label;
        link.setAttribute('data-pn-rel', rel);
        link.setAttribute('data-pn-base', label);
        if (pnRasterImageByName(label)) {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            const fullUrl = hrefBase + '&inline=1';
            let idx = 0;
            for (let i = 0; i < galleryImages.length; i++) {
              if (galleryImages[i].url === fullUrl || String(galleryImages[i].label) === label) {
                idx = i;
                break;
              }
            }
            pnOpenProjekteNeuImageLightbox(fullUrl, label, galleryImages, idx);
          });
        }
        wrap.appendChild(link);
        li.appendChild(wrap);
      }
      ul.appendChild(li);
    });
    return ul;
  };
  target.appendChild(buildList(nodes));
  if (!target.getAttribute('data-pn-lazy-thumbs')) {
    target.setAttribute('data-pn-lazy-thumbs', '1');
    target.addEventListener('toggle', function (ev) {
      const det = ev.target;
      if (!det || det.tagName !== 'DETAILS' || !det.open) return;
      det.querySelectorAll('img.anlagen-pn-thumb-pending').forEach(function (thumb) {
        const hrefBase = thumb.getAttribute('data-pn-href-base');
        const label = thumb.getAttribute('data-pn-label') || '';
        if (!hrefBase) return;
        thumb.classList.remove('anlagen-pn-thumb-pending');
        thumb.loading = 'lazy';
        if (window.kuklaAnlagenThumbLoader) {
          const src = thumb.getAttribute('data-thumb-src') || window.kuklaAnlagenThumbLoader.thumbUrlFromHrefBase(hrefBase);
          window.kuklaAnlagenThumbLoader.loadThumbIntoImg(thumb, src, 0);
        } else {
          thumb.src = hrefBase + '&thumb=1&thumb_max=256&prefer_cache=1';
        }
        thumb.addEventListener('click', function () {
          const fullUrl = hrefBase + '&inline=1';
          let idx = 0;
          for (let i = 0; i < galleryImages.length; i++) {
            if (galleryImages[i].url === fullUrl || String(galleryImages[i].label) === label) {
              idx = i;
              break;
            }
          }
          pnOpenProjekteNeuImageLightbox(fullUrl, label, galleryImages, idx);
        });
      });
    }, true);
  }
}

function fetchPnTreeByFab(fab) {
  if (!fab) return Promise.resolve(null);
  if (pnTreeCache.has(fab)) return Promise.resolve(pnTreeCache.get(fab));
  const url = '/api/anlagenstamm_files_list.php?fabrikationsnummer=' + encodeURIComponent(fab) + '&fab=' + encodeURIComponent(fab) + '&compact=1&_ts=' + Date.now();
  return fetch(url, { credentials: 'include', cache: 'no-store' })
    .then(r => r.json())
    .then(data => {
      if (!data || (!data.success && !data.ok)) return null;
      pnTreeCache.set(fab, data);
      return data;
    })
    .catch(() => null);
}

function setupPnTreeModal() {
  const modal = document.getElementById('pnTreeModal');
  const body = document.getElementById('pnTreeModalBody');
  const title = document.getElementById('pnTreeModalTitle');
  const hint = document.getElementById('pnTreeModalHint');
  const closeTop = document.getElementById('pnTreeModalCloseTop');
  const closeBottom = document.getElementById('pnTreeModalClose');
  if (!modal || !body || !title || !hint) return;

  function closeModal() {
    modal.classList.remove('active');
  }
  function openModal() {
    modal.classList.add('active');
  }
  if (closeTop) closeTop.addEventListener('click', closeModal);
  if (closeBottom) closeBottom.addEventListener('click', closeModal);
  modal.addEventListener('click', function(e) {
    if (e.target === modal) closeModal();
  });

  document.addEventListener('click', function(e) {
    const link = e.target.closest('.pn-root-link');
    if (!link) return;
    e.preventDefault();
    const fab = (link.getAttribute('data-fab') || '').trim();
    if (!fab) return;
    title.textContent = 'PROJEKTE NEU · ' + fab;
    hint.textContent = 'Lade Ordnerbaum…';
    body.innerHTML = '<p class="muted" style="margin:0">Lade…</p>';
    openModal();
    fetchPnTreeByFab(fab).then(data => {
      if (!data) {
        hint.textContent = 'Keine nutzbare Server-Antwort erhalten.';
        body.innerHTML = '<p class="muted" style="margin:0">Bitte später erneut versuchen.</p>';
        return;
      }
      const pn = data.projekte_neu || {};
      const tree = Array.isArray(pn.tree) ? pn.tree : [];
      const rootName = String(pn.root_name || '').trim();
      if (rootName) {
        link.textContent = rootName;
      }
      hint.textContent = rootName ? ('Root: ' + rootName) : (pn.enabled ? '' : 'PROJEKTE NEU ist für diese Fabrikationsnummer nicht verfügbar.');
      if (window.dispoDesktopAnlagenstamm && window.dispoDesktopAnlagenstamm.renderPnTree) {
        window.dispoDesktopAnlagenstamm.renderPnTree(fab, tree, body);
      } else {
        renderPnModalTree(fab, tree, body);
      }
    });
  });
}

function isTdPdfDokuPath(rel, name) {
  if (!rel || !name) return false;
  var n = String(name);
  var ext = (n.split('.').pop() || '').toLowerCase();
  if (['pdf', 'doc', 'docx'].indexOf(ext) < 0) return false;
  if (n.indexOf('TD') < 0) return false;
  var segs = String(rel).replace(/\\/g, '/').toLowerCase().split('/');
  var inDoku = segs.indexOf('doku') >= 0;
  var stem = n.replace(/\.[^.]+$/, '');
  var codeName = /^TD[DE]\d+/i.test(stem);
  return inDoku || codeName;
}

function tdRelFromClickTarget(target) {
  if (!target || !target.closest) return null;
  var a = target.closest('a');
  if (a) {
    var relA = a.getAttribute('data-pn-rel') || '';
    var nameA = (a.getAttribute('data-pn-base') || a.textContent || '').trim();
    if (!relA) {
      try {
        var href = a.getAttribute('href') || '';
        var u = new URL(href, window.location.origin);
        relA = u.searchParams.get('path') || '';
      } catch (_) { /* ignore */ }
    }
    if (relA) return { rel: relA, name: nameA || relA.split(/[/\\]/).pop() };
  }
  var row = target.closest('.dienstreise-explorer-row');
  if (row && row.getAttribute('data-is-dir') !== '1') {
    var relR = row.getAttribute('data-relative-path') || '';
    var nameEl = row.querySelector('.dienstreise-explorer-filename');
    var nameR = nameEl ? String(nameEl.textContent || '').trim() : '';
    if (!nameR) nameR = relR.split(/[/\\]/).pop() || '';
    if (relR) return { rel: relR, name: nameR };
  }
  return null;
}

function fillEmptyFieldsFromTdPdf() {
  var map = {
    type: 'formType',
    leistung: 'formLeistung',
    nenngeschwindigkeit: 'formNenngeschwindigkeit',
    kraftaufnehmer: 'formKraftaufnehmer',
    material: 'formMaterial',
    tacho: 'formTacho',
    elektronik: 'formElektronik',
    geraete_nummer: 'formGeraeteNummer',
    dms_nr: 'formDmsNr',
    dms_position: 'formDmsPosition',
    position: 'formPosition',
    geliefert_ueber: 'formGeliefertUeber',
    projekt: 'formProjekt',
    bemerkungen: 'formBemerkungen'
  };
  var msgEl = document.getElementById('fillFromTdPdfMsg');
  var formFabEl = document.getElementById('formFab');
  var fab = formFabEl && formFabEl.value.trim();
  if (!fab) {
    if (msgEl) msgEl.textContent = 'Fabrikationsnummer fehlt.';
    return;
  }
  if (msgEl) msgEl.textContent = 'Lese TD-Datei…';
  var u = anlagenstammApiUrl('api/anlagenstamm_td_pdf_prefill.php?fab=' + encodeURIComponent(fab));
  var pr = (window.__anlagenSelectedTdPdfRel || '').trim();
  if (pr) u += '&path=' + encodeURIComponent(pr);
  var req = (typeof anlagenstammFetch === 'function')
    ? anlagenstammFetch(u, { credentials: 'same-origin' })
    : fetch(u, { credentials: 'same-origin' });
  req
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || d.ok === false) {
        if (msgEl) msgEl.textContent = (d && d.error) ? d.error : 'Fehler beim Lesen der TD-Datei.';
        return;
      }
      var p = d.prefill || {};
      var filled = 0;
      Object.keys(map).forEach(function (field) {
        var value = (p[field] == null) ? '' : p[field].toString();
        value = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
        if (!value) return;
        var el = document.getElementById(map[field]);
        if (!el && field === 'kraftaufnehmer' && typeof window.kuklaInitKraftaufnehmerRows === 'function') {
          window.kuklaInitKraftaufnehmerRows({ readOnly: anlagenReadOnly, primaryValue: value, extras: [] });
          el = document.getElementById(map[field]);
        }
        if (!el) return;
        var current = (el.value || '').toString().trim();
        if (current !== '') return;
        el.value = value;
        try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) { /* ignore */ }
        if (field === 'elektronik') {
          var tek = document.getElementById('formElektronikTechnik');
          if (tek && !(tek.value || '').toString().trim()) tek.value = value;
        }
        filled++;
      });
      if (msgEl) {
        var recKeys = Object.keys(p);
        if (filled > 0) msgEl.textContent = filled + ' leere Felder gefüllt' + (d.file ? ' (' + d.file + ').' : '.');
        else if (recKeys.length > 0) msgEl.textContent = recKeys.length + ' Wert(e) im TD erkannt, aber betreffende Formularfelder sind schon befüllt (Prüfung: ' + recKeys.join(', ') + (d.file ? ' · ' + d.file : '') + ').';
        else msgEl.textContent = (d.note || 'Keine Werte aus dem TD-Text zugeordnet.') + (d.file ? ' (' + d.file + ')' : '') + '.';
      }
    })
    .catch(function (err) {
      if (msgEl) msgEl.textContent = 'Fehler: ' + (err && err.message ? err.message : String(err));
    });
}

function isMlPdfDokuPath(rel, name) {
  if (!rel || !name) return false;
  var n = String(name);
  var ext = (n.split('.').pop() || '').toLowerCase();
  if (ext !== 'pdf') return false;
  var segs = String(rel).replace(/\\/g, '/').toLowerCase();
  var inMotorList = segs.indexOf('motor list') >= 0 || segs.indexOf('01.02') >= 0;
  var mlName = /_ml_/i.test(n) || /motor.?list/i.test(n) || /motorle/i.test(n);
  return inMotorList || mlName;
}

function fillMotorsFromMlPdf() {
  var msgEl = document.getElementById('fillFromMlPdfMsg');
  var formFabEl = document.getElementById('formFab');
  var fab = formFabEl && formFabEl.value.trim();
  if (!fab) {
    if (msgEl) msgEl.textContent = 'Fabrikationsnummer fehlt.';
    return;
  }
  if (msgEl) msgEl.textContent = 'Lese Motorliste…';
  var u = anlagenstammApiUrl('api/anlagenstamm_ml_pdf_prefill.php?fab=' + encodeURIComponent(fab));
  var pr = (window.__anlagenSelectedMlPdfRel || '').trim();
  if (pr) u += '&path=' + encodeURIComponent(pr);
  var req = (typeof anlagenstammFetch === 'function')
    ? anlagenstammFetch(u, { credentials: 'same-origin' })
    : fetch(u, { credentials: 'same-origin' });
  req
    .then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = t ? JSON.parse(t) : null; } catch (e) {
          throw new Error(r.status === 404
            ? 'Motorlisten-API nicht gefunden (Deploy fehlt).'
            : 'Serverfehler beim Lesen der Motorliste (HTTP ' + r.status + ').');
        }
        if (!d) {
          throw new Error('Leere Serverantwort (HTTP ' + r.status + ').');
        }
        return d;
      });
    })
    .then(function (d) {
      if (!d || d.ok === false) {
        if (msgEl) msgEl.textContent = (d && d.error) ? d.error : 'Fehler beim Lesen der Motorliste.';
        return;
      }
      var motors = Array.isArray(d.motors) ? d.motors : [];
      if (!motors.length) {
        if (msgEl) msgEl.textContent = (d.note || 'Keine Antriebe im PDF erkannt.') + (d.file ? ' (' + d.file + ')' : '');
        return;
      }
      if (typeof window.kuklaMotorSetRows === 'function') window.kuklaMotorSetRows(motors);
      if (msgEl) msgEl.textContent = motors.length + ' Motor(en) geladen' + (d.file ? ' (' + d.file + ')' : '');
    })
    .catch(function (err) {
      if (msgEl) msgEl.textContent = 'Fehler: ' + (err && err.message ? err.message : String(err));
    });
}

function bindTdPrefillUi() {
  var root = document.getElementById('formModal') || document;
  if (root && !root._tdSelectBound) {
    root._tdSelectBound = true;
    root.addEventListener('click', function (e) {
      var hit = tdRelFromClickTarget(e.target);
      if (!hit) return;
      if (isTdPdfDokuPath(hit.rel, hit.name)) {
        window.__anlagenSelectedTdPdfRel = hit.rel;
        var m = document.getElementById('fillFromTdPdfMsg');
        if (m) m.textContent = 'TD-Quelle: ' + (hit.name || hit.rel);
      }
      if (isMlPdfDokuPath(hit.rel, hit.name)) {
        window.__anlagenSelectedMlPdfRel = hit.rel;
        var ml = document.getElementById('fillFromMlPdfMsg');
        if (ml) ml.textContent = 'Motorliste: ' + (hit.name || hit.rel);
      }
    });
  }
  var fillBtn = document.getElementById('btnFillFromTdPdf');
  if (fillBtn && !fillBtn._tdFillBound) {
    fillBtn._tdFillBound = true;
    if (anlagenReadOnly) fillBtn.disabled = true;
    else fillBtn.addEventListener('click', fillEmptyFieldsFromTdPdf);
  }
  var mlBtn = document.getElementById('btnFillFromMlPdf');
  if (mlBtn && !mlBtn._mlFillBound) {
    mlBtn._mlFillBound = true;
    if (anlagenReadOnly) mlBtn.disabled = true;
    else mlBtn.addEventListener('click', fillMotorsFromMlPdf);
  }
}

function isAktePanelActive(panelId) {
  var p = document.querySelector('.akte-panel[data-akte-panel="' + panelId + '"]');
  return !!(p && p.classList.contains('is-active'));
}

function loadModalFilesForFab(fab) {
  var docsPanel = document.querySelector('.akte-panel[data-akte-panel="docs"]');
  if (!docsPanel || isAktePanelActive('docs')) {
    if (typeof window.anlagenstammDocumentsRefresh === 'function') {
      window.anlagenstammDocumentsRefresh();
    }
  }
  var pnToggle = document.getElementById('modalPnTreeToggle');
  var pnTree = document.getElementById('modalPnTreeForm');
  var pnHint = document.getElementById('modalPnHintForm');
  function fetchPnPanels() {
    var pendingFab = (pnToggle && pnToggle._pnPendingFab) || fab;
    if (typeof window.anlagenstammFetchFilesPanels !== 'function') return;
    if (pnTree && pnTree.getAttribute('data-pn-fetch-fab') === String(pendingFab || '')) return;
    if (pnTree) pnTree.setAttribute('data-pn-fetch-fab', String(pendingFab || ''));
    window.anlagenstammFetchFilesPanels(pendingFab, {
      listUl: null,
      pnTree: pnTree,
      pnHint: pnHint
    });
  }
  window.kuklaEnsureAkteFilesLoaded = fetchPnPanels;
  if (pnToggle && pnTree) {
    pnToggle.open = false;
    pnToggle.removeAttribute('data-pn-loaded');
    pnTree.innerHTML = '';
    pnTree.removeAttribute('data-pn-fetch-fab');
    if (pnHint) {
      pnHint.textContent = 'Aufklappen für Ordner. TD-Datei mit „TD“ im Namen anklicken, dann unter Technik „Leere Felder aus TD füllen“.';
    }
    pnToggle._pnPendingFab = fab;
    if (!pnToggle._pnBound) {
      pnToggle._pnBound = true;
      pnToggle.addEventListener('toggle', function () {
        if (!pnToggle.open || pnToggle.getAttribute('data-pn-loaded') === '1') return;
        var pendingFab = pnToggle._pnPendingFab;
        if (!pendingFab) return;
        fetchPnPanels();
        pnToggle.setAttribute('data-pn-loaded', '1');
      });
    }
    if (isAktePanelActive('files')) {
      fetchPnPanels();
      pnToggle.setAttribute('data-pn-loaded', '1');
    }
    return;
  }
  var filesPanel = document.querySelector('.akte-panel[data-akte-panel="files"]');
  if (filesPanel && !isAktePanelActive('files')) {
    if (pnHint) {
      pnHint.textContent = 'Ordner werden geladen, sobald der Tab Dateien geöffnet wird.';
    }
    return;
  }
  fetchPnPanels();
}

function fillFormFromRow(row) {
  row = row || {};
  window.__anlagenSelectedTdPdfRel = '';
  var tdMsg = document.getElementById('fillFromTdPdfMsg');
  if (tdMsg) tdMsg.textContent = '';
  bindTdPrefillUi();
  var set = function (id, val) {
    var el = document.getElementById(id);
    if (el) el.value = val != null ? String(val) : '';
  };
  set('formId', row.id || '');
  set('formFab', row.fabrikationsnummer || '');
  set('formType', row.type || '');
  set('formLeistung', row.leistung || '');
  set('formNenngeschwindigkeit', row.nenngeschwindigkeit || '');
  set('formBehaelterNenninhalt', row.behaelter_nenninhalt || '');
  set('formMaterial', row.material || '');
  set('formTacho', row.tacho || '');
  set('formElektronik', row.elektronik || '');
  set('formElektronikTechnik', row.elektronik || '');
  set('formElektronikType', row.elektronik_type || '');
  set('formGeraeteNummer', row.geraete_nummer || '');
  set('formBussystem', row.bussystem || '');
  set('formPosition', row.position || '');
  set('formGeliefertUeber', row.geliefert_ueber || '');
  set('formProjekt', row.projekt || '');
  set('formBemerkungen', row.bemerkungen || '');
  if (typeof window.kuklaInitKraftaufnehmerRows === 'function') {
    window.kuklaInitKraftaufnehmerRows({
      readOnly: anlagenReadOnly,
      primaryValue: row.kraftaufnehmer || '',
      primaryDmsNr: row.dms_nr || '',
      primaryDmsPosition: row.dms_position || '',
      primaryVersSpannung: row.vers_spannung || '',
      primarySensitivitaet: row.sensitivitaet || '',
      row: row
    });
  } else {
    set('formKraftaufnehmer', row.kraftaufnehmer || '');
  }
  if (typeof window.kuklaInitMotorRows === 'function') {
    window.kuklaInitMotorRows({
      readOnly: anlagenReadOnly,
      rows: Array.isArray(row.motoren) ? row.motoren : []
    });
  }
  anlagenstammSyncBehaelterNenninhaltVisibility();
}

var formTypeElBind = document.getElementById('formType');
if (formTypeElBind && formTypeElBind.getAttribute('data-behaelter-bound') !== '1') {
  formTypeElBind.setAttribute('data-behaelter-bound', '1');
  formTypeElBind.addEventListener('input', anlagenstammSyncBehaelterNenninhaltVisibility);
  formTypeElBind.addEventListener('change', anlagenstammSyncBehaelterNenninhaltVisibility);
}

function openFormModal() {
  if (formModal) formModal.classList.add('active');
}

function isAkteStandaloneWindow() {
  return !!(window.KUKLA_ANLAGENSTAMM_AKTE_WINDOW);
}

function openAkteViaElectron(id) {
  if (isAkteStandaloneWindow()) return false;
  var api = (window.monteurApp && window.monteurApp.openAnlagenstammAkteWindow)
    || (window.dispoApp && window.dispoApp.openAnlagenstammAkteWindow);
  if (typeof api !== 'function') return false;
  api({ id: id == null || id === '' ? null : id });
  return true;
}

function notifyAnlagenstammSaved() {
  try {
    var bc = new BroadcastChannel('anlagenstamm-refresh');
    bc.postMessage({ type: 'anlagenstamm-saved' });
  } catch (e) {}
  try {
    if (window.opener && !window.opener.closed && window.opener.postMessage) {
      window.opener.postMessage({ type: 'anlagenstamm-saved' }, window.location.origin);
    }
  } catch (e2) {}
  if (window.monteurApp && typeof window.monteurApp.notifyAnlagenstammSaved === 'function') {
    window.monteurApp.notifyAnlagenstammSaved();
  }
}

function openNewModal() {
  fillFormFromRow({});
  var title = document.getElementById('modalTitle');
  if (title) title.textContent = 'Neue Anlage';
  var delWrap = document.getElementById('modalDeleteWrap');
  if (delWrap) delWrap.style.display = 'none';
  openFormModal();
}

function openEditModal(id) {
  var numId = parseInt(id, 10);
  if (!numId) return;
  anlagenstammFetch(anlagenstammApiUrl('api/anlagenstamm_get.php?id=' + encodeURIComponent(numId)), {
    credentials: 'same-origin',
    cache: 'no-store'
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data || !data.success || !data.data) {
        alert((data && data.error) || 'Anlage nicht gefunden');
        return;
      }
      fillFormFromRow(data.data);
      var title = document.getElementById('modalTitle');
      if (title) title.textContent = 'Anlage bearbeiten · ' + (data.data.fabrikationsnummer || '');
      var delWrap = document.getElementById('modalDeleteWrap');
      if (delWrap) delWrap.style.display = '';
      openFormModal();
      loadModalFilesForFab(data.data.fabrikationsnummer || '');
    })
    .catch(function (err) {
      alert('Fehler: ' + (err && err.message ? err.message : String(err)));
    });
}

function openNew() {
  if (openAkteViaElectron(null)) return;
  openNewModal();
}

function editRow(id) {
  if (openAkteViaElectron(id)) return;
  openEditModal(id);
}

function closeModal() {
  if (isAkteStandaloneWindow()) {
    window.close();
    return;
  }
  if (formModal) formModal.classList.remove('active');
}

function deleteRow(id, fab) {
  if (!confirm('Anlage „' + fab + '“ wirklich löschen?')) return;
  fetch(anlagenstammApiUrl('api/anlagenstamm_delete.php'), {
    method: 'POST',
    headers: anlagenstammApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id })
  })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        notifyAnlagenstammSaved();
        if (isAkteStandaloneWindow()) {
          window.close();
          return;
        }
        closeModal();
        loadList();
      } else {
        alert(data.error || 'Löschen fehlgeschlagen');
      }
    })
    .catch(err => alert('Fehler: ' + err.message));
}

if (anlagenForm && !anlagenReadOnly) {
  anlagenForm.addEventListener('submit', function(e) {
  e.preventDefault();
  if (typeof window.kuklaCollectKraftaufnehmerExtra === 'function') window.kuklaCollectKraftaufnehmerExtra();
  var elMain = document.getElementById('formElektronik');
  var elTech = document.getElementById('formElektronikTechnik');
  if (elMain && elTech && elTech.value && !elMain.value) elMain.value = elTech.value;
  const fd = new FormData(this);
  if (window.KuklaHinweise && typeof KuklaHinweise.omitCreateFieldsFromFormData === 'function') {
    KuklaHinweise.omitCreateFieldsFromFormData(this, fd);
  } else {
    this.querySelectorAll('.hinweis-create-form [name]').forEach(function (el) {
      if (!el.name || el.name === 'fabrikationsnummer' || el.name === 'id') return;
      fd.delete(el.name);
    });
  }
  var fabElSave = document.getElementById('formFab');
  if (fabElSave) fd.set('fabrikationsnummer', String(fabElSave.value || '').trim());
  fetch(anlagenstammApiUrl('api/anlagenstamm_save.php'), { method: 'POST', body: fd, headers: anlagenstammApiHeaders() })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        if (typeof window.kuklaOnAnlagenstammSaved === 'function') {
          var g = function (name) { return String(fd.get(name) || '').trim(); };
          window.kuklaOnAnlagenstammSaved({
            fabrikationsnummer: g('fabrikationsnummer'),
            type: g('type'),
            leistung: g('leistung'),
            nenngeschwindigkeit: g('nenngeschwindigkeit'),
            behaelter_nenninhalt: g('behaelter_nenninhalt'),
            elektronik: g('elektronik'),
            position: g('position'),
            projekt: g('projekt'),
            kraftaufnehmer: g('kraftaufnehmer'),
            dms_nr: g('dms_nr'),
            dms_position: g('dms_position'),
            tacho: g('tacho'),
            material: g('material'),
            geliefert_ueber: g('geliefert_ueber'),
            bemerkungen: g('bemerkungen')
          });
        }
        notifyAnlagenstammSaved();
        if (isAkteStandaloneWindow()) {
          setTimeout(function () { window.close(); }, 300);
          return;
        }
        loadList();
        closeModal();
      } else {
        alert(data.error || 'Speichern fehlgeschlagen');
      }
    })
    .catch(err => alert('Fehler: ' + err.message));
  });
}

if (tableBody) {
  tableBody.addEventListener('click', function(e) {
    const btn = e.target.closest('.btn-edit');
    if (btn) { e.preventDefault(); editRow(parseInt(btn.dataset.id, 10)); }
  });
  tableBody.addEventListener('dblclick', function(e) {
    const tr = e.target.closest('tr');
    if (!tr || e.target.closest('button')) return;
    const id = tr.getAttribute('data-id');
    if (id) editRow(parseInt(id, 10));
  });
}
var modalBtnDelete = document.getElementById('modalBtnDelete');
if (modalBtnDelete && !anlagenReadOnly) {
  modalBtnDelete.addEventListener('click', function() {
    const id = document.getElementById('formId').value;
    const fab = document.getElementById('formFab').value.trim();
    if (!id || !fab) return;
    deleteRow(parseInt(id, 10), fab);
  });
}

const btnNew = document.getElementById('btnNew');
if (btnNew) btnNew.addEventListener('click', openNew);

// Import DOCX – Label öffnet Dateiauswahl nativ (for="importDocxInput"), change-Handler verarbeitet Upload
const importDocxInput = document.getElementById('importDocxInput');
const importPreviewModal = document.getElementById('importPreviewModal');
const importPreviewBody = document.getElementById('importPreviewBody');
const btnImportVerwerfen = document.getElementById('btnImportVerwerfen');
const btnImportSpeichern = document.getElementById('btnImportSpeichern');

if (importDocxInput) {
  const importDocxWrap = document.getElementById('importDocxWrap');
  const importDocxStatus = document.getElementById('importDocxStatus');
  importDocxInput.addEventListener('change', function() {
    const files = this.files;
    if (!files || files.length === 0) return;
    if (importDocxWrap) importDocxWrap.classList.add('loading');
    if (importDocxStatus) importDocxStatus.textContent = 'Importiere…';
    if (!confirm('DOCX-Dateien importieren? Bestehende Einträge mit gleicher Fabrikationsnummer werden aktualisiert.')) {
      if (importDocxWrap) importDocxWrap.classList.remove('loading');
      if (importDocxStatus) importDocxStatus.textContent = '';
      this.value = '';
      return;
    }
    const fd = new FormData();
    for (let i = 0; i < files.length; i++) {
      fd.append('docx_files[]', files[i]);
    }
    fetch(anlagenstammApiUrl('api/anlagenstamm_import_preview.php'), {
      method: 'POST',
      body: fd,
      credentials: 'same-origin',
      cache: 'no-store'
    })
      .then(function(r) {
        return r.text().then(function(text) {
          return anlagenstammParseJsonResponse(r, text);
        });
      })
      .then(function(result) {
        if (importDocxWrap) importDocxWrap.classList.remove('loading');
        if (importDocxStatus) importDocxStatus.textContent = '';
        var data = result.data;
        if (result.ok && data.success) {
          renderImportPreview(data.rows);
          if (importPreviewModal) importPreviewModal.classList.add('active');
        } else {
          alert(data.error || 'Import fehlgeschlagen');
        }
        importDocxInput.value = '';
      })
      .catch(function(err) {
        if (importDocxWrap) importDocxWrap.classList.remove('loading');
        if (importDocxStatus) importDocxStatus.textContent = '';
        alert('Fehler: ' + err.message);
        importDocxInput.value = '';
      });
  });
}

if (btnImportVerwerfen && importPreviewModal) {
  btnImportVerwerfen.addEventListener('click', function() {
    importPreviewModal.classList.remove('active');
  });
}

if (btnImportSpeichern) {
  btnImportSpeichern.addEventListener('click', function() {
    const rows = collectImportPreviewRows();
    if (rows.length === 0) {
      alert('Keine Zeilen zum Speichern.');
      return;
    }
    btnImportSpeichern.disabled = true;
    fetch(anlagenstammApiUrl('api/anlagenstamm_import_save.php'), {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows })
    })
      .then(function(r) {
        return r.text().then(function(text) {
          return anlagenstammParseJsonResponse(r, text);
        });
      })
      .then(function(result) {
        var data = result.data;
        btnImportSpeichern.disabled = false;
        if (result.ok && data.success) {
          if (importPreviewModal) importPreviewModal.classList.remove('active');
          loadList();
          const total = (data.imported || 0) + (data.updated || 0);
          alert(total + ' Anlagen importiert' + (data.updated ? ' (davon ' + data.updated + ' aktualisiert)' : '') + '.');
        } else {
          alert(data.error || 'Speichern fehlgeschlagen');
        }
      })
      .catch(err => {
        btnImportSpeichern.disabled = false;
        alert('Fehler: ' + err.message);
      });
  });
}

function renderImportPreview(rows) {
  if (!importPreviewBody) return;
  importPreviewBody.innerHTML = rows.map((r, i) => `
    <tr data-import-index="${i}">
      <td><input type="text" name="fabrikationsnummer" value="${escapeAttr(r.fabrikationsnummer || '')}" required></td>
      <td><input type="text" name="leistung" value="${escapeAttr(r.leistung || '')}"></td>
      <td><input type="text" name="geliefert_ueber" value="${escapeAttr(r.geliefert_ueber || '')}"></td>
      <td><input type="text" name="projekt" value="${escapeAttr(r.projekt || '')}"></td>
      <td><input type="text" name="type" value="${escapeAttr(r.type || '')}"></td>
      <td><textarea name="bemerkungen" rows="2" spellcheck="true" lang="de">${escapeHtml(r.bemerkungen || '')}</textarea></td>
      <td><button type="button" class="btn btn-delete btn-import-remove" title="Zeile entfernen">×</button></td>
    </tr>
  `).join('');
  importPreviewBody.querySelectorAll('.btn-import-remove').forEach(btn => {
    btn.addEventListener('click', function() {
      this.closest('tr').remove();
    });
  });
}

function collectImportPreviewRows() {
  if (!importPreviewBody) return [];
  const rows = [];
  importPreviewBody.querySelectorAll('tr').forEach(tr => {
    const fn = tr.querySelector('input[name="fabrikationsnummer"]');
    if (!fn || fn.value.trim() === '') return;
    rows.push({
      fabrikationsnummer: fn.value.trim(),
      leistung: (tr.querySelector('input[name="leistung"]') || {}).value?.trim() || '',
      geliefert_ueber: (tr.querySelector('input[name="geliefert_ueber"]') || {}).value?.trim() || '',
      projekt: (tr.querySelector('input[name="projekt"]') || {}).value?.trim() || '',
      type: (tr.querySelector('input[name="type"]') || {}).value?.trim() || '',
      bemerkungen: (tr.querySelector('textarea[name="bemerkungen"]') || {}).value?.trim() || ''
    });
  });
  return rows;
}

function filterRows() {
  pageState.page = 1;
  if (readFilterFn()) {
    fnFocusFlow();
    return;
  }
  listState.omitFnFilter = false;
  loadList();
}

/** Sortiert die Daten-Array für loadList (nach currentSort). */
function applySortToData(data) {
  return data;
}

/** Sortiert die sichtbaren tbody-Zeilen nach Spalte und Richtung (DOM). */
function sortTableByColumn(colIndex, dir) {
  currentSort = { col: colIndex, dir };
  updateSortButtonsUI();
  pageState.page = 1;
  if (readFilterFn()) fnFocusFlow();
  else loadList();
}

function updateSortButtonsUI() {
  const tbl = document.getElementById('anlagenstammTable');
  if (!tbl) return;
  tbl.querySelectorAll('.sort-btn').forEach(btn => {
    const col = parseInt(btn.getAttribute('data-col'), 10);
    const isAsc = btn.classList.contains('sort-asc');
    const dir = isAsc ? 1 : -1;
    if (currentSort && currentSort.col === col && currentSort.dir === dir) btn.classList.add('active');
    else btn.classList.remove('active');
  });
}

(function initFilter() {
  const tbl = document.getElementById('anlagenstammTable');
  if (!tbl) return;
  let filterTimer = null;
  const queueFilter = function (delayMs) {
    if (filterTimer) window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(function () {
      filterRows();
    }, delayMs);
  };
  tbl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && e.target.matches('.filter-row input[type="text"]')) {
      e.preventDefault();
      if (filterTimer) window.clearTimeout(filterTimer);
      filterRows();
    }
  });
  tbl.addEventListener('input', function(e) {
    if (e.target.matches('.filter-row input[type="text"]')) {
      const isFn = e.target.id === 'filterFn';
      queueFilter(isFn ? FN_FOCUS_DEBOUNCE_MS : FILTER_DEBOUNCE_MS);
    }
  });
  tbl.addEventListener('click', function(e) {
    const sortBtn = e.target.closest('.sort-btn');
    if (sortBtn) {
      e.preventDefault();
      const col = parseInt(sortBtn.getAttribute('data-col'), 10);
      const dir = sortBtn.classList.contains('sort-asc') ? 1 : -1;
      sortTableByColumn(col, dir);
    }
  });
  const btn = document.getElementById('btnApplyFilter');
  if (btn) btn.addEventListener('click', filterRows);
  updateSortButtonsUI();
})();
setupPnTreeModal();
(function initPaging() {
  const pagePrev = document.getElementById('pagePrev');
  const pageNext = document.getElementById('pageNext');
  const pageSizeEl = document.getElementById('pageSize');
  if (pagePrev) pagePrev.addEventListener('click', function () {
    const el = getAnlagenTableScrollEl();
    if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
  });
  if (pageNext) pageNext.addEventListener('click', function () {
    loadNextListPage();
  });
  if (pageSizeEl) pageSizeEl.addEventListener('change', function () {
    const n = parseInt(String(pageSizeEl.value || '100'), 10);
    pageState.pageSize = isNaN(n) ? 100 : Math.min(1000, Math.max(10, n));
    if (readFilterFn()) fnFocusFlow();
    else loadList();
  });
})();
initAnlagenColumnPanel();
initAnlagenInfiniteScroll();
if (tableBody) loadList();

// Tabelle nach Speichern/Löschen im Popup aktualisieren (postMessage + BroadcastChannel)
if (typeof window !== 'undefined') {
  window.loadList = loadList;
  window.closeModal = closeModal;
  window.initAnlagenColumnPanel = initAnlagenColumnPanel;
  window.applyAnlagenColumnVisibility = applyAnlagenColumnVisibility;
  function refreshFromPopup() {
    if (document.getElementById('tableBody')) loadList();
  }
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'anlagenstamm-saved' && e.origin === window.location.origin) {
      refreshFromPopup();
    }
  });
  try {
    var bc = new BroadcastChannel('anlagenstamm-refresh');
    bc.onmessage = function () { refreshFromPopup(); };
  } catch (err) { /* BroadcastChannel nicht unterstützt */ }
  if (window.monteurApp && typeof window.monteurApp.onAnlagenstammSaved === 'function') {
    window.monteurApp.onAnlagenstammSaved(function () { refreshFromPopup(); });
  }
}

if (document.getElementById('kraftaufnehmerRows') && typeof window.kuklaInitKraftaufnehmerRows === 'function') {
  var kaBox = document.getElementById('kraftaufnehmerRows');
  if (!kaBox || !kaBox.querySelector('.kraftaufnehmer-row')) {
    window.kuklaInitKraftaufnehmerRows({
      readOnly: anlagenReadOnly,
      primaryValue: '',
      extras: []
    });
  }
}
if (document.getElementById('motorRows') && typeof window.kuklaInitMotorRows === 'function') {
  var motorBox = document.getElementById('motorRows');
  if (!motorBox || !motorBox.querySelector('.motor-row')) {
    window.kuklaInitMotorRows({
      readOnly: anlagenReadOnly,
      rows: []
    });
  }
}

bindTdPrefillUi();

function kuklaBootAnlagenakteWindow() {
  if (!window.KUKLA_ANLAGENSTAMM_AKTE_WINDOW) return;
  var params = new URLSearchParams(window.location.search);
  var id = params.get('id');
  var fabParam = (params.get('fab') || '').trim();
  var cancel = document.getElementById('btnFormCancel') || document.getElementById('popupBtnCancel');
  if (cancel && !cancel._akteWinBound) {
    cancel._akteWinBound = true;
    cancel.addEventListener('click', function () { window.close(); });
  }
  function afterFill(row) {
    row = row || {};
    var title = document.getElementById('modalTitle');
    var fab = row.fabrikationsnummer || fabParam || 'Neue Anlage';
    if (title) title.textContent = row.id ? ('Anlage · ' + fab) : (fabParam ? ('Anlage · ' + fabParam) : 'Neue Anlage');
    document.title = 'Anlagenakte · ' + fab;
    var delWrap = document.getElementById('modalDeleteWrap');
    if (delWrap) delWrap.style.display = row.id ? '' : 'none';
    if (row.fabrikationsnummer && typeof loadModalFilesForFab === 'function') {
      loadModalFilesForFab(row.fabrikationsnummer);
    }
  }
  var fetchFn = typeof anlagenstammFetch === 'function' ? anlagenstammFetch : fetch;
  function loadById(numId) {
    fetchFn(anlagenstammApiUrl('api/anlagenstamm_get.php?id=' + encodeURIComponent(numId)), {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: typeof anlagenstammApiHeaders === 'function' ? anlagenstammApiHeaders() : undefined
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.success || !data.data) {
          if (fabParam) return loadByFab(fabParam);
          alert((data && data.error) || 'Anlage nicht gefunden');
          return;
        }
        fillFormFromRow(data.data);
        afterFill(data.data);
      })
      .catch(function (err) {
        alert('Fehler: ' + (err && err.message ? err.message : String(err)));
      });
  }
  function loadByFab(fab) {
    fetchFn('/api/anlagenstamm_lookup', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        typeof anlagenstammApiHeaders === 'function' ? anlagenstammApiHeaders() : {}
      ),
      body: JSON.stringify({ fab: fab })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        var row = data && data.ok && data.row ? data.row : null;
        if (row && row.id) {
          fillFormFromRow(row);
          afterFill(row);
          return;
        }
        fillFormFromRow({ fabrikationsnummer: fab });
        afterFill({ fabrikationsnummer: fab });
      })
      .catch(function (err) {
        alert('Fehler: ' + (err && err.message ? err.message : String(err)));
      });
  }
  if (id) {
    loadById(id);
    return;
  }
  if (fabParam) {
    loadByFab(fabParam);
    return;
  }
  fillFormFromRow({});
  afterFill({});
}
window.kuklaBootAnlagenakteWindow = kuklaBootAnlagenakteWindow;
window.fillFormFromRow = fillFormFromRow;
if (window.KUKLA_ANLAGENSTAMM_AKTE_WINDOW) {
  kuklaBootAnlagenakteWindow();
}
