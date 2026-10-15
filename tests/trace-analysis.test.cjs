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
      server: { ads: 0.8, magazine: 5 }, predictorBeforeReconcile: { ads: 1, magazine: 4 },
      acknowledgedFrame: { sequence: 11, sentYaw: 0, sentPitch: 0,
        serverYawDifferenceDegrees: 1.25, serverPitchDifferenceDegrees: -0.1 } }],
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
  assert.equal(report.authoritative.acknowledgedAim.yawOverHalfDegree, 1);
  assert.equal(report.authoritative.acknowledgedAim.pitchOverHalfDegree, 0);
  assert.match(formatReport(report), /Acknowledged aim angles/);
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

test('cover and acknowledged aim diagnostics stay separate from hit evidence', async () => {
  const { analyzeTrace, formatReport } = await analyzer;
  const report = analyzeTrace({ formatVersion: 2, trace: {
    fireGates: [{ match: 1, sequence: 5, reason: 'no-target',
      scan: { closestCover: { distanceMeters: 60, preferredPart: 'head',
        blocker: { distanceMeters: 12, material: 'concrete' } } } }],
    serverSnapshots: [
      { match: 1, acknowledgedFrame: { sequence: 5,
        serverYawDifferenceDegrees: 0.8, serverPitchDifferenceDegrees: -0.1 } },
      { match: 1, acknowledgedFrame: { sequence: 5,
        serverYawDifferenceDegrees: 0.8, serverPitchDifferenceDegrees: -0.1 } }
    ]
  } });
  assert.equal(report.coverEvidence.retainedGateRows, 1);
  assert.deepEqual(report.coverEvidence.byMaterial, { concrete: 1 });
  assert.equal(report.coverEvidence.latest.blockerDistanceMeters, 12);
  assert.equal(report.authoritative.acknowledgedAim.uniqueAcknowledgedFrames, 1);
  assert.equal(report.authoritative.acknowledgedAim.yawOverHalfDegree, 1);
  assert.equal(report.serverEvents.hits, 0);
  assert.match(formatReport(report), /Preferred-center cover blockers/);
});

test('aim report exposes explicit point overrides in old and new trace rows', async () => {
  const { analyzeTrace, formatReport } = await analyzer;
  const report = analyzeTrace({ formatVersion: 2, scriptVersion: '1.5.11', trace: {
    settings: [{ at: 1, values: { point: 'head' } }],
    aimDecisions: [
      { at: 10, fireSent: true, weaponId: 'longbow', target: { aimPart: 'chest' } },
      { at: 11, fireSent: true, weaponId: 'longbow', target: { aimPart: 'head' } },
      { at: 12, fireSent: true, weaponId: 'hornet', requestedPoint: 'chest',
        target: { aimPart: 'chest' } }
    ]
  } });
  assert.deepEqual(report.aimPointChoices.byRequested.head,
    { head: 1, chest: 1, none: 0 });
  assert.deepEqual(report.aimPointChoices.byRequested.chest,
    { head: 0, chest: 1, none: 0 });
  assert.deepEqual(report.aimPointChoices.byWeapon, [
    { weapon: 'hornet', requested: 'chest', head: 0, chest: 1, none: 0 },
    { weapon: 'longbow', requested: 'head', head: 1, chest: 1, none: 0 }
  ]);
  assert.match(formatReport(report), /Requested vs selected aim points/);
});

test('aim report counts partially visible head selections without treating them as hits', async () => {
  const { analyzeTrace, formatReport } = await analyzer;
  const report = analyzeTrace({ formatVersion: 2, scriptVersion: '1.5.15', trace: {
    aimDecisions: [
      { fireSent: true, target: { aimPart: 'head', visibility: 'partial' } },
      { fireSent: true, target: { aimPart: 'head', visibility: 'clear' } }
    ],
    serverEvents: [{ type: 'shot' }]
  } });
  assert.deepEqual(report.aimVisibility, { partial: 1, clear: 1 });
  assert.equal(report.serverEvents.hits, 0);
  assert.match(formatReport(report), /Selected point visibility.*"partial":1/);
});

test('multi-pellet report keeps local hit projections separate from server hits', async () => {
  const { analyzeTrace } = await analyzer;
  const report = analyzeTrace({ formatVersion: 2, scriptVersion: '1.5.13', trace: {
    aimDecisions: [
      { fireSent: true, localShotPredicted: true, weaponId: 'breacher',
        weapon: { stats: { pellets: 8 } },
        geometry: { projectedPelletHitsInput: 0, projectedPelletHitsOutgoing: 1 } },
      { fireSent: true, localShotPredicted: true, weaponId: 'breacher',
        weapon: { stats: { pellets: 8 } },
        geometry: { projectedPelletHitsInput: 2, projectedPelletHitsOutgoing: 3 } }
    ],
    serverEvents: [{ type: 'shot' }]
  } });
  assert.deepEqual(report.pelletProjection, {
    retainedMultiPelletShots: 2, measured: 2,
    noProjectedHitsBefore: 1, noProjectedHitsAfter: 0,
    projectedHitsBefore: 2, projectedHitsAfter: 4
  });
  assert.equal(report.serverEvents.hits, 0);
});

test('early ADS shots are counted without treating corrected ramp fire as a failure', async () => {
  const { analyzeTrace, formatReport } = await analyzer;
  const report = analyzeTrace({ formatVersion: 2, scriptVersion: '1.5.14', trace: {
    aimDecisions: [
      { match: 1, sequence: 1, fireSent: true, weaponId: 'vanguard', localAds: 0.3,
        sampled: { earlyAds: true }, localShotPredicted: true, correctionApplied: true,
        geometry: { predictedOutgoing: { meanMeters: 0.01 } } },
      { match: 1, sequence: 2, fireSent: true, weaponId: 'vanguard', localAds: 0.3,
        sampled: { earlyAds: true }, localShotPredicted: true, correctionApplied: false,
        geometry: { predictedOutgoing: { meanMeters: 2 } } }
    ]
  } });
  assert.equal(report.firingEvidence.earlyAdsSent, 2);
  assert.equal(report.firingEvidence.earlyAdsPredicted, 2);
  assert.equal(report.firingEvidence.earlyAdsCorrected, 1);
  assert.deepEqual(report.investigate.map(item => item.sequence), [2]);
  assert.match(formatReport(report), /Early ADS Fire.*sent 2/);
});

test('adaptive hip-fire evidence is separate from ADS ramp evidence', async () => {
  const { analyzeTrace, formatReport } = await analyzer;
  const report = analyzeTrace({ formatVersion: 2, scriptVersion: '1.5.16', trace: {
    aimDecisions: [
      { match: 1, sequence: 1, fireSent: true, weaponId: 'longbow',
        adsRequested: false, localAds: 0, sampled: { hipFire: true, hipSeeded: true },
        localShotPredicted: true, correctionApplied: true,
        geometry: { predictedOutgoing: { meanMeters: 0.01 } } },
      { match: 1, sequence: 2, fireSent: true, weaponId: 'hornet',
        adsRequested: false, localAds: 0.2, sampled: { hipFire: true, hipSeeded: false },
        localShotPredicted: false, correctionApplied: false,
        weapon: { cooldown: 0.05 } }
    ]
  } });
  assert.deepEqual(report.hipFireEvidence, { sent: 2, locallyPredicted: 1,
    corrected: 1, seeded: 1, byWeapon: { longbow: 1, hornet: 1 } });
  assert.equal(report.firingEvidence.earlyAdsSent, 0);
  assert.equal(report.investigate.some(item => item.reasons.includes('ADS below ready threshold')), false);
  assert.match(formatReport(report), /Adaptive hip Fire.*sent 2/);
});

test('tick-aligned server shots expose provisional hip and ADS hit counts', async () => {
  const { analyzeTrace, formatReport } = await analyzer;
  const localShots = Array.from({ length: 12 }, (_, index) => ({
    at: 1000 + index * 1000, match: 1, sequence: index + 1,
    tick: 100 + index * 30, player: { velocity: [0, 0, 0] },
    yaw: 0, pitch: 0, eye: [0, 0, 0], directions: [[0, 0, -1]],
    weapon: { id: 'rifle' }
  }));
  const serverEvents = localShots.flatMap((shot, index) => {
    const tick = shot.tick + 9;
    const yaw = 0.1 + (index === 11 ? 0.02 : 0);
    const events = [{ at: shot.at + 210, match: 1, tick, type: 'shot',
      shot: { weaponId: 'rifle', origin: [0, 0, 0],
        directions: [[-Math.sin(yaw), 0, -Math.cos(yaw)]],
        impacts: index === 0 ? [{ point: [0, 0, -5], material: 'concrete' }] : [] } }];
    if (index === 0 || index === 6) events.push({ at: shot.at + 210,
      match: 1, tick, type: 'hit', damage: 20 });
    return events;
  });
  serverEvents.push({ at: 1210, match: 1, tick: 109, type: 'shot',
    shot: { weaponId: 'other' } });
  const report = analyzeTrace({ formatVersion: 2, trace: {
    match: 1, localShots, serverEvents,
    frames: localShots.map(shot => ({ match: 1, sequence: shot.sequence,
      after: [0.1, 0, 0, 0] })),
    serverSnapshots: [{ acknowledgedShot: { delta: 0 } },
      { acknowledgedShot: { delta: 2 } }],
    aimDecisions: localShots.map((shot, index) => ({ match: 1,
      sequence: shot.sequence, fireSent: true, weaponId: 'rifle',
      adsRequested: index >= 6, sampled: { hipFire: index < 6 },
      targetDistance: index < 6 ? 20 : 80, localSpeed: 0,
      target: { point: [-Math.sin(0.1) * (index < 6 ? 20 : 80), 0,
        -Math.cos(0.1) * (index < 6 ? 20 : 80)] } }))
  } });
  assert.equal(report.correlatedShots.paired, 12);
  assert.equal(report.correlatedShots.pairedWithDecision, 12);
  assert.equal(report.correlatedShots.pairedHits, 2);
  assert.deepEqual(report.correlatedShots.byModeDistanceMovement, [
    { mode: 'ads', distance: '40-99 m', movement: 'still', shots: 6, hits: 1 },
    { mode: 'hip', distance: '0-39 m', movement: 'still', shots: 6, hits: 1 }
  ]);
  assert.deepEqual(report.authoritative.acknowledgedShotCount, { aligned: 1, diverged: 1 });
  assert.equal(report.correlatedShots.rayEvidence.serverShotEventsWithDirections, 12);
  assert.equal(report.correlatedShots.rayEvidence.comparedRays, 12);
  assert.equal(report.correlatedShots.rayEvidence.weaponAgreement.same, 12);
  assert.equal(report.correlatedShots.rayEvidence.differencesOverHalfDegree, 1);
  assert.equal(report.correlatedShots.rayEvidence.medianLocalToServerDegrees, 0);
  assert.ok(report.correlatedShots.rayEvidence.maxLocalToServerDegrees > 1);
  assert.equal(report.correlatedShots.rayEvidence.medianOriginOffsetMeters, 0);
  assert.equal(report.correlatedShots.rayEvidence.serverShotEventsWithImpacts, 1);
  assert.equal(report.correlatedShots.rayEvidence.impactsCloserThanSelectedPoint, 1);
  assert.match(formatReport(report), /Provisional server-shot pairs: 12 paired/);
  assert.match(formatReport(report), /Server-reported ray comparison/);
});

test('ammo requests and reserve gains stay separate, and cooldown frames are not flagged as aim failures', async () => {
  const { analyzeTrace, formatReport } = await analyzer;
  const report = analyzeTrace({ formatVersion: 2, scriptVersion: '1.5.10', trace: {
    match: 1,
    ammoPickups: [{ match: 1, ammoType: 'light', amount: 30, reserveBefore: 20 }],
    serverSnapshots: [
      { match: 1, server: { ammo: { light: 20 } } },
      { match: 1, server: { ammo: { light: 50 } } }
    ],
    aimDecisions: [
      { match: 1, sequence: 1, fireSent: true, localShotPredicted: false,
        weapon: { cooldown: 0.03 }, weaponId: 'vanguard' },
      { match: 1, sequence: 2, fireSent: true, localShotPredicted: false,
        weapon: { cooldown: 0 }, weaponId: 'vanguard' }
    ]
  } });
  assert.deepEqual(report.ammoAssist, { pickupRequests: 1, requestsByType: { light: 1 },
    serverReserveIncreases: { light: { transitions: 1, rounds: 30 } } });
  assert.equal(report.outgoingFire.missingPredictionWithCooldown, 1);
  assert.equal(report.outgoingFire.missingPredictionWithoutCooldown, 1);
  assert.deepEqual(report.investigate.map(item => item.sequence), [2]);
  assert.match(formatReport(report), /Ammo assist: 1 pickup requests/);
});

test('no-fire report distinguishes sampled gates, outbound frames, and server evidence', async () => {
  const { analyzeTrace, formatReport } = await analyzer;
  const report = analyzeTrace({ formatVersion: 2, scriptVersion: '1.5.8', trace: {
    match: 1,
    localShots: [{ match: 1, sequence: 10 }, { match: 3, sequence: 1 }],
    counters: { rageSamples: 100, gateReasons: { unplayable: 80, aligning: 20 },
      highestAckByMatch: { 1: 10 } },
    frames: [
      { match: 1, sequence: 9, sampledButtons: 64, buttons: 64 },
      { match: 1, sequence: 10, sampledButtons: 1 | 2, buttons: 2 },
      { match: 1, sequence: 11, sampledButtons: 0, buttons: 0 },
      { match: 2, sequence: 1, buttons: 0 }
    ],
    fireGates: [
      { at: 10, match: 1, reason: 'unplayable', originalButtons: 0,
        sampledButtons: 0, player: { mode: 'parachute' } },
      { at: 20, match: 1, reason: 'aligning', originalButtons: 1 | 64,
        sampledButtons: 2 | 64, player: { mode: 'ground' },
        weapon: { id: 'sidearm' }, target: { distance: 53.2 },
        aimState: { targetIndex: 42, ready: false, yawGapDegrees: 8,
          pitchGapDegrees: 3, withinOneTurn: false } },
      { at: 30, match: 1, reason: 'aligning', originalButtons: 1,
        sampledButtons: 2, player: { mode: 'ground' },
        weapon: { id: 'sidearm' }, target: { distance: 89.3 },
        aimState: { targetIndex: 43, ready: true, yawGapDegrees: 0.4,
          pitchGapDegrees: 0.5, withinOneTurn: true } }
    ],
    settings: [
      { at: 1, match: 0, reason: 'change', values: { rage: true, range: 600 } },
      { at: 2, match: 1, reason: 'match-start', values: { rage: true, range: 600 } },
      { at: 3, match: 1, reason: 'change', values: { rage: false, range: 450 } }
    ],
    serverEvents: [], serverSnapshots: []
  } });
  assert.deepEqual(report.gateReasons, { unplayable: 80, aligning: 20 });
  assert.equal(report.gateSamples.retained, 3);
  assert.deepEqual(report.gateSamples.retainedReasons, { unplayable: 1, aligning: 2 });
  assert.deepEqual(report.gateSamples.byPlayerMode,
    { parachute: { unplayable: 1 }, ground: { aligning: 2 } });
  assert.deepEqual(report.gateSamples.selectedTargets,
    { retained: 2, minDistanceMeters: 53.2, maxDistanceMeters: 89.3 });
  assert.deepEqual(report.firingEvidence, {
    originalFireGateRows: 2, preparedFireGateRows: 0, sampledFireFrames: 1,
    outgoingFireFrames: 0,
    sentDecisionRows: 0, earlyAdsSent: 0, earlyAdsPredicted: 0,
    earlyAdsCorrected: 0, serverShotEvents: 0
  });
  assert.equal(report.gateSamples.aimState.retained, 2);
  assert.equal(report.gateSamples.aimState.readyTrue, 1);
  assert.equal(report.gateSamples.aimState.withinOneTurnFalse, 1);
  assert.equal(report.gateSamples.aimState.medianYawGapDegrees, 0.4);
  assert.equal(report.gateSamples.aimState.maxYawGapDegrees, 8);
  assert.equal(report.gateSamples.latestByReason.aligning.aimState.targetIndex, 43);
  assert.equal(report.inputButtons.originalGateSamples.byButton.interact, 1);
  assert.equal(report.inputButtons.preparedGateSamples.byButton.interact, 1);
  assert.equal(report.inputButtons.sampledFrames.byButton.interact, 1);
  assert.equal(report.inputButtons.outgoingFrames.byButton.interact, 1);
  assert.equal(report.inputButtons.frameSendChanges.comparable, 3);
  assert.equal(report.inputButtons.frameSendChanges.removed.fire, 1);
  assert.deepEqual(report.predictionConsistency, {
    retainedLocalShots: 2, overlappingFrames: 1,
    predictedFireRemovedOnWire: 1, predictedFireOnWire: 0
  });
  assert.equal(report.inputButtons.frameSendChanges.removed.interact, 0);
  assert.equal(report.inputButtons.gateSampleChanges.removed.fire, 2);
  assert.equal(report.inputButtons.gateSampleChanges.removed.interact, 0);
  assert.deepEqual(report.inputButtons.outgoingFrameAckCoverage,
    { covered: 2, pendingOrUnobserved: 1, unknown: 1 });
  assert.equal(report.settingsHistory.retained, 3);
  assert.deepEqual(report.settingsHistory.transitions, [{
    at: 3, match: 1, reason: 'change', changed: {
      rage: { from: true, to: false }, range: { from: 600, to: 450 }
    }
  }]);
  const text = formatReport(report);
  assert.match(text, /Fire path evidence \(retained rows\): original game samples 2, prepared samples 0, pre-send frames 1, outgoing frames 0/);
  assert.match(text, /Interact button bit 64/);
  assert.match(text, /absent Interact bits do not prove F\/E was never pressed/);
});

test('interaction loss is only reported when visible between original and prepared samples', async () => {
  const { analyzeTrace } = await analyzer;
  const report = analyzeTrace({ formatVersion: 2, trace: {
    fireGates: [
      { originalButtons: 64, sampledButtons: 0, reason: 'no-target' },
      { originalButtons: 64, sampledButtons: 64, reason: 'no-target' },
      { originalButtons: null, sampledButtons: null, reason: 'no-target' }
    ],
    frames: [{ match: 1, sequence: 3, buttons: 64 }]
  } });
  assert.equal(report.inputButtons.gateSampleChanges.comparable, 2);
  assert.equal(report.inputButtons.gateSampleChanges.removed.interact, 1);
  assert.equal(report.inputButtons.originalGateSamples.missing, 1);
  assert.equal(report.inputButtons.sampledFrames.observed, 0);
  assert.equal(report.firingEvidence.sampledFireFrames, null);
  assert.equal(report.inputButtons.outgoingFrames.byButton.interact, 1);
  assert.deepEqual(report.inputButtons.outgoingFrameAckCoverage,
    { covered: 0, pendingOrUnobserved: 0, unknown: 1 });
  assert.equal(report.serverEvents.shots, 0);
  assert.equal(report.outgoingFire.retained, 0);
});

test('interaction key evidence separates pointer lock and input state from sent buttons', async () => {
  const { analyzeTrace } = await analyzer;
  const report = analyzeTrace({ formatVersion: 2, trace: {
    interactions: [
      { phase: 'keydown', key: 'KeyF', pointerLocked: false,
        inputEnabled: true, fromToolsPanel: true },
      { phase: 'pointerlockchange', pointerLocked: true },
      { phase: 'keydown', key: 'KeyE', pointerLocked: true,
        inputEnabled: false, fromToolsPanel: false },
      { phase: 'keyup', key: 'KeyE', pointerLocked: true }
    ],
    frames: [{ match: 1, sequence: 1, sampledButtons: 0, buttons: 0 }]
  } });
  assert.deepEqual(report.interactionEvidence, {
    retained: 4, keyDowns: 2, keyUps: 1,
    keyDownsWithoutPointerLock: 1, keyDownsWithInputDisabled: 1,
    keyDownsFromToolsPanel: 1, pointerLockChanges: 1
  });
  assert.equal(report.inputButtons.outgoingFrames.byButton.interact, 0);
});
