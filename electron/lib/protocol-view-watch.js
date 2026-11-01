'use strict';

/** Masken, deren Stift-Ansicht der 400-ms-Scan nachführt. */
const PROTOCOL_VIEW_IDS = [
  'viewProtokolleArbeitsnachweis',
  'viewProtokolleMontagebericht',
  'viewProtokolleKontrollwiegungen',
  'viewProtokolleSchleppketten',
  'viewProtokollePruefzertifikat',
];

function protocolViewsToScan(activeViewId) {
  const id = String(activeViewId || '');
  return PROTOCOL_VIEW_IDS.indexOf(id) >= 0 ? [id] : [];
}

const api = { PROTOCOL_VIEW_IDS, protocolViewsToScan };

if (typeof module === 'object' && module.exports) {
  module.exports = api;
} else {
  const root = typeof globalThis !== 'undefined' ? globalThis : this;
  root.KuklaProtocolViewWatch = api;
}
