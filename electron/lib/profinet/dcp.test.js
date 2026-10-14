'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dcp = require('./dcp');

const SRC = '02:00:00:00:00:01';
const DST = '08:00:06:01:02:03';

test('Identify-All geht an die DCP-Multicast-Adresse', () => {
  const frame = dcp.buildIdentifyAll(SRC, 0x11);
  assert.equal(dcp.formatMac(frame, 0), dcp.MULTICAST_MAC);
  assert.equal(dcp.formatMac(frame, 6), SRC);
  assert.equal(frame.readUInt16BE(12), dcp.ETHERTYPE);
  assert.equal(frame.readUInt16BE(14), dcp.FRAME_IDENTIFY_REQ);
  assert.equal(frame[16], 5);
  assert.equal(frame[17], 0);
  assert.equal(frame.readUInt32BE(18), 0x11);
});

test('Identify-Antwort liefert Name, IP und Hersteller', () => {
  const name = Buffer.from('waage1', 'utf8');
  const vendor = Buffer.from('Siemens', 'utf8');
  const ipBlock = Buffer.alloc(14);
  ipBlock.writeUInt16BE(1, 0);
  ipBlock[2] = 10;
  ipBlock[3] = 0;
  ipBlock[4] = 0;
  ipBlock[5] = 5;
  ipBlock[6] = 255;
  ipBlock[7] = 255;
  ipBlock[8] = 255;
  ipBlock[9] = 0;
  ipBlock[10] = 10;
  ipBlock[11] = 0;
  ipBlock[12] = 0;
  ipBlock[13] = 1;
  const blocks = Buffer.concat([
    block(2, 2, name),
    block(1, 2, ipBlock),
    block(2, 1, vendor),
  ]);
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0xfeff, 0);
  head[2] = 5;
  head[3] = 1;
  head.writeUInt32BE(7, 4);
  head.writeUInt16BE(blocks.length, 10);
  const eth = Buffer.alloc(14);
  dcp.parseMac('ff:ff:ff:ff:ff:ff').copy(eth, 0);
  dcp.parseMac(DST).copy(eth, 6);
  eth.writeUInt16BE(dcp.ETHERTYPE, 12);
  const parsed = dcp.parseIdentifyResponse(Buffer.concat([eth, head, blocks]));
  assert.equal(parsed.mac, DST);
  assert.equal(parsed.xid, 7);
  assert.equal(parsed.station_name, 'waage1');
  assert.equal(parsed.ip_address, '10.0.0.5');
  assert.equal(parsed.subnet_mask, '255.255.255.0');
  assert.equal(parsed.gateway, '10.0.0.1');
  assert.equal(parsed.vendor, 'Siemens');
  assert.equal(dcp.isUnbaptized(parsed), false);
  assert.equal(dcp.isUnbaptized({ station_name: '', ip_address: '0.0.0.0' }), true);
});

test('Set-Frame schreibt den Namen unicast und nicht an die Multicast-Adresse', () => {
  const frame = dcp.buildSetName(SRC, DST, 'neue-waage', 9);
  assert.equal(dcp.formatMac(frame, 0), DST);
  assert.notEqual(dcp.formatMac(frame, 0), dcp.MULTICAST_MAC);
  assert.equal(frame.readUInt16BE(14), dcp.FRAME_GETSET_REQ);
  assert.equal(frame[16], 4);
  assert.ok(frame.includes(Buffer.from('neue-waage')));
});

test('PDPortDataReal-Fixture ergibt zwei Knoten und eine Kante', () => {
  const fixture = dcp.buildPdPortFixture([
    { mac: '00:1b:1b:aa:bb:cc', port: 'port-001', name: 'switch1' },
  ]);
  const topo = dcp.parsePdPortDataReal(fixture, SRC, 'port-002');
  assert.equal(topo.nodes.length, 2);
  assert.equal(topo.links.length, 1);
  assert.equal(topo.links[0].local_mac, SRC);
  assert.equal(topo.links[0].local_port, 'port-002');
  assert.equal(topo.links[0].peer_mac, '00:1b:1b:aa:bb:cc');
  assert.equal(topo.links[0].peer_port, 'port-001');
  assert.equal(topo.links[0].peer_name, 'switch1');
  assert.equal(topo.nodes[1].name, 'switch1');
});

function block(option, sub, data) {
  const header = Buffer.alloc(4);
  header[0] = option;
  header[1] = sub;
  header.writeUInt16BE(data.length, 2);
  const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([header, data, pad]);
}
