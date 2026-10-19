'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  replaceFileOffMainThread,
  statOffMainThread,
  existsOffMainThread,
  readdirOffMainThread,
  readFileOffMainThread,
  closeCloudIoLane,
} = require('./cloud-io-lane');

describe('cloud-io-lane', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukla-cloud-io-'));

  after(async () => {
    await closeCloudIoLane();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('schreibt, liest und prüft eine Datei außerhalb des Haupt-Aufrufers', async () => {
    const dest = path.join(dir, 'unter', 'datei.txt');
    const written = await replaceFileOffMainThread(dest, Buffer.from('inhalt-a'));
    assert.equal(written, dest);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'inhalt-a');
    const st = await statOffMainThread(dest);
    assert.equal(st.isFile, true);
    assert.equal(st.size, Buffer.byteLength('inhalt-a'));
    assert.equal(await existsOffMainThread(dest), true);
    assert.equal(await existsOffMainThread(path.join(dir, 'fehlt.txt')), false);
    const names = (await readdirOffMainThread(path.dirname(dest))).map((e) => e.name);
    assert.ok(names.includes('datei.txt'));
    const buf = await readFileOffMainThread(dest);
    assert.equal(Buffer.from(buf).toString('utf8'), 'inhalt-a');
    await replaceFileOffMainThread(dest, Buffer.from('inhalt-b'));
    assert.equal(fs.readFileSync(dest, 'utf8'), 'inhalt-b');
  });
});
