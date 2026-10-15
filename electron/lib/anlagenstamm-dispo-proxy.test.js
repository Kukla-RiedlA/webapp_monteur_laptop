'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  dispoMonteurFetchHeaders,
  setAnlagenstammProxyDeviceIdResolver,
  monteurUpstreamHttpError,
} = require('./anlagenstamm-dispo-proxy');

describe('Anlagenstamm-Dispo-Proxy Geräte-Header', () => {
  afterEach(() => {
    setAnlagenstammProxyDeviceIdResolver(null);
  });

  it('hängt die Laptop-Geräte-ID an, auch ohne explizites Argument', () => {
    setAnlagenstammProxyDeviceIdResolver(() => 'lap-test-device');
    const headers = dispoMonteurFetchHeaders(14, { Authorization: 'Basic abc' });
    assert.equal(headers['X-Kukla-Device-Id'], 'lap-test-device');
    assert.equal(headers['X-Technician-Id'], '14');
  });

  it('explizite Geräte-ID gewinnt vor dem Resolver', () => {
    setAnlagenstammProxyDeviceIdResolver(() => 'lap-from-app');
    const headers = dispoMonteurFetchHeaders(14, null, 'lap-from-payload');
    assert.equal(headers['X-Kukla-Device-Id'], 'lap-from-payload');
  });

  it('Geräte-Freigabe bleibt die Server-Meldung, ohne Monteur-Rollen-Hinweis', () => {
    const msg = monteurUpstreamHttpError(
      403,
      'Forbidden',
      'Gerät wartet auf Freigabe durch die Disposition.',
      '/dispo_api/api/anlagenstamm_monteur_save.php',
      'https://example/save',
    );
    assert.equal(msg, 'Gerät wartet auf Freigabe durch die Disposition.');
    assert.equal(/users\.role/.test(msg), false);
  });

  it('Rollenfehler behält den Hinweis auf users.role = monteur', () => {
    const msg = monteurUpstreamHttpError(403, 'Forbidden', 'Kein gültiger Monteur.', '/x', '');
    assert.match(msg, /Kein gültiger Monteur/);
    assert.match(msg, /users\.role = monteur/);
  });
});
