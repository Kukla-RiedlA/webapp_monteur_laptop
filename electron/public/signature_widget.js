/**
 * Signatur-Widget (Touch/Stift/Maus) — Dispo-Web, PWA, Electron.
 */
(function (global) {
  function collectDeviceFingerprint() {
    var o = {};
    try {
      o.ua = navigator.userAgent || '';
      o.platform = navigator.platform || '';
      o.language = navigator.language || '';
      o.languages = navigator.languages ? navigator.languages.join(',') : '';
      o.screen = [screen.width, screen.height, screen.colorDepth].join('x');
      o.dpr = typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1;
      o.hw = typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : 0;
      o.mem = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null;
      o.touch = typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0;
      o.tz =
        typeof Intl !== 'undefined' && Intl.DateTimeFormat
          ? Intl.DateTimeFormat().resolvedOptions().timeZone || ''
          : '';
      o.ts = Date.now();
    } catch (e) {}
    try {
      return JSON.stringify(o);
    } catch (e2) {
      return '{}';
    }
  }

  function parseApiJson(res, text) {
    var j = {};
    try {
      j = JSON.parse(text || '{}');
    } catch (e) {
      throw new Error('Ungültige JSON-Antwort vom Server.');
    }
    if (!res.ok) {
      throw new Error((j && j.error) || 'HTTP ' + res.status);
    }
    if (j && j.ok === false) {
      throw new Error((j && j.error) || 'Server meldet Fehler.');
    }
    return j;
  }

  function fetchPostJson(url, bodyObj) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(bodyObj || {})
    }).then(function (res) {
      return res.text().then(function (text) {
        return parseApiJson(res, text);
      });
    });
  }

  function pwaPostJson(path, body) {
    if (!global.PwaApi || typeof global.PwaApi.postJson !== 'function') {
      return Promise.reject(new Error('PwaApi.postJson fehlt'));
    }
    return global.PwaApi.postJson(path, body).then(function (j) {
      if (j && j.ok === false) {
        throw new Error((j && j.error) || 'Server meldet Fehler.');
      }
      return j;
    });
  }

  function openModal(html) {
    var overlay = document.createElement('div');
    overlay.setAttribute(
      'style',
      [
        'position:fixed',
        'inset:0',
        'z-index:99999',
        'background:rgba(0,0,0,0.55)',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:8px',
        'box-sizing:border-box'
      ].join(';')
    );
    var box = document.createElement('div');
    box.setAttribute(
      'style',
      [
        'background:#fff',
        'border-radius:10px',
        'max-width:min(560px,100vw)',
        'width:100%',
        'max-height:96vh',
        'overflow:auto',
        'box-shadow:0 8px 32px rgba(0,0,0,0.35)',
        'padding:12px',
        'box-sizing:border-box'
      ].join(';')
    );
    box.innerHTML = html;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    function close() {
      try {
        document.body.removeChild(overlay);
      } catch (e) {}
    }
    return { overlay: overlay, box: box, close: close };
  }

  /** Strokes in CSS-Pixel-Koordinaten (nach ctx.scale dpr). */
  function setupCanvas(canvas) {
    var ctx = canvas.getContext('2d');
    var dpr = typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1;
    var cw = canvas.clientWidth || 400;
    var ch = canvas.clientHeight || 180;
    canvas.width = Math.floor(cw * dpr);
    canvas.height = Math.floor(ch * dpr);
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    var strokes = [];
    var drawing = false;
    var t0 = Date.now();
    var ptrTypes = {};

    function getPos(ev) {
      var r = canvas.getBoundingClientRect();
      var scaleX = cw / r.width;
      var scaleY = ch / r.height;
      var cx = ev.clientX - r.left;
      var cy = ev.clientY - r.top;
      return { x: cx * scaleX, y: cy * scaleY };
    }

    function ptFromEv(ev) {
      var p = getPos(ev);
      var pr = typeof ev.pressure === 'number' && ev.pressure > 0 ? ev.pressure : 0.5;
      var pt = ev.pointerType || 'mouse';
      ptrTypes[pt] = true;
      return { x: p.x, y: p.y, t: Date.now() - t0, p: pr, pt: pt };
    }

    function down(ev) {
      ev.preventDefault();
      drawing = true;
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch (e) {}
      var g = [];
      strokes.push(g);
      g.push(ptFromEv(ev));
      ctx.beginPath();
      ctx.moveTo(g[0].x, g[0].y);
    }

    function move(ev) {
      ev.preventDefault();
      if (!drawing || strokes.length === 0) return;
      var g = strokes[strokes.length - 1];
      g.push(ptFromEv(ev));
      var q = g[g.length - 1];
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
    }

    function up(ev) {
      ev.preventDefault();
      drawing = false;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch (e) {}
      ctx.beginPath();
    }

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    return {
      clear: function () {
        strokes = [];
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.scale(dpr, dpr);
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
      },
      getStrokes: function () {
        return strokes;
      },
      getPointerTypes: function () {
        return Object.keys(ptrTypes).join(',');
      },
      captureStartMs: function () {
        return t0;
      }
    };
  }

  function open(opts) {
    opts = opts || {};
    // Default-refType: vor Dispo-Migration 022 war 'rams' (job_rams). Seit 022
    // ist dieser Wert nicht mehr in der Whitelist des Signaturmoduls. Wir
    // setzen den Default auf 'rams_iso'. Der Laptop nutzt das Widget aktuell
    // nur mit refType='montagebericht', daher rein defensiver Wert.
    var refType = opts.refType || 'rams_iso';
    var refId = parseInt(String(opts.refId || '0'), 10);
    var signerRole = opts.signerRole || 'techniker';
    var pdfLang = opts.pdfLanguage || 'DE';
    var mobile = !!opts.mobile;
    var stagingKey = opts.stagingKey || '';

    var sessionUrl = mobile ? '/api/mobile/signature_session_open.php' : '/api/signature/session_open.php';
    var submitUrl = mobile ? '/api/mobile/signature_submit.php' : '/api/signature/submit.php';

    var technicianIdWeb =
      typeof opts.technicianUserId === 'number' ? opts.technicianUserId : 0;
    var signerUserWeb =
      typeof opts.signerUserId === 'number' ? opts.signerUserId : technicianIdWeb;

    var signerNameDefault = String(opts.signerNameSuggestion || '').trim();

    function sessionBody() {
      var techMob = 0;
      if (mobile && global.PwaApi && global.PwaApi.getTechnicianId) {
        techMob = parseInt(String(global.PwaApi.getTechnicianId()), 10) || 0;
      }
      return {
        ref_type: refType,
        ref_id: refId,
        signer_role: signerRole,
        pdf_language: pdfLang,
        staging_key: stagingKey,
        technician_id: mobile ? techMob : technicianIdWeb
      };
    }

    function runDefaultSession() {
      var body = sessionBody();
      if (mobile) {
        return pwaPostJson(sessionUrl, body);
      }
      return fetchPostJson(sessionUrl, body);
    }

    var sessionPromise =
      typeof opts.customSessionOpen === 'function' ? opts.customSessionOpen() : runDefaultSession();

    sessionPromise
      .then(function (sess) {
        var token = sess.session_token;
        var previewUrl = sess.pdf_preview_url || '';

        var ui =
          '<div style="font-weight:bold;margin-bottom:8px;font-size:16px">Unterschrift</div>' +
          (previewUrl
            ? '<iframe src="' +
              previewUrl.replace(/"/g, '&quot;') +
              '" style="width:100%;height:220px;border:1px solid #ccc;border-radius:6px;margin-bottom:8px"></iframe>'
            : '') +
          '<label style="display:block;margin-bottom:6px;font-size:13px">Name Unterzeichner<br/>' +
          '<input type="text" id="kuklaSigName" style="width:100%;padding:8px;box-sizing:border-box" value="' +
          signerNameDefault.replace(/"/g, '&quot;') +
          '"/></label>' +
          '<div style="font-size:12px;color:#444;margin-bottom:4px">Mit Finger, Stift oder Maus unterschreiben:</div>' +
          '<canvas id="kuklaSigCanvas" width="400" height="180" style="width:100%;height:180px;border:1px solid #222;border-radius:6px;touch-action:none;cursor:crosshair;background:#fafafa"></canvas>' +
          '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
          '<button type="button" id="kuklaSigClear">Löschen</button>' +
          '<button type="button" id="kuklaSigCancel">Abbrechen</button>' +
          '<button type="button" id="kuklaSigOk" style="font-weight:bold">Signieren</button>' +
          '</div>' +
          '<p style="font-size:11px;color:#666;margin-top:8px;margin-bottom:0">Signatur inkl. biometrischer Daten und Dokument-Hash wird serverseitig protokolliert.</p>';

        var m = openModal(ui);
        var canvas = m.box.querySelector('#kuklaSigCanvas');
        var paint = setupCanvas(canvas);

        m.box.querySelector('#kuklaSigClear').onclick = function () {
          paint.clear();
        };
        m.box.querySelector('#kuklaSigCancel').onclick = function () {
          m.close();
          if (opts.onCancel) opts.onCancel();
        };

        m.box.querySelector('#kuklaSigOk').onclick = function () {
          var nameEl = m.box.querySelector('#kuklaSigName');
          var signerName = nameEl ? String(nameEl.value || '').trim() : '';
          if (!signerName) {
            alert('Bitte Namen eingeben.');
            return;
          }
          var strokes = paint.getStrokes();
          if (!strokes.length) {
            alert('Bitte unterschreiben.');
            return;
          }
          var dataUrl = canvas.toDataURL('image/png');
          var b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
          var payload = {
            session_token: token,
            signature_png_b64: b64,
            strokes_json: JSON.stringify(strokes),
            signer_name: signerName,
            device_fingerprint: collectDeviceFingerprint(),
            capture_started_at_ms: paint.captureStartMs(),
            capture_ended_at_ms: Date.now(),
            pointer_types: paint.getPointerTypes(),
            signer_role: signerRole
          };
          if (signerRole === 'techniker') {
            var uid = mobile
              ? parseInt(String(global.PwaApi && global.PwaApi.getTechnicianId ? global.PwaApi.getTechnicianId() : '0'), 10)
              : signerUserWeb;
            if (uid > 0) payload.signer_user_id = uid;
          }

          var btnOk = m.box.querySelector('#kuklaSigOk');
          btnOk.disabled = true;

          function finishOk(r) {
            m.close();
            if (opts.onSigned) opts.onSigned(r);
          }
          function fail(e) {
            btnOk.disabled = false;
            alert(e && e.message ? e.message : 'Signatur fehlgeschlagen');
          }

          var subPromise =
            typeof opts.customSubmit === 'function'
              ? opts.customSubmit(payload)
              : mobile
                ? pwaPostJson(submitUrl, payload)
                : fetchPostJson(submitUrl, payload);
          subPromise.then(finishOk).catch(fail);
        };
      })
      .catch(function (e) {
        alert(e && e.message ? e.message : 'Signatur-Session fehlgeschlagen');
        if (opts.onCancel) opts.onCancel();
      });
  }

  function openForPdf(opts) {
    opts = opts || {};
    var mobile = !!opts.mobile;
    if (opts.pdfUrl && opts.file == null) {
      var cred =
        opts.withCredentials === false ? 'omit' : mobile ? 'include' : 'same-origin';
      fetch(opts.pdfUrl, { credentials: cred })
        .then(function (res) {
          if (!res.ok) {
            throw new Error('PDF-Download fehlgeschlagen (HTTP ' + res.status + ').');
          }
          return res.blob();
        })
        .then(function (blob) {
          var o2 = Object.assign({}, opts);
          delete o2.pdfUrl;
          o2.file = blob;
          o2.stagingFileName = opts.pdfFileName || 'document.pdf';
          openForPdf(o2);
        })
        .catch(function (e) {
          alert(e && e.message ? e.message : 'PDF-Download fehlgeschlagen');
        });
      return;
    }
    var file = opts.file;
    if (!file) {
      alert('PDF-Datei fehlt (opts.file oder pdfUrl).');
      return;
    }
    var stageUrl = mobile ? '/api/mobile/signature_stage_pdf.php' : '/api/signature/stage_pdf.php';

    function runDefaultStage() {
      var fd = new FormData();
      var fn =
        (file && file.name) ? file.name : opts.stagingFileName || 'document.pdf';
      fd.append('file', file, fn);
      if (mobile) {
        if (!global.PwaApi || typeof global.PwaApi.uploadFormData !== 'function') {
          return Promise.reject(new Error('PwaApi.uploadFormData fehlt'));
        }
        return global.PwaApi.uploadFormData(stageUrl, fd).then(function (j) {
          if (j && j.ok === false) throw new Error((j && j.error) || 'Upload fehlgeschlagen');
          return j;
        });
      }
      return fetch(stageUrl, { method: 'POST', body: fd, credentials: 'same-origin' }).then(function (res) {
        return res.text().then(function (text) {
          return parseApiJson(res, text);
        });
      });
    }

    var stagePromise =
      typeof opts.customStagePdfFromFile === 'function'
        ? opts.customStagePdfFromFile(file)
        : runDefaultStage();

    stagePromise
      .then(function (r) {
        if (!r || !r.staging_key) throw new Error('staging_key fehlt');
        open({
          refType: 'generic_pdf',
          refId: 0,
          stagingKey: r.staging_key,
          signerRole: opts.signerRole || 'techniker',
          pdfLanguage: opts.pdfLanguage || 'DE',
          mobile: mobile,
          technicianUserId: opts.technicianUserId,
          signerUserId: opts.signerUserId,
          signerNameSuggestion: opts.signerNameSuggestion,
          onSigned: opts.onSigned,
          onCancel: opts.onCancel
        });
      })
      .catch(function (e) {
        alert(e && e.message ? e.message : 'PDF-Upload fehlgeschlagen');
      });
  }

  global.SignatureWidget = { open: open, openForPdf: openForPdf };
})(typeof window !== 'undefined' ? window : this);
