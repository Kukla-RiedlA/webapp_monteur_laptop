/**
 * OP-G Bildschirm: CSV-Text an den iframe schicken, Upload-Dialog.
 */
(function (root) {
  'use strict';

  function frameOf(host) {
    return host ? host.querySelector('[data-opcg-frame]') : null;
  }

  function send(frame, texts, reset) {
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage({
      type: 'opcg-csv',
      reset: reset !== false,
      texts: texts || []
    }, '*');
  }

  function whenReady(frame, done) {
    if (!frame) return;
    function readyNow() {
      try {
        return frame.dataset.opcgReady === '1' || !!(frame.contentWindow && frame.contentWindow.OPCG);
      } catch (_) {
        return false;
      }
    }
    if (readyNow()) {
      frame.dataset.opcgReady = '1';
      done();
      return;
    }
    frame.addEventListener('load', function () {
      frame.dataset.opcgReady = '1';
      done();
    });
  }

  function decodeBuffer(buf) {
    var bytes = new Uint8Array(buf);
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes);
    if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0) return new TextDecoder('utf-16le').decode(bytes);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function readFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    return Promise.all(files.map(function (file) {
      return file.arrayBuffer().then(decodeBuffer);
    }));
  }

  function bindSlot(host, frame, choose) {
    var slot = choose.getAttribute('data-opcg-choose');
    var input = host.querySelector('[data-opcg-files="' + slot + '"]');
    var status = host.querySelector('[data-opcg-slot="' + slot + '"]');
    if (!input) return;
    choose.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      if (status) status.textContent = 'Wird gelesen …';
      readFiles([file]).then(function (texts) {
        whenReady(frame, function () {
          frame.contentWindow.postMessage({
            type: 'opcg-csv',
            slot: Number(slot),
            text: texts[0],
            reset: false
          }, '*');
        });
        if (status) status.textContent = file.name;
      }).catch(function (err) {
        if (status) status.textContent = err && err.message ? err.message : 'Lesen fehlgeschlagen.';
      });
    });
  }

  function openFresh(host) {
    if (!host) return;
    bindUpload(host);
    Array.prototype.forEach.call(host.querySelectorAll('[data-opcg-slot]'), function (el) {
      el.textContent = '';
    });
    Array.prototype.forEach.call(host.querySelectorAll('input[data-opcg-files]'), function (input) {
      input.value = '';
    });
    whenReady(frameOf(host), function () { send(frameOf(host), [], true); });
  }

  function bindUpload(host) {
    if (!host || host.getAttribute('data-opcg-upload') === '1') return;
    host.setAttribute('data-opcg-upload', '1');
    var frame = frameOf(host);
    if (!frame) return;
    var chooses = host.querySelectorAll('[data-opcg-choose]');
    var slotted = false;
    Array.prototype.forEach.call(chooses, function (choose) {
      var slot = choose.getAttribute('data-opcg-choose');
      if (slot === null || slot === '') return;
      slotted = true;
      bindSlot(host, frame, choose);
    });
    if (slotted) return;
    var input = host.querySelector('[data-opcg-files]');
    var choose = host.querySelector('[data-opcg-choose]');
    var button = host.querySelector('[data-opcg-load]');
    var status = host.querySelector('[data-opcg-status]');
    if (!input || !button) return;
    if (choose) choose.addEventListener('click', function () { input.click(); });
    button.addEventListener('click', function () {
      var chosen = input.files;
      if (!chosen || !chosen.length) {
        if (status) status.textContent = 'Bitte mindestens eine PA-Liste wählen.';
        return;
      }
      if (status) status.textContent = 'Wird gelesen …';
      readFiles(chosen).then(function (texts) {
        whenReady(frame, function () { send(frame, texts, true); });
        if (status) status.textContent = chosen.length + ' Liste(n) geladen.';
      }).catch(function (err) {
        if (status) status.textContent = err && err.message ? err.message : 'Lesen fehlgeschlagen.';
      });
    });
  }

  root.OpcgTool = {
    send: send,
    whenReady: whenReady,
    bindUpload: bindUpload,
    openFresh: openFresh,
    readFiles: readFiles,
    decodeBuffer: decodeBuffer
  };
})(window);
