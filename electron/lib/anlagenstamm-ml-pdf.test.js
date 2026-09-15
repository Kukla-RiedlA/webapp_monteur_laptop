'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseMlPdfText, isMlPdfCandidate, isMotorListLayout } = require('./anlagenstamm-ml-pdf');

describe('MOTORLE / Motor-List Parser', () => {
  const extract = fs.readFileSync(path.join(__dirname, 'fixtures', 'motorle-extract.txt'), 'utf8');

  it('erkennt Motor-List-Layout', () => {
    assert.equal(isMotorListLayout(extract), true);
  });

  it('ordnet MOTORLE.pdf als Motorlisten-Kandidat', () => {
    assert.equal(isMlPdfCandidate('MOTORLE.pdf', 'Doku/englisch/04 Motor list/MOTORLE.pdf'), true);
    assert.equal(isMlPdfCandidate('MOTORLE.pdf', 'Doku/sonstiges/MOTORLE.pdf'), true);
    assert.equal(isMlPdfCandidate('notiz.pdf', 'Doku/englisch/sonstiges/notiz.pdf'), false);
  });

  it('liest fünf Antriebe aus der Kukla-Motorliste', () => {
    const motors = parseMlPdfText(extract);
    assert.equal(motors.length, 5);
    assert.equal(motors[0].positionsnummer, 'W-M1');
    assert.match(motors[0].bezeichnung, /weigh feeder/i);
    assert.match(motors[0].hersteller, /SEW/i);
    assert.match(motors[0].type, /KA47/);
    assert.equal(motors[0].seriennummer, '50.7386306501.0001.16');
    assert.equal(motors[0].nennleistung_kw, '0,55');
    assert.equal(motors[0].nennstrom, '1,62');
    assert.equal(motors[0].nenndrehzahl, '1360');
    assert.equal(motors[0].getriebedrehzahl, '4,2');
    assert.match(motors[0].nennspannung, /380/);
    assert.equal(motors[0].nennfrequenz, '50');
    assert.match(motors[0].anlaufart, /Frequency converter/i);
    assert.equal(motors[4].positionsnummer, 'W-M5');
    assert.match(motors[4].bezeichnung, /Discharge/i);
    assert.equal(motors[4].nennleistung_kw, '0,75');
    assert.match(motors[4].anlaufart, /Direct/i);
  });

  it('liest das Original-PDF MOTORLE.pdf', async () => {
    const pdfPath = 'C:/Users/ariedl/Downloads/MOTORLE.pdf';
    if (!fs.existsSync(pdfPath)) return;
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(fs.readFileSync(pdfPath));
    const motors = parseMlPdfText(data.text || '');
    assert.equal(motors.length, 5);
    assert.equal(motors[0].positionsnummer, 'W-M1');
    assert.match(motors[0].type, /KA47/);
    assert.equal(motors[4].positionsnummer, 'W-M5');
  });
});
