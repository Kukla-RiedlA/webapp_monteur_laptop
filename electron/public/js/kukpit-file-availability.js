/**
 * Eine Anzeige für Projektdateien: Häkchen im grünen Kreis = offline, Wolke = nur online.
 */
(function (global) {
  function kukpitFileAvailabilityHtml(isOffline) {
    if (isOffline === true || isOffline === 1 || isOffline === '1') {
      return (
        '<span class="kukpit-file-badge kukpit-file-badge--offline" title="Offline verfügbar" aria-label="Offline verfügbar">' +
        '<span class="kukpit-file-badge-mark" aria-hidden="true">✓</span></span>'
      );
    }
    return '<span class="kukpit-file-badge kukpit-file-badge--online" title="Nur online" aria-label="Nur online">☁</span>';
  }

  function kukpitAppendFileAvailability(parent, isOffline) {
    if (!parent) return;
    const holder = global.document.createElement('span');
    holder.innerHTML = kukpitFileAvailabilityHtml(isOffline);
    const node = holder.firstChild;
    if (node) parent.appendChild(node);
  }

  global.kukpitFileAvailabilityHtml = kukpitFileAvailabilityHtml;
  global.kukpitAppendFileAvailability = kukpitAppendFileAvailability;
})(typeof window !== 'undefined' ? window : globalThis);
