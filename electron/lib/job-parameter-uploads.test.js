'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  jobKey,
  sha256Buffer,
  writeCacheFile,
  upsertJobParameterUpload,
  listMergedJobUploads,
  restoreUploadsToJobFolder,
  deleteUploadRow,
  ensureJobParameterUploadsSchema,
} = require('./job-parameter-uploads');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-param-up-'));
}

function openMemoryDb() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    ensureJobParameterUploadsSchema(db);
    return db;
  } catch (_) {
    return createFakeUploadsDb();
  }
}

function createFakeUploadsDb() {
  const rows = [];
  let seq = 1;
  return {
    exec() {},
    close() {},
    prepare(sql) {
      const s = String(sql);
      return {
        run(...a) {
          if (s.includes('INSERT INTO job_parameter_uploads')) {
            const rec = {
              id: seq,
              job_key: a[0],
              local_job_id: a[1],
              server_job_id: a[2],
              job_number: a[3],
              fab: a[4],
              original_filename: a[5],
              sha256: a[6],
              cache_path: a[7],
              job_rel_path: a[8],
              size: a[9],
              uploaded_at: a[10],
              technician_id: a[11],
              dispo_file_id: a[12],
              mime: a[13],
            };
            const ex = rows.find(
              (r) => r.job_key === rec.job_key && r.fab === rec.fab && r.sha256 === rec.sha256,
            );
            if (ex) Object.assign(ex, rec, { id: ex.id });
            else {
              rec.id = seq++;
              rows.push(rec);
            }
          } else if (s.includes('UPDATE job_parameter_uploads SET job_rel_path')) {
            const row = rows.find((r) => r.id === a[2]);
            if (row) {
              row.job_rel_path = a[0];
              row.local_job_id = a[1];
            }
          } else if (s.includes('DELETE FROM job_parameter_uploads WHERE id')) {
            const i = rows.findIndex((r) => r.id === a[0]);
            if (i >= 0) rows.splice(i, 1);
          }
        },
        get(...a) {
          if (s.includes('SELECT id FROM job_parameter_uploads WHERE job_key')) {
            const r = rows.find((x) => x.job_key === a[0] && x.fab === a[1] && x.sha256 === a[2]);
            return r ? { id: r.id } : undefined;
          }
          if (s.includes('SELECT * FROM job_parameter_uploads WHERE id')) {
            return rows.find((x) => x.id === a[0]) || undefined;
          }
          return undefined;
        },
        all() {
          return rows.slice();
        },
      };
    },
  };
}

describe('job-parameter-uploads keys', () => {
  it('bildet stabile Job-Keys', () => {
    assert.equal(jobKey(940752, 12), 's:940752');
    assert.equal(jobKey(null, 12), 'l:12');
  });
});

describe('job-parameter-uploads cache', () => {
  let root;
  let db;

  beforeEach(() => {
    root = tmpRoot();
    db = openMemoryDb();
  });

  afterEach(() => {
    try {
      if (db) db.close();
    } catch (_) {}
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (_) {}
  });

  it('listet Cache als Backup wenn der Job-Ordner fehlt und stellt nach Restore wieder her', () => {
    const buf = Buffer.from('name;value;unit;comment\nA;1;;\n', 'utf8');
    const sha = sha256Buffer(buf);
    const cachePath = writeCacheFile(root, 's:9', sha, 'FN12186_PA.csv', buf);
    const ins = upsertJobParameterUpload(db, {
      local_job_id: 3,
      server_job_id: 9,
      job_number: '940752',
      fab: '12186',
      original_filename: 'FN12186_PA.csv',
      sha256: sha,
      cache_path: cachePath,
      job_rel_path: 'Dokumente_Monteur/12186/Montage/AO/Parameter/FN12186_PA.csv',
      size: buf.length,
      uploaded_at: '2026-09-11 10:00:00',
    });
    assert.equal(ins.ok, true);
    const listed = listMergedJobUploads(db, {
      local_job_id: 3,
      server_job_id: 9,
      job_number: '940752',
      paramDirs: [],
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].is_backup, true);
    assert.equal(listed[0].original_filename, 'FN12186_PA.csv');

    const destDir = path.join(root, 'job', 'Parameter');
    const restored = restoreUploadsToJobFolder(db, {
      local_job_id: 3,
      server_job_id: 9,
      resolveParamDir: () => destDir,
      relFor: () => 'Dokumente_Monteur/12186/Montage/AO/Parameter/FN12186_PA.csv',
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.restored.length, 1);
    assert.equal(fs.existsSync(path.join(destDir, 'FN12186_PA.csv')), true);

    const listed2 = listMergedJobUploads(db, {
      local_job_id: 3,
      server_job_id: 9,
      paramDirs: [{ dir: destDir, fab: '12186' }],
    });
    assert.equal(listed2[0].is_backup, false);
  });

  it('löscht Cache-Zeile und Datei', () => {
    const buf = Buffer.from('x', 'utf8');
    const sha = sha256Buffer(buf);
    const cachePath = writeCacheFile(root, 'l:1', sha, 'a.csv', buf);
    const ins = upsertJobParameterUpload(db, {
      local_job_id: 1,
      fab: '100',
      original_filename: 'a.csv',
      sha256: sha,
      cache_path: cachePath,
      size: 1,
    });
    const del = deleteUploadRow(db, ins.id);
    assert.equal(del.ok, true);
    assert.equal(fs.existsSync(cachePath), false);
    assert.equal(listMergedJobUploads(db, { local_job_id: 1 }).length, 0);
  });
});

describe('deleteParameterFileByFabSha', () => {
  it('lehnt projekte_neu ab ohne DB', () => {
    const { deleteParameterFileByFabSha } = require('./anlagenstamm-local');
    const db = {
      exec() {},
      prepare(sql) {
        const s = String(sql);
        return {
          all() {
            if (s.includes('PRAGMA table_info')) return [{ name: 'server_file_id' }];
            return [];
          },
          get() { return undefined; },
          run() { return { changes: 0 }; },
        };
      },
    };
    const r = deleteParameterFileByFabSha(db, '12186', 'abc', 'projekte_neu');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not_upload');
  });
});
