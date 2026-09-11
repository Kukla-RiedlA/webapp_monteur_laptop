'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  filenameDatetimeIso,
  resolveDisplayDatetime,
  decorateParameterListItem,
  sortParameterFilesByDisplayDesc,
} = require('./anlagenstamm-filename-datetime');

describe('anlagenstamm-filename-datetime', () => {
  it('liest Datum und Uhrzeit aus PA7-Dateinamen', () => {
    assert.equal(
      filenameDatetimeIso('FN10066_PA7_EN_20220928_0942.CSV'),
      '2022-09-28 09:42:00',
    );
    assert.equal(
      filenameDatetimeIso('FN10066_PA7_EN_ER_20170505_0855.csv'),
      '2017-05-05 08:55:00',
    );
  });

  it('verwirft ungültige Kalendertage', () => {
    assert.equal(filenameDatetimeIso('FN1_PA7_DE_20220231_1200.CSV'), null);
  });

  it('bevorzugt Dateiname vor Scan-uploaded_at', () => {
    const iso = resolveDisplayDatetime({
      filename: 'FN10066_PA7_EN_20220928_0942.CSV',
      fallbackDatetime: '2026-09-11 01:19:00',
    });
    assert.equal(iso, '2022-09-28 09:42:00');
  });

  it('dekoriert Listenzeilen und sortiert nach Dateinamen-Datum', () => {
    const files = [
      decorateParameterListItem({
        id: 1,
        original_filename: 'FN10066_PA7_EN_20220928_0942.CSV',
        uploaded_at: '2026-09-11 01:36:00',
      }),
      decorateParameterListItem({
        id: 2,
        original_filename: 'FN10066_PA7_EN_20260910_1110.CSV',
        uploaded_at: '2026-09-11 01:19:00',
      }),
    ];
    assert.equal(files[0].display_datetime, '2022-09-28 09:42:00');
    const sorted = sortParameterFilesByDisplayDesc(files);
    assert.equal(sorted[0].original_filename, 'FN10066_PA7_EN_20260910_1110.CSV');
    assert.equal(sorted[1].original_filename, 'FN10066_PA7_EN_20220928_0942.CSV');
  });

  it('führt Dispo- und lokale Parameterlisten per sha256 zusammen', () => {
    const { mergeParameterFileLists } = require('./anlagenstamm-filename-datetime');
    const merged = mergeParameterFileLists(
      [
        {
          id: 1,
          sha256: 'aaa',
          original_filename: 'FN09751_PA7_EN_20221006_1608.CSV',
          uploaded_at: '2022-10-06 16:08:00',
        },
      ],
      [
        {
          id: 1,
          sha256: 'AAA',
          original_filename: 'FN09751_PA7_EN_20221006_1608.CSV',
          uploaded_at: '2022-10-06 16:08:00',
        },
        {
          id: 2,
          sha256: 'bbb',
          original_filename: 'FN09751_PA7_EN_20260201_0433.CSV',
          uploaded_at: '2026-02-01 04:33:00',
        },
      ],
    );
    assert.equal(merged.length, 2);
    assert.equal(merged[0].original_filename, 'FN09751_PA7_EN_20260201_0433.CSV');
  });
});
