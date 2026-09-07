import * as pdfjsLib from '/vendor/pdfjs/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '/vendor/pdfjs/pdf.worker.min.mjs',
  window.location.origin,
).href;

const ALLOWED_COLORS = ['#c1121f', '#0e7b5a', '#1a1a1a'];

const sessionId = new URLSearchParams(window.location.search).get('id') || '';
const titleEl = document.getElementById('pdfTitle');
const statusEl = document.getElementById('pdfStatus');
const stageEl = document.getElementById('pdfStage');
const widthEl = document.getElementById('pdfWidth');
const textSizeEl = document.getElementById('pdfTextSize');
const zoomOutEl = document.getElementById('pdfZoomOut');
const zoomInEl = document.getElementById('pdfZoomIn');
const zoomLabelEl = document.getElementById('pdfZoomLabel');

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;

const DRAW_TOOLS = ['pen', 'line', 'circle'];
const TEXT_SIZES = [10, 14, 20, 28];

const state = {
  tool: 'pen',
  color: '#c1121f',
  widthPt: 2.5,
  textSizePt: 14,
  zoom: 1,
  strokes: [],
  texts: [],
  undo: [],
  pages: [],
  dirty: false,
  drawing: null,
  erasing: null,
  moving: null,
  pdf: null,
  viewKeep: null,
};

let renderSeq = 0;
let zoomApplySeq = 0;
let zoomTimer = 0;
let zoomAnchor = null;

function setStatus(text) {
  if (statusEl) statusEl.textContent = text || '';
}

function setDirty(on) {
  state.dirty = !!on;
}

function currentMarkup() {
  return {
    version: 1,
    strokes: state.strokes.map((s) => ({
      kind: s.kind || 'pen',
      page: s.page,
      color: s.color,
      widthPt: s.widthPt,
      points: s.points,
    })),
    texts: state.texts.map((t) => ({
      page: t.page,
      color: t.color,
      sizePt: t.sizePt,
      x: t.x,
      y: t.y,
      text: t.text,
    })),
  };
}

function pageFromEvent(ev) {
  const node = ev.target && ev.target.closest ? ev.target.closest('.pdf-page') : null;
  if (!node) return null;
  const index = parseInt(node.getAttribute('data-page'), 10);
  if (!Number.isFinite(index)) return null;
  return state.pages[index] || null;
}

function normPos(page, ev) {
  const r = page.wrap.getBoundingClientRect();
  const x = r.width ? (ev.clientX - r.left) / r.width : 0;
  const y = r.height ? (ev.clientY - r.top) / r.height : 0;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

function drawStrokeOnCtx(ctx, stroke, cssW, cssH, dpr) {
  if (!stroke.points || stroke.points.length < 2) return;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke.color;
  const pageW = stroke.pageWidthPt || 595;
  ctx.lineWidth = (stroke.widthPt || 2.5) * (cssW / pageW);
  const kind = stroke.kind || 'pen';
  if (kind === 'circle') {
    const cx = stroke.points[0][0] * cssW;
    const cy = stroke.points[0][1] * cssH;
    const ex = stroke.points[1][0] * cssW;
    const ey = stroke.points[1][1] * cssH;
    const r = Math.hypot(ex - cx, ey - cy);
    if (r >= 1) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    ctx.beginPath();
    ctx.moveTo(stroke.points[0][0] * cssW, stroke.points[0][1] * cssH);
    const last = kind === 'line' ? stroke.points[stroke.points.length - 1] : null;
    if (last) {
      ctx.lineTo(last[0] * cssW, last[1] * cssH);
    } else {
      for (let i = 1; i < stroke.points.length; i += 1) {
        ctx.lineTo(stroke.points[i][0] * cssW, stroke.points[i][1] * cssH);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

function redrawInk(page) {
  const canvas = page.ink;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = page.wrap.clientWidth;
  const cssH = page.wrap.clientHeight;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const stroke of state.strokes) {
    if (stroke.page !== page.index) continue;
    drawStrokeOnCtx(ctx, stroke, cssW, cssH, dpr);
  }
  if (state.drawing && state.drawing.page === page.index) {
    drawStrokeOnCtx(ctx, state.drawing, cssW, cssH, dpr);
  }
}

function placeTextEl(page, item) {
  const el = document.createElement('div');
  el.className = 'pdf-text-box';
  el.textContent = item.text;
  el.style.left = item.x * 100 + '%';
  el.style.top = item.y * 100 + '%';
  el.style.color = item.color;
  el.style.fontSize = Math.max(8, item.sizePt * (page.wrap.clientWidth / (page.widthPt || 595))) + 'px';
  page.texts.appendChild(el);
  bindTextBox(page, item, el);
  return el;
}

function rebuildTexts(page) {
  page.texts.innerHTML = '';
  for (const item of state.texts) {
    if (item.page !== page.index) continue;
    placeTextEl(page, item);
  }
}

function redrawAllOverlays() {
  for (const page of state.pages) {
    redrawInk(page);
    rebuildTexts(page);
  }
}

function pushUndo(entry) {
  state.undo.push(entry);
  setDirty(true);
}

function undoLast() {
  const last = state.undo.pop();
  if (!last) return;
  if (last.type === 'stroke') {
    state.strokes = state.strokes.filter((s) => s !== last.item);
  } else if (last.type === 'text') {
    state.texts = state.texts.filter((t) => t !== last.item);
  } else if (last.type === 'move' && last.item) {
    last.item.x = last.from.x;
    last.item.y = last.from.y;
  } else if (last.type === 'move-stroke' && last.item && last.fromPoints) {
    last.item.points = last.fromPoints.map((pt) => [pt[0], pt[1]]);
  } else if (last.type === 'erase') {
    (last.strokes || []).slice().sort((a, b) => a.index - b.index).forEach((row) => {
      const idx = Math.max(0, Math.min(state.strokes.length, row.index));
      state.strokes.splice(idx, 0, row.item);
    });
    (last.texts || []).slice().sort((a, b) => a.index - b.index).forEach((row) => {
      const idx = Math.max(0, Math.min(state.texts.length, row.index));
      state.texts.splice(idx, 0, row.item);
    });
  }
  redrawAllOverlays();
  setDirty(state.strokes.length > 0 || state.texts.length > 0);
  setStatus(state.dirty ? 'Ungespeichert' : '');
}

function clampZoom(z) {
  const n = Number(z);
  if (!Number.isFinite(n)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
}

function snapZoom(z) {
  return Math.round(clampZoom(z) / ZOOM_STEP) * ZOOM_STEP;
}

function formatZoom(z) {
  return Math.round(clampZoom(z) * 100) + '%';
}

function updateZoomUi(z) {
  const zoom = clampZoom(z == null ? state.zoom : z);
  if (zoomLabelEl) zoomLabelEl.textContent = formatZoom(zoom);
  if (zoomOutEl) zoomOutEl.disabled = zoom <= ZOOM_MIN + 0.001;
  if (zoomInEl) zoomInEl.disabled = zoom >= ZOOM_MAX - 0.001;
}

function stageFocusPoint(anchor) {
  const r = stageEl.getBoundingClientRect();
  if (anchor && Number.isFinite(anchor.clientX) && Number.isFinite(anchor.clientY)) {
    return { x: anchor.clientX, y: anchor.clientY, stageTop: r.top, stageLeft: r.left };
  }
  return {
    x: r.left + stageEl.clientWidth / 2,
    y: r.top + stageEl.clientHeight / 2,
    stageTop: r.top,
    stageLeft: r.left,
  };
}

function captureVisiblePage(anchor) {
  const focus = stageFocusPoint(anchor);
  const wraps = stageEl.querySelectorAll('.pdf-page');
  if (!wraps.length) return state.viewKeep || null;
  let chosen = wraps[wraps.length - 1];
  for (let i = 0; i < wraps.length; i += 1) {
    const box = wraps[i].getBoundingClientRect();
    if (focus.y >= box.top && focus.y <= box.bottom) {
      chosen = wraps[i];
      break;
    }
    if (box.top > focus.y) {
      chosen = wraps[Math.max(0, i - 1)];
      break;
    }
  }
  const box = chosen.getBoundingClientRect();
  const keep = {
    index: parseInt(chosen.getAttribute('data-page'), 10) || 0,
    yInPage: box.height ? (focus.y - box.top) / box.height : 0,
    xInPage: box.width ? (focus.x - box.left) / box.width : 0.5,
    stageOffsetY: focus.y - focus.stageTop,
    stageOffsetX: focus.x - focus.stageLeft,
  };
  state.viewKeep = keep;
  return keep;
}

function restoreVisiblePage(saved) {
  if (!saved || saved.index == null) return;
  const wrap = stageEl.querySelector('.pdf-page[data-page="' + String(saved.index) + '"]');
  if (!wrap) return;
  const yInPage = Math.min(1, Math.max(0, Number(saved.yInPage) || 0));
  const xInPage = Math.min(1, Math.max(0, Number(saved.xInPage) || 0.5));
  const offsetY = Number.isFinite(saved.stageOffsetY) ? saved.stageOffsetY : stageEl.clientHeight / 2;
  const offsetX = Number.isFinite(saved.stageOffsetX) ? saved.stageOffsetX : stageEl.clientWidth / 2;
  stageEl.scrollTop = Math.max(0, wrap.offsetTop + wrap.offsetHeight * yInPage - offsetY);
  stageEl.scrollLeft = Math.max(0, wrap.offsetLeft + wrap.offsetWidth * xInPage - offsetX);
}

async function applyZoom(next, anchor) {
  const seq = ++zoomApplySeq;
  const z = clampZoom(next);
  const saved = captureVisiblePage(anchor || zoomAnchor);
  zoomAnchor = null;
  state.zoom = z;
  pendingZoom = null;
  updateZoomUi(z);
  if (!state.pdf) return;
  await renderPdf(state.pdf, saved);
  if (seq !== zoomApplySeq) return;
  restoreVisiblePage(saved);
}

let pendingZoom = null;

function requestZoom(next, anchor, immediate) {
  const z = clampZoom(next);
  pendingZoom = z;
  zoomAnchor = anchor || zoomAnchor;
  updateZoomUi(z);
  clearTimeout(zoomTimer);
  if (immediate) {
    applyZoom(z, zoomAnchor);
    return;
  }
  zoomTimer = setTimeout(() => {
    applyZoom(pendingZoom == null ? z : pendingZoom, zoomAnchor);
  }, 70);
}

function zoomBy(delta, anchor, immediate) {
  const base = pendingZoom == null ? state.zoom : pendingZoom;
  requestZoom(base + delta, anchor, immediate);
}

async function renderPdf(pdf, viewKeep) {
  const seq = ++renderSeq;
  const keep = viewKeep || state.viewKeep;
  const frag = document.createDocumentFragment();
  const nextPages = [];
  const fitW = Math.max(280, stageEl.clientWidth - 36);
  const maxCss = Math.max(200, Math.round(fitW * state.zoom));
  for (let i = 1; i <= pdf.numPages; i += 1) {
    if (seq !== renderSeq) return false;
    const pdfPage = await pdf.getPage(i);
    const base = pdfPage.getViewport({ scale: 1 });
    const scale = maxCss / base.width;
    const viewport = pdfPage.getViewport({ scale });
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page';
    wrap.dataset.page = String(i - 1);
    wrap.style.width = Math.round(viewport.width) + 'px';
    wrap.style.height = Math.round(viewport.height) + 'px';

    const renderCanvas = document.createElement('canvas');
    renderCanvas.className = 'pdf-page-render';
    const dpr = window.devicePixelRatio || 1;
    renderCanvas.width = Math.round(viewport.width * dpr);
    renderCanvas.height = Math.round(viewport.height * dpr);
    renderCanvas.style.width = Math.round(viewport.width) + 'px';
    renderCanvas.style.height = Math.round(viewport.height) + 'px';
    const ctx = renderCanvas.getContext('2d');
    const renderTask = pdfPage.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    await renderTask.promise;

    const ink = document.createElement('canvas');
    ink.className = 'pdf-page-ink';
    const texts = document.createElement('div');
    texts.className = 'pdf-page-texts';
    wrap.appendChild(renderCanvas);
    wrap.appendChild(ink);
    wrap.appendChild(texts);
    frag.appendChild(wrap);

    const page = {
      index: i - 1,
      wrap,
      ink,
      texts,
      widthPt: base.width,
      heightPt: base.height,
    };
    nextPages.push(page);
    bindPage(page);
  }
  if (seq !== renderSeq) return false;
  stageEl.innerHTML = '';
  stageEl.appendChild(frag);
  state.pages = nextPages;
  redrawAllOverlays();
  restoreVisiblePage(keep);
  return true;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function strokeHitsPoint(stroke, p, cssW, cssH, thresholdPx) {
  const pts = stroke.points;
  if (!pts || pts.length < 2) return false;
  const kind = stroke.kind || 'pen';
  if (kind === 'circle') {
    const cx = pts[0][0] * cssW;
    const cy = pts[0][1] * cssH;
    const r = Math.hypot((pts[1][0] - pts[0][0]) * cssW, (pts[1][1] - pts[0][1]) * cssH);
    return Math.abs(Math.hypot(p.x * cssW - cx, p.y * cssH - cy) - r) <= thresholdPx;
  }
  if (kind === 'line') {
    const lastI = pts.length - 1;
    return distToSegment(
      p.x * cssW, p.y * cssH,
      pts[0][0] * cssW, pts[0][1] * cssH,
      pts[lastI][0] * cssW, pts[lastI][1] * cssH,
    ) <= thresholdPx;
  }
  for (let i = 1; i < pts.length; i += 1) {
    const d = distToSegment(
      p.x * cssW, p.y * cssH,
      pts[i - 1][0] * cssW, pts[i - 1][1] * cssH,
      pts[i][0] * cssW, pts[i][1] * cssH,
    );
    if (d <= thresholdPx) return true;
  }
  return false;
}

function eraseHitAt(page, p) {
  const cssW = page.wrap.clientWidth || 1;
  const cssH = page.wrap.clientHeight || 1;
  const session = state.erasing;
  if (!session) return false;
  let changed = false;
  for (let i = state.strokes.length - 1; i >= 0; i -= 1) {
    const stroke = state.strokes[i];
    if (stroke.page !== page.index) continue;
    const wPx = (stroke.widthPt || 2.5) * (cssW / (stroke.pageWidthPt || 595));
    if (!strokeHitsPoint(stroke, p, cssW, cssH, Math.max(16, wPx + 10))) continue;
    session.strokes.push({ index: i, item: stroke });
    state.strokes.splice(i, 1);
    changed = true;
  }
  for (let i = state.texts.length - 1; i >= 0; i -= 1) {
    const item = state.texts[i];
    if (item.page !== page.index) continue;
    const sizePx = Math.max(8, item.sizePt * (cssW / (page.widthPt || 595)));
    const left = item.x * cssW;
    const top = item.y * cssH;
    const w = Math.min(cssW * 0.7, Math.max(28, String(item.text || '').length * sizePx * 0.55));
    const h = sizePx * 1.5;
    const px = p.x * cssW;
    const py = p.y * cssH;
    if (px < left - 6 || px > left + w + 6 || py < top - 6 || py > top + h + 6) continue;
    session.texts.push({ index: i, item });
    state.texts.splice(i, 1);
    changed = true;
  }
  if (changed) {
    redrawInk(page);
    rebuildTexts(page);
  }
  return changed;
}

function eraseTextItem(item) {
  const idx = state.texts.indexOf(item);
  if (idx < 0) return;
  if (!state.erasing) {
    state.erasing = { strokes: [], texts: [] };
  }
  state.erasing.texts.push({ index: idx, item });
  state.texts.splice(idx, 1);
  const page = state.pages[item.page];
  if (page) rebuildTexts(page);
}

function finishErase() {
  const session = state.erasing;
  state.erasing = null;
  if (!session) return;
  if (!session.strokes.length && !session.texts.length) return;
  pushUndo({
    type: 'erase',
    strokes: session.strokes.slice(),
    texts: session.texts.slice(),
  });
  setStatus('Ungespeichert');
  setDirty(state.strokes.length > 0 || state.texts.length > 0);
}

function findStrokeAt(page, p) {
  const cssW = page.wrap.clientWidth || 1;
  const cssH = page.wrap.clientHeight || 1;
  for (let i = state.strokes.length - 1; i >= 0; i -= 1) {
    const stroke = state.strokes[i];
    if (stroke.page !== page.index) continue;
    const wPx = (stroke.widthPt || 2.5) * (cssW / (stroke.pageWidthPt || 595));
    if (strokeHitsPoint(stroke, p, cssW, cssH, Math.max(16, wPx + 10))) return stroke;
  }
  return null;
}

function applyStrokeOffset(stroke, fromPoints, dx, dy) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < fromPoints.length; i += 1) {
    const x = fromPoints[i][0] + dx;
    const y = fromPoints[i][1] + dy;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (minX < 0) dx -= minX;
  if (minY < 0) dy -= minY;
  if (maxX > 1) dx -= maxX - 1;
  if (maxY > 1) dy -= maxY - 1;
  for (let i = 0; i < fromPoints.length; i += 1) {
    stroke.points[i][0] = Math.min(1, Math.max(0, fromPoints[i][0] + dx));
    stroke.points[i][1] = Math.min(1, Math.max(0, fromPoints[i][1] + dy));
  }
}

function finishMoveStroke() {
  const mv = state.moving;
  state.moving = null;
  if (!mv || !mv.stroke || !mv.fromPoints) return;
  const a = mv.fromPoints[0];
  const b = mv.stroke.points[0];
  if (!a || !b) return;
  if (Math.abs(a[0] - b[0]) < 0.001 && Math.abs(a[1] - b[1]) < 0.001) return;
  pushUndo({
    type: 'move-stroke',
    item: mv.stroke,
    fromPoints: mv.fromPoints,
  });
  setStatus('Ungespeichert');
}

function bindPage(page) {
  page.ink.addEventListener('pointerdown', (ev) => {
    if (state.tool === 'eraser') {
      ev.preventDefault();
      page.ink.setPointerCapture(ev.pointerId);
      state.erasing = { strokes: [], texts: [] };
      eraseHitAt(page, normPos(page, ev));
      return;
    }
    if (state.tool === 'move') {
      ev.preventDefault();
      const p = normPos(page, ev);
      const stroke = findStrokeAt(page, p);
      if (!stroke) return;
      page.ink.setPointerCapture(ev.pointerId);
      page.ink.classList.add('is-dragging');
      state.moving = {
        stroke,
        fromPoints: stroke.points.map((pt) => [pt[0], pt[1]]),
        start: p,
      };
      return;
    }
    if (DRAW_TOOLS.indexOf(state.tool) < 0) return;
    ev.preventDefault();
    page.ink.setPointerCapture(ev.pointerId);
    const p = normPos(page, ev);
    state.drawing = {
      kind: state.tool,
      page: page.index,
      color: state.color,
      widthPt: state.widthPt,
      pageWidthPt: page.widthPt,
      points: [[p.x, p.y], [p.x, p.y]],
    };
  });
  page.ink.addEventListener('pointermove', (ev) => {
    if (state.moving && state.moving.stroke) {
      ev.preventDefault();
      const p = normPos(page, ev);
      applyStrokeOffset(
        state.moving.stroke,
        state.moving.fromPoints,
        p.x - state.moving.start.x,
        p.y - state.moving.start.y,
      );
      redrawInk(page);
      return;
    }
    if (state.tool === 'eraser' && state.erasing) {
      ev.preventDefault();
      eraseHitAt(page, normPos(page, ev));
      return;
    }
    if (!state.drawing || state.drawing.page !== page.index) return;
    ev.preventDefault();
    const p = normPos(page, ev);
    if (state.drawing.kind === 'line' || state.drawing.kind === 'circle') {
      state.drawing.points[1] = [p.x, p.y];
    } else {
      const pts = state.drawing.points;
      const last = pts[pts.length - 1];
      if (last && Math.abs(last[0] - p.x) < 0.0008 && Math.abs(last[1] - p.y) < 0.0008) return;
      pts.push([p.x, p.y]);
    }
    redrawInk(page);
  });
  function endStroke(ev) {
    if (state.moving) {
      ev.preventDefault();
      try { page.ink.releasePointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
      page.ink.classList.remove('is-dragging');
      finishMoveStroke();
      redrawInk(page);
      return;
    }
    if (state.tool === 'eraser' && state.erasing) {
      ev.preventDefault();
      try { page.ink.releasePointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
      finishErase();
      return;
    }
    if (!state.drawing || state.drawing.page !== page.index) return;
    ev.preventDefault();
    try { page.ink.releasePointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
    const stroke = state.drawing;
    state.drawing = null;
    const a = stroke.points[0];
    const b = stroke.points[stroke.points.length - 1];
    const tooShort = !a || !b || (Math.abs(a[0] - b[0]) < 0.004 && Math.abs(a[1] - b[1]) < 0.004
      && (stroke.kind !== 'pen' || stroke.points.length < 3));
    if (!stroke.points || stroke.points.length < 2 || tooShort) {
      redrawInk(page);
      return;
    }
    if (stroke.kind === 'line' || stroke.kind === 'circle') {
      stroke.points = [stroke.points[0], stroke.points[stroke.points.length - 1]];
    }
    state.strokes.push(stroke);
    pushUndo({ type: 'stroke', item: stroke });
    redrawInk(page);
    setStatus('Ungespeichert');
  }
  page.ink.addEventListener('pointerup', endStroke);
  page.ink.addEventListener('pointercancel', endStroke);

  page.texts.addEventListener('pointerdown', (ev) => {
    if (state.tool !== 'text') return;
    if (ev.target && ev.target.classList && ev.target.classList.contains('pdf-text-box')) return;
    ev.preventDefault();
    const p = normPos(page, ev);
    startText(page, p);
  });
}

function bindTextBox(page, item, el) {
  el.addEventListener('pointerdown', (ev) => {
    if (el.classList.contains('is-editing')) return;
    if (state.tool === 'eraser') {
      ev.preventDefault();
      ev.stopPropagation();
      const started = !state.erasing;
      if (started) state.erasing = { strokes: [], texts: [] };
      eraseTextItem(item);
      if (started) finishErase();
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    const startX = item.x;
    const startY = item.y;
    const originX = ev.clientX;
    const originY = ev.clientY;
    let moved = false;
    el.classList.add('is-dragging');
    try { el.setPointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
    function onMove(mv) {
      const w = page.wrap.clientWidth || 1;
      const h = page.wrap.clientHeight || 1;
      const nx = startX + (mv.clientX - originX) / w;
      const ny = startY + (mv.clientY - originY) / h;
      if (Math.abs(mv.clientX - originX) + Math.abs(mv.clientY - originY) > 4) moved = true;
      item.x = Math.min(0.98, Math.max(0, nx));
      item.y = Math.min(0.98, Math.max(0, ny));
      el.style.left = item.x * 100 + '%';
      el.style.top = item.y * 100 + '%';
    }
    function onUp(up) {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      try { el.releasePointerCapture(up.pointerId); } catch (_) { /* ignore */ }
      el.classList.remove('is-dragging');
      if (moved) {
        pushUndo({ type: 'move', item, from: { x: startX, y: startY } });
        setStatus('Ungespeichert');
      }
    }
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
  el.addEventListener('dblclick', (ev) => {
    if (state.tool === 'eraser') return;
    ev.preventDefault();
    ev.stopPropagation();
    beginEditText(page, item, el);
  });
}

function startText(page, pos) {
  const item = {
    page: page.index,
    color: state.color,
    sizePt: state.textSizePt,
    x: pos.x,
    y: pos.y,
    text: '',
  };
  const el = placeTextEl(page, item);
  el.textContent = '';
  beginEditText(page, item, el, true);
}

function beginEditText(page, item, el, isNew) {
  if (el.classList.contains('is-editing')) return;
  el.classList.add('is-editing');
  el.contentEditable = 'true';
  el.focus();
  function commit() {
    el.contentEditable = 'false';
    el.classList.remove('is-editing');
    el.removeEventListener('blur', commit);
    const text = String(el.textContent || '').replace(/\s+$/g, '').trim();
    if (!text) {
      state.texts = state.texts.filter((t) => t !== item);
      el.remove();
      setDirty(state.strokes.length > 0 || state.texts.length > 0);
      return;
    }
    item.text = text.slice(0, 500);
    el.textContent = item.text;
    if (isNew && state.texts.indexOf(item) < 0) {
      state.texts.push(item);
      pushUndo({ type: 'text', item });
    } else {
      setDirty(true);
      setStatus('Ungespeichert');
    }
  }
  el.addEventListener('keydown', function onKey(ev) {
    if (ev.key === 'Escape') {
      if (isNew) el.textContent = '';
      else el.textContent = item.text || '';
      el.blur();
    }
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      el.blur();
    }
  });
  el.addEventListener('blur', commit);
}

function setTool(tool) {
  const next = DRAW_TOOLS.indexOf(tool) >= 0 || tool === 'text' || tool === 'eraser' || tool === 'move' ? tool : 'pen';
  state.tool = next;
  document.body.classList.toggle('is-draw', DRAW_TOOLS.indexOf(next) >= 0);
  document.body.classList.toggle('is-text', next === 'text');
  document.body.classList.toggle('is-pen', next === 'pen');
  document.body.classList.toggle('is-eraser', next === 'eraser');
  document.body.classList.toggle('is-move', next === 'move');
  document.querySelectorAll('[data-tool]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-tool') === next);
  });
  if (widthEl) widthEl.hidden = next === 'text' || next === 'eraser' || next === 'move';
  if (textSizeEl) textSizeEl.hidden = next !== 'text';
}

function setColor(color) {
  const next = ALLOWED_COLORS.indexOf(color) >= 0 ? color : '#c1121f';
  state.color = next;
  document.querySelectorAll('[data-color]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-color') === next);
  });
}

async function save(saveAs) {
  if (!sessionId) {
    setStatus('Keine Sitzung.');
    return { ok: false };
  }
  if (!state.strokes.length && !state.texts.length) {
    setDirty(false);
    setStatus('Nichts zu speichern.');
    return { ok: true };
  }
  setStatus('Speichern …');
  try {
    const res = await fetch('/api/pdf-annotator/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: sessionId,
        saveAs: !!saveAs,
        markup: currentMarkup(),
      }),
    });
    const data = await res.json().catch(() => null);
    if (data && data.cancelled) {
      setStatus('Speichern abgebrochen.');
      return { ok: false, cancelled: true };
    }
    if (!res.ok || !data || !data.ok) {
      setStatus((data && data.error) || 'Speichern fehlgeschlagen.');
      return { ok: false };
    }
    setDirty(false);
    setStatus('Gespeichert: ' + (data.fileName || 'PDF'));
    if (data.fileName) document.title = data.fileName;
    return { ok: true };
  } catch (e) {
    setStatus(e && e.message ? e.message : 'Speichern fehlgeschlagen.');
    return { ok: false };
  }
}

window.__pdfAnnotatorHasUnsavedChanges = function () {
  return !!state.dirty;
};

window.__pdfAnnotatorDiscardChanges = function () {
  setDirty(false);
  return true;
};

window.__pdfAnnotatorSaveForClose = async function () {
  const result = await save(false);
  return !!(result && result.ok);
};

async function boot() {
  if (!sessionId) {
    stageEl.innerHTML = '<div class="pdf-annot-error">Keine PDF-Sitzung.</div>';
    setStatus('Fehler');
    return;
  }
  try {
    const metaRes = await fetch('/api/pdf-annotator/session/' + encodeURIComponent(sessionId));
    const meta = await metaRes.json().catch(() => null);
    if (!metaRes.ok || !meta || !meta.ok) {
      throw new Error((meta && meta.error) || 'Sitzung unbekannt.');
    }
    titleEl.textContent = meta.fileName || 'PDF';
    document.title = meta.fileName || 'PDF';
    const fileRes = await fetch('/api/pdf-annotator/file/' + encodeURIComponent(sessionId));
    if (!fileRes.ok) throw new Error('PDF konnte nicht geladen werden.');
    const buf = await fileRes.arrayBuffer();
    state.pdf = await pdfjsLib.getDocument({
      data: buf,
      disableRange: true,
      disableStream: true,
      cMapUrl: '/vendor/pdfjs-cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs-fonts/',
      wasmUrl: '/vendor/pdfjs-wasm/',
    }).promise;
    setStatus(state.pdf.numPages + ' Seite(n)');
    await renderPdf(state.pdf);
  } catch (e) {
    stageEl.innerHTML =
      '<div class="pdf-annot-error">PDF konnte nicht geöffnet werden.<br>' +
      (e && e.message ? e.message : '') +
      '</div>';
    setStatus('Fehler');
  }
}

document.querySelectorAll('[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => setTool(btn.getAttribute('data-tool')));
});
document.querySelectorAll('[data-color]').forEach((btn) => {
  btn.addEventListener('click', () => setColor(btn.getAttribute('data-color')));
});
widthEl.addEventListener('change', () => {
  state.widthPt = parseFloat(widthEl.value) || 2.5;
});
if (textSizeEl) {
  textSizeEl.addEventListener('change', () => {
    const n = parseFloat(textSizeEl.value);
    state.textSizePt = TEXT_SIZES.indexOf(n) >= 0 ? n : 14;
  });
}
document.getElementById('pdfUndo').addEventListener('click', undoLast);
document.getElementById('pdfSave').addEventListener('click', () => save(false));
document.getElementById('pdfSaveAs').addEventListener('click', () => save(true));
zoomOutEl.addEventListener('click', () => zoomBy(-ZOOM_STEP, null, true));
zoomInEl.addEventListener('click', () => zoomBy(ZOOM_STEP, null, true));
zoomLabelEl.addEventListener('click', () => requestZoom(1, null, true));

stageEl.addEventListener('wheel', (ev) => {
  if (!(ev.ctrlKey || ev.metaKey)) return;
  ev.preventDefault();
  const step = ev.deltaY > 0 ? -0.1 : 0.1;
  zoomBy(step, { clientX: ev.clientX, clientY: ev.clientY }, false);
}, { passive: false });

document.addEventListener('keydown', (ev) => {
  const key = String(ev.key || '').toLowerCase();
  if ((ev.ctrlKey || ev.metaKey) && key === 'z') {
    ev.preventDefault();
    undoLast();
  }
  if ((ev.ctrlKey || ev.metaKey) && key === 's') {
    ev.preventDefault();
    save(ev.shiftKey);
  }
  if ((ev.ctrlKey || ev.metaKey) && (key === '+' || key === '=' || ev.code === 'NumpadAdd')) {
    ev.preventDefault();
    zoomBy(ZOOM_STEP, null, true);
  }
  if ((ev.ctrlKey || ev.metaKey) && (key === '-' || key === '_' || ev.code === 'NumpadSubtract')) {
    ev.preventDefault();
    zoomBy(-ZOOM_STEP, null, true);
  }
  if ((ev.ctrlKey || ev.metaKey) && key === '0') {
    ev.preventDefault();
    requestZoom(1, null, true);
  }
});

window.addEventListener('beforeunload', (ev) => {
  if (!state.dirty) return;
  ev.preventDefault();
  ev.returnValue = '';
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.pdf) return;
    const keep = captureVisiblePage(null);
    renderPdf(state.pdf, keep).catch(() => {});
  }, 180);
});

setTool('pen');
setColor('#c1121f');
updateZoomUi(1);
boot();
