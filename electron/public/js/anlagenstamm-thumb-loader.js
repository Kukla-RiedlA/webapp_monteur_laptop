/**
 * Galerie-Thumbs: SQLite-Cache (prefer_cache), Vollbild erst beim Öffnen.
 * Requests seriell, damit der Electron-Hauptprozess nicht einfriert.
 */
(function (global) {
  'use strict';

  var pending = [];
  var busy = false;

  function thumbUrlFromHrefBase(hrefBase) {
    return String(hrefBase || '') + '&thumb=1&thumb_max=256&prefer_cache=1';
  }

  function pump() {
    if (busy || !pending.length) return;
    var job = pending.shift();
    if (!job || !job.img || !job.img.parentNode) {
      pump();
      return;
    }
    busy = true;
    fetchThumb(job.img, job.src, job.attempt || 0)
      .finally(function () {
        busy = false;
        pump();
      });
  }

  function fetchThumb(img, src, attempt) {
    return fetch(src, { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 204) {
          if (attempt < 20) {
            setTimeout(function () { enqueue(img, src, attempt + 1); }, 700);
          }
          return null;
        }
        if (!r.ok) throw new Error('thumb');
        var ct = (r.headers.get('content-type') || '').toLowerCase();
        if (ct.indexOf('json') >= 0 || ct.indexOf('text/html') >= 0) throw new Error('thumb');
        return r.blob();
      })
      .then(function (blob) {
        if (!blob || !img.parentNode) return;
        if (!blob.type || blob.type.indexOf('image/') !== 0) return;
        var prev = img.getAttribute('data-blob-url');
        if (prev) {
          try { global.URL.revokeObjectURL(prev); } catch (_) { /* ignore */ }
        }
        var obj = global.URL.createObjectURL(blob);
        img.setAttribute('data-blob-url', obj);
        img.src = obj;
      })
      .catch(function () {
        if (attempt < 4) {
          setTimeout(function () { enqueue(img, src, attempt + 1); }, 900);
        }
      });
  }

  function enqueue(img, src, attempt) {
    if (!img || !src) return;
    pending.push({ img: img, src: src, attempt: attempt || 0 });
    pump();
  }

  function loadThumbIntoImg(img, src, attempt) {
    enqueue(img, src, attempt || 0);
  }

  function bindLazyThumbs(root, selector) {
    if (!root) return;
    var sel = selector || 'img.akte-gallery-thumb, img.anlagen-pn-thumb';
    var imgs = Array.prototype.slice.call(root.querySelectorAll(sel));
    function start(img) {
      var src = img.getAttribute('data-thumb-src');
      if (!src) return;
      loadThumbIntoImg(img, src, 0);
    }
    if (typeof global.IntersectionObserver === 'function') {
      var io = new global.IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          var img = en.target;
          io.unobserve(img);
          start(img);
        });
      }, { root: null, rootMargin: '80px', threshold: 0.01 });
      imgs.forEach(function (img) { io.observe(img); });
    } else {
      imgs.forEach(start);
    }
  }

  global.kuklaAnlagenThumbLoader = {
    thumbUrlFromHrefBase: thumbUrlFromHrefBase,
    loadThumbIntoImg: loadThumbIntoImg,
    bindLazyThumbs: bindLazyThumbs,
  };
})(window);
