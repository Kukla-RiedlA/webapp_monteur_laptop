/**
 * Galerie-Thumbs: SQLite-Cache (prefer_cache), Vollbild erst beim Öffnen.
 */
(function (global) {
  'use strict';

  function thumbUrlFromHrefBase(hrefBase) {
    return String(hrefBase || '') + '&thumb=1&thumb_max=256&prefer_cache=1';
  }

  function loadThumbIntoImg(img, src, attempt) {
    if (!img || !src) return;
    attempt = attempt || 0;
    fetch(src, { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 204) {
          if (attempt < 24) {
            setTimeout(function () { loadThumbIntoImg(img, src, attempt + 1); }, 400);
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
        if (attempt < 6) {
          setTimeout(function () { loadThumbIntoImg(img, src, attempt + 1); }, 700);
        }
      });
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
