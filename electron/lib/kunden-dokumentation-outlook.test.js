'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildOutlookDraftScript } = require('./kunden-dokumentation');

describe('Outlook-Entwurf Arbeitsnachweis', () => {
  it('HTML-Versand setzt Format, Signatur im Body und schliesst den Inspector vor Send', () => {
    const ps = buildOutlookDraftScript({
      recipients: ["kunde@example.com"],
      attachments: ["C:\\Temp\\Working_report.pdf"],
      subject: "Working report",
      htmlBody: '<p>Please find attached the working report.</p>',
      send: true,
      errorFile: 'C:\\Temp\\kukla-outlook-error.txt',
    });
    const formatAt = ps.indexOf('$mail.BodyFormat = 2');
    const inspectorAt = ps.indexOf('$mail.GetInspector');
    assert.ok(formatAt >= 0 && inspectorAt > formatAt);
    assert.match(ps, /<body\[\^>\]\*>/);
    assert.doesNotMatch(ps, /\$mail\.HTMLBody = \$html \+ \$signatureHtml/);
    assert.match(ps, /\$inspector\.Close\(0\)/);
    const closeAt = ps.indexOf('$inspector.Close(0)');
    const saveAt = ps.indexOf('$mail.Save()');
    const sendAt = ps.indexOf('$mail.Send()');
    assert.ok(closeAt < saveAt && saveAt < sendAt);
    assert.doesNotMatch(ps, /\$mail\.Display\(\)/);
    assert.match(ps, /0x39FE001F/);
    assert.match(ps, /Kein E-Mail-Empfänger angegeben/);
    assert.match(ps, /'C:\\Temp\\Working_report\.pdf'/);
  });

  it('Kunden-Dokumentation bleibt ein Entwurf ohne Sofortversand', () => {
    const ps = buildOutlookDraftScript({
      recipients: [],
      subject: "Kundendokumentation – O'Brien",
      body: "Im Anhang",
      send: false,
    });
    assert.match(ps, /\$mail\.Display\(\)/);
    assert.doesNotMatch(ps, /\$mail\.Send\(\)/);
    assert.doesNotMatch(ps, /\$mail\.BodyFormat = 2/);
    assert.match(ps, /\$mail\.Body = 'Im Anhang'/);
    assert.match(ps, /\$mail\.Subject = 'Kundendokumentation – O''Brien'/);
  });
});
