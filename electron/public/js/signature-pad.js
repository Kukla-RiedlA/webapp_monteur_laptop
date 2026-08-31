/**
 * Pointer-Signaturpad (Maus/Touch/Stift) – keine QES.
 * Export: window.KuklaSignaturePad.attach(canvas) → { clear, isEmpty, toDataUrl, getStrokes }
 */
(function (global) {
  function attach(canvas) {
    if (!canvas) return null;
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

    function getPos(ev) {
      var r = canvas.getBoundingClientRect();
      var scaleX = cw / r.width;
      var scaleY = ch / r.height;
      return { x: (ev.clientX - r.left) * scaleX, y: (ev.clientY - r.top) * scaleY };
    }

    function down(ev) {
      ev.preventDefault();
      drawing = true;
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch (e) {}
      var p = getPos(ev);
      strokes.push([p]);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    }

    function move(ev) {
      ev.preventDefault();
      if (!drawing || !strokes.length) return;
      var p = getPos(ev);
      strokes[strokes.length - 1].push(p);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
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
        ctx.lineJoin = 'round';
      },
      isEmpty: function () {
        return strokes.length === 0;
      },
      toDataUrl: function () {
        return canvas.toDataURL('image/png');
      },
      getStrokes: function () {
        return strokes;
      }
    };
  }

  global.KuklaSignaturePad = { attach: attach };
})(typeof window !== 'undefined' ? window : this);
