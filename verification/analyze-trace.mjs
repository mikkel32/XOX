#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const list = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rounded = value => finite(value) ? Math.round(value * 100) / 100 : null;
const VISIBILITY = new Set(['clear', 'partial', 'front-partial', 'fallback',
  'fallback-partial', 'fallback-front-partial', 'unchecked']);
const visibilityStatus = value => VISIBILITY.has(value) ? value : 'unknown';
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

function summarizeAimPointChoices(sent, settings) {
  const points = ['head', 'chest', 'auto'];
  const byRequested = Object.fromEntries([...points, 'unknown'].map(point =>
    [point, { head: 0, chest: 0, none: 0 }]));
  const byWeapon = new Map();
  for (const item of sent) {
    let requested = points.includes(item?.requestedPoint) ? item.requestedPoint : null;
    if (!requested && finite(item?.at)) {
      for (let index = settings.length - 1; index >= 0; index--) {
        const setting = settings[index];
        if (finite(setting?.at) && setting.at <= item.at &&
            points.includes(setting?.values?.point)) {
          requested = setting.values.point;
          break;
        }
      }
    }
    requested ||= 'unknown';
    const selected = ['head', 'chest'].includes(item?.target?.aimPart)
      ? item.target.aimPart : 'none';
    const weapon = typeof item?.weaponId === 'string' ? item.weaponId : 'unknown';
    byRequested[requested][selected]++;
    const key = `${weapon}:${requested}`;
    if (!byWeapon.has(key)) byWeapon.set(key,
      { weapon, requested, head: 0, chest: 0, none: 0 });
    byWeapon.get(key)[selected]++;
  }
  return { byRequested,
    byWeapon: [...byWeapon.values()].sort((a, b) =>
      a.weapon.localeCompare(b.weapon) || a.requested.localeCompare(b.requested)) };
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

function summarizeAcknowledgedAim(snapshots) {
  const byFrame = new Map();
  for (const snapshot of snapshots) {
    const frame = snapshot?.acknowledgedFrame;
    if (!Number.isSafeInteger(snapshot?.match) || !Number.isSafeInteger(frame?.sequence)) continue;
    byFrame.set(`${snapshot.match}:${frame.sequence}`, frame);
  }
  const yaw = [], pitch = [];
  for (const frame of byFrame.values()) {
    if (finite(frame.serverYawDifferenceDegrees)) yaw.push(Math.abs(frame.serverYawDifferenceDegrees));
    if (finite(frame.serverPitchDifferenceDegrees)) pitch.push(Math.abs(frame.serverPitchDifferenceDegrees));
  }
  const median = values => {
    values.sort((a, b) => a - b);
    return values.length ? rounded(values[Math.floor((values.length - 1) / 2)]) : null;
  };
  return { uniqueAcknowledgedFrames: byFrame.size,
    yawSamples: yaw.length, pitchSamples: pitch.length,
    yawOverHalfDegree: yaw.filter(value => value > 0.5).length,
    pitchOverHalfDegree: pitch.filter(value => value > 0.5).length,
    medianAbsoluteYawDegrees: median(yaw), medianAbsolutePitchDegrees: median(pitch),
    maxAbsoluteYawDegrees: yaw.length ? rounded(yaw.at(-1)) : null,
    maxAbsolutePitchDegrees: pitch.length ? rounded(pitch.at(-1)) : null };
}

function distanceBand(value) {
  if (!finite(value)) return 'unknown';
  if (value < 150) return '0-149 m';
  if (value < 300) return '150-299 m';
  if (value < 450) return '300-449 m';
  if (value <= 600) return '450-600 m';
  return 'over 600 m';
}

const validVector = value => Array.isArray(value) && value.length === 3 && value.every(finite);
function unitVector(value) {
  if (!validVector(value)) return null;
  const length = Math.hypot(...value);
  return finite(length) && length > 1e-9
    ? value.map(component => component / length) : null;
}

function directionBasis(yaw, pitch) {
  if (!finite(yaw) || !finite(pitch)) return null;
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  return { forward: [-sy * cp, sp, -cy * cp], right: [cy, 0, -sy],
    up: [sy * sp, cp, cy * sp] };
}

const dot3 = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
function angleDegrees(a, b) {
  const first = unitVector(a), second = unitVector(b);
  return first && second
    ? Math.acos(Math.max(-1, Math.min(1, dot3(first, second)))) * 180 / Math.PI : null;
}

function rotatedShotRay(direction, source, destination) {
  const ray = unitVector(direction);
  if (!ray || !source || !destination) return null;
  const forward = dot3(ray, source.forward), right = dot3(ray, source.right);
  const up = dot3(ray, source.up);
  return [0, 1, 2].map(index => forward * destination.forward[index] +
    right * destination.right[index] + up * destination.up[index]);
}

function sampledHitboxRayEntry(origin, ray, target) {
  if (!validVector(origin) || !validVector(ray) || !validVector(target?.position) ||
      !finite(target.bodyHeight) || target.bodyHeight < 0.5 || target.bodyHeight > 2.5 ||
      !['head', 'chest'].includes(target.aimPart)) return null;
  const [x, y, z] = target.position, h = target.bodyHeight;
  const halfWidth = target.aimPart === 'head' ? 0.14 : 0.25;
  const min = [x - halfWidth, y + (target.aimPart === 'head' ? h - 0.28 : h / 2), z - halfWidth];
  const max = [x + halfWidth, y + h - (target.aimPart === 'head' ? 0 : 0.28), z + halfWidth];
  let near = 0, far = 600;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(ray[axis]) < 1e-9) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null;
      continue;
    }
    const first = (min[axis] - origin[axis]) / ray[axis];
    const last = (max[axis] - origin[axis]) / ray[axis];
    near = Math.max(near, Math.min(first, last));
    far = Math.min(far, Math.max(first, last));
    if (near > far) return null;
  }
  return far >= 0 ? near : null;
}

const PAIR_DELAY_MIN_MS = 80;
const PAIR_DELAY_MAX_MS = 450;
const PAIR_TICK_OFFSET_MAX = 20;

function shotPairMismatch(shot, event) {
  if (event.shot?.weaponId && shot.weapon?.id &&
      event.shot.weaponId !== shot.weapon.id) return 'weapon';
  if (Array.isArray(event.shot?.directions) && Array.isArray(shot.directions) &&
      event.shot.directions.length !== shot.directions.length) return 'pelletCount';
  return null;
}

function candidateMaxRayDifference(shot, event, frame) {
  const predicted = shot.directions, reported = event.shot?.directions;
  if (!Array.isArray(predicted) || !Array.isArray(reported) ||
      !predicted.length || predicted.length !== reported.length || reported.length > 32 ||
      shotPairMismatch(shot, event)) return null;
  const source = directionBasis(shot.yaw, shot.pitch);
  const destination = directionBasis(frame?.after?.[0], frame?.after?.[1]);
  if (!source || !destination) return null;
  let maximum = 0;
  for (let index = 0; index < reported.length; index++) {
    const rotated = rotatedShotRay(predicted[index], source, destination);
    const difference = angleDegrees(reported[index], rotated);
    if (!finite(difference)) return null;
    maximum = Math.max(maximum, difference);
  }
  return maximum;
}

function correlateServerShots(localShots, events, decisions, frames, ackLatencyMs) {
  const serverShotRows = events.filter(event => event?.type === 'shot');
  const serverShots = serverShotRows.filter(event =>
    Number.isSafeInteger(event.match) && Number.isSafeInteger(event.tick) && finite(event.at));
  const local = localShots.filter(shot => Number.isSafeInteger(shot?.match) &&
    Number.isSafeInteger(shot?.tick) && Number.isSafeInteger(shot?.sequence) && finite(shot?.at));
  const sent = new Map(decisions.filter(item => item?.fireSent === true &&
    Number.isSafeInteger(item?.match) && Number.isSafeInteger(item?.sequence))
    .map(item => [`${item.match}:${item.sequence}`, item]));
  const hitRows = events.filter(event => event?.type === 'hit');
  const hitTicks = new Set(hitRows.filter(event =>
    Number.isSafeInteger(event.match) && Number.isSafeInteger(event.tick))
    .map(event => `${event.match}:${event.tick}`));
  const shotsAtTick = new Map();
  for (const event of serverShotRows) {
    if (!Number.isSafeInteger(event.match) || !Number.isSafeInteger(event.tick)) continue;
    const key = `${event.match}:${event.tick}`;
    shotsAtTick.set(key, (shotsAtTick.get(key) || 0) + 1);
  }
  const byMatch = {};
  const byModeDistanceMovement = {};
  const byVisibility = {};
  const reportedHitboxByVisibility = {};
  const outgoing = new Map(frames.filter(frame => Number.isSafeInteger(frame?.match) &&
    Number.isSafeInteger(frame?.sequence) && Array.isArray(frame?.after))
    .map(frame => [`${frame.match}:${frame.sequence}`, frame]));
  const rayDifferences = [], reportedSpread = [], targetMiss = [], originOffsets = [];
  const rayExamples = [];
  const comparableRayGroups = new Map();
  const rayEvidence = { serverShotEventsWithDirections: serverShots.filter(event =>
    Array.isArray(event.shot?.directions) && event.shot.directions.length > 0).length,
    serverShotEventsWithImpacts: serverShots.filter(event => list(event.shot?.impacts).length).length,
    pairedShotsWithDirections: 0, comparedRays: 0, pelletCountDisagreements: 0,
    incompatibleUniqueCandidates: 0, incompatibleByReason: { weapon: 0, pelletCount: 0 },
    missingLocalDirections: 0, missingServerDirections: 0,
    missingSampledAim: 0, missingOutgoingAim: 0, invalidRayVectors: 0,
    weaponAgreement: { same: 0, different: 0, unknown: 0 },
    differencesOverHalfDegree: 0, targetPointSamples: 0,
    pairedShotsWithImpacts: 0, impactsCloserThanSelectedPoint: 0, examples: [] };
  const pairing = { localRows: localShots.length, eligibleLocalShots: local.length,
    ineligibleLocalShots: localShots.length - local.length,
    serverShotRows: serverShotRows.length, eligibleServerShots: serverShots.length,
    ineligibleServerShots: serverShotRows.length - serverShots.length,
    expectedDelayMs: finite(ackLatencyMs) ? rounded(ackLatencyMs + 50) : 200,
    allowedDelayMs: [PAIR_DELAY_MIN_MS, PAIR_DELAY_MAX_MS],
    allowedTickOffset: [0, PAIR_TICK_OFFSET_MAX],
    unmatchedByReason: { unsupportedTickOffset: 0, noPlausibleCandidate: 0,
      sameOffsetOutsideDelayWindow: 0, differentTickOffset: 0, incompatible: 0,
      multipleCompatibleServerShots: 0, sharedServerShot: 0 },
    ambiguousExamples: [] };
  const ambiguousRayBounds = { ambiguousLocalShots: 0, measuredLocalShots: 0,
    incompleteCandidateSets: 0, overLimitCandidateSets: 0, examples: [] };
  const hitEvidence = { hitEvents: hitRows.length, hitEventsWithMatchAndTick:
    hitRows.length - hitRows.filter(event => !Number.isSafeInteger(event.match) ||
      !Number.isSafeInteger(event.tick)).length,
    pairedAtHitTick: 0, pairedAtUniqueShotHitTick: 0, pairedAtMultiShotHitTick: 0 };
  let paired = 0, pairedWithDecision = 0, pairedHits = 0;
  const expectedDelay = finite(ackLatencyMs) ? ackLatencyMs + 50 : 200;
  const pairedDelays = [];
  const delaysByMatch = new Map();
  const pairedServerEvents = new Set();
  const ambiguousCandidateServerEvents = new Set();
  for (const match of new Set(local.map(shot => shot.match))) {
    const shots = local.filter(shot => shot.match === match);
    const server = serverShots.filter(event => event.match === match);
    const withinWindow = (shot, event) => {
      const delay = event.at - shot.at, tickOffset = event.tick - shot.tick;
      return delay >= PAIR_DELAY_MIN_MS && delay <= PAIR_DELAY_MAX_MS &&
        tickOffset >= 0 && tickOffset <= PAIR_TICK_OFFSET_MAX;
    };
    const offsets = new Map();
    for (const shot of shots) {
      const candidates = server.filter(event => withinWindow(shot, event) &&
        !shotPairMismatch(shot, event));
      if (!candidates.length) continue;
      const closest = Math.min(...candidates.map(event =>
        Math.abs(event.at - shot.at - expectedDelay)));
      const nearestOffsets = new Set(candidates.filter(event =>
        Math.abs(Math.abs(event.at - shot.at - expectedDelay) - closest) < 1e-6)
        .map(event => event.tick - shot.tick));
      if (nearestOffsets.size !== 1) continue;
      const offset = [...nearestOffsets][0];
      offsets.set(offset, (offsets.get(offset) || 0) + 1);
    }
    const ranked = [...offsets].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const [offset, votes = 0] = ranked[0] || [];
    const runnerUpVotes = ranked[1]?.[1] || 0;
    const offsetStatus = !server.length ? 'noEligibleServerShots' :
      votes < 10 ? 'tooFewVotes' :
      votes < 0.4 * Math.min(shots.length, server.length) ? 'weakCoverage' :
      votes < 2 * runnerUpVotes ? 'competingOffsets' : 'supported';
    const supported = offsetStatus === 'supported';
    const compatibleByShot = new Map();
    const contendersByServer = new Map();
    if (supported) for (const shot of shots) {
      const compatible = server.filter(event => event.tick - shot.tick === offset &&
        withinWindow(shot, event) && !shotPairMismatch(shot, event));
      compatibleByShot.set(shot, compatible);
      for (const event of compatible) {
        if (!contendersByServer.has(event)) contendersByServer.set(event, []);
        contendersByServer.get(event).push(shot);
      }
    }
    const matchReasons = {};
    const matchDelays = [];
    const unmatched = (reason, shot, candidateCount = 0) => {
      pairing.unmatchedByReason[reason]++;
      matchReasons[reason] = (matchReasons[reason] || 0) + 1;
      if (['multipleCompatibleServerShots', 'sharedServerShot'].includes(reason) &&
          pairing.ambiguousExamples.length < 10)
        pairing.ambiguousExamples.push({ match, sequence: shot.sequence, tick: shot.tick,
          reason, compatibleServerShots: candidateCount });
    };
    const measureAmbiguousRays = (reason, shot, candidates, competingLocalShots = 1) => {
      ambiguousRayBounds.ambiguousLocalShots++;
      if (candidates.length > 32) { ambiguousRayBounds.overLimitCandidateSets++; return; }
      const frame = outgoing.get(`${match}:${shot.sequence}`);
      const differences = candidates.map(event => candidateMaxRayDifference(shot, event, frame));
      const comparable = differences.filter(finite);
      if (comparable.length) ambiguousRayBounds.measuredLocalShots++;
      if (comparable.length !== candidates.length) ambiguousRayBounds.incompleteCandidateSets++;
      if (ambiguousRayBounds.examples.length < 10) ambiguousRayBounds.examples.push({
        match, sequence: shot.sequence, tick: shot.tick, reason,
        serverCandidates: candidates.length, competingLocalShots,
        comparableCandidates: comparable.length,
        minMaxRayDifferenceDegrees: comparable.length ? rounded(Math.min(...comparable)) : null,
        maxMaxRayDifferenceDegrees: comparable.length ? rounded(Math.max(...comparable)) : null });
    };
    let matchPairs = 0;
    for (const shot of shots) {
      if (!supported) {
        unmatched('unsupportedTickOffset', shot);
        continue;
      }
      const candidates = server.filter(event => event.tick - shot.tick === offset &&
        withinWindow(shot, event));
      const compatible = compatibleByShot.get(shot);
      if (candidates.length === 1 && compatible.length === 0) {
        rayEvidence.incompatibleUniqueCandidates++;
        const reason = shotPairMismatch(shot, candidates[0]);
        rayEvidence.incompatibleByReason[reason]++;
        if (reason === 'pelletCount') rayEvidence.pelletCountDisagreements++;
      }
      if (!compatible.length) {
        const reason = candidates.length ? 'incompatible' :
          server.some(event => event.tick - shot.tick === offset) ?
            'sameOffsetOutsideDelayWindow' :
          server.some(event => withinWindow(shot, event)) ? 'differentTickOffset' :
          'noPlausibleCandidate';
        unmatched(reason, shot);
        continue;
      }
      if (compatible.length > 1) {
        for (const candidate of compatible) ambiguousCandidateServerEvents.add(candidate);
        measureAmbiguousRays('multipleCompatibleServerShots', shot, compatible);
        unmatched('multipleCompatibleServerShots', shot, compatible.length);
        continue;
      }
      const event = compatible[0];
      if (contendersByServer.get(event).length > 1) {
        ambiguousCandidateServerEvents.add(event);
        measureAmbiguousRays('sharedServerShot', shot, compatible,
          contendersByServer.get(event).length);
        unmatched('sharedServerShot', shot, contendersByServer.get(event).length);
        continue;
      }
      pairedServerEvents.add(event);
      matchPairs++; paired++;
      const delay = event.at - shot.at;
      pairedDelays.push(delay);
      matchDelays.push(delay);
      const tickKey = `${match}:${event.tick}`;
      const atHitTick = hitTicks.has(tickKey);
      if (atHitTick) hitEvidence.pairedAtHitTick++;
      if (atHitTick && shotsAtTick.get(tickKey) > 1)
        hitEvidence.pairedAtMultiShotHitTick++;
      const hit = atHitTick && shotsAtTick.get(tickKey) === 1;
      if (hit) hitEvidence.pairedAtUniqueShotHitTick++;
      if (hit) pairedHits++;
      const decision = sent.get(`${match}:${shot.sequence}`);
      const reported = event.shot;
      if (list(reported?.impacts).length) rayEvidence.pairedShotsWithImpacts++;
      const weaponMismatch = !!(reported?.weaponId && shot.weapon?.id &&
        reported.weaponId !== shot.weapon.id);
      if (reported?.weaponId && shot.weapon?.id)
        rayEvidence.weaponAgreement[weaponMismatch ? 'different' : 'same']++;
      else rayEvidence.weaponAgreement.unknown++;
      const directions = list(reported?.directions);
      const predicted = list(shot.directions);
      if (!directions.length) rayEvidence.missingServerDirections++;
      if (!predicted.length) rayEvidence.missingLocalDirections++;
      if (directions.length) {
        rayEvidence.pairedShotsWithDirections++;
        if (validVector(reported?.origin) && validVector(decision?.target?.position) &&
            finite(decision.target.bodyHeight) && ['head', 'chest'].includes(decision.target.aimPart)) {
          let rays = 0, intersections = 0;
          for (const direction of directions.slice(0, 32)) {
            const ray = unitVector(direction);
            if (!ray) continue;
            rays++;
            if (sampledHitboxRayEntry(reported.origin, ray, decision.target) !== null)
              intersections++;
          }
          if (rays) {
            const visibility = visibilityStatus(decision.target.visibility);
            reportedHitboxByVisibility[visibility] ||= {
              pairs: 0, rays: 0, raysIntersecting: 0, pairsWithIntersection: 0 };
            const group = reportedHitboxByVisibility[visibility];
            group.pairs++;
            group.rays += rays;
            group.raysIntersecting += intersections;
            if (intersections) group.pairsWithIntersection++;
          }
        }
        const frame = outgoing.get(`${match}:${shot.sequence}`);
        const source = directionBasis(shot.yaw, shot.pitch);
        const destination = directionBasis(frame?.after?.[0], frame?.after?.[1]);
        if (!source) rayEvidence.missingSampledAim++;
        if (!destination) rayEvidence.missingOutgoingAim++;
        const weapon = [reported?.weaponId, shot.weapon?.id]
          .find(value => typeof value === 'string' && value) || 'unknown';
        const selectedDistance = finite(decision?.target?.distance)
          ? decision.target.distance : decision?.targetDistance;
        const distance = distanceBand(selectedDistance);
        const localFireMode = decision?.sampled?.hipFire === true && decision.adsRequested === false
          ? 'hip-selected' : decision?.adsRequested === true && decision.sampled?.hipFire !== true
            ? 'ads-requested' : 'unknown';
        const groupKey = JSON.stringify([weapon, distance, localFireMode]);
        let pairDifference = null;
        for (let index = 0; !weaponMismatch && predicted.length === directions.length &&
            index < directions.length; index++) {
          const actual = unitVector(directions[index]);
          const expected = rotatedShotRay(predicted[index], source, destination);
          const difference = angleDegrees(actual, expected);
          if (!finite(difference)) {
            if (source && destination) rayEvidence.invalidRayVectors++;
            continue;
          }
          rayDifferences.push(difference);
          rayEvidence.comparedRays++;
          if (difference > 0.5) rayEvidence.differencesOverHalfDegree++;
          if (!comparableRayGroups.has(groupKey)) comparableRayGroups.set(groupKey,
            { weapon, distance, localFireMode, angles: [] });
          comparableRayGroups.get(groupKey).angles.push(difference);
          pairDifference = Math.max(pairDifference ?? 0, difference);
        }
        for (const direction of directions) {
          const spread = angleDegrees(direction, destination?.forward);
          if (finite(spread)) reportedSpread.push(spread);
        }
        if (finite(pairDifference)) rayExamples.push({ match, sequence: shot.sequence,
          weapon: reported.weaponId || shot.weapon?.id || null,
          maxDifferenceDegrees: rounded(pairDifference) });
        if (validVector(reported?.origin) && validVector(shot.eye))
          originOffsets.push(Math.hypot(...reported.origin.map((value, index) => value - shot.eye[index])));
        if (!weaponMismatch && validVector(decision?.target?.point) && validVector(reported?.origin)) {
          const targetDirection = unitVector(decision.target.point.map((value, index) =>
            value - reported.origin[index]));
          const misses = directions.map(direction => angleDegrees(direction, targetDirection))
            .filter(finite);
          const distance = Math.hypot(...decision.target.point.map((value, index) =>
            value - reported.origin[index]));
          const nearestAngle = misses.length ? Math.min(...misses) : null;
          if (finite(nearestAngle) && nearestAngle < 90 && finite(distance)) {
            targetMiss.push(distance * Math.sin(nearestAngle * Math.PI / 180));
            rayEvidence.targetPointSamples++;
          }
        }
      }
      if (!weaponMismatch && validVector(decision?.target?.point) && validVector(reported?.origin)) {
        const distance = Math.hypot(...decision.target.point.map((value, index) =>
          value - reported.origin[index]));
        if (list(reported.impacts).some(impact => validVector(impact?.point) &&
            Math.hypot(...impact.point.map((value, index) => value - reported.origin[index])) <
            distance - 0.25)) rayEvidence.impactsCloserThanSelectedPoint++;
      }
      if (!decision) continue;
      pairedWithDecision++;
      const visibility = visibilityStatus(decision.target?.visibility);
      byVisibility[visibility] ||= { shots: 0, hits: 0 };
      byVisibility[visibility].shots++;
      if (hit) byVisibility[visibility].hits++;
      const mode = decision.sampled?.hipFire === true && decision.adsRequested === false
        ? 'hip' : decision.adsRequested === true ? 'ads' : 'other';
      const distance = finite(decision.target?.distance) ? decision.target.distance :
        decision.targetDistance;
      const band = !finite(distance) ? 'unknown' : distance < 40 ? '0-39 m' :
        distance < 100 ? '40-99 m' : distance < 150 ? '100-149 m' : '150+ m';
      const speed = finite(decision.localSpeed) ? decision.localSpeed :
        Math.hypot(shot.player?.velocity?.[0] || 0, shot.player?.velocity?.[2] || 0);
      const movement = speed > 0.5 ? 'moving' : 'still';
      const key = [mode, band, movement].join('|');
      byModeDistanceMovement[key] ||= { mode, distance: band, movement, shots: 0, hits: 0 };
      byModeDistanceMovement[key].shots++;
      if (hit) byModeDistanceMovement[key].hits++;
    }
    delaysByMatch.set(match, matchDelays);
    byMatch[match] = { retainedLocalShots: shots.length, retainedServerShots: server.length,
      inferredTickOffset: supported ? offset : null, offsetVotes: votes,
      runnerUpOffsetVotes: runnerUpVotes, offsetStatus,
      offsetCandidates: ranked.slice(0, 3).map(([tickOffset, count]) => ({ tickOffset, votes: count })),
      paired: matchPairs, unmatchedByReason: matchReasons };
  }
  const median = values => {
    const ordered = values.filter(finite).sort((a, b) => a - b);
    if (!ordered.length) return null;
    const middle = Math.floor(ordered.length / 2);
    return rounded(ordered.length % 2 ? ordered[middle] :
      (ordered[middle - 1] + ordered[middle]) / 2);
  };
  const timing = values => ({ samples: values.length,
    minMs: values.length ? rounded(Math.min(...values)) : null,
    medianMs: median(values),
    maxMs: values.length ? rounded(Math.max(...values)) : null });
  pairing.pairedDelayMs = timing(pairedDelays);
  pairing.unpairedEligibleServerShots = serverShots.length - paired;
  for (const [match, values] of delaysByMatch) byMatch[match].pairedDelayMs = timing(values);
  const fanByPairing = { paired: [], ambiguousCandidate: [], unpaired: [] };
  const fanExamples = [];
  let eventsWithMultipleDirections = 0, skippedInvalidOrOverLimit = 0;
  for (const event of serverShotRows) {
    const directions = event.shot?.directions;
    if (!Array.isArray(directions) || directions.length < 2) continue;
    eventsWithMultipleDirections++;
    // The trace producer retains at most 32 rays in one shot event.
    if (directions.length > 32) { skippedInvalidOrOverLimit++; continue; }
    const rays = directions.map(unitVector);
    if (rays.some(ray => !ray)) { skippedInvalidOrOverLimit++; continue; }
    let maxSeparation = 0;
    for (let first = 0; first < rays.length; first++) {
      for (let second = first + 1; second < rays.length; second++) {
        const cosine = Math.max(-1, Math.min(1, dot3(rays[first], rays[second])));
        maxSeparation = Math.max(maxSeparation, Math.acos(cosine) * 180 / Math.PI);
      }
    }
    const pairingStatus = pairedServerEvents.has(event) ? 'paired' :
      ambiguousCandidateServerEvents.has(event) ? 'ambiguousCandidate' : 'unpaired';
    fanByPairing[pairingStatus].push(maxSeparation);
    if (maxSeparation > 0.5) {
      fanExamples.push({ match: Number.isSafeInteger(event.match) ? event.match : null,
        tick: Number.isSafeInteger(event.tick) ? event.tick : null,
        weaponId: typeof event.shot.weaponId === 'string' ? event.shot.weaponId : null,
        rays: rays.length, pairingStatus, maxSeparationDegrees: rounded(maxSeparation) });
      fanExamples.sort((a, b) => b.maxSeparationDegrees - a.maxSeparationDegrees);
      if (fanExamples.length > 5) fanExamples.length = 5;
    }
  }
  const fanAngles = Object.values(fanByPairing).flat();
  const reportedRayFan = {
    serverShotEvents: serverShotRows.length, eventsWithMultipleDirections,
    measuredEvents: fanAngles.length, skippedInvalidOrOverLimit,
    byPairing: Object.fromEntries(Object.entries(fanByPairing).map(([status, angles]) =>
      [status, { events: angles.length,
        overHalfDegreeEvents: angles.filter(angle => angle > 0.5).length,
        medianMaxSeparationDegrees: median(angles) }])),
    medianMaxSeparationDegrees: median(fanAngles),
    maxSeparationDegrees: fanAngles.length
      ? rounded(fanAngles.reduce((maximum, angle) => Math.max(maximum, angle), 0)) : null,
    examples: fanExamples };
  rayEvidence.medianLocalToServerDegrees = median(rayDifferences);
  rayEvidence.maxLocalToServerDegrees = rayDifferences.length ? rounded(Math.max(...rayDifferences)) : null;
  rayEvidence.medianServerRayFromOutgoingAimDegrees = median(reportedSpread);
  rayEvidence.medianTargetPointMissMeters = median(targetMiss);
  rayEvidence.medianOriginOffsetMeters = median(originOffsets);
  rayEvidence.examples = rayExamples.sort((a, b) =>
    b.maxDifferenceDegrees - a.maxDifferenceDegrees).slice(0, 10);
  const comparableRaysByWeaponDistanceMode = [...comparableRayGroups.values()]
    .map(({ angles, ...dimensions }) => {
      angles.sort((a, b) => a - b);
      return { ...dimensions, count: angles.length,
        medianDegrees: median(angles),
        p90Degrees: rounded(angles[Math.ceil(angles.length * 0.9) - 1]),
        differencesOverHalfDegree: angles.filter(value => value > 0.5).length };
    }).sort((a, b) => a.weapon.localeCompare(b.weapon) ||
      a.distance.localeCompare(b.distance) || a.localFireMode.localeCompare(b.localFireMode));
  return { method: 'provisional same-match tick and arrival-time alignment',
    paired, pairedWithDecision, pairedHits, pairing, ambiguousRayBounds, hitEvidence,
    byMatch, byVisibility, reportedRayFan,
    reportedHitboxByVisibility, rayEvidence,
    comparableRaysByWeaponDistanceMode,
    byModeDistanceMovement: Object.values(byModeDistanceMovement).sort((a, b) =>
      a.mode.localeCompare(b.mode) || a.distance.localeCompare(b.distance) ||
      a.movement.localeCompare(b.movement)) };
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
  const localShots = list(trace.localShots);
  const spreadReplayEvidence = { calibrated: 0, uncalibrated: 0,
    unrecorded: 0, byWeapon: {} };
  const replayByWeapon = new Map();
  for (const shot of localShots) {
    const status = shot?.spreadReplayCalibrated === true ? 'calibrated' :
      shot?.spreadReplayCalibrated === false ? 'uncalibrated' : 'unrecorded';
    spreadReplayEvidence[status]++;
    const weapon = typeof shot?.weapon?.id === 'string' ? shot.weapon.id : 'unknown';
    if (!replayByWeapon.has(weapon)) replayByWeapon.set(weapon,
      { calibrated: 0, uncalibrated: 0, unrecorded: 0 });
    const group = replayByWeapon.get(weapon);
    group[status]++;
  }
  spreadReplayEvidence.byWeapon = Object.fromEntries(replayByWeapon);
  const gates = list(trace.fireGates);
  const interactions = list(trace.interactions);
  const settings = list(trace.settings);
  const settingsHistory = summarizeSettings(settings);
  const aimPointChoices = summarizeAimPointChoices(sent, settings);
  const aimVisibility = {};
  for (const decision of sent) {
    const status = visibilityStatus(decision?.target?.visibility);
    aimVisibility[status] = (aimVisibility[status] || 0) + 1;
  }
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
  let missingPredictionWithCooldown = 0, missingPredictionWithoutCooldown = 0;
  const ackCoverage = { covered: 0, pendingOrUnobserved: 0, unknown: 0 };

  for (const item of sent) {
    const weapon = typeof item.weaponId === 'string' ? item.weaponId : 'unknown';
    const distance = finite(item.target?.distance) ? item.target.distance : item.targetDistance;
    const band = distanceBand(distance);
    const movement = finite(item.localSpeed) ? (item.localSpeed > 0.5 ? 'moving' : 'still')
      : item.movingInput ? 'moving' : 'still';
    if (weapon === 'unknown') missingWeapon++;
    if (band === 'unknown') missingDistance++;
    if (!item.localShotPredicted) {
      missingPrediction++;
      if (finite(item.weapon?.cooldown) && item.weapon.cooldown > 0) missingPredictionWithCooldown++;
      else missingPredictionWithoutCooldown++;
    }
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
    if (!item.localShotPredicted && !(finite(item.weapon?.cooldown) && item.weapon.cooldown > 0))
      reasons.push('no local prediction without recorded cooldown');
    if (finite(item.localAds) && item.localAds < 0.995 && item.sampled?.hipFire !== true &&
        !(item.sampled?.earlyAds === true && item.correctionApplied))
      reasons.push('ADS below ready threshold');
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

  const multiPellet = sent.filter(item => item.localShotPredicted &&
    finite(item.weapon?.stats?.pellets) && item.weapon.stats.pellets > 1);
  const measuredPellets = multiPellet.filter(item =>
    finite(item.geometry?.projectedPelletHitsInput) &&
    finite(item.geometry?.projectedPelletHitsOutgoing));
  const pelletProjection = { retainedMultiPelletShots: multiPellet.length,
    measured: measuredPellets.length,
    noProjectedHitsBefore: measuredPellets.filter(item =>
      item.geometry.projectedPelletHitsInput === 0).length,
    noProjectedHitsAfter: measuredPellets.filter(item =>
      item.geometry.projectedPelletHitsOutgoing === 0).length,
    projectedHitsBefore: measuredPellets.reduce((sum, item) =>
      sum + item.geometry.projectedPelletHitsInput, 0),
    projectedHitsAfter: measuredPellets.reduce((sum, item) =>
      sum + item.geometry.projectedPelletHitsOutgoing, 0) };

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
    acknowledgedAim: summarizeAcknowledgedAim(snapshots),
    medianAckLatencyMs: median(snapshots.map(item => item.ackLatencyMs)),
    medianReportedRttMs: median(snapshots.map(item => item.reportedRttMs)),
    adsDisagreementSamples: snapshots.filter(item => finite(item.server?.ads) &&
      finite(item.predictorBeforeReconcile?.ads) &&
      Math.abs(item.server.ads - item.predictorBeforeReconcile.ads) > 0.05).length,
    acknowledgedShotCount: { aligned: snapshots.filter(item => item.acknowledgedShot?.delta === 0).length,
      diverged: snapshots.filter(item => Number.isSafeInteger(item.acknowledgedShot?.delta) &&
        item.acknowledgedShot.delta !== 0).length },
    magazineDisagreementSamples: snapshots.filter(item => finite(item.server?.magazine) &&
      finite(item.predictorBeforeReconcile?.magazine) &&
      item.server.magazine !== item.predictorBeforeReconcile.magazine).length };

  const ammoPickups = list(trace.ammoPickups);
  const requestsByType = {};
  for (const request of ammoPickups) {
    const type = typeof request?.ammoType === 'string' ? request.ammoType : 'unknown';
    requestsByType[type] = (requestsByType[type] || 0) + 1;
  }
  const serverReserveIncreases = {};
  const lastAmmoByMatch = new Map();
  for (const snapshot of snapshots) {
    const ammo = snapshot?.server?.ammo;
    if (!ammo || typeof ammo !== 'object') continue;
    const previous = lastAmmoByMatch.get(snapshot.match);
    for (const [type, amount] of Object.entries(ammo)) {
      if (!finite(amount) || !finite(previous?.[type]) || amount <= previous[type]) continue;
      serverReserveIncreases[type] ||= { transitions: 0, rounds: 0 };
      serverReserveIncreases[type].transitions++;
      serverReserveIncreases[type].rounds += amount - previous[type];
    }
    lastAmmoByMatch.set(snapshot.match, ammo);
  }
  const ammoAssist = { pickupRequests: ammoPickups.length, requestsByType, serverReserveIncreases };

  const inventoryEvidence = { observedServerInventories: 0, agentInteractRequestsByKind: {},
    agentEquipRequests: 0, serverWeaponAcquisitions: 0, serverWeaponReplacements: 0,
    serverActiveSlotChanges: 0, transitions: [] };
  for (const decision of list(trace.agentDecisions)) {
    if (decision?.action === 'loot-interact') {
      const kind = typeof decision.goal?.kind === 'string' ? decision.goal.kind : 'unknown';
      inventoryEvidence.agentInteractRequestsByKind[kind] =
        (inventoryEvidence.agentInteractRequestsByKind[kind] || 0) + 1;
    }
    if (decision?.action === 'equip') inventoryEvidence.agentEquipRequests++;
  }
  const previousInventoryByMatch = new Map();
  for (const snapshot of snapshots) {
    const slots = snapshot?.server?.slots;
    if (!Array.isArray(slots)) continue;
    inventoryEvidence.observedServerInventories++;
    const previous = previousInventoryByMatch.get(snapshot.match);
    if (previous) {
      for (let index = 0; index < Math.min(2, slots.length); index++) {
        const before = previous.slots[index]?.weapon || null;
        const after = slots[index]?.weapon || null;
        if (!after || after === before) continue;
        if (before) inventoryEvidence.serverWeaponReplacements++;
        else inventoryEvidence.serverWeaponAcquisitions++;
        if (inventoryEvidence.transitions.length < 12)
          inventoryEvidence.transitions.push({ match: snapshot.match, tick: snapshot.tick ?? null,
            slot: index, from: before, to: after });
      }
      if (Number.isInteger(previous.activeSlot) &&
          Number.isInteger(snapshot.server.activeSlot) &&
          previous.activeSlot !== snapshot.server.activeSlot)
        inventoryEvidence.serverActiveSlotChanges++;
    }
    previousInventoryByMatch.set(snapshot.match,
      { slots, activeSlot: snapshot.server.activeSlot });
  }

  const retained = Object.fromEntries(['frames', 'localShots', 'aimDecisions', 'fireGates',
    'serverSnapshots', 'serverEvents', 'settings', 'interactions', 'ammoPickups',
    'agentDecisions', 'kicks', 'connectionStates', 'errors']
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
  const coverEvidence = { retainedGateRows: 0, blockerMeasured: 0, byMaterial: {}, latest: null };
  for (const gate of gates) {
    const reason = typeof gate?.reason === 'string' ? gate.reason : 'unspecified';
    const mode = typeof gate?.player?.mode === 'string' ? gate.player.mode : 'unknown';
    retainedGateReasons[reason] = (retainedGateReasons[reason] || 0) + 1;
    byPlayerMode[mode] ||= {};
    byPlayerMode[mode][reason] = (byPlayerMode[mode][reason] || 0) + 1;
    if (finite(gate?.target?.distance)) selectedDistances.push(gate.target.distance);
    const cover = gate?.scan?.closestCover;
    if (cover && typeof cover === 'object') {
      coverEvidence.retainedGateRows++;
      if (finite(cover.blocker?.distanceMeters)) {
        coverEvidence.blockerMeasured++;
        const material = typeof cover.blocker.material === 'string' ? cover.blocker.material : 'unknown';
        coverEvidence.byMaterial[material] = (coverEvidence.byMaterial[material] || 0) + 1;
      }
      coverEvidence.latest = { match: gate.match ?? null, sequence: gate.sequence ?? null,
        targetDistanceMeters: rounded(cover.distanceMeters),
        preferredPart: cover.preferredPart ?? null,
        blockerDistanceMeters: rounded(cover.blocker?.distanceMeters),
        material: cover.blocker?.material ?? null };
    }
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
  const shotKey = item => `${item.match ?? 'unknown'}:${item.sequence}`;
  const predictedSequences = new Set(localShots.filter(shot => Number.isSafeInteger(shot?.sequence))
    .map(shotKey));
  const predictedFrames = frames.filter(frame => Number.isSafeInteger(frame?.sequence) &&
    predictedSequences.has(shotKey(frame)));
  const predictionConsistency = { retainedLocalShots: localShots.length,
    overlappingFrames: predictedFrames.length,
    predictedFireRemovedOnWire: predictedFrames.filter(frame =>
      (buttonMask(frame.sampledButtons) & BUTTONS.fire) &&
      !(buttonMask(frame.buttons) & BUTTONS.fire)).length,
    predictedFireOnWire: predictedFrames.filter(frame =>
      buttonMask(frame.buttons) & BUTTONS.fire).length };
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
  const earlyAdsSent = sent.filter(item => item.sampled?.earlyAds === true);
  const hipFireSent = sent.filter(item => item.sampled?.hipFire === true &&
    item.adsRequested === false);
  const hipByWeapon = {};
  for (const item of hipFireSent) {
    const weapon = typeof item.weaponId === 'string' ? item.weaponId : 'unknown';
    hipByWeapon[weapon] = (hipByWeapon[weapon] || 0) + 1;
  }
  const hipFireEvidence = { sent: hipFireSent.length,
    locallyPredicted: hipFireSent.filter(item => item.localShotPredicted).length,
    corrected: hipFireSent.filter(item => item.correctionApplied).length,
    seeded: hipFireSent.filter(item => item.sampled?.hipSeeded === true).length,
    byWeapon: hipByWeapon };
  const predictedFire = sent.filter(item => item.localShotPredicted === true);
  const correctionSkipReasons = new Map();
  const seedSyncStatuses = new Map();
  const seedSyncOnAckMismatch = new Map();
  let ackShotCountMismatchSkips = 0;
  for (const item of predictedFire) {
    const reason = typeof item.correctionSkipReason === 'string' &&
      item.correctionSkipReason ? item.correctionSkipReason : null;
    const status = typeof item.seedSyncStatus === 'string' &&
      item.seedSyncStatus ? item.seedSyncStatus : null;
    if (reason) correctionSkipReasons.set(reason, (correctionSkipReasons.get(reason) || 0) + 1);
    if (status) seedSyncStatuses.set(status, (seedSyncStatuses.get(status) || 0) + 1);
    if (reason === 'ack-shot-count-mismatch') {
      ackShotCountMismatchSkips++;
      if (status) seedSyncOnAckMismatch.set(status,
        (seedSyncOnAckMismatch.get(status) || 0) + 1);
    }
  }
  const predictedFireSync = { retainedPredictedFire: predictedFire.length,
    correctionSkipReasonRecorded: [...correctionSkipReasons.values()].reduce((a, b) => a + b, 0),
    ackShotCountMismatchSkips,
    byCorrectionSkipReason: Object.fromEntries(correctionSkipReasons),
    seedSyncStatusRecorded: [...seedSyncStatuses.values()].reduce((a, b) => a + b, 0),
    bySeedSyncStatus: Object.fromEntries(seedSyncStatuses),
    seedSyncStatusRecordedOnAckMismatch: [...seedSyncOnAckMismatch.values()]
      .reduce((a, b) => a + b, 0),
    bySeedSyncStatusOnAckMismatch: Object.fromEntries(seedSyncOnAckMismatch) };
  const correlatedShots = correlateServerShots(localShots, events, decisions, frames,
    authoritative.medianAckLatencyMs);
  const agentActions = {};
  const agentRoutes = { observed: 0, bySource: {}, full: 0, partial: 0, blocked: 0,
    maxStuckCount: 0, maxAbsSteerDegrees: 0 };
  for (const item of list(trace.agentDecisions)) {
    const action = typeof item?.action === 'string' ? item.action : 'unknown';
    agentActions[action] = (agentActions[action] || 0) + 1;
    if (finite(item?.stuckCount)) agentRoutes.maxStuckCount = Math.max(
      agentRoutes.maxStuckCount, item.stuckCount);
    const route = item?.route;
    if (!route || typeof route !== 'object') continue;
    agentRoutes.observed++;
    const source = typeof route.source === 'string' ? route.source : 'unknown';
    agentRoutes.bySource[source] = (agentRoutes.bySource[source] || 0) + 1;
    if (finite(route.clearanceMeters)) {
      if (route.clearanceMeters >= 4) agentRoutes.full++;
      else if (route.clearanceMeters >= 0.75) agentRoutes.partial++;
      else agentRoutes.blocked++;
    }
    if (finite(route.steerDegrees)) agentRoutes.maxAbsSteerDegrees = Math.max(
      agentRoutes.maxAbsSteerDegrees, Math.abs(route.steerDegrees));
  }
  const firingEvidence = { originalFireGateRows: originalGateButtons.byButton.fire,
    preparedFireGateRows: sampledGateButtons.byButton.fire,
    sampledFireFrames: sampledFrameButtons.observed ? sampledFrameButtons.byButton.fire : null,
    outgoingFireFrames: frameButtons.byButton.fire, sentDecisionRows: sent.length,
    earlyAdsSent: earlyAdsSent.length,
    earlyAdsPredicted: earlyAdsSent.filter(item => item.localShotPredicted).length,
    earlyAdsCorrected: earlyAdsSent.filter(item => item.correctionApplied).length,
    serverShotEvents: server.shots };
  anomalies.sort((a, b) => (b.predictedMissMeters ?? 0) - (a.predictedMissMeters ?? 0) ||
    b.reasons.length - a.reasons.length);
  return {
    formatVersion: document.formatVersion, scriptVersion: document.scriptVersion || 'unknown',
    capturedAt: document.capturedAt || null, matchesObserved: trace.match || 0,
    latestSettings: settingsHistory.latest, settingsHistory, aimPointChoices,
    aimVisibility,
    retention: { retained, dropped: trace.retention?.dropped || null },
    rageSamples: trace.counters?.rageSamples ?? null,
    gateReasons: gateCounts, gateSamples, coverEvidence,
    targetRejects: trace.counters?.targetRejects || null,
    inputButtons, firingEvidence, hipFireEvidence, predictedFireSync,
    spreadReplayEvidence, correlatedShots,
    agentActions, agentRoutes, interactionEvidence, ammoAssist, inventoryEvidence,
    predictionConsistency,
    pelletProjection,
    outgoingFire: { retained: sent.length, held: held.length, heldReasons,
      ackCoverage, missingWeapon, missingDistance,
      missingPrediction, missingPredictionWithCooldown, missingPredictionWithoutCooldown,
      missingGeometry, byWeaponRangeMovement },
    serverEvents: server, authoritative,
    investigate: anomalies.slice(0, 20),
    interpretation: [
      'Distances and geometric miss estimates describe local client predictions, not authoritative hits.',
      'An ACK covers an input sequence; it does not establish that the server fired or hit.',
      'Server events have no guaranteed input sequence, so server hits cannot be assigned to a weapon, target, or distance.',
      'Tick-aligned shot pairs are provisional. A shared tick and plausible arrival delay do not prove which input caused a server hit.',
      'Pairing requires one compatible local shot and one compatible server shot within the selected tick offset and delay window. Unsupported offsets, missing fields, and ambiguous candidates remain unmatched.',
      'A paired shot at a unique server-shot hit tick is only a same-tick observation. Multiple own-player server shots at one hit tick are excluded from paired-hit groups; neither case proves which ray hit.',
      'Server-reported shot directions are visual event data from the game. Their difference from a rotated local prediction can diagnose spread-seed or aim-state drift only when provisional pairing is correct.',
      'Within-shot ray separation uses directions in one server shot event and does not require local/server pairing. It describes a reported ray fan, not a server spread parameter or per-shot aim error; single-ray events provide no separation measurement.',
      'Ray-fan pairing labels and ambiguous-candidate angular ranges use the provisional pairing window. Candidate ranges compare rays by array index after rotating the local prediction to outgoing aim; they do not choose a server shot or establish spread or aim as the cause.',
      'Reported-ray intersections use the locally sampled target hitbox; they do not prove the target occupied that box on the server or that cover allowed the shot.',
      'Comparable-ray groups use locally selected distance and recorded local fire-mode flags. ADS requested or hip selected does not establish the server scope state.',
      'Server ray versus outgoing aim is an observed angular difference, not a direct server spread parameter. A small selected-point miss does not prove the target occupied that point on the server.',
      'Server-reported impacts are grouped with the preceding own-player shot by event order. An impact closer than the locally selected target point suggests an obstruction, but neither ordering nor provisional input pairing proves the hit path.',
      'Fire-gate rows are coalesced samples; gate counters cover every Rage sample when present.',
      'Fire-gate original buttons are the game input before this hook; prepared gate buttons are after sample rewriting. Frame sampledButtons, when present, are before sendInput rewriting; frame buttons are on the wire.',
      'Older traces may lack F/E keyboard events; absent Interact bits do not prove F/E was never pressed.',
      'Button names use the captured client bit map: Fire 1, Aim 2, Interact 64 (F/E).',
      'A Fire input held during recorded weapon cooldown may have no local shot prediction; this is normal for automatic fire.',
      'A locally predicted shot whose Fire bit is removed before send can desynchronize shot seed, bloom, and cooldown until reconciliation.',
      'Projected pellet hits use the captured client hitboxes and locally predicted spread; they are not server-confirmed hits.',
      'Adaptive hip-fire decisions use local shot-seed and spread estimates; only server events can establish actual hits.',
      'The seedSyncStatus field records a shot-count comparison, not verified seed equality. Neither an ACK shot-count match nor a mismatch identifies a server ray or proves which shot hit.',
      'Spread replay calibration checks whether the local captured-kernel model reproduces the client predictor rays; it does not verify the private server seed or ray.',
      'Ammo pickup requests and server reserve increases are separate observations; the trace does not prove which request caused an increase.',
      'Agent Interact and Swap requests and later server inventory changes are separate observations; they cannot be attributed to a particular request without a server receipt.',
      'Predictor state is sampled before server reconciliation and can temporarily differ because of network delay.',
      'Acknowledged aim compares a retained outgoing input with the server snapshot for its ACK. A mismatch suggests server clamping or state drift, but does not by itself establish which rule caused it.',
      'Cover blockers are first intersections along the preferred hitbox-center ray in the captured client world. They do not establish server penetration rules.',
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
    `Preferred-center cover blockers (coalesced gate rows): ${JSON.stringify(report.coverEvidence)}`,
    `Latest recorded settings: ${JSON.stringify(report.latestSettings || {})}`,
    `Recorded setting changes (${report.settingsHistory.retained} rows): ${JSON.stringify(report.settingsHistory.transitions)}`,
    `Requested vs selected aim points (retained Fire): ${JSON.stringify(report.aimPointChoices.byRequested)}`,
    `Aim points by weapon: ${JSON.stringify(report.aimPointChoices.byWeapon)}`,
    `Selected point visibility (retained Fire): ${JSON.stringify(report.aimVisibility)}`,
    `Fire path evidence (retained rows): original game samples ${report.firingEvidence.originalFireGateRows}, ` +
      `prepared samples ${report.firingEvidence.preparedFireGateRows}, pre-send frames ` +
      `${report.firingEvidence.sampledFireFrames ?? 'unavailable'}, outgoing frames ` +
      `${report.firingEvidence.outgoingFireFrames}, sent decisions ${report.firingEvidence.sentDecisionRows}, ` +
      `server shot events ${report.firingEvidence.serverShotEvents}`,
    `Early ADS Fire (retained decisions): sent ${report.firingEvidence.earlyAdsSent}, ` +
      `locally predicted ${report.firingEvidence.earlyAdsPredicted}, ` +
      `corrected ${report.firingEvidence.earlyAdsCorrected}`,
    `Adaptive hip Fire (retained decisions): sent ${report.hipFireEvidence.sent}, ` +
      `locally predicted ${report.hipFireEvidence.locallyPredicted}, ` +
      `corrected ${report.hipFireEvidence.corrected}, seeded ${report.hipFireEvidence.seeded}; ` +
      `by weapon ${JSON.stringify(report.hipFireEvidence.byWeapon)}`,
    `Predicted Fire correction and shot-count proxy (recorded seedSyncStatus field): ` +
      `${JSON.stringify(report.predictedFireSync)}`,
    `Local spread replay calibration (retained shots): ` +
      `${JSON.stringify(report.spreadReplayEvidence)}`,
    `Shot-pair eligibility and timing (provisional): ${JSON.stringify(report.correlatedShots.pairing)}`,
    `Ambiguous shot candidate ray-difference ranges (provisional, at most 10 examples): ` +
      `${JSON.stringify(report.correlatedShots.ambiguousRayBounds)}`,
    `Provisional server-shot pairs: ${report.correlatedShots.paired} paired, ` +
      `${report.correlatedShots.pairedWithDecision} with retained decisions, ` +
      `${report.correlatedShots.pairedHits} at a unique-server-shot hit tick; ` +
      `by match ${JSON.stringify(report.correlatedShots.byMatch)}`,
    `Server hit-tick observations (not ray attribution): ${JSON.stringify(report.correlatedShots.hitEvidence)}`,
    `Paired shot modes by distance and movement (provisional): ` +
      `${JSON.stringify(report.correlatedShots.byModeDistanceMovement)}`,
    `Pairs at unique-shot server hit ticks by selected-point visibility (provisional): ` +
      `${JSON.stringify(report.correlatedShots.byVisibility)}`,
    `Server-reported rays through sampled hitboxes by visibility (provisional): ` +
      `${JSON.stringify(report.correlatedShots.reportedHitboxByVisibility)}`,
    `Server-reported ray comparison (provisional pairs): ${JSON.stringify(report.correlatedShots.rayEvidence)}`,
    `Within-shot server-reported ray separation (pairing independent): ` +
      `${JSON.stringify(report.correlatedShots.reportedRayFan)}`,
    'Comparable ray angular differences by weapon / selected distance / local fire mode (provisional):',
    ...(report.correlatedShots.comparableRaysByWeaponDistanceMode.length
      ? report.correlatedShots.comparableRaysByWeaponDistanceMode.map(group =>
        `  ${group.weapon} | ${group.distance} | ${group.localFireMode}: ${group.count} rays, ` +
          `median ${group.medianDegrees} deg, P90 ${group.p90Degrees} deg, ` +
          `>0.5 deg ${group.differencesOverHalfDegree}`)
      : ['  No comparable rays.']),
    `Combat agent decisions (retained): ${JSON.stringify(report.agentActions)}`,
    `Combat agent routes (retained decisions): ${JSON.stringify(report.agentRoutes)}`,
    `Combat agent inventory (retained observations): ${JSON.stringify(report.inventoryEvidence)}`,
    `Prediction/send overlap: ${report.predictionConsistency.overlappingFrames} retained frames with local shots; ` +
      `${report.predictionConsistency.predictedFireRemovedOnWire} had Fire removed before send`,
    `Local multi-pellet projection: ${JSON.stringify(report.pelletProjection)}`,
    `Interact button bit 64 (retained rows): original game samples ` +
      `${report.inputButtons.originalGateSamples.byButton.interact}, prepared samples ` +
      `${report.inputButtons.preparedGateSamples.byButton.interact}, pre-send frames ` +
      `${report.inputButtons.sampledFrames.observed ? report.inputButtons.sampledFrames.byButton.interact : 'unavailable'}, outgoing frames ` +
      `${report.inputButtons.outgoingFrames.byButton.interact}`,
    `F/E and pointer-lock evidence: ${JSON.stringify(report.interactionEvidence)}`,
    `Ammo assist: ${report.ammoAssist.pickupRequests} pickup requests ` +
      `${JSON.stringify(report.ammoAssist.requestsByType)}; observed server reserve increases ` +
      `${JSON.stringify(report.ammoAssist.serverReserveIncreases)}`,
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
      `magazine ${report.authoritative.magazineDisagreementSamples}; ` +
      `ACK-aligned shot counts ${JSON.stringify(report.authoritative.acknowledgedShotCount)}`,
    `Acknowledged aim angles (unique retained frames): ${JSON.stringify(report.authoritative.acknowledgedAim)}`,
    `Server snapshots observed ${report.authoritative.observed ?? 'unknown'}, retained ${report.authoritative.retained}`,
    `Retained: ${JSON.stringify(report.retention.retained)}`,
    `Dropped: ${JSON.stringify(report.retention.dropped || {})}`,
    `Missing among sent Fire: weapon ${report.outgoingFire.missingWeapon}, distance ${report.outgoingFire.missingDistance}, ` +
      `local prediction ${report.outgoingFire.missingPrediction} ` +
      `(with recorded cooldown ${report.outgoingFire.missingPredictionWithCooldown}, ` +
      `without ${report.outgoingFire.missingPredictionWithoutCooldown}), ` +
      `geometry ${report.outgoingFire.missingGeometry}`,
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
