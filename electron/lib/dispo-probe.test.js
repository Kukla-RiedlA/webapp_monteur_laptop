'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTechnicianId,
  isDispoReachableHttpStatus,
  classifyDispoProbeStatus,
  dispoProbeUrls,
} = require('./dispo-probe');

describe('parseTechnicianId', () => {
  it('does not fall back to 1 when empty (first install)', () => {
    assert.equal(parseTechnicianId(null), null);
    assert.equal(parseTechnicianId(undefined), null);
    assert.equal(parseTechnicianId(''), null);
    assert.equal(parseTechnicianId(0), null);
    assert.equal(parseTechnicianId('Nach Dispo-Login'), null);
  });

  it('accepts a real technician id', () => {
    assert.equal(parseTechnicianId(15), 15);
    assert.equal(parseTechnicianId('15'), 15);
  });
});

describe('classifyDispoProbeStatus', () => {
  it('treats 403 without technician id as reachable (admin-id probe must not block login)', () => {
    assert.equal(classifyDispoProbeStatus(403, false), 'reachable');
    assert.equal(classifyDispoProbeStatus(400, false), 'reachable');
    assert.equal(classifyDispoProbeStatus(401, false), 'reachable');
  });

  it('keeps 403 with a stored technician id as fail', () => {
    assert.equal(classifyDispoProbeStatus(403, true), 'fail');
    assert.equal(classifyDispoProbeStatus(200, true), 'ok');
    assert.equal(classifyDispoProbeStatus(401, true), 'auth');
  });

  it('does not treat network-style statuses as reachable', () => {
    assert.equal(isDispoReachableHttpStatus(404), false);
    assert.equal(isDispoReachableHttpStatus(502), false);
    assert.equal(classifyDispoProbeStatus(404, false), 'fail');
  });
});

describe('dispoProbeUrls', () => {
  it('omits technician_id when unknown', () => {
    const u = dispoProbeUrls('https://10.0.0.180', null);
    assert.equal(u.myJobs, 'https://10.0.0.180/api/my_jobs.php');
    assert.equal(u.technicianId, null);
  });

  it('includes technician_id when known', () => {
    const u = dispoProbeUrls('https://10.0.0.180/', 15);
    assert.equal(u.myJobs, 'https://10.0.0.180/api/my_jobs.php?technician_id=15');
  });
});
