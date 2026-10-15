'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const analyzer = import(pathToFileURL(path.join(__dirname, '..', 'verification', 'analyze-trace.mjs')).href);

function localShot(index, changes = {}) {
  return { at: 1000 + index * 1000, match: 1, tick: 100 + index * 30,
    sequence: index + 1, yaw: 0, pitch: 0, eye: [0, 1.66, 0],
    directions: [[0, 0, -1]], weapon: { id: 'rifle' }, ...changes };
}

function serverShot(local, delay = 180, changes = {}) {
  return { at: local.at + delay, match: 1, tick: local.tick + 9, type: 'shot',
    shot: { weaponId: 'rifle', origin: [0, 1.66, 0],
      directions: [[0, 0, -1]], impacts: [] }, ...changes };
}

function traceReport(analyzeTrace, localShots, serverEvents, extra = {}) {
  return analyzeTrace({ formatVersion: 2, trace: {
    match: 1, localShots, serverEvents,
    frames: localShots.map(shot => ({ match: shot.match, sequence: shot.sequence,
      after: [0, 0, 0, 0] })), ...extra
  } });
}

test('ambiguous server and local candidates remain unmatched before ray or hit grouping', async () => {
  const { analyzeTrace } = await analyzer;
  const local = Array.from({ length: 12 }, (_, index) => localShot(index));
  const server = local.map(shot => serverShot(shot));
  const duplicate = traceReport(analyzeTrace, local, [
    ...server, { ...server[0], at: server[0].at + 1 },
    { type: 'hit', match: 1, tick: server[0].tick, damage: 20 }
  ]);
  assert.equal(duplicate.correlatedShots.paired, 11);
  assert.equal(duplicate.correlatedShots.pairing.unmatchedByReason.multipleCompatibleServerShots, 1);
  assert.equal(duplicate.correlatedShots.pairing.unpairedEligibleServerShots, 2);
  assert.equal(duplicate.correlatedShots.rayEvidence.comparedRays, 11);
  assert.equal(duplicate.correlatedShots.pairedHits, 0);
  assert.equal(duplicate.serverEvents.hits, 1);
  assert.deepEqual(duplicate.correlatedShots.pairing.ambiguousExamples, [
    { match: 1, sequence: 1, tick: 100,
      reason: 'multipleCompatibleServerShots', compatibleServerShots: 2 }
  ]);

  const shared = traceReport(analyzeTrace,
    [...local, { ...local[0], at: local[0].at + 1, sequence: 99 }], server);
  assert.equal(shared.correlatedShots.paired, 11);
  assert.equal(shared.correlatedShots.pairing.unmatchedByReason.sharedServerShot, 2);
  assert.deepEqual(shared.correlatedShots.pairing.ambiguousExamples.map(item => item.sequence),
    [1, 99]);
  assert.equal(shared.correlatedShots.rayEvidence.comparedRays, 11);
});

test('pairing reports timing boundaries, alternate offsets, and excluded delays', async () => {
  const { analyzeTrace, formatReport } = await analyzer;
  const local = Array.from({ length: 16 }, (_, index) => localShot(index));
  const server = local.slice(0, 10).map(shot => serverShot(shot));
  server.push(serverShot(local[10], 79), serverShot(local[11], 451),
    serverShot(local[12], 80), serverShot(local[13], 450),
    serverShot(local[14], 180, { tick: local[14].tick + 8 }));
  const report = traceReport(analyzeTrace, local, server,
    { serverSnapshots: [{ ackLatencyMs: 130 }] });
  const { pairing, byMatch } = report.correlatedShots;
  assert.equal(report.correlatedShots.paired, 12);
  assert.equal(byMatch[1].inferredTickOffset, 9);
  assert.equal(byMatch[1].offsetStatus, 'supported');
  assert.deepEqual(byMatch[1].offsetCandidates,
    [{ tickOffset: 9, votes: 12 }, { tickOffset: 8, votes: 1 }]);
  assert.equal(pairing.expectedDelayMs, 180);
  assert.deepEqual(pairing.pairedDelayMs,
    { samples: 12, minMs: 80, medianMs: 180, maxMs: 450 });
  assert.equal(pairing.unmatchedByReason.sameOffsetOutsideDelayWindow, 2);
  assert.equal(pairing.unmatchedByReason.differentTickOffset, 1);
  assert.equal(pairing.unmatchedByReason.noPlausibleCandidate, 1);
  assert.match(formatReport(report), /Shot-pair eligibility and timing/);
});

test('competing tick offsets prevent provisional shot and ray pairing', async () => {
  const { analyzeTrace } = await analyzer;
  const local = Array.from({ length: 20 }, (_, index) => localShot(index));
  const server = local.map((shot, index) => serverShot(shot, 180,
    { tick: shot.tick + (index < 10 ? 9 : 8) }));
  const report = traceReport(analyzeTrace, local, server);
  assert.equal(report.correlatedShots.byMatch[1].offsetStatus, 'competingOffsets');
  assert.deepEqual(report.correlatedShots.byMatch[1].offsetCandidates,
    [{ tickOffset: 8, votes: 10 }, { tickOffset: 9, votes: 10 }]);
  assert.equal(report.correlatedShots.pairing.unmatchedByReason.unsupportedTickOffset, 20);
  assert.equal(report.correlatedShots.paired, 0);
  assert.equal(report.correlatedShots.rayEvidence.comparedRays, 0);
});

test('missing metadata and incompatible pellet counts cannot manufacture ray comparisons', async () => {
  const { analyzeTrace, formatReport } = await analyzer;
  const local = Array.from({ length: 16 }, (_, index) => localShot(index));
  local[10].directions = undefined;
  local[12].yaw = null;
  local[14].directions = [[0, 0, 0]];
  local[15].directions = [[0, 0, -1], [0, 0, -1]];
  const server = local.map(shot => serverShot(shot));
  server[11].shot = { ...server[11].shot, directions: null };
  const report = traceReport(analyzeTrace,
    [...local, { at: 99999, match: 1, sequence: 200 }],
    [...server, { match: 1, tick: 999, type: 'shot' },
      { match: 1, type: 'hit', damage: 10 }],
    { frames: local.filter((_, index) => index !== 13).map(shot =>
      ({ match: 1, sequence: shot.sequence, after: [0, 0, 0, 0] })) });
  const { pairing, rayEvidence, hitEvidence } = report.correlatedShots;
  assert.equal(pairing.eligibleLocalShots, 16);
  assert.equal(pairing.ineligibleLocalShots, 1);
  assert.equal(pairing.eligibleServerShots, 16);
  assert.equal(pairing.ineligibleServerShots, 1);
  assert.equal(report.correlatedShots.paired, 15);
  assert.equal(pairing.unmatchedByReason.incompatible, 1);
  assert.equal(rayEvidence.incompatibleByReason.pelletCount, 1);
  assert.equal(rayEvidence.pelletCountDisagreements, 1);
  assert.equal(rayEvidence.missingLocalDirections, 1);
  assert.equal(rayEvidence.missingServerDirections, 1);
  assert.equal(rayEvidence.missingSampledAim, 1);
  assert.equal(rayEvidence.missingOutgoingAim, 1);
  assert.equal(rayEvidence.invalidRayVectors, 1);
  assert.equal(rayEvidence.comparedRays, 10);
  assert.equal(report.serverEvents.hits, 1);
  assert.equal(hitEvidence.hitEventsWithMatchAndTick, 0);
  assert.equal(report.correlatedShots.pairedHits, 0);
  assert.match(formatReport(report), /missingLocalDirections/);
});

test('a reported ray through a sampled box is not a server hit', async () => {
  const { analyzeTrace, formatReport } = await analyzer;
  const local = Array.from({ length: 10 }, (_, index) => localShot(index));
  const report = traceReport(analyzeTrace, local, local.map(shot => serverShot(shot)), {
    aimDecisions: [{ match: 1, sequence: 1, fireSent: true, weaponId: 'rifle',
      target: { position: [0, 0, -20], bodyHeight: 1.8, aimPart: 'head',
        point: [0, 1.66, -20], visibility: 'clear' } }]
  });
  assert.equal(report.correlatedShots.reportedHitboxByVisibility.clear.raysIntersecting, 1);
  assert.equal(report.correlatedShots.pairedHits, 0);
  assert.equal(report.serverEvents.hits, 0);
  assert.match(formatReport(report), /do not prove the target occupied that box on the server/);
});

test('predicted Fire counts recorded ACK mismatch skips and seed states only', async () => {
  const { analyzeTrace, formatReport } = await analyzer;
  const report = analyzeTrace({ formatVersion: 2, trace: {
    aimDecisions: [
      { fireSent: true, localShotPredicted: true,
        correctionSkipReason: 'ack-shot-count-mismatch', seedSyncStatus: 'reset' },
      { fireSent: true, localShotPredicted: true,
        correctionSkipReason: 'ack-shot-count-mismatch', seedSyncStatus: 'waiting' },
      { fireSent: true, localShotPredicted: true,
        correctionSkipReason: 'no-target', seedSyncStatus: 'steady' },
      { fireSent: true, localShotPredicted: true, correctionApplied: true },
      { fireSent: true, localShotPredicted: false,
        correctionSkipReason: 'ack-shot-count-mismatch', seedSyncStatus: 'excluded' },
      { fireSent: false, localShotPredicted: true,
        correctionSkipReason: 'ack-shot-count-mismatch', seedSyncStatus: 'excluded' }
    ],
    serverSnapshots: [{ acknowledgedShot: { delta: 1 } }]
  } });
  assert.deepEqual(report.predictedFireSync, {
    retainedPredictedFire: 4,
    correctionSkipReasonRecorded: 3,
    ackShotCountMismatchSkips: 2,
    byCorrectionSkipReason: { 'ack-shot-count-mismatch': 2, 'no-target': 1 },
    seedSyncStatusRecorded: 3,
    bySeedSyncStatus: { reset: 1, waiting: 1, steady: 1 },
    seedSyncStatusRecordedOnAckMismatch: 2,
    bySeedSyncStatusOnAckMismatch: { reset: 1, waiting: 1 }
  });
  assert.equal(report.authoritative.acknowledgedShotCount.diverged, 1);
  assert.equal(report.serverEvents.hits, 0);
  assert.match(formatReport(report), /Predicted Fire correction and seed sync/);
  assert.match(formatReport(report), /does not identify a server hit/);
});
