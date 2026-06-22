/**
 * Bildergalerie in separatem Electron-Fenster (Fallback: Einzel-Lightbox).
 */
(function (global) {
  'use strict';

  var RASTER_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif'];

  function isRasterImageName(fileName) {
    var m = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m && RASTER_EXTS.indexOf(m[1]) >= 0;
  }

  function getMonteurApp() {
    try {
      if (global.monteurApp && typeof global.monteurApp.openImageGallery === 'function') {
        return global.monteurApp;
      }
      if (global.parent && global.parent.monteurApp && typeof global.parent.monteurApp.openImageGallery === 'function') {
        return global.parent.monteurApp;
      }
    } catch (_) {}
    return null;
  }

  function getStoredTechnicianId() {
    try {
      var tid = localStorage.getItem('monteur_technicianId');
      if (tid) return String(tid).trim();
    } catch (_) {}
    return '';
  }

  function appendTechnicianToUrl(url) {
    var u = String(url || '').trim();
    if (!u) return u;
    var tid = getStoredTechnicianId();
    if (!tid) return u;
    if (u.indexOf('technician_id=') >= 0) return u;
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'technician_id=' + encodeURIComponent(tid);
  }

  function normalizeGalleryImages(images) {
    if (!Array.isArray(images)) return [];
    return images
      .map(function (item) {
        if (!item) return null;
        if (typeof item === 'string') {
          var u = appendTechnicianToUrl(String(item).trim());
          return u ? { url: u, label: '' } : null;
        }
        var url = appendTechnicianToUrl(String(item.url || '').trim());
        if (!url) return null;
        var label = String(item.label || item.title || item.name || '').trim();
        var thumbUrl = appendTechnicianToUrl(String(item.thumbUrl || item.thumb || '').trim());
        return thumbUrl ? { url: url, label: label, thumbUrl: thumbUrl } : { url: url, label: label };
      })
      .filter(Boolean);
  }

  function openImageGallery(images, index, options) {
    options = options || {};
    var list = normalizeGalleryImages(images);
    if (!list.length) return Promise.resolve({ ok: false, error: 'no_images' });
    var start = Math.max(0, Math.min(parseInt(index, 10) || 0, list.length - 1));
    var app = getMonteurApp();
    if (app) {
      return app.openImageGallery({
        images: list,
        index: start,
        title: options.title || list[start].label || 'Bildergalerie',
      });
    }
    if (typeof options.fallback === 'function') {
      options.fallback(list[start], list, start);
      return Promise.resolve({ ok: true, fallback: true });
    }
    return Promise.resolve({ ok: false, error: 'no_electron' });
  }

  function collectRasterFilesFromTree(nodes, mapFn) {
    var out = [];
    function walk(list) {
      (list || []).forEach(function (n) {
        if (!n) return;
        var type = String(n.type || n.kind || '').toLowerCase();
        var children = n.children || n.items || n.nodes || [];
        if (type === 'dir' || type === 'folder' || type === 'directory' || (children && children.length)) {
          walk(children);
          return;
        }
        if (type !== 'file' && type !== '') return;
        var name = String(n.name || n.label || n.basename || '').trim();
        var rel = String(n.rel || n.path || '').trim();
        if (!rel || !isRasterImageName(name || rel)) return;
        var mapped = mapFn(n, name, rel);
        if (mapped) out.push(mapped);
      });
    }
    walk(nodes);
    return out;
  }

  global.MonteurImageGallery = {
    isRasterImageName: isRasterImageName,
    open: openImageGallery,
    collectRasterFilesFromTree: collectRasterFilesFromTree,
    normalize: normalizeGalleryImages,
  };
})(typeof window !== 'undefined' ? window : global);
