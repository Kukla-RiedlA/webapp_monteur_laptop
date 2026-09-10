/**
 * Hover-Vorschau für Dateilisten (jobs.php #fileList, Abrechnung ul.ab-files).
 * Abschalten: window.KUKLA_FILE_PREVIEW_HOVER = false (Skript dann ohne Bindung).
 */
(function (global) {
  'use strict';

  if (global.KUKLA_FILE_PREVIEW_HOVER === false) {
    return;
  }

  var pop = null;
  var imgEl = null;
  var msgEl = null;
  var textEl = null;
  var hideTimer = 0;
  var showTimer = 0;
  var imgWaitTimer = 0;
  var loadGen = 0;
  var currentKey = '';
  var blobUrls = {};
  var prefetching = {};
  var failedKeys = {};
  var prefetchQueue = [];
  var prefetchActive = 0;
  var PREFETCH_MAX = 2;

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'kukla-file-preview-pop';
    pop.setAttribute('aria-hidden', 'true');
    imgEl = document.createElement('img');
    imgEl.alt = '';
    msgEl = document.createElement('p');
    msgEl.className = 'kukla-file-preview-msg';
    textEl = document.createElement('pre');
    textEl.className = 'kukla-file-preview-text';
    textEl.hidden = true;
    pop.appendChild(msgEl);
    pop.appendChild(imgEl);
    pop.appendChild(textEl);
    document.body.appendChild(pop);
    return pop;
  }

  function clearImgWait() {
    if (imgWaitTimer) {
      clearTimeout(imgWaitTimer);
      imgWaitTimer = 0;
    }
  }

  function hide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = 0;
    }
    clearImgWait();
    currentKey = '';
    loadGen += 1;
    if (!pop) return;
    pop.classList.remove('is-open', 'is-loading');
    pop.style.display = 'none';
    if (imgEl) {
      imgEl.onload = null;
      imgEl.onerror = null;
      imgEl.removeAttribute('src');
      imgEl.hidden = true;
    }
    if (textEl) {
      textEl.hidden = true;
      textEl.textContent = '';
    }
    if (msgEl) msgEl.textContent = '';
  }

  function menuTopOffset() {
    var nav = document.querySelector('.app-header-nav-sticky')
      || document.querySelector('.app-header');
    if (nav) {
      var bottom = nav.getBoundingClientRect().bottom;
      if (bottom > 0) return Math.round(bottom) + 8;
    }
    if (document.body.classList.contains('has-sticky-header')) {
      return 128;
    }
    return 12;
  }

  function place(anchor) {
    var r = anchor.getBoundingClientRect();
    var top = menuTopOffset();
    var maxH = Math.max(200, window.innerHeight - top - 12);
    var maxW = Math.min(720, window.innerWidth * 0.48, window.innerWidth - 24);
    pop.style.maxWidth = maxW + 'px';
    pop.style.maxHeight = maxH + 'px';
    if (imgEl) {
      imgEl.style.maxHeight = Math.max(140, maxH - 24) + 'px';
    }
    var left = r.right + 12;
    if (left + maxW > window.innerWidth - 12) {
      left = r.left - maxW - 12;
    }
    if (left < 12) left = 12;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function showMsg(text, loading) {
    ensurePop();
    pop.classList.add('is-open');
    pop.classList.toggle('is-loading', !!loading);
    pop.style.display = 'flex';
    msgEl.textContent = text || '';
    msgEl.hidden = !text;
  }

  function showReady(anchor) {
    clearImgWait();
    ensurePop();
    pop.classList.add('is-open');
    pop.classList.remove('is-loading');
    pop.style.display = 'flex';
    msgEl.hidden = true;
    msgEl.textContent = '';
    imgEl.hidden = false;
    if (anchor) place(anchor);
  }

  function showFailed() {
    clearImgWait();
    if (imgEl) {
      imgEl.hidden = true;
    }
    pop.classList.remove('is-loading');
    showMsg('Keine Vorschau', false);
  }

  function previewUrl(spec, meta) {
    var u = spec.url;
    if (meta) {
      u += (u.indexOf('?') >= 0 ? '&' : '?') + 'meta=1';
    }
    return u;
  }

  function acceptPreviewType(ct) {
    ct = String(ct || '').toLowerCase();
    if (!ct) return true;
    if (ct.indexOf('image/') === 0) return true;
    if (ct.indexOf('octet-stream') >= 0) return true;
    return false;
  }

  function fetchOnce(spec) {
    var key = spec.url;
    return fetch(previewUrl(spec, false), { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('preview_http');
        if (!acceptPreviewType(r.headers.get('content-type'))) {
          throw new Error('preview_type');
        }
        return r.blob();
      })
      .then(function (blob) {
        if (!blob || blob.size < 32) throw new Error('preview_empty');
        if (blobUrls[key]) return blobUrls[key];
        blobUrls[key] = URL.createObjectURL(blob);
        delete failedKeys[key];
        return blobUrls[key];
      });
  }

  function fetchBlob(spec) {
    var key = spec && spec.url;
    if (!key) return Promise.reject(new Error('no_url'));
    if (blobUrls[key]) return Promise.resolve(blobUrls[key]);
    if (prefetching[key]) return prefetching[key];
    var p = fetchOnce(spec)
      .catch(function () {
        return delay(400).then(function () {
          return fetchOnce(spec);
        });
      });
    prefetching[key] = p;
    p.then(function () {}, function () {}).then(function () {
      if (prefetching[key] === p) delete prefetching[key];
    });
    return p;
  }

  function prefetch(spec) {
    if (!spec || !spec.url) return;
    fetchBlob(spec).then(function () {}, function () {});
  }

  function runPrefetchQueue() {
    while (prefetchActive < PREFETCH_MAX && prefetchQueue.length) {
      var spec = prefetchQueue.shift();
      if (!spec || !spec.url || blobUrls[spec.url]) continue;
      prefetchActive += 1;
      fetchBlob(spec).then(function () {}, function () {}).then(function () {
        prefetchActive -= 1;
        runPrefetchQueue();
      });
    }
  }

  function enqueuePrefetch(spec) {
    if (!spec || !spec.url) return;
    if (blobUrls[spec.url] || prefetching[spec.url]) return;
    var i;
    for (i = 0; i < prefetchQueue.length; i++) {
      if (prefetchQueue[i] && prefetchQueue[i].url === spec.url) return;
    }
    prefetchQueue.push(spec);
    runPrefetchQueue();
  }

  function prefetchList(root, getSpec) {
    if (!root || typeof getSpec !== 'function') return;
    var items = root.querySelectorAll('li');
    var n;
    for (n = 0; n < items.length; n++) {
      enqueuePrefetch(getSpec(items[n]));
    }
  }

  function imageIsReady() {
    return !!(imgEl && !imgEl.hidden && imgEl.getAttribute('src'));
  }

  function attachBlob(blobUrl, key, gen, anchor) {
    imgEl.onload = function () {
      if (gen !== loadGen || currentKey !== key) return;
      showReady(anchor);
    };
    imgEl.onerror = function () {
      /* Kurzer Decode-Fehler ist oft transitiv; onload oder Timeout entscheiden. */
    };
    imgWaitTimer = setTimeout(function () {
      imgWaitTimer = 0;
      if (gen !== loadGen || currentKey !== key) return;
      if (!imgEl.hidden) return;
      failedKeys[key] = true;
      showFailed();
    }, 2500);
    imgEl.src = blobUrl;
    if (imgEl.complete && imgEl.naturalWidth > 0) {
      showReady(anchor);
    }
  }

  function load(spec, anchor) {
    ensurePop();
    place(anchor);
    textEl.hidden = true;
    textEl.textContent = '';
    var key = spec.url;
    var gen = ++loadGen;
    currentKey = key;
    clearImgWait();
    imgEl.onload = null;
    imgEl.onerror = null;
    if (blobUrls[key]) {
      attachBlob(blobUrls[key], key, gen, anchor);
      return;
    }
    showMsg('Vorschau wird geladen …', true);
    imgEl.hidden = true;

    fetchBlob(spec).then(function (blobUrl) {
      if (gen !== loadGen || currentKey !== key) return;
      attachBlob(blobUrl, key, gen, anchor);
    }).catch(function () {
      if (gen !== loadGen || currentKey !== key) return;
      failedKeys[key] = true;
      showFailed();
    });
  }

  function previewAnchor(row) {
    if (!row) return null;
    return row.querySelector('a.job-file-link, a[href]');
  }

  function bindList(root, getSpec) {
    if (!root) return;
    if (root.dataset.kuklaPreviewBound !== '1') {
      root.dataset.kuklaPreviewBound = '1';
      root.addEventListener('mouseover', function (e) {
        var row = e.target.closest ? e.target.closest('li') : null;
        if (!row || !root.contains(row)) return;
        var anchor = previewAnchor(row);
        if (!anchor || !anchor.contains(e.target)) {
          if (showTimer) {
            clearTimeout(showTimer);
            showTimer = 0;
          }
          if (!hideTimer) hideTimer = setTimeout(hide, 80);
          return;
        }
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = 0;
        }
        var spec = getSpec(row);
        if (!spec || !spec.url) return;
        prefetch(spec);
        if (showTimer) clearTimeout(showTimer);
        showTimer = setTimeout(function () {
          if (currentKey === spec.url && pop && pop.classList.contains('is-open')) {
            if (pop.classList.contains('is-loading') || imageIsReady()) {
              place(anchor);
              return;
            }
            if (failedKeys[spec.url]) {
              place(anchor);
              return;
            }
          }
          load(spec, anchor);
        }, 60);
      });
      root.addEventListener('mouseleave', function () {
        if (showTimer) {
          clearTimeout(showTimer);
          showTimer = 0;
        }
        hideTimer = setTimeout(hide, 80);
      });
      if (typeof MutationObserver !== 'undefined') {
        var mo = new MutationObserver(function () {
          prefetchList(root, getSpec);
        });
        mo.observe(root, { childList: true });
      }
    }
    prefetchList(root, getSpec);
  }

  function bindJobFileList(root) {
    var el = root || document.getElementById('fileList');
    if (!el) return;
    bindList(el, function (li) {
      var jobId = li.getAttribute('data-job-id') || '';
      var fileId = li.getAttribute('data-file-id') || '';
      var stored = li.getAttribute('data-stored-name') || '';
      if (!jobId || !fileId) return null;
      var url = '/api/job_file_preview.php?job_id=' + encodeURIComponent(jobId)
        + '&file_id=' + encodeURIComponent(fileId);
      if (stored) url += '&name=' + encodeURIComponent(stored);
      return { url: url };
    });
  }

  function bindAbrechnungList(ul, bucket, jobIdOrFn) {
    if (!ul) return;
    bindList(ul, function (li) {
      var jobId = typeof jobIdOrFn === 'function' ? jobIdOrFn() : jobIdOrFn;
      var a = li.querySelector('a[href]');
      var name = (a && a.textContent) ? a.textContent.trim() : '';
      if (!jobId || !name) return null;
      return {
        url: '/api/abrechnung_file_preview.php?job_id=' + encodeURIComponent(String(jobId))
          + '&bucket=' + encodeURIComponent(bucket || 'dispo')
          + '&name=' + encodeURIComponent(name)
      };
    });
  }

  global.KuklaFilePreviewHover = {
    bindList: bindList,
    bindJobFileList: bindJobFileList,
    bindAbrechnungList: bindAbrechnungList,
    prefetch: prefetch,
    hide: hide
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      bindJobFileList();
    });
  } else {
    bindJobFileList();
  }
})(window);
