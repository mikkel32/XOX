#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const list = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rounded = value => finite(value) ? Math.round(value * 100) / 100 : null;
const BUTTONS = Object.freeze({ fire: 1, aim: 2, jump: 4, crouch: 8,
  sprint: 16, reload: 32, interact: 64, swap: 128, plate: 256, heal: 512 });
const buttonMask = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function countButtons(items, getButtons) {
  const byButton = Object.fromEntries(Object.keys(BUTTONS).map(name => [name, 0]));
  const masks = {};
  let observed = 0;
  for (const item of items) {
    const mask = buttonMask(getButtons(item));
    if (mask === null) continue;
    observed++;
    masks[mask] = (masks[mask] || 0) + 1;
    for (const [name, bit] of Object.entries(BUTTONS)) if (mask & bit) byButton[name]++;
  }
  return { rows: items.length, observed, missing: items.length - observed, byButton, masks };
}

function compareButtons(items, before, after) {
  const added = Object.fromEntries(Object.keys(BUTTONS).map(name => [name, 0]));
  const removed = { ...added };
  let comparable = 0;
  for (const item of items) {
    const from = buttonMask(before(item)), to = buttonMask(after(item));
    if (from === null || to === null) continue;
    comparable++;
    for (const [name, bit] of Object.entries(BUTTONS)) {
      if (!(from & bit) && (to & bit)) added[name]++;
      if ((from & bit) && !(to & bit)) removed[name]++;
    }
  }
  return { comparable, added, removed };
}

function ackStatus(item, highestAckByMatch) {
  const highest = highestAckByMatch[String(item?.match)];
  if (!Number.isSafeInteger(item?.sequence) || !Number.isSafeInteger(highest)) return 'unknown';
  return highest >= item.sequence ? 'covered' : 'pendingOrUnobserved';
}

function summarizeSettings(entries) {
  const transitions = [];
  for (let index = 1; index < entries.length; index++) {
    const previous = entries[index - 1]?.values;
    const current = entries[index]?.values;
    if (!previous || !current || typeof previous !== 'object' || typeof current !== 'object') continue;
    const changed = {};
    for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
      if (previous[key] !== current[key]) changed[key] = { from: previous[key] ?? null, to: current[key] ?? null };
    }
    if (Object.keys(changed).length) transitions.push({ at: entries[index].at ?? null,
      match: entries[index].match ?? null, reason: entries[index].reason ?? null, changed });
  }
  return { retained: entries.length, baseline: entries[0]?.values || null,
    latest: entries.at(-1)?.values || null, transitions };
}

function summarizeGateAim(gates) {
  const yawGaps = [], pitchGaps = [];
  const byReason = {};
  let retained = 0, readyTrue = 0, readyFalse = 0;
  let withinOneTurnTrue = 0, withinOneTurnFalse = 0;
  for (const gate of gates) {
    const aim = gate?.aimState;
    if (!aim || typeof aim !== 'object') continue;
    retained++;
    const reason = typeof gate.reason === 'string' ? gate.reason : 'unspecified';
    byReason[reason] ||= { rows: 0, readyTrue: 0, readyFalse: 0,
      withinOneTurnTrue: 0, withinOneTurnFalse: 0 };
    const row = byReason[reason];
    row.rows++;
    if (aim.ready === true) { readyTrue++; row.readyTrue++; }
    if (aim.ready === false) { readyFalse++; row.readyFalse++; }
    if (finite(aim.yawGapDegrees)) yawGaps.push(aim.yawGapDegrees);
    if (finite(aim.pitchGapDegrees)) pitchGaps.push(aim.pitchGapDegrees);
    // The source writes false for no-target rows; only count a turn test with measured gaps.
    if (finite(aim.yawGapDegrees) && finite(aim.pitchGapDegrees)) {
      if (aim.withinOneTurn === true) { withinOneTurnTrue++; row.withinOneTurnTrue++; }
      if (aim.withinOneTurn === false) { withinOneTurnFalse++; row.withinOneTurnFalse++; }
    }
  }
  const median = values => {
    values.sort((a, b) => a - b);
    return values.length ? rounded(values[Math.floor((values.length - 1) / 2)]) : null;
  };
  return { retained, readyTrue, readyFalse, withinOneTurnTrue, withinOneTurnFalse,
    yawGapSamples: yawGaps.length, medianYawGapDegrees: median(yawGaps),
    maxYawGapDegrees: yawGaps.length ? rounded(yawGaps.at(-1)) : null,
    pitchGapSamples: pitchGaps.length, medianPitchGapDegrees: median(pitchGaps),
    maxPitchGapDegrees: pitchGaps.length ? rounded(pitchGaps.at(-1)) : null,
    byReason };
}

function distanceBand(value) {
  if (!finite(value)) return 'unknown';
  if (value < 150) return '0-149 m';
  if (value < 300) return '150-299 m';
  if (value < 450) return '300-449 m';
  if (value <= 600) return '450-600 m';
  return 'over 600 m';
}

export function analyzeTrace(document) {
  if (!document || ![1, 2].includes(document.formatVersion) ||
      !document.trace || typeof document.trace !== 'object') {
    throw new Error('Expected a XOX trace export with formatVersion 1 or 2.');
  }
  const trace = document.trace;
  const decisions = list(trace.aimDecisions);
  const sent = decisions.filter(item => item?.fireSent === true);
  const held = decisions.filter(item => item?.fireSent === false);
  const heldReasons = {};
  for (const item of held) {
    const reason = typeof item.reason === 'string' ? item.reason : 'unspecified';
    heldReasons[reason] = (heldReasons[reason] || 0) + 1;
  }
  const events = list(trace.serverEvents);
  const snapshots = list(trace.serverSnapshots);
  const frames = list(trace.frames);
  const gates = list(trace.fireGates);
  const interactions = list(trace.interactions);
  const settingsHistory = summarizeSettings(list(trace.settings));
  const gateAimState = summarizeGateAim(gates);
  const highestAckByMatch = { ...(trace.counters?.highestAckByMatch || {}) };
  for (const snapshot of snapshots) {
    if (Number.isSafeInteger(snapshot?.ack) && Number.isSafeInteger(snapshot?.match)) {
      const key = String(snapshot.match);
      highestAckByMatch[key] = Math.max(highestAckByMatch[key] ?? -1, snapshot.ack);
    }
  }
  const groups = new Map();
  const anomalies = [];
  let missingWeapon = 0, missingDistance = 0, missingPrediction = 0, missingGeometry = 0;
  const ackCoverage = { covered: 0, pendingOrUnobserved: 0, unknown: 0 };

  for (const item of sent) {
    const weapon = typeof item.weaponId === 'string' ? item.weaponId : 'unknown';
    const distance = finite(item.target?.distance) ? item.target.distance : item.targetDistance;
    const band = distanceBand(distance);
    const movement = finite(item.localSpeed) ? (item.localSpeed > 0.5 ? 'moving' : 'still')
      : item.movingInput ? 'moving' : 'still';
    if (weapon === 'unknown') missingWeapon++;
    if (band === 'unknown') missingDistance++;
    if (!item.localShotPredicted) missingPrediction++;
    const before = item.geometry?.predictedInput?.meanMeters;
    const after = item.geometry?.predictedOutgoing?.meanMeters;
    const status = ackStatus(item, highestAckByMatch);
    ackCoverage[status]++;
    if (!finite(after)) missingGeometry++;
    const key = [weapon, band, movement].join('|');
    if (!groups.has(key)) groups.set(key, { weapon, distance: band, movement,
      sent: 0, predicted: 0, corrected: 0, ackCovered: 0, adsBelowReady: 0,
      geometricSamples: 0, predictedMissBeforeSum: 0, predictedMissAfterSum: 0 });
    const group = groups.get(key);
    group.sent++;
    if (status === 'covered') group.ackCovered++;
    if (item.localShotPredicted) group.predicted++;
    if (item.correctionApplied) group.corrected++;
    if (finite(item.localAds) && item.localAds < 0.995) group.adsBelowReady++;
    if (finite(before) && finite(after)) {
      group.geometricSamples++;
      group.predictedMissBeforeSum += before;
      group.predictedMissAfterSum += after;
    }
    const reasons = [];
    if (!item.localShotPredicted) reasons.push('no local prediction');
    if (finite(item.localAds) && item.localAds < 0.995) reasons.push('ADS below ready threshold');
    if (finite(after) && after > 0.3) reasons.push('predicted ray over 0.3 m from selected point');
    if (finite(item.sampled?.selectionDriftMeters) && item.sampled.selectionDriftMeters > 0.2) {
      reasons.push('target shifted over 0.2 m between sample and send');
    }
    if (reasons.length) anomalies.push({ match: item.match, sequence: item.sequence,
      weapon, distanceMeters: rounded(distance), movement, localAds: item.localAds ?? null,
      predictedMissMeters: rounded(after), reasons });
  }

  const byWeaponRangeMovement = [...groups.values()].map(group => ({
    weapon: group.weapon, distance: group.distance, movement: group.movement,
    sent: group.sent, predicted: group.predicted, corrected: group.corrected,
    ackCovered: group.ackCovered,
    adsBelowReady: group.adsBelowReady, geometricSamples: group.geometricSamples,
    meanPredictedMissBeforeMeters: group.geometricSamples
      ? rounded(group.predictedMissBeforeSum / group.geometricSamples) : null,
    meanPredictedMissAfterMeters: group.geometricSamples
      ? rounded(group.predictedMissAfterSum / group.geometricSamples) : null
  })).sort((a, b) => a.weapon.localeCompare(b.weapon) ||
    a.distance.localeCompare(b.distance) || a.movement.localeCompare(b.movement));

  const server = { shots: 0, hits: 0, kills: 0, damage: 0, headshots: 0 };
  for (const event of events) {
    if (event?.type === 'shot') server.shots++;
    if (event?.type === 'hit') {
      server.hits++;
      if (event.head) server.headshots++;
      if (finite(event.damage)) server.damage += event.damage;
    }
    if (event?.type === 'kill') server.kills++;
  }
  server.damage = rounded(server.damage);

  const median = values => {
    const sorted = values.filter(finite).sort((a, b) => a - b);
    return sorted.length ? rounded(sorted[Math.floor((sorted.length - 1) / 2)]) : null;
  };
  const authoritative = { observed: trace.counters?.serverSnapshotsSeen ?? null,
    retained: snapshots.length, highestAckByMatch,
    medianAckLatencyMs: median(snapshots.map(item => item.ackLatencyMs)),
    medianReportedRttMs: median(snapshots.map(item => item.reportedRttMs)),
    adsDisagreementSamples: snapshots.filter(item => finite(item.server?.ads) &&
      finite(item.predictorBeforeReconcile?.ads) &&
      Math.abs(item.server.ads - item.predictorBeforeReconcile.ads) > 0.05).length,
    magazineDisagreementSamples: snapshots.filter(item => finite(item.server?.magazine) &&
      finite(item.predictorBeforeReconcile?.magazine) &&
      item.server.magazine !== item.predictorBeforeReconcile.magazine).length };

  const retained = Object.fromEntries(['frames', 'localShots', 'aimDecisions', 'fireGates',
    'serverSnapshots', 'serverEvents', 'settings', 'interactions', 'kicks', 'connectionStates', 'errors']
    .map(key => [key, list(trace[key]).length]));
  const interactionEvidence = { retained: interactions.length, keyDowns: 0, keyUps: 0,
    keyDownsWithoutPointerLock: 0, keyDownsWithInputDisabled: 0,
    keyDownsFromToolsPanel: 0, pointerLockChanges: 0 };
  for (const entry of interactions) {
    if (entry?.phase === 'pointerlockchange') interactionEvidence.pointerLockChanges++;
    if (entry?.phase === 'keydown' && ['KeyF', 'KeyE'].includes(entry.key)) {
      interactionEvidence.keyDowns++;
      if (entry.pointerLocked === false) interactionEvidence.keyDownsWithoutPointerLock++;
      if (entry.inputEnabled === false) interactionEvidence.keyDownsWithInputDisabled++;
      if (entry.fromToolsPanel === true) interactionEvidence.keyDownsFromToolsPanel++;
    }
    if (entry?.phase === 'keyup' && ['KeyF', 'KeyE'].includes(entry.key))
      interactionEvidence.keyUps++;
  }
  const retainedGateReasons = {};
  const byPlayerMode = {};
  const selectedDistances = [];
  const latestGateByReason = {};
  for (const gate of gates) {
    const reason = typeof gate?.reason === 'string' ? gate.reason : 'unspecified';
    const mode = typeof gate?.player?.mode === 'string' ? gate.player.mode : 'unknown';
    retainedGateReasons[reason] = (retainedGateReasons[reason] || 0) + 1;
    byPlayerMode[mode] ||= {};
    byPlayerMode[mode][reason] = (byPlayerMode[mode][reason] || 0) + 1;
    if (finite(gate?.target?.distance)) selectedDistances.push(gate.target.distance);
    latestGateByReason[reason] = { at: gate?.at ?? null, match: gate?.match ?? null,
      sequence: gate?.sequence ?? null, playerMode: mode, weapon: gate?.weapon?.id ?? null,
      targetDistanceMeters: rounded(gate?.target?.distance), originalButtons: gate?.originalButtons ?? null,
      sampledButtons: gate?.sampledButtons ?? null,
      aimState: gate?.aimState && typeof gate.aimState === 'object' ? {
        targetIndex: gate.aimState.targetIndex ?? null,
        ready: gate.aimState.ready ?? null,
        yawGapDegrees: rounded(gate.aimState.yawGapDegrees),
        pitchGapDegrees: rounded(gate.aimState.pitchGapDegrees),
        withinOneTurn: gate.aimState.withinOneTurn ?? null
      } : null };
  }
  const gateCounts = trace.counters?.gateReasons || retainedGateReasons;
  const frameButtons = countButtons(frames, frame => frame?.buttons);
  const sampledFrameButtons = countButtons(frames, frame => frame?.sampledButtons);
  const frameSendChanges = compareButtons(frames, frame => frame?.sampledButtons,
    frame => frame?.buttons);
  const originalGateButtons = countButtons(gates, gate => gate?.originalButtons);
  const sampledGateButtons = countButtons(gates, gate => gate?.sampledButtons);
  const gateButtonChanges = compareButtons(gates, gate => gate?.originalButtons,
    gate => gate?.sampledButtons);
  const frameAckCoverage = { covered: 0, pendingOrUnobserved: 0, unknown: 0 };
  for (const frame of frames) frameAckCoverage[ackStatus(frame, highestAckByMatch)]++;
  const gateSamples = { retained: gates.length, retainedReasons: retainedGateReasons,
    byPlayerMode, latestByReason: latestGateByReason, aimState: gateAimState,
    selectedTargets: { retained: selectedDistances.length,
      minDistanceMeters: selectedDistances.length ? rounded(Math.min(...selectedDistances)) : null,
      maxDistanceMeters: selectedDistances.length ? rounded(Math.max(...selectedDistances)) : null } };
  const inputButtons = { outgoingFrames: frameButtons, sampledFrames: sampledFrameButtons,
    frameSendChanges, originalGateSamples: originalGateButtons,
    preparedGateSamples: sampledGateButtons, gateSampleChanges: gateButtonChanges,
    outgoingFrameAckCoverage: frameAckCoverage };
  const firingEvidence = { originalFireGateRows: originalGateButtons.byButton.fire,
    preparedFireGateRows: sampledGateButtons.byButton.fire,
    sampledFireFrames: sampledFrameButtons.observed ? sampledFrameButtons.byButton.fire : null,
    outgoingFireFrames: frameButtons.byButton.fire, sentDecisionRows: sent.length,
    serverShotEvents: server.shots };
  anomalies.sort((a, b) => (b.predictedMissMeters ?? 0) - (a.predictedMissMeters ?? 0) ||
    b.reasons.length - a.reasons.length);
  return {
    formatVersion: document.formatVersion, scriptVersion: document.scriptVersion || 'unknown',
    capturedAt: document.capturedAt || null, matchesObserved: trace.match || 0,
    latestSettings: settingsHistory.latest, settingsHistory,
    retention: { retained, dropped: trace.retention?.dropped || null },
    rageSamples: trace.counters?.rageSamples ?? null,
    gateReasons: gateCounts, gateSamples, targetRejects: trace.counters?.targetRejects || null,
    inputButtons, firingEvidence, interactionEvidence,
    outgoingFire: { retained: sent.length, held: held.length, heldReasons,
      ackCoverage, missingWeapon, missingDistance,
      missingPrediction, missingGeometry, byWeaponRangeMovement },
    serverEvents: server, authoritative,
    investigate: anomalies.slice(0, 20),
    interpretation: [
      'Distances and geometric miss estimates describe local client predictions, not authoritative hits.',
      'An ACK covers an input sequence; it does not establish that the server fired or hit.',
      'Server events have no guaranteed input sequence, so server hits cannot be assigned to a weapon, target, or distance.',
      'Fire-gate rows are coalesced samples; gate counters cover every Rage sample when present.',
      'Fire-gate original buttons are the game input before this hook; prepared gate buttons are after sample rewriting. Frame sampledButtons, when present, are before sendInput rewriting; frame buttons are on the wire.',
      'This trace has no raw keyboard events, so absent Interact bits do not prove F/E was never pressed.',
      'Button names use the captured client bit map: Fire 1, Aim 2, Interact 64 (F/E).',
      'Predictor state is sampled before server reconciliation and can temporarily differ because of network delay.',
      'Retained buffers may cover different time windows; inspect dropped counts before comparing totals.'
    ]
  };
}

export function formatReport(report) {
  const lines = [
    `XOX trace v${report.formatVersion} / script ${report.scriptVersion}`,
    `Matches observed: ${report.matchesObserved}; retained Fire: ${report.outgoingFire.retained}; ` +
      `server shots: ${report.serverEvents.shots}; hits: ${report.serverEvents.hits}; kills: ${report.serverEvents.kills}`,
    `Outgoing Fire held: ${report.outgoingFire.held}; reasons: ${JSON.stringify(report.outgoingFire.heldReasons)}`,
    `Rage samples: ${report.rageSamples ?? 'unavailable'}; gate reasons: ${JSON.stringify(report.gateReasons)}`,
    `Retained fire-gate rows: ${report.gateSamples.retained} (coalesced); reasons: ${JSON.stringify(report.gateSamples.retainedReasons)}`,
    `Retained gate rows by player mode: ${JSON.stringify(report.gateSamples.byPlayerMode)}`,
    `Retained selected targets: ${report.gateSamples.selectedTargets.retained}; distance ` +
      `${report.gateSamples.selectedTargets.minDistanceMeters ?? '?'} to ` +
      `${report.gateSamples.selectedTargets.maxDistanceMeters ?? '?'} m`,
    `Recorded gate aim state: ${JSON.stringify(report.gateSamples.aimState)}`,
    `Latest gate row per reason: ${JSON.stringify(report.gateSamples.latestByReason)}`,
    `Target rejection checks: ${JSON.stringify(report.targetRejects || {})}`,
    `Latest recorded settings: ${JSON.stringify(report.latestSettings || {})}`,
    `Recorded setting changes (${report.settingsHistory.retained} rows): ${JSON.stringify(report.settingsHistory.transitions)}`,
    `Fire path evidence (retained rows): original game samples ${report.firingEvidence.originalFireGateRows}, ` +
      `prepared samples ${report.firingEvidence.preparedFireGateRows}, pre-send frames ` +
      `${report.firingEvidence.sampledFireFrames ?? 'unavailable'}, outgoing frames ` +
      `${report.firingEvidence.outgoingFireFrames}, sent decisions ${report.firingEvidence.sentDecisionRows}, ` +
      `server shot events ${report.firingEvidence.serverShotEvents}`,
    `Interact button bit 64 (retained rows): original game samples ` +
      `${report.inputButtons.originalGateSamples.byButton.interact}, prepared samples ` +
      `${report.inputButtons.preparedGateSamples.byButton.interact}, pre-send frames ` +
      `${report.inputButtons.sampledFrames.observed ? report.inputButtons.sampledFrames.byButton.interact : 'unavailable'}, outgoing frames ` +
      `${report.inputButtons.outgoingFrames.byButton.interact}`,
    `F/E and pointer-lock evidence: ${JSON.stringify(report.interactionEvidence)}`,
    `Game sample -> prepared button changes in ${report.inputButtons.gateSampleChanges.comparable} retained gate rows: ` +
      `added ${JSON.stringify(report.inputButtons.gateSampleChanges.added)}, ` +
      `removed ${JSON.stringify(report.inputButtons.gateSampleChanges.removed)}`,
    `Pre-send -> wire button changes in ${report.inputButtons.frameSendChanges.comparable} retained frames: ` +
      `added ${JSON.stringify(report.inputButtons.frameSendChanges.added)}, ` +
      `removed ${JSON.stringify(report.inputButtons.frameSendChanges.removed)}`,
    `Pre-send frame buttons observed ${report.inputButtons.sampledFrames.observed}, ` +
      `missing ${report.inputButtons.sampledFrames.missing}`,
    `Outgoing frame button masks: ${JSON.stringify(report.inputButtons.outgoingFrames.masks)}`,
    `Input ACK coverage: ${JSON.stringify(report.outgoingFire.ackCoverage)}; ` +
      `median ACK latency ${report.authoritative.medianAckLatencyMs ?? '?'} ms; ` +
      `median RTT ${report.authoritative.medianReportedRttMs ?? '?'} ms`,
    `All retained outgoing frames ACK coverage: ${JSON.stringify(report.inputButtons.outgoingFrameAckCoverage)}`,
    `Before-reconcile disagreements: ADS ${report.authoritative.adsDisagreementSamples}, ` +
      `magazine ${report.authoritative.magazineDisagreementSamples}`,
    `Server snapshots observed ${report.authoritative.observed ?? 'unknown'}, retained ${report.authoritative.retained}`,
    `Retained: ${JSON.stringify(report.retention.retained)}`,
    `Dropped: ${JSON.stringify(report.retention.dropped || {})}`,
    `Missing among sent Fire: weapon ${report.outgoingFire.missingWeapon}, distance ${report.outgoingFire.missingDistance}, ` +
      `local prediction ${report.outgoingFire.missingPrediction}, geometry ${report.outgoingFire.missingGeometry}`,
    '', 'Outgoing Fire by weapon / selected distance / movement (local estimates):'
  ];
  for (const group of report.outgoingFire.byWeaponRangeMovement) {
    lines.push(`  ${group.weapon.padEnd(18)} ${group.distance.padEnd(12)} ${group.movement.padEnd(6)} ` +
      `sent ${group.sent}, ACK-covered ${group.ackCovered}, predicted ${group.predicted}, ` +
      `corrected ${group.corrected}, ` +
      `mean miss ${group.meanPredictedMissBeforeMeters ?? '?'} -> ${group.meanPredictedMissAfterMeters ?? '?'} m`);
  }
  if (!report.outgoingFire.byWeaponRangeMovement.length) lines.push('  No retained per-shot decisions.');
  if (report.investigate.length) {
    lines.push('', 'Investigate these outgoing Fire frames:');
    for (const item of report.investigate) lines.push(
      `  match ${item.match ?? '?'} seq ${item.sequence ?? '?'} ${item.weapon} ` +
      `${item.distanceMeters ?? '?'} m ${item.movement}: ${item.reasons.join(', ')}`);
  }
  lines.push('', ...report.interpretation);
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const files = args.filter(arg => arg !== '--json');
  if (files.length !== 1) {
    console.error('Usage: node verification/analyze-trace.mjs <trace.json> [--json]');
    process.exitCode = 2;
  } else {
    try {
      const report = analyzeTrace(JSON.parse(await readFile(resolve(files[0]), 'utf8')));
      console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
    } catch (error) {
      console.error('Trace analysis failed:', error.message);
      process.exitCode = 1;
    }
  }
}
