#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const list = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rounded = value => finite(value) ? Math.round(value * 100) / 100 : null;

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
    const highestAck = highestAckByMatch[String(item.match)];
    const ackStatus = !Number.isSafeInteger(item.sequence) || !Number.isSafeInteger(highestAck)
      ? 'unknown' : highestAck >= item.sequence ? 'covered' : 'pendingOrUnobserved';
    ackCoverage[ackStatus]++;
    if (!finite(after)) missingGeometry++;
    const key = [weapon, band, movement].join('|');
    if (!groups.has(key)) groups.set(key, { weapon, distance: band, movement,
      sent: 0, predicted: 0, corrected: 0, ackCovered: 0, adsBelowReady: 0,
      geometricSamples: 0, predictedMissBeforeSum: 0, predictedMissAfterSum: 0 });
    const group = groups.get(key);
    group.sent++;
    if (ackStatus === 'covered') group.ackCovered++;
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
    'serverSnapshots', 'serverEvents', 'settings', 'kicks', 'connectionStates', 'errors']
    .map(key => [key, list(trace[key]).length]));
  const gateCounts = trace.counters?.gateReasons || Object.fromEntries(
    [...new Set(list(trace.fireGates).map(gate => gate.reason))].map(reason => [reason,
      list(trace.fireGates).filter(gate => gate.reason === reason).length]));
  anomalies.sort((a, b) => (b.predictedMissMeters ?? 0) - (a.predictedMissMeters ?? 0) ||
    b.reasons.length - a.reasons.length);
  return {
    formatVersion: document.formatVersion, scriptVersion: document.scriptVersion || 'unknown',
    capturedAt: document.capturedAt || null, matchesObserved: trace.match || 0,
    latestSettings: list(trace.settings).at(-1)?.values || null,
    retention: { retained, dropped: trace.retention?.dropped || null },
    rageSamples: trace.counters?.rageSamples ?? null,
    gateReasons: gateCounts, targetRejects: trace.counters?.targetRejects || null,
    outgoingFire: { retained: sent.length, held: held.length, heldReasons,
      ackCoverage, missingWeapon, missingDistance,
      missingPrediction, missingGeometry, byWeaponRangeMovement },
    serverEvents: server, authoritative,
    investigate: anomalies.slice(0, 20),
    interpretation: [
      'Distances and geometric miss estimates describe local client predictions, not authoritative hits.',
      'An ACK covers an input sequence; it does not establish that the server fired or hit.',
      'Server events have no guaranteed input sequence, so server hits cannot be assigned to a weapon, target, or distance.',
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
    `Target rejection checks: ${JSON.stringify(report.targetRejects || {})}`,
    `Latest recorded settings: ${JSON.stringify(report.latestSettings || {})}`,
    `Input ACK coverage: ${JSON.stringify(report.outgoingFire.ackCoverage)}; ` +
      `median ACK latency ${report.authoritative.medianAckLatencyMs ?? '?'} ms; ` +
      `median RTT ${report.authoritative.medianReportedRttMs ?? '?'} ms`,
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
