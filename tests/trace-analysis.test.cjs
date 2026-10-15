'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const analyzer = import(pathToFileURL(path.join(__dirname, '..', 'verification', 'analyze-trace.mjs')).href);

test('trace analysis groups sent inputs while keeping server hits unattributed', async () => {
  const { analyzeTrace, formatReport } = await analyzer;
  const report = analyzeTrace({ formatVersion: 2, scriptVersion: '1.5.8', trace: {
    match: 1,
    frames: [], localShots: [], fireGates: [], kicks: [], connectionStates: [], errors: [],
    serverSnapshots: [{ match: 1, ack: 11, ackLatencyMs: 80, reportedRttMs: 90,
      server: { ads: 0.8, magazine: 5 }, predictorBeforeReconcile: { ads: 1, magazine: 4 } }],
    retention: { dropped: { frames: 10, aimDecisions: 0 } },
    counters: { rageSamples: 40, gateReasons: { 'ads-ramp': 5, 'fire-sampled': 20 },
      targetRejects: { range: 12 }, highestAckByMatch: { 1: 11 } },
    aimDecisions: [
      { match: 1, sequence: 10, fireSent: true, weaponId: 'sniper', targetDistance: 550,
        movingInput: true, localAds: 1, localShotPredicted: true, correctionApplied: true,
        geometry: { predictedInput: { meanMeters: 14 }, predictedOutgoing: { meanMeters: 0.12 } } },
      { match: 1, sequence: 11, fireSent: true, weaponId: 'sniper', targetDistance: 555,
        movingInput: false, localSpeed: 3, localAds: 1, localShotPredicted: true, correctionApplied: false,
        geometry: { predictedInput: { meanMeters: 2 }, predictedOutgoing: { meanMeters: 1 } } },
      { match: 1, sequence: 12, fireSent: false, weaponId: 'smg', targetDistance: 120,
        movingInput: false, localShotPredicted: false, reason: 'aligning' }
    ],
    serverEvents: [{ type: 'shot' }, { type: 'shot' }, { type: 'hit', damage: 21 }, { type: 'kill' }]
  } });
  assert.equal(report.outgoingFire.retained, 2);
  assert.deepEqual(report.outgoingFire.heldReasons, { aligning: 1 });
  assert.deepEqual(report.outgoingFire.byWeaponRangeMovement, [{
    weapon: 'sniper', distance: '450-600 m', movement: 'moving', sent: 2,
    predicted: 2, corrected: 1, ackCovered: 2, adsBelowReady: 0, geometricSamples: 2,
    meanPredictedMissBeforeMeters: 8, meanPredictedMissAfterMeters: 0.56
  }]);
  assert.deepEqual(report.serverEvents, { shots: 2, hits: 1, kills: 1, damage: 21, headshots: 0 });
  assert.equal(report.retention.dropped.frames, 10);
  assert.deepEqual(report.outgoingFire.ackCoverage,
    { covered: 2, pendingOrUnobserved: 0, unknown: 0 });
  assert.equal(report.authoritative.medianAckLatencyMs, 80);
  assert.equal(report.authoritative.adsDisagreementSamples, 1);
  assert.equal(report.authoritative.magazineDisagreementSamples, 1);
  assert.equal(report.investigate[0].sequence, 11);
  assert.match(formatReport(report), /cannot be assigned to a weapon/);
});

test('older trace format remains readable without inventing weapon or range detail', async () => {
  const { analyzeTrace } = await analyzer;
  const report = analyzeTrace({ formatVersion: 1, scriptVersion: '1.5.6', trace: {
    match: 1, frames: [], localShots: [], serverEvents: [{ type: 'shot' }, { type: 'hit' }]
  } });
  assert.equal(report.outgoingFire.retained, 0);
  assert.equal(report.serverEvents.hits, 1);
  assert.equal(report.retention.dropped, null);
  assert.throws(() => analyzeTrace({ formatVersion: 7, trace: {} }), /formatVersion 1 or 2/);
});
