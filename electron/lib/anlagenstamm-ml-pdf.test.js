'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseMlPdfText, isMlPdfCandidate, isMotorListLayout, mlPdfLangRank } = require('./anlagenstamm-ml-pdf');

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

  it('bevorzugt Deutsch vor Englisch vor Spanisch', () => {
    assert.equal(mlPdfLangRank('Doku/Deutsch/01 Technische Informationen/01.02 Motorliste/11509_ML_DE.pdf'), 0);
    assert.equal(mlPdfLangRank('Doku/Englisch/01 Technical information/01.02 Motor list/11509_ML_EN.pdf'), 1);
    assert.equal(mlPdfLangRank('Doku/Spanisch/01 Información técnica/01.02 Ficha técnica motor/11509_ML_SP.pdf'), 3);
  });

  function assertSheetMotor(motors) {
    assert.equal(motors.length, 2);
    assert.equal(motors[0].positionsnummer, '+110-160-M01');
    assert.equal(motors[0].type, 'KA67 DRN100LM4/TF/EI7C');
    assert.equal(motors[0].seriennummer, '50.8178929001.0001.22');
    assert.equal(motors[0].nennleistung_kw, '2,2');
    assert.equal(motors[0].nenndrehzahl, '1762');
    assert.equal(motors[0].getriebedrehzahl, '20');
    assert.equal(motors[0].nennfrequenz, '60');
    assert.equal(motors[0].fu_type, 'Sinamics G120');
    assert.equal(motors[0].fu_hersteller, 'Siemens');
    assert.equal(motors[0].fu_nennstrom, '5,9');
    assert.equal(motors[0].fu_max_speed, '2500');
    assert.equal(motors[1].positionsnummer, '+110-160-M02');
    assert.equal(motors[1].type, 'K77 DRN100LM4/TF');
    assert.match(motors[0].bezeichnung, /^XD1/);
  }

  it('liest das deutsche Motordatenblatt mit angeklebten Werten', () => {
    const text = fs.readFileSync(path.join(__dirname, 'fixtures', '11509-ml-de.txt'), 'utf8');
    const motors = parseMlPdfText(text);
    assertSheetMotor(motors);
    assert.equal(motors[0].bezeichnung, 'XD1 Antrieb Wiegeband');
    assert.equal(motors[0].anlaufart, 'Frequenzumrichter');
    assert.equal(motors[0].hersteller, 'SEW Eurodrive');
  });

  it('liest das englische Motordatenblatt mit angeklebten Werten', () => {
    const text = fs.readFileSync(path.join(__dirname, 'fixtures', '11509-ml-en.txt'), 'utf8');
    const motors = parseMlPdfText(text);
    assertSheetMotor(motors);
    assert.equal(motors[0].bezeichnung, 'XD1 Drive weighing belt');
  });

  it('liest das spanische Motordatenblatt trotz umbrochener Spalten', () => {
    const text = fs.readFileSync(path.join(__dirname, 'fixtures', '11509-ml-sp.txt'), 'utf8');
    const motors = parseMlPdfText(text);
    assertSheetMotor(motors);
    assert.equal(motors[0].bezeichnung, 'XD1');
    assert.equal(motors[0].anlaufart, 'Convertidor de frecuencia');
    assert.equal(motors[0].schutzart, 'IP55');
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
