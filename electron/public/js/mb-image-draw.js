(function initKuklaImageDraw() {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var tool = '';
  var selectedIndex = -1;
  var activeImg = null;
  var drag = null;
  var pointerMove = null;
  var skipImgClick = false;
  var undoMap = typeof WeakMap === 'function' ? new WeakMap() : null;

  function undoStack(img) {
    if (!img || !undoMap) return null;
    var stack = undoMap.get(img);
    if (!stack) {
      stack = [];
      undoMap.set(img, stack);
    }
    return stack;
  }

  function pushUndo(img) {
    var stack = undoStack(img);
    if (!stack) return;
    stack.push(JSON.stringify(readShapes(img)));
    if (stack.length > 40) stack.shift();
  }

  function encodeShapes(arr) {
    try {
      return btoa(unescape(encodeURIComponent(JSON.stringify(arr || []))));
    } catch (e) {
      return '';
    }
  }

  function decodeShapes(b64) {
    if (!b64) return [];
    try {
      var json = decodeURIComponent(escape(atob(String(b64))));
      var parsed = JSON.parse(json);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function readShapes(img) {
    return decodeShapes(img && img.getAttribute('data-mb-draw'));
  }

  function writeShapes(img, shapes, opts) {
    if (!img) return;
    if (!(opts && opts.skipUndo)) pushUndo(img);
    var encoded = encodeShapes(shapes || []);
    if (encoded) img.setAttribute('data-mb-draw', encoded);
    else img.removeAttribute('data-mb-draw');
    renderOverlay(img);
    if (!(opts && opts.skipInput)) {
      var ed = img.closest && img.closest('.mb-rich-editor, [data-mb-editor], [data-fab-rich]');
      if (ed) {
        try { ed.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* ignore */ }
      }
    }
  }

  var overlays = [];

  function pruneOverlays() {
    overlays = overlays.filter(function (o) {
      if (o.img && o.img.isConnected) return true;
      if (o.svg && o.svg.parentNode) o.svg.parentNode.removeChild(o.svg);
      return false;
    });
  }

  function overlayFor(img) {
    if (!img) return null;
    for (var i = 0; i < overlays.length; i++) {
      if (overlays[i].img === img) return overlays[i].svg;
    }
    return null;
  }

  function positionOverlay(img, svg) {
    if (!img || !svg) return;
    var r = img.getBoundingClientRect();
    svg.style.position = 'fixed';
    svg.style.left = r.left + 'px';
    svg.style.top = r.top + 'px';
    svg.style.width = Math.max(1, r.width) + 'px';
    svg.style.height = Math.max(1, r.height) + 'px';
    svg.style.margin = '0';
    svg.style.padding = '0';
    svg.style.zIndex = '40';
    var live = !!tool && tool !== 'move' && img === activeImg;
    svg.style.pointerEvents = live ? 'auto' : 'none';
    var hit = svg.querySelector('rect.mb-draw-hit');
    if (hit) hit.setAttribute('pointer-events', live ? 'all' : 'none');
    svg.classList.toggle('is-drawing', live && tool !== 'erase');
    svg.classList.toggle('is-erasing', live && tool === 'erase');
    svg.style.visibility = (tool === 'move') ? 'hidden' : 'visible';
    svg.style.display = (r.width < 2 || r.height < 2) ? 'none' : 'block';
  }

  function syncAllOverlays() {
    pruneOverlays();
    overlays.forEach(function (o) {
      positionOverlay(o.img, o.svg);
    });
  }

  function bindOverlaySync() {
    if (document.documentElement.dataset.mbDrawSync) return;
    document.documentElement.dataset.mbDrawSync = '1';
    window.addEventListener('scroll', syncAllOverlays, true);
    window.addEventListener('resize', syncAllOverlays);
  }

  function attachOverlay(img) {
    if (!img) return null;
    bindOverlaySync();
    var svg = overlayFor(img);
    if (!svg) {
      svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'mb-draw-layer mb-draw-layer-float');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'none');
      var hit = document.createElementNS(NS, 'rect');
      hit.setAttribute('class', 'mb-draw-hit');
      hit.setAttribute('x', '0');
      hit.setAttribute('y', '0');
      hit.setAttribute('width', '100');
      hit.setAttribute('height', '100');
      hit.setAttribute('fill', 'transparent');
      hit.setAttribute('pointer-events', 'all');
      svg.appendChild(hit);
      document.body.appendChild(svg);
      overlays.push({ img: img, svg: svg });
      bindOverlay(svg, img);
    }
    positionOverlay(img, svg);
    return svg;
  }

  function ensureWrap(img) {
    attachOverlay(img);
    return img && img.parentNode;
  }

  function ensureHitRect(svg) {
    if (!svg) return;
    if (svg.querySelector('rect.mb-draw-hit')) return;
    var hit = document.createElementNS(NS, 'rect');
    hit.setAttribute('class', 'mb-draw-hit');
    hit.setAttribute('x', '0');
    hit.setAttribute('y', '0');
    hit.setAttribute('width', '100');
    hit.setAttribute('height', '100');
    hit.setAttribute('fill', 'transparent');
    hit.setAttribute('pointer-events', 'all');
    svg.insertBefore(hit, svg.firstChild);
  }

  function pctFromEvent(svg, ev) {
    var r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return { x: 0, y: 0 };
    return {
      x: clamp(((ev.clientX - r.left) / r.width) * 100, 0, 100),
      y: clamp(((ev.clientY - r.top) / r.height) * 100, 0, 100),
    };
  }

  function strokeWidthAttr(shape) {
    var w = Number(shape && shape.w);
    if (!isFinite(w) || w <= 0) w = 0.8;
    return String(w);
  }

  function colorOf(shape) {
    return (shape && shape.c) || '#0e7b5a';
  }

  function shapeEl(shape, index) {
    var el;
    var t = shape && shape.t;
    if (t === 'line') {
      el = document.createElementNS(NS, 'line');
      el.setAttribute('x1', shape.x1);
      el.setAttribute('y1', shape.y1);
      el.setAttribute('x2', shape.x2);
      el.setAttribute('y2', shape.y2);
    } else if (t === 'path') {
      el = document.createElementNS(NS, 'polyline');
      el.setAttribute('points', (shape.pts || []).map(function (p) {
        return p[0] + ',' + p[1];
      }).join(' '));
    } else if (t === 'rect') {
      el = document.createElementNS(NS, 'rect');
      el.setAttribute('x', Math.min(shape.x, shape.x + shape.bw));
      el.setAttribute('y', Math.min(shape.y, shape.y + shape.bh));
      el.setAttribute('width', Math.abs(shape.bw));
      el.setAttribute('height', Math.abs(shape.bh));
    } else if (t === 'circle') {
      el = document.createElementNS(NS, 'ellipse');
      el.setAttribute('cx', shape.cx);
      el.setAttribute('cy', shape.cy);
      el.setAttribute('rx', Math.abs(shape.rx));
      el.setAttribute('ry', Math.abs(shape.ry));
    } else {
      return null;
    }
    el.setAttribute('class', 'mb-draw-shape' + (index === selectedIndex ? ' is-selected' : ''));
    el.setAttribute('stroke', colorOf(shape));
    el.setAttribute('stroke-width', strokeWidthAttr(shape));
    el.setAttribute('fill', 'none');
    el.setAttribute('data-mb-shape', String(index));
    return el;
  }

  function bboxOf(shape) {
    if (!shape) return null;
    if (shape.t === 'line') {
      return {
        x: Math.min(shape.x1, shape.x2),
        y: Math.min(shape.y1, shape.y2),
        w: Math.abs(shape.x2 - shape.x1),
        h: Math.abs(shape.y2 - shape.y1),
      };
    }
    if (shape.t === 'path') {
      var pts = shape.pts || [];
      if (!pts.length) return null;
      var minX = 100;
      var minY = 100;
      var maxX = 0;
      var maxY = 0;
      pts.forEach(function (p) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
      });
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    if (shape.t === 'rect') {
      return {
        x: Math.min(shape.x, shape.x + shape.bw),
        y: Math.min(shape.y, shape.y + shape.bh),
        w: Math.abs(shape.bw),
        h: Math.abs(shape.bh),
      };
    }
    if (shape.t === 'circle') {
      return {
        x: shape.cx - Math.abs(shape.rx),
        y: shape.cy - Math.abs(shape.ry),
        w: Math.abs(shape.rx) * 2,
        h: Math.abs(shape.ry) * 2,
      };
    }
    return null;
  }

  function addHandle(svg, x, y, kind) {
    var h = document.createElementNS(NS, 'circle');
    h.setAttribute('class', 'mb-draw-handle');
    h.setAttribute('cx', x);
    h.setAttribute('cy', y);
    h.setAttribute('r', '3');
    h.setAttribute('data-mb-handle', kind);
    svg.appendChild(h);
  }

  function renderOverlay(img) {
    var svg = overlayFor(img);
    if (!svg) return;
    ensureHitRect(svg);
    var hit = svg.querySelector('rect.mb-draw-hit');
    Array.prototype.slice.call(svg.childNodes).forEach(function (n) {
      if (n !== hit) svg.removeChild(n);
    });
    var shapes = readShapes(img);
    shapes.forEach(function (shape, i) {
      var el = shapeEl(shape, i);
      if (el) svg.appendChild(el);
    });
    if (img === activeImg && selectedIndex >= 0 && shapes[selectedIndex]) {
      var sh = shapes[selectedIndex];
      if (sh.t === 'line') {
        addHandle(svg, sh.x1, sh.y1, 'p1');
        addHandle(svg, sh.x2, sh.y2, 'p2');
      } else {
        var box = bboxOf(sh);
        if (box) addHandle(svg, box.x + box.w, box.y + box.h, 'br');
      }
    }
    positionOverlay(img, svg);
  }

  function hitShape(shapes, p) {
    for (var i = shapes.length - 1; i >= 0; i--) {
      var s = shapes[i];
      var box = bboxOf(s);
      var pad = s.t === 'line' || s.t === 'path' ? 6 : 4;
      if (s.t === 'line') {
        var d = distToSegment(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
        if (d <= pad) return i;
      } else if (box && p.x >= box.x - pad && p.x <= box.x + box.w + pad && p.y >= box.y - pad && p.y <= box.y + box.h + pad) {
        return i;
      }
    }
    return -1;
  }

  function distToSegment(p, a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var len2 = dx * dx + dy * dy;
    if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
    var t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function currentStroke() {
    var sel = document.getElementById('mbDrawStroke');
    var v = sel ? parseFloat(sel.value) : 0.8;
    return isFinite(v) && v > 0 ? v : 0.8;
  }

  function currentColor() {
    var el = document.getElementById('mbDrawColor');
    return (el && el.value) || '#0e7b5a';
  }

  function notifyNeedImage() {
    if (typeof showToast === 'function') {
      showToast('Bitte zuerst ein Bild im Text auswählen, dann zeichnen.');
    } else {
      alert('Bitte zuerst ein Bild im Text auswählen, dann zeichnen.');
    }
  }

  function bindOverlay(svg, img) {
    if (svg.dataset.mbDrawBound) return;
    svg.dataset.mbDrawBound = '1';

    svg.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      activeImg = img;
      document.querySelectorAll('img.mb-img-selected').forEach(function (n) {
        n.classList.remove('mb-img-selected');
      });
      img.classList.add('mb-img-selected');
      var p = pctFromEvent(svg, ev);
      var shapes = readShapes(img);
      var handle = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-mb-handle');
      if (handle && selectedIndex >= 0 && tool !== 'erase') {
        pushUndo(img);
        drag = { kind: 'handle', handle: handle, start: p, orig: JSON.parse(JSON.stringify(shapes[selectedIndex])), saved: true };
        svg.setPointerCapture(ev.pointerId);
        return;
      }
      if (tool === 'erase') {
        var eraseHit = hitShape(shapes, p);
        drag = { kind: 'erase', did: false };
        if (eraseHit >= 0) {
          shapes.splice(eraseHit, 1);
          selectedIndex = -1;
          writeShapes(img, shapes);
          drag.did = true;
        }
        svg.setPointerCapture(ev.pointerId);
        return;
      }
      var hit = hitShape(shapes, p);
      if (hit >= 0) {
        selectedIndex = hit;
        pushUndo(img);
        drag = { kind: 'move', start: p, orig: JSON.parse(JSON.stringify(shapes[hit])), saved: true };
        svg.setPointerCapture(ev.pointerId);
        renderOverlay(img);
        return;
      }
      if (tool && tool !== 'erase') {
        selectedIndex = -1;
        var base = { c: currentColor(), w: currentStroke() };
        if (tool === 'line') drag = { kind: 'draw', shape: Object.assign({ t: 'line', x1: p.x, y1: p.y, x2: p.x, y2: p.y }, base) };
        else if (tool === 'free') drag = { kind: 'draw', shape: Object.assign({ t: 'path', pts: [[p.x, p.y]] }, base) };
        else if (tool === 'rect') drag = { kind: 'draw', shape: Object.assign({ t: 'rect', x: p.x, y: p.y, bw: 0, bh: 0 }, base) };
        else if (tool === 'circle') drag = { kind: 'draw', shape: Object.assign({ t: 'circle', cx: p.x, cy: p.y, rx: 0, ry: 0 }, base) };
        svg.setPointerCapture(ev.pointerId);
        return;
      }
      selectedIndex = -1;
      renderOverlay(img);
    });

    svg.addEventListener('pointermove', function (ev) {
      if (!drag) return;
      var p = pctFromEvent(svg, ev);
      var shapes = readShapes(img);
      if (drag.kind === 'erase') {
        var eraseHit = hitShape(shapes, p);
        if (eraseHit >= 0) {
          shapes.splice(eraseHit, 1);
          selectedIndex = -1;
          writeShapes(img, shapes, { skipUndo: !!drag.did, skipInput: true });
          drag.did = true;
        }
        return;
      }
      if (drag.kind === 'draw' && drag.shape) {
        if (drag.shape.t === 'line') {
          drag.shape.x2 = p.x;
          drag.shape.y2 = p.y;
        } else if (drag.shape.t === 'path') {
          drag.shape.pts.push([p.x, p.y]);
        } else if (drag.shape.t === 'rect') {
          drag.shape.bw = p.x - drag.shape.x;
          drag.shape.bh = p.y - drag.shape.y;
        } else if (drag.shape.t === 'circle') {
          drag.shape.rx = Math.abs(p.x - drag.shape.cx);
          drag.shape.ry = Math.abs(p.y - drag.shape.cy);
        }
        var preview = shapes.concat([drag.shape]);
        ensureHitRect(svg);
        var hitEl = svg.querySelector('rect.mb-draw-hit');
        Array.prototype.slice.call(svg.childNodes).forEach(function (n) {
          if (n !== hitEl) svg.removeChild(n);
        });
        preview.forEach(function (shape, i) {
          var el = shapeEl(shape, i);
          if (el) svg.appendChild(el);
        });
        return;
      }
      if (selectedIndex < 0 || !shapes[selectedIndex]) return;
      var dx = p.x - drag.start.x;
      var dy = p.y - drag.start.y;
      var o = drag.orig;
      if (drag.kind === 'move') {
        shapes[selectedIndex] = moveShape(o, dx, dy);
      } else if (drag.kind === 'handle') {
        shapes[selectedIndex] = resizeShape(o, drag.handle, p);
      }
      img.setAttribute('data-mb-draw', encodeShapes(shapes));
      renderOverlay(img);
    });

    svg.addEventListener('pointerup', function () {
      if (drag && drag.kind === 'draw' && drag.shape) {
        var shapes = readShapes(img);
        if (isUsableShape(drag.shape)) {
          shapes.push(normalizeShape(drag.shape));
          selectedIndex = shapes.length - 1;
          writeShapes(img, shapes);
        } else {
          renderOverlay(img);
        }
      } else if (drag && (drag.kind === 'move' || drag.kind === 'handle')) {
        writeShapes(img, readShapes(img), { skipUndo: true });
      } else if (drag && drag.kind === 'erase' && drag.did) {
        writeShapes(img, readShapes(img), { skipUndo: true });
      }
      drag = null;
    });
  }

  function isUsableShape(s) {
    if (!s) return false;
    if (s.t === 'line') return Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 0.8;
    if (s.t === 'path') return (s.pts || []).length > 2;
    if (s.t === 'rect') return Math.abs(s.bw) > 0.8 && Math.abs(s.bh) > 0.8;
    if (s.t === 'circle') return Math.abs(s.rx) > 0.8 && Math.abs(s.ry) > 0.8;
    return false;
  }

  function normalizeShape(s) {
    if (s.t === 'rect') {
      var x = Math.min(s.x, s.x + s.bw);
      var y = Math.min(s.y, s.y + s.bh);
      return Object.assign({}, s, { x: x, y: y, bw: Math.abs(s.bw), bh: Math.abs(s.bh) });
    }
    if (s.t === 'circle') {
      return Object.assign({}, s, { rx: Math.abs(s.rx), ry: Math.abs(s.ry) });
    }
    return s;
  }

  function moveShape(s, dx, dy) {
    var n = JSON.parse(JSON.stringify(s));
    function sh(v) { return clamp(v + dx, 0, 100); }
    function sv(v) { return clamp(v + dy, 0, 100); }
    if (n.t === 'line') {
      n.x1 = sh(n.x1); n.x2 = sh(n.x2); n.y1 = sv(n.y1); n.y2 = sv(n.y2);
    } else if (n.t === 'path') {
      n.pts = (n.pts || []).map(function (p) { return [sh(p[0]), sv(p[1])]; });
    } else if (n.t === 'rect') {
      n.x = sh(n.x); n.y = sv(n.y);
    } else if (n.t === 'circle') {
      n.cx = sh(n.cx); n.cy = sv(n.cy);
    }
    return n;
  }

  function resizeShape(s, handle, p) {
    var n = JSON.parse(JSON.stringify(s));
    if (n.t === 'line') {
      if (handle === 'p1') { n.x1 = p.x; n.y1 = p.y; }
      else { n.x2 = p.x; n.y2 = p.y; }
      return n;
    }
    var box = bboxOf(s);
    if (!box) return n;
    var nw = Math.max(0.8, p.x - box.x);
    var nh = Math.max(0.8, p.y - box.y);
    if (n.t === 'rect') {
      n.x = box.x; n.y = box.y; n.bw = nw; n.bh = nh;
    } else if (n.t === 'circle') {
      n.cx = box.x + nw / 2;
      n.cy = box.y + nh / 2;
      n.rx = nw / 2;
      n.ry = nh / 2;
    } else if (n.t === 'path') {
      var sx = box.w ? nw / box.w : 1;
      var sy = box.h ? nh / box.h : 1;
      n.pts = (n.pts || []).map(function (pt) {
        return [box.x + (pt[0] - box.x) * sx, box.y + (pt[1] - box.y) * sy];
      });
    }
    return n;
  }

  function rotatePt(x, y) {
    return { x: clamp(100 - y, 0, 100), y: clamp(x, 0, 100) };
  }

  function rotateShapes(shapes) {
    return (shapes || []).map(function (s) {
      var n = JSON.parse(JSON.stringify(s));
      if (n.t === 'line') {
        var a = rotatePt(n.x1, n.y1);
        var b = rotatePt(n.x2, n.y2);
        n.x1 = a.x; n.y1 = a.y; n.x2 = b.x; n.y2 = b.y;
      } else if (n.t === 'path') {
        n.pts = (n.pts || []).map(function (p) {
          var r = rotatePt(p[0], p[1]);
          return [r.x, r.y];
        });
      } else if (n.t === 'rect') {
        var c1 = rotatePt(n.x, n.y);
        var c2 = rotatePt(n.x + n.bw, n.y + n.bh);
        n.x = Math.min(c1.x, c2.x);
        n.y = Math.min(c1.y, c2.y);
        n.bw = Math.abs(c2.x - c1.x);
        n.bh = Math.abs(c2.y - c1.y);
      } else if (n.t === 'circle') {
        var c = rotatePt(n.cx, n.cy);
        n.cx = c.x;
        n.cy = c.y;
        var rx = n.rx;
        n.rx = n.ry;
        n.ry = rx;
      }
      return n;
    });
  }

  function imageFromEvent(ev) {
    var t = ev && ev.target;
    if (!t || !t.closest) return null;
    var svg = t.closest('svg.mb-draw-layer-float');
    if (svg) {
      for (var i = 0; i < overlays.length; i++) {
        if (overlays[i].svg === svg) return overlays[i].img;
      }
    }
    var wrap = t.closest('.mb-img-annotate');
    if (wrap) return wrap.querySelector('img');
    if (t.tagName === 'IMG') return t;
    return t.closest('img');
  }

  function overlayImgAtPoint(x, y) {
    var prev = [];
    overlays.forEach(function (o) {
      if (!o.svg) return;
      prev.push([o.svg, o.svg.style.visibility, o.svg.style.pointerEvents]);
      o.svg.style.visibility = 'hidden';
      o.svg.style.pointerEvents = 'none';
    });
    var el = document.elementFromPoint(x, y);
    prev.forEach(function (p) {
      p[0].style.visibility = p[1];
      p[0].style.pointerEvents = p[2];
    });
    if (!el) return null;
    if (el.tagName === 'IMG') return el;
    return el.closest ? el.closest('img') : null;
  }

  function caretRangeAt(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      var pos = document.caretPositionFromPoint(x, y);
      if (!pos) return null;
      var range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
      return range;
    }
    return null;
  }

  function placeNodeAtPoint(editor, node, x, y) {
    if (!editor || !node) return;
    overlays.forEach(function (o) {
      if (o.svg) o.svg.style.visibility = 'hidden';
    });
    var vis = node.style.visibility;
    node.style.visibility = 'hidden';
    var range = caretRangeAt(x, y);
    var hitEl = document.elementFromPoint(x, y);
    node.style.visibility = vis || '';
    overlays.forEach(function (o) {
      if (o.svg) o.svg.style.visibility = tool === 'move' ? 'hidden' : 'visible';
    });
    if (range && editor.contains(range.startContainer)) {
      var sc = range.startContainer;
      var scEl = sc.nodeType === 1 ? sc : sc.parentNode;
      if (!(scEl && (scEl === node || node.contains(scEl)))) {
        try {
          range.insertNode(node);
          return;
        } catch (eIns) { /* fallback */ }
      }
    }
    if (hitEl && editor.contains(hitEl) && hitEl !== node && !node.contains(hitEl)) {
      if (hitEl.tagName === 'IMG') {
        var hr = hitEl.getBoundingClientRect();
        if (x < hr.left + hr.width / 2) hitEl.parentNode.insertBefore(node, hitEl);
        else hitEl.parentNode.insertBefore(node, hitEl.nextSibling);
        return;
      }
      var block = hitEl;
      while (block.parentNode && block.parentNode !== editor) block = block.parentNode;
      if (block.parentNode === editor) {
        var br = block.getBoundingClientRect();
        if (y < br.top + br.height / 2) editor.insertBefore(node, block);
        else editor.insertBefore(node, block.nextSibling);
        return;
      }
    }
    editor.appendChild(node);
  }

  function unwrapAnnotates(root) {
    (root || document).querySelectorAll('span.mb-img-annotate').forEach(function (wrap) {
      var img = wrap.querySelector('img');
      if (!img) {
        wrap.remove();
        return;
      }
      var svg = wrap.querySelector('svg.mb-draw-layer');
      if (svg) svg.remove();
      var w = img.getAttribute('data-mb-width');
      if (w === '25' || w === '50' || w === '100') {
        img.style.width = w + '%';
        img.style.height = 'auto';
      } else {
        img.removeAttribute('data-mb-width');
        if ((img.style.width || '') === '100%') img.style.width = '';
      }
      wrap.parentNode.insertBefore(img, wrap);
      wrap.remove();
    });
  }

  function prepareEditorImages(editor) {
    if (!editor) return;
    editor.querySelectorAll('img').forEach(function (img) {
      img.setAttribute('contenteditable', 'false');
      img.setAttribute('draggable', 'false');
    });
  }

  function eachRichEditor(root, fn) {
    var scope = root || document;
    var seen = [];
    function add(ed) {
      if (!ed || seen.indexOf(ed) >= 0) return;
      if (!ed.matches || !ed.matches('.mb-rich-editor, [data-mb-editor], [data-fab-rich]')) return;
      seen.push(ed);
      fn(ed);
    }
    add(scope);
    if (scope.querySelectorAll) {
      scope.querySelectorAll('.mb-rich-editor, [data-mb-editor], [data-fab-rich]').forEach(add);
    }
  }

  function finishPointerMove(ev) {
    if (!pointerMove) return;
    var st = pointerMove;
    pointerMove = null;
    st.node.classList.remove('mb-img-dragging');
    if (st.moved) {
      skipImgClick = true;
      placeNodeAtPoint(st.editor, st.node, ev.clientX, ev.clientY);
      try { st.editor.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) { /* ignore */ }
      syncAllOverlays();
    }
  }

  function bindGlobalPointerMove() {
    if (document.documentElement.dataset.mbImgPointer) return;
    document.documentElement.dataset.mbImgPointer = '1';
    document.addEventListener('pointerdown', function (ev) {
      if (tool !== 'move') return;
      if (ev.button != null && ev.button !== 0) return;
      if (ev.target && ev.target.closest && ev.target.closest('#montageberichtToolbar')) return;
      var img = imageFromEvent(ev) || overlayImgAtPoint(ev.clientX, ev.clientY);
      if (!img) return;
      var ed = img.closest && img.closest('.mb-rich-editor, [data-mb-editor], [data-fab-rich]');
      if (!ed) return;
      ev.preventDefault();
      ev.stopPropagation();
      document.querySelectorAll('img.mb-img-selected').forEach(function (n) {
        n.classList.remove('mb-img-selected');
      });
      img.classList.add('mb-img-selected');
      img.setAttribute('contenteditable', 'false');
      rememberImage(img);
      if (window.KuklaEditorImages && window.KuklaEditorImages.hideResizeHandle) {
        window.KuklaEditorImages.hideResizeHandle();
      }
      pointerMove = {
        editor: ed,
        img: img,
        node: img,
        x: ev.clientX,
        y: ev.clientY,
        moved: false,
      };
    }, true);
    document.addEventListener('pointermove', function (ev) {
      if (!pointerMove) return;
      var dx = ev.clientX - pointerMove.x;
      var dy = ev.clientY - pointerMove.y;
      if (!pointerMove.moved && (dx * dx + dy * dy) < 36) return;
      pointerMove.moved = true;
      pointerMove.node.classList.add('mb-img-dragging');
      ev.preventDefault();
    }, true);
    document.addEventListener('pointerup', finishPointerMove, true);
    document.addEventListener('pointercancel', function () {
      if (!pointerMove) return;
      pointerMove.node.classList.remove('mb-img-dragging');
      pointerMove = null;
    }, true);
  }

  function bindImageReorder(root) {
    bindGlobalPointerMove();
    eachRichEditor(root, function (ed) {
      prepareEditorImages(ed);
      if (ed.dataset.mbImgReorder) return;
      ed.dataset.mbImgReorder = '1';
      ed.addEventListener('dragstart', function (ev) {
        if (imageFromEvent(ev)) ev.preventDefault();
      }, true);
      ed.addEventListener('pointerdown', function (ev) {
        if (tool === 'move') return;
        if (tool) return;
        if (ev.button != null && ev.button !== 0) return;
        var img = imageFromEvent(ev);
        if (!img || !ed.contains(img)) return;
        ev.preventDefault();
        img.classList.add('mb-img-selected');
        rememberImage(img);
      }, true);
      ed.addEventListener('click', function (ev) {
        if (!skipImgClick) return;
        skipImgClick = false;
        ev.preventDefault();
        ev.stopPropagation();
      }, true);
    });
  }

  function lockEditor(el) {
    if (!el || el.dataset.mbDrawLock) return;
    el.dataset.mbDrawLock = '1';
    el.addEventListener('dragstart', function (ev) {
      if (!tool) return;
      if (ev.target && (ev.target.tagName === 'IMG' || (ev.target.closest && ev.target.closest('.mb-img-annotate')))) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    }, true);
    el.addEventListener('drop', function (ev) {
      if (!tool) return;
      ev.preventDefault();
      ev.stopPropagation();
    }, true);
  }

  function wrapEditorImages(editor) {
    if (!editor) return;
    lockEditor(editor);
    editor.querySelectorAll('img[data-mb-draw]').forEach(function (img) {
      attachOverlay(img);
      renderOverlay(img);
    });
  }

  function hydrate(root) {
    var scope = root || document;
    unwrapAnnotates(scope);
    bindImageReorder(scope);
    eachRichEditor(scope, function (ed) {
      lockEditor(ed);
      prepareEditorImages(ed);
      ed.querySelectorAll('img[data-mb-draw]').forEach(function (img) {
        attachOverlay(img);
        renderOverlay(img);
      });
    });
    syncAllOverlays();
  }

  function startTool(name, img) {
    if (name === 'move') {
      if (window.KuklaEditorImages && window.KuklaEditorImages.hideResizeHandle) {
        window.KuklaEditorImages.hideResizeHandle();
      }
      if (img) rememberImage(img);
      setTool('move');
      return;
    }
    if (!img) {
      notifyNeedImage();
      setTool('');
      return;
    }
    activeImg = img;
    img.setAttribute('draggable', 'false');
    var ed = img.closest && img.closest('.mb-rich-editor, [data-mb-editor], [data-fab-rich]');
    if (ed) lockEditor(ed);
    attachOverlay(img);
    if (window.KuklaEditorImages && window.KuklaEditorImages.hideResizeHandle) {
      window.KuklaEditorImages.hideResizeHandle();
    }
    renderOverlay(img);
    setTool(name);
    syncAllOverlays();
  }

  function updateWrapMode(img) {
    var svg = overlayFor(img);
    if (!svg) return;
    positionOverlay(img, svg);
  }

  function setTool(name) {
    tool = name === tool ? '' : (name || '');
    document.querySelectorAll('#montageberichtToolbar [data-mb-draw]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-mb-draw') === tool && !!tool);
    });
    syncAllOverlays();
    document.body.classList.toggle('mb-img-move-mode', tool === 'move');
    if (!tool && activeImg) {
      activeImg.setAttribute('draggable', 'false');
    }
    return tool;
  }

  function rememberImage(img) {
    if (!img) return;
    activeImg = img;
  }

  function isDrawingToolActive() {
    return !!tool && tool !== 'move';
  }

  function undoLast(img) {
    var target = img || activeImg;
    if (!target) {
      notifyNeedImage();
      return;
    }
    var stack = undoStack(target);
    if (!stack || !stack.length) return;
    var prev = stack.pop();
    var shapes = [];
    try { shapes = JSON.parse(prev); } catch (e) { shapes = []; }
    writeShapes(target, shapes, { skipUndo: true });
  }

  function removeSelectedOrFalse(img) {
    if (!img) return false;
    var shapes = readShapes(img);
    if (selectedIndex >= 0 && shapes[selectedIndex] && img === activeImg) {
      writeShapes(img, shapes.filter(function (_, i) { return i !== selectedIndex; }));
      selectedIndex = -1;
      return true;
    }
    return false;
  }

  function rotateForImage(img) {
    if (!img) return;
    writeShapes(img, rotateShapes(readShapes(img)));
  }

  function bindToolbar(toolbarEl, getImg) {
    if (!toolbarEl || toolbarEl.dataset.mbDrawUi) return;
    toolbarEl.dataset.mbDrawUi = '1';
    function resolveImg() {
      var img = typeof getImg === 'function' ? getImg() : null;
      return img || activeImg || document.querySelector('#viewProtokolleMontagebericht img.mb-img-selected');
    }
    toolbarEl.querySelectorAll('[data-mb-draw]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        startTool(btn.getAttribute('data-mb-draw'), resolveImg());
      });
    });
    toolbarEl.querySelectorAll('[data-mb-draw-act="undo"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        undoLast(resolveImg());
      });
    });
  }

  bindGlobalPointerMove();

  window.KuklaImageDraw = {
    hydrate: hydrate,
    ensureWrap: ensureWrap,
    unwrapAnnotates: unwrapAnnotates,
    bindImageReorder: bindImageReorder,
    imageFromEvent: imageFromEvent,
    startTool: startTool,
    setTool: setTool,
    bindToolbar: bindToolbar,
    rememberImage: rememberImage,
    isDrawingToolActive: isDrawingToolActive,
    undoLast: undoLast,
    removeSelectedOrFalse: removeSelectedOrFalse,
    rotateForImage: rotateForImage,
    encodeShapes: encodeShapes,
    decodeShapes: decodeShapes,
  };
})();
