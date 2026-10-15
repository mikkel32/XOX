// ==UserScript==
// @name         BridgeZone - Xray and Silent AIM
// @namespace    local.bridgezone.tools
// @version      1.5.20
// @description  Xray, corrected aim, combat agent, and ammo pickup assistance.
// @match        https://www.bridgegame.ai/*
// @match        https://bridgegame.ai/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  if (window.__bridgeZoneTools) return;
  const VERSION = '1.5.20';
  const STORAGE_KEY = 'bridgezone.tools.v2';
  const SETTINGS_REVISION = 3;
  const MAX_OUTGOING_TURN = 8 * Math.PI / 180;
  const HIP_RANGE_LIMIT = 40;
  const OUTGOING_AIM_TOLERANCE = 0.008;
  const INTERACT_BUTTON = 64;
  const AMMO_TYPES = ['light', 'heavy', 'shells', 'sniper'];
  const AMMO_CAPS = { light: 240, heavy: 180, shells: 48, sniper: 40 };
  const TRACE_LIMITS = Object.freeze({ frames: 4096, localShots: 512, aimDecisions: 512,
    fireGates: 512, serverSnapshots: 1024, serverEvents: 1024,
    settings: 64, interactions: 128, ammoPickups: 128, agentDecisions: 256,
    kicks: 64, connectionStates: 128, errors: 128 });
  const defaults = { xray: true, loot: true, silent: true, rage: true, rapidFire: true, hipFire: true, hipRange: 40, agent: true, fov: 90, range: 600, point: 'auto', smartAim: true, visibleOnly: true, stealth: true, smooth: 1, ammo: true };
  const options = { ...defaults };
  const runtime = {
    client: null, physics: {}, hookReady: false, stopped: false, aimRejected: false,
    rewrites: 0, compensated: 0, predictions: new Map(), sampleContexts: new Map(),
    target: null, error: '', pipeline: null, renderedAt: 0
  };
  runtime.stealth = { deterministic: 0, misses: 0, cooldown: 0, backoffUntil: 0, lastShotAt: 0, heldShots: 0, phase: Math.random() * Math.PI * 2 };
  runtime.outgoingAim = { yaw: null, pitch: null, targetIndex: null, ready: false, pendingManualUntil: 0 };
  runtime.ammoPickup = { id: null, nextAt: 0 };
  runtime.agent = { action: 'off', goal: null, lastTraceAt: 0, lastTraceKey: '',
    lastPosition: null, lastPositionAt: 0, sidestep: 1, nextInteractAt: 0,
    navigationGoalKey: null, lastGoalDistance: null, detourUntil: 0, stuckCount: 0 };
  runtime.server = { shots: 0, hits: 0, headshots: 0, kills: 0, damage: 0 };
  runtime.seedSync = { status: 'unknown', aligned: 0, diverged: 0 };
  const seenServerEvents = new Set();
  const restores = [];
  const clientRestores = [];
  let host, root, overlay, painter, panel, showButton, status, stats, timer;
  let panelVisible = true;
  let width = 0, height = 0, pixelRatio = 0;
  let updatedAt = 0;
  let physicsImportStarted = false;
  let physicsAttempts = 0, physicsRetryAt = 0;
  let lootCacheClient = null, lootCacheAt = 0, lootCache = [];
  const zonePage = () => !window.location || /^\/zone(?:\/|$)/.test(window.location.pathname);

  runtime.trace = {
    startedAt: new Date().toISOString(),
    match: 0,
    frames: [],
    localShots: [],
    aimDecisions: [],
    fireGates: [],
    serverSnapshots: [],
    serverEvents: [],
    settings: [],
    interactions: [],
    ammoPickups: [],
    agentDecisions: [],
    kicks: [],
    connectionStates: [],
    errors: [],
    retention: { limits: { ...TRACE_LIMITS }, dropped: Object.fromEntries(Object.keys(TRACE_LIMITS).map(key => [key, 0])) },
    counters: { rageSamples: 0, serverSnapshotsSeen: 0, gateReasons: {},
      targetRejects: {}, highestAckByMatch: {} }
  };

  function recordTrace(kind, entry) {
    const items = runtime.trace[kind];
    const limit = TRACE_LIMITS[kind];
    if (!items || !limit) return;
    items.push(entry);
    if (items.length > limit) {
      runtime.trace.retention.dropped[kind] += items.length - limit;
      items.splice(0, items.length - limit);
    }
  }

  function recordFrames(incoming, outgoing) {
    if (!Array.isArray(incoming) || !Array.isArray(outgoing)) return;
    const count = Math.min(incoming.length, outgoing.length);
    for (let i = Math.max(0, count - 256); i < count; i++) {
      const before = incoming[i], after = outgoing[i];
      if (!before || !after) continue;
      recordTrace('frames', {
        at: performance.now(), match: runtime.trace.match,
        sequence: after.s, tick: after.vt, buttons: after.buttons,
        sampledButtons: before.buttons,
        before: [before.yaw, before.pitch, before.mx, before.mz],
        after: [after.yaw, after.pitch, after.mx, after.mz]
      });
    }
  }

  function traceSnapshot() {
    // All retained fields are plain, allowlisted JSON. Clone nested geometry as well.
    return JSON.parse(JSON.stringify(runtime.trace));
  }

  function exportTrace(pretty = true) {
    return JSON.stringify({ formatVersion: 2, scriptVersion: VERSION,
      capturedAt: new Date().toISOString(), clock: 'performance.now milliseconds since page start',
      trace: traceSnapshot() }, null, pretty ? 2 : undefined);
  }

  const archiveState = { lastAttemptAt: -Infinity, savedAt: null, saving: null, error: null };
  const archiveId = runtime.trace.startedAt + ':' + Math.random().toString(36).slice(2, 10);
  let traceArchiveDb = null;
  function openTraceArchive() {
    if (!window.indexedDB) return Promise.reject(new Error('IndexedDB unavailable'));
    if (traceArchiveDb) return traceArchiveDb;
    traceArchiveDb = new Promise((resolve, reject) => {
      const request = window.indexedDB.open('bridgezone-tools-traces', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('sessions'))
          request.result.createObjectStore('sessions', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Trace archive open failed'));
    }).catch(error => { traceArchiveDb = null; throw error; });
    return traceArchiveDb;
  }

  function archiveTrace(force = false) {
    if (!window.indexedDB || !runtime.trace.match) return Promise.resolve(false);
    if (archiveState.saving) return force
      ? archiveState.saving.then(() => archiveTrace(true)) : archiveState.saving;
    const now = performance.now();
    if (!force && now - archiveState.lastAttemptAt < 15000) return Promise.resolve(false);
    archiveState.lastAttemptAt = now;
    const id = archiveId;
    const payload = exportTrace(false);
    const savedAt = new Date().toISOString();
    const saving = openTraceArchive().then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction('sessions', 'readwrite');
      const store = transaction.objectStore('sessions');
      store.put({ id, savedAt, match: runtime.trace.match, payload });
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        for (const key of keys.result.sort().slice(0, -3)) store.delete(key);
      };
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error || new Error('Trace archive write failed'));
      transaction.onabort = () => reject(transaction.error || new Error('Trace archive aborted'));
    })).then(result => {
      archiveState.savedAt = savedAt;
      archiveState.error = null;
      return result;
    }).catch(error => {
      archiveState.error = error?.message || String(error);
      return false;
    }).finally(() => { archiveState.saving = null; });
    archiveState.saving = saving;
    return saving;
  }

  async function latestArchivedTrace() {
    const db = await openTraceArchive();
    return new Promise((resolve, reject) => {
      const request = db.transaction('sessions', 'readonly').objectStore('sessions').getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) =>
        b.savedAt.localeCompare(a.savedAt))[0]?.payload || null);
      request.onerror = () => reject(request.error || new Error('Trace archive read failed'));
    });
  }

  function recordSettings(reason) {
    const values = Object.fromEntries(['silent', 'rage', 'rapidFire', 'hipFire', 'hipRange', 'agent', 'fov', 'range',
      'point', 'smartAim', 'visibleOnly', 'stealth', 'smooth', 'ammo'].map(key => [key, options[key]]));
    const previous = runtime.trace.settings.at(-1);
    if (reason !== 'match-start' && previous && JSON.stringify(previous.values) === JSON.stringify(values)) return;
    recordTrace('settings', { at: performance.now(), match: runtime.trace.match, reason, values });
  }

  function restoreHooks(hooks) {
    while (hooks.length) {
      try { hooks.pop()(); }
      catch (error) { runtime.error = 'Cleanup hook: ' + (error?.message || error); }
    }
  }

  function detachClient() {
    if (runtime.client) void archiveTrace(true);
    restoreHooks(clientRestores);
    runtime.client = null;
    runtime.pipeline = null;
    runtime.renderedAt = 0;
    runtime.predictions.clear();
    runtime.sampleContexts.clear();
    runtime.pendingSampleContext = null;
    runtime.target = null;
    runtime.ammoPickup = { id: null, nextAt: 0 };
    runtime.agent.action = 'off';
    runtime.agent.goal = null;
    runtime.agent.lastPosition = null;
    runtime.agent.navigationGoalKey = null;
    runtime.agent.lastGoalDistance = null;
    runtime.agent.detourUntil = 0;
    lootCacheClient = null;
    lootCache = [];
  }

  function setOptions(patch, persist = true) {
    if (!patch || typeof patch !== 'object') return;
    const wasStealth = options.stealth;
    for (const name of ['xray', 'loot', 'silent', 'rage', 'rapidFire', 'hipFire', 'agent', 'smartAim', 'visibleOnly', 'stealth', 'ammo']) {
      if (typeof patch[name] === 'boolean') options[name] = patch[name];
    }
    if (patch.agent === true) options.silent = options.rage = true;
    else if (patch.silent === false || patch.rage === false) options.agent = false;
    if (Number.isFinite(patch.fov)) options.fov = Math.max(1, Math.min(90, patch.fov));
    if (Number.isFinite(patch.range)) options.range = Math.max(10, Math.min(600, patch.range));
    if (Number.isFinite(patch.hipRange)) options.hipRange = Math.max(10, Math.min(HIP_RANGE_LIMIT, patch.hipRange));
    if (['head', 'chest', 'auto'].includes(patch.point)) options.point = patch.point;
    if (Number.isFinite(patch.smooth)) options.smooth = Math.max(0, Math.min(1, patch.smooth));
    if (runtime.aimRejected) options.silent = options.rage = options.agent = false;
    recordSettings('change');
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY,
        JSON.stringify({ ...options, settingsRevision: SETTINGS_REVISION })); } catch { /* Storage is optional. */ }
    }
    syncControls();
    if (!options.xray && !options.loot) painter?.clearRect(0, 0, width, height);
    if (!options.silent || wasStealth !== options.stealth) {
      runtime.target = null;
      runtime.outgoingAim = { yaw: null, pitch: null, targetIndex: null, ready: false, pendingManualUntil: 0 };
    }
  }

  function migrateSavedSettings(saved) {
    if (!saved || typeof saved !== 'object') return {};
    if (saved.settingsRevision === SETTINGS_REVISION ||
        saved.silent === false && saved.rage === false) return saved;
    return { ...saved, silent: true, rage: true, agent: true };
  }

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const migrated = migrateSavedSettings(saved);
    // Keep saved aim settings and migrate narrow legacy cones to the current default.
    setOptions({ ...migrated, smooth: 1,
      fov: Math.max(Number.isFinite(saved.fov) ? saved.fov : defaults.fov, defaults.fov) }, false);
  } catch { /* Use defaults. */ }

  function ownState(client) {
    return client.predictorReady && client.predictor?.ps ? client.predictor.ps : client.latest?.me;
  }

  function enemy(client, snap, forAim = false) {
    return snap && Number.isInteger(snap.i) && snap.i !== client.you &&
      !client.team?.isAlly(snap.i) && !client.eliminated?.has(snap.i) &&
      snap.m !== 'dead' && snap.m !== 'plane' &&
      (!forAim || !(snap.f & 256)) &&
      (snap.hp === undefined || snap.hp > 0) &&
      Array.isArray(snap.p) && snap.p.length === 3 && snap.p.every(Number.isFinite);
  }

  function bodyHeight(crouch = 0) {
    return 1.8 - 0.65 * Math.max(0, Math.min(1, crouch));
  }

  function aimPoint(snap, point = options.point) {
    const h = bodyHeight(snap.c);
    return [snap.p[0], snap.p[1] + (point === 'head' || point === 'auto' ? h - 0.14 : h * 0.75 - 0.14), snap.p[2]];
  }

  function clearAimPoint(world, hasLineOfSight, origin, snap, part) {
    const center = aimPoint(snap, part);
    if (hasLineOfSight(world, origin, center)) return { point: center, visibility: 'clear' };
    // Probe points safely inside the captured hitbox when cover blocks its
    // center. A visible edge can still be a valid shot at the requested part.
    const inset = part === 'head' ? 0.07 : 0.12;
    const dx = center[0] - origin[0], dz = center[2] - origin[2];
    const horizontal = Math.hypot(dx, dz);
    const candidates = [[center[0], center[1] + inset, center[2]]];
    if (horizontal > 0.01) {
      const sideX = -dz / horizontal * inset, sideZ = dx / horizontal * inset;
      candidates.push([center[0] + sideX, center[1], center[2] + sideZ],
        [center[0] - sideX, center[1], center[2] - sideZ]);
    }
    candidates.push([center[0], center[1] - inset, center[2]]);
    if (horizontal > 0.01) {
      // These points remain inside the captured head (0.14 m half-width,
      // 0.28 m height) or torso (0.25 m half-width) hitbox.
      const diagonal = part === 'head' ? 0.09 : 0.12;
      const sideX = -dz / horizontal * diagonal, sideZ = dx / horizontal * diagonal;
      for (const vertical of [diagonal, -diagonal]) {
        candidates.push([center[0] + sideX, center[1] + vertical, center[2] + sideZ],
          [center[0] - sideX, center[1] + vertical, center[2] - sideZ]);
      }
    }
    for (const point of candidates) {
      if (hasLineOfSight(world, origin, point)) return { point, visibility: 'partial' };
    }
    return null;
  }

  function vector3(value) {
    return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? [...value] : null;
  }

  function ammoSnapshot(ammo) {
    return Object.fromEntries(AMMO_TYPES.filter(type => Number.isFinite(ammo?.[type]))
      .map(type => [type, ammo[type]]));
  }

  function noteScan(scan, snap, distance, reason) {
    if (!scan) return;
    scan.counts[reason] = (scan.counts[reason] || 0) + 1;
    if (Number.isFinite(distance) && (!scan.closest || distance < scan.closest.distance)) {
      scan.closest = { index: snap.i, distance: Math.round(distance * 10) / 10,
        speed: Math.round(Math.hypot(...(vector3(snap.v) || [0, 0, 0])) * 10) / 10, reason };
    }
  }

  function selectTarget(client, frame, shotOrigin, scan) {
    const me = ownState(client);
    if (!vector3(me?.pos)) {
      if (scan) scan.unavailable = 'local-position';
      return null;
    }
    const origin = shotOrigin || [me.pos[0], me.pos[1] + 1.62 - 0.62 * Math.max(0, Math.min(1, me.crouch || 0)), me.pos[2]];
    const cp = Math.cos(frame.pitch);
    const forward = [-Math.sin(frame.yaw) * cp, Math.sin(frame.pitch), -Math.cos(frame.yaw) * cp];
    const minDot = options.rage ? -1 : Math.cos(options.fov * Math.PI / 180);
    // The captured kernel uses rangeEnd for damage falloff, not target reach.
    const maxRange = options.range;
    const weaponRange = client.predictor?.activeStats?.rangeEnd;
    const effectiveRange = Number.isFinite(weaponRange)
      ? Math.max(25, Math.min(maxRange, weaponRange)) : maxRange;
    const approachYaw = runtime.outgoingAim.yaw ?? frame.yaw;
    const approachPitch = runtime.outgoingAim.pitch ?? frame.pitch;
    const ownVelocity = vector3(me.vel) || vector3(me.v) || [0, 0, 0];
    const ownSpeed = Math.hypot(ownVelocity[0], ownVelocity[2]);
    let best = null;
    let bestScore = Infinity;
    for (const { snap: current } of client.remoteFrames || []) {
      if (scan) scan.observed++;
      if (!enemy(client, current, true)) {
        noteScan(scan, current || {}, null, 'invalid');
        continue;
      }
      let snap = current;
      let sampled = false;
      if (client.interpolator?.sample && Number.isFinite(frame.vt)) {
        const sample = { ...current, p: [...current.p], v: [...(current.v || [0, 0, 0])] };
        // Match the server's rewind tick without changing the client's render snapshots.
        if (!client.interpolator.sample(current.i, frame.vt, sample)) {
          noteScan(scan, current, Math.hypot(...current.p.map((value, i) => value - origin[i])), 'interpolation');
          continue;
        }
        snap = sample;
        sampled = true;
      }
      if (!enemy(client, snap, true)) {
        noteScan(scan, current, Math.hypot(...current.p.map((value, i) => value - origin[i])), 'invalid');
        continue;
      }
      const speed = Math.hypot(...(snap.v || [0, 0, 0]));
      const distanceToFeet = Math.hypot(...snap.p.map((value, i) => value - origin[i]));
      // Head and Chest are explicit choices. Only Auto may change aim points.
      const adaptive = options.point === 'auto' && options.smartAim;
      const preferred = adaptive
        ? (distanceToFeet > 50 || speed > 4 || ownSpeed > 3 ? 'chest' : 'head')
        : options.point === 'chest' ? 'chest' : 'head';
      let point = aimPoint(snap, preferred);
      const delta = point.map((value, i) => value - origin[i]);
      let distance = Math.hypot(...delta);
      if (distance < 0.01 || distance > maxRange) {
        noteScan(scan, snap, distance, 'range');
        continue;
      }
      let dot = delta.reduce((sum, value, i) => sum + value * forward[i], 0) / distance;
      if (dot < minDot) {
        noteScan(scan, snap, distance, 'fov');
        continue;
      }
      let aimPart = preferred, visibility = options.visibleOnly ? 'clear' : 'unchecked';
      if (options.visibleOnly) {
        const { getCollisionWorld, hasLineOfSight } = runtime.physics;
        // If collision hooks are unavailable, don't select a target through unknown cover.
        if (!getCollisionWorld || !hasLineOfSight) {
          noteScan(scan, snap, distance, 'physics-unavailable');
          continue;
        }
        const world = getCollisionWorld();
        let clear = clearAimPoint(world, hasLineOfSight, origin, snap, preferred);
        if (!clear && adaptive) {
          aimPart = preferred === 'chest' ? 'head' : 'chest';
          clear = clearAimPoint(world, hasLineOfSight, origin, snap, aimPart);
          if (clear) clear.visibility = clear.visibility === 'partial' ? 'fallback-partial' : 'fallback';
        }
        if (!clear) {
          if (scan && (!scan.coverCandidate || distance < scan.coverCandidate.distance))
            scan.coverCandidate = { world, origin: [...origin], point: aimPoint(snap, preferred),
              distance, index: snap.i, preferred };
          noteScan(scan, snap, distance, 'cover');
          continue;
        }
        point = clear.point;
        visibility = clear.visibility;
      }
      const aimDelta = point.map((value, i) => value - origin[i]);
      distance = Math.hypot(...aimDelta);
      if (distance > maxRange) {
        noteScan(scan, snap, distance, 'range');
        continue;
      }
      dot = aimDelta.reduce((sum, value, i) => sum + value * forward[i], 0) / distance;
      if (dot < minDot) {
        noteScan(scan, snap, distance, 'fov');
        continue;
      }
      const pitch = Math.atan2(aimDelta[1], Math.hypot(aimDelta[0], aimDelta[2]));
      if (Math.abs(pitch) > 1.54) {
        noteScan(scan, snap, distance, 'pitch');
        continue;
      }
      const yaw = Math.atan2(-aimDelta[0], -aimDelta[2]);
      noteScan(scan, snap, distance, 'eligible');
      // The captured hitbox narrows with distance. Favor targets inside the
      // active weapon's damage range without imposing an artificial cutoff.
      // Prefer a fully visible center when another target is comparably good.
      const partialPenalty = visibility.endsWith('partial') ? (options.rage ? 0.12 : 0.005) : 0;
      const score = options.rage
        ? 0.45 * Math.max(Math.abs(normalizedDelta(approachYaw, yaw)), Math.abs(approachPitch - pitch)) +
          0.9 * Math.log1p(distance / effectiveRange) +
          (ownSpeed > 1 ? 0.2 * Math.min(3, distance / effectiveRange) : 0) +
          0.02 * Math.min(speed, 20) -
          (snap.i === runtime.outgoingAim.targetIndex ? 0.15 : 0) + partialPenalty
        : 1 - dot + partialPenalty;
      if (score >= bestScore) continue;
      bestScore = score;
      best = {
        index: snap.i, distance, direction: aimDelta.map(value => value / distance),
        yaw, pitch, origin: [...origin], point: [...point],
        hitboxCenter: aimPoint(snap, aimPart), position: [...snap.p],
        velocity: vector3(snap.v), bodyHeight: bodyHeight(snap.c),
        aimPart,
        visibility, sampled
      };
    }
    if (scan?.coverCandidate) {
      const candidate = scan.coverCandidate;
      delete scan.coverCandidate;
      const delta = candidate.point.map((value, index) => value - candidate.origin[index]);
      const length = Math.hypot(...delta);
      let blocker = null;
      if (length > 0.05 && typeof runtime.physics.raycastWorld === 'function') {
        try {
          const hit = runtime.physics.raycastWorld(candidate.world, candidate.origin,
            delta.map(value => value / length), length - 0.05);
          if (hit && Number.isFinite(hit.dist)) blocker = {
            distanceMeters: Math.round(hit.dist * 100) / 100,
            point: vector3(hit.point), normal: vector3(hit.normal),
            material: typeof hit.material === 'string' && /^[a-z0-9_-]{1,32}$/i.test(hit.material)
              ? hit.material : 'other'
          };
        } catch { /* A diagnostic ray must not affect target selection. */ }
      }
      scan.closestCover = { index: candidate.index,
        distanceMeters: Math.round(candidate.distance * 10) / 10,
        preferredPart: candidate.preferred, blocker };
    }
    if (scan && best) scan.selected = { index: best.index, distance: Math.round(best.distance * 10) / 10,
      aimPart: best.aimPart, visibility: best.visibility };
    return best;
  }

  function playable(client) {
    const me = ownState(client);
    const remaining = value => typeof value === 'number' ? value : value?.left || 0;
    return options.silent && !runtime.aimRejected && !runtime.stopped && !client.disposed && !client.paused &&
      !client.cinema?.active && client.you != null && client.input?.enabled !== false &&
      me?.mode === 'ground' && !(remaining(me.vault) > 0) && !(remaining(me.mantle) > 0) &&
      me.spectating == null && !me.downed && !(me.health <= 0) &&
      !client.localDead?.() && !client.localDowned?.() && client.latest?.phase !== 'finished';
  }

  function compensateSpread(shot, target, turnFrom = null) {
    if (!Array.isArray(shot?.directions) || !shot.directions.length ||
        !shot.directions.every(direction => Array.isArray(direction) &&
          direction.length === 3 && direction.every(Number.isFinite))) return null;
    // The shared kernel rotates the same sampled spread offsets with outgoing
    // yaw/pitch. For pellets, try centering each ray and keep the angle that
    // intersects the most of the selected hitbox.
    const directions = shot.directions.slice(0, 32);
    const average = directions.reduce((sum, direction) => sum.map((value, i) => value + direction[i]), [0, 0, 0]);
    const y = shot.yaw, p = shot.pitch;
    const forward = [-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
    const right = [Math.cos(y), 0, -Math.sin(y)];
    const up = [Math.sin(y) * Math.sin(p), Math.cos(p), Math.cos(y) * Math.sin(p)];
    const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
    let best = null, bestHits = -1, bestMiss = Infinity;
    for (const direction of directions.length === 1 ? directions : [average, ...directions]) {
      const denom = dot(direction, forward);
      if (denom <= 0 || !Number.isFinite(denom)) continue;
      const u = dot(direction, right) / denom, m = dot(direction, up) / denom;
      const arg = Math.hypot(1, u, m) * target.direction[1] / Math.hypot(1, m);
      if (!Number.isFinite(arg) || Math.abs(arg) > 1) continue;
      const pitch = Math.asin(arg) - Math.atan(m);
      if (Math.abs(pitch) > 1.54) continue;
      const a = -Math.cos(pitch) + m * Math.sin(pitch);
      const rawYaw = target.yaw + Math.atan2(u, -a);
      const yaw = Math.atan2(Math.sin(rawYaw), Math.cos(rawYaw));
      if (turnFrom && (Math.abs(normalizedDelta(turnFrom.yaw, yaw)) > MAX_OUTGOING_TURN ||
          Math.abs(pitch - turnFrom.pitch) > MAX_OUTGOING_TURN)) continue;
      if (directions.length === 1) return { yaw, pitch };
      const hits = projectedPelletHits(shot, target, yaw, pitch) ?? 0;
      const miss = predictedMiss(shot, target, yaw, pitch)?.meanMeters ?? Infinity;
      if (hits > bestHits || (hits === bestHits && miss < bestMiss)) {
        best = { yaw, pitch };
        bestHits = hits;
        bestMiss = miss;
      }
    }
    return best;
  }

  function safeWeaponId(value) {
    return typeof value === 'string' && /^[a-z0-9_-]{1,32}$/i.test(value) ? value : null;
  }

  function weaponSnapshot(client) {
    const predictor = client.predictor;
    const weapon = predictor?.activeStats;
    const ws = predictor?.ws;
    const active = Number.isInteger(predictor?.active) ? predictor.active : client.latest?.me?.active;
    const slot = predictor?.slots?.[active] || client.latest?.me?.slots?.[active];
    const slotId = safeWeaponId(slot?.weapon);
    const statsId = safeWeaponId(weapon?.id);
    const stats = {};
    for (const key of ['rangeStart', 'rangeEnd', 'minDamage', 'damage', 'hipSpread', 'adsSpread',
      'moveSpread', 'pelletSpread', 'adsSeconds', 'moveSpeed', 'pellets', 'rpm', 'magSize',
      'headMult', 'limbMult', 'recoilV', 'recoilH', 'zoom', 'weight', 'reloadSeconds', 'equipSeconds']) {
      if (Number.isFinite(weapon?.[key])) stats[key] = weapon[key];
    }
    return {
      id: slotId || statsId, idSource: slotId ? 'slot' : statsId ? 'stats' : null,
      rarity: typeof slot?.rarity === 'string' && /^[a-z0-9_-]{1,32}$/i.test(slot.rarity)
        ? slot.rarity : Number.isSafeInteger(slot?.rarity) ? slot.rarity : null,
      class: typeof weapon?.class === 'string' && /^[a-z0-9_-]{1,32}$/i.test(weapon.class)
        ? weapon.class : null,
      fireMode: ['auto', 'semi', 'pump', 'bolt'].includes(weapon?.fireMode) ? weapon.fireMode : null,
      stats,
      ads: Number.isFinite(ws?.ads) ? ws.ads : null,
      bloom: Number.isFinite(ws?.bloom) ? ws.bloom : null,
      cooldown: Number.isFinite(ws?.cooldown) ? ws.cooldown : null,
      reload: Number.isFinite(ws?.reload) ? ws.reload : null,
      shots: Number.isFinite(ws?.shots) ? ws.shots : null,
      burst: Number.isFinite(ws?.burst) ? ws.burst : null,
      trigger: typeof ws?.trigger === 'boolean' ? ws.trigger : null,
      magazine: Number.isFinite(slot?.mag) ? slot.mag : null,
      reserve: Number.isFinite(predictor?.ammo?.[weapon?.ammo]) ? predictor.ammo[weapon.ammo] : null
    };
  }

  function playerSnapshot(client) {
    const me = ownState(client);
    return { position: vector3(me?.pos), velocity: vector3(me?.vel) || vector3(me?.v),
      mode: ['ground', 'air', 'parachute', 'dead'].includes(me?.mode) ? me.mode : null,
      crouch: Number.isFinite(me?.crouch) ? me.crouch : null,
      grounded: typeof me?.grounded === 'boolean' ? me.grounded : null,
      sprinting: typeof me?.sprinting === 'boolean' ? me.sprinting : null };
  }

  function recordServerSnapshot(client, snapshot) {
    const me = snapshot?.me;
    if (!me || typeof me !== 'object') return;
    runtime.trace.counters.serverSnapshotsSeen++;
    const ack = Number.isSafeInteger(me.ack) ? me.ack : null;
    const match = runtime.trace.match;
    if (ack !== null) {
      const highest = runtime.trace.counters.highestAckByMatch;
      if (!(match in highest) && Object.keys(highest).length >= 64) {
        delete highest[Object.keys(highest)[0]];
        runtime.trace.retention.dropped.ackMatches = (runtime.trace.retention.dropped.ackMatches || 0) + 1;
      }
      highest[match] = Math.max(highest[match] ?? -1, ack);
    }
    const now = performance.now();
    const combat = (snapshot.events || []).some(event => event?.by === client.you &&
      ['shot', 'hit', 'kill'].includes(event.type));
    if (!combat && runtime.lastServerSnapshot && now - runtime.lastServerSnapshot.at < 100) return;
    runtime.lastServerSnapshot = { at: now };
    const slot = me.slots?.[me.active];
    const predicted = client.predictor;
    const predictedSlot = predicted?.slots?.[predicted.active];
    const sentAt = ack === null ? null : client.sentAt?.get?.(ack);
    const acknowledgedFrame = ack === null ? null : [...runtime.trace.frames].reverse().find(frame =>
      frame.match === match && frame.sequence === ack && Array.isArray(frame.after) &&
      Number.isFinite(frame.after[0]) && Number.isFinite(frame.after[1]));
    const acknowledgedShot = ack === null ? null : [...runtime.trace.localShots].reverse().find(shot =>
      shot.match === match && Number.isSafeInteger(shot.sequence) && shot.sequence <= ack &&
      Number.isSafeInteger(shot.weapon?.shots));
    const shotCountDelta = acknowledgedShot && Number.isSafeInteger(me.shots)
      ? me.shots - acknowledgedShot.weapon.shots : null;
    if (shotCountDelta === 0) {
      runtime.seedSync.aligned++;
      runtime.seedSync.status = 'aligned';
    } else if (shotCountDelta !== null) {
      runtime.seedSync.diverged++;
      runtime.seedSync.status = 'diverged';
    }
    recordTrace('serverSnapshots', {
      at: now, match, tick: Number.isFinite(snapshot.t) ? snapshot.t : null, ack,
      ackLatencyMs: Number.isFinite(sentAt) && now >= sentAt ? now - sentAt : null,
      reportedRttMs: Number.isFinite(client.rtt) ? client.rtt : null,
      weaponId: safeWeaponId(slot?.weapon),
      server: { ads: Number.isFinite(me.ads) ? me.ads : null,
        yaw: Number.isFinite(me.yaw) ? me.yaw : null,
        pitch: Number.isFinite(me.pitch) ? me.pitch : null,
        bloom: Number.isFinite(me.bloom) ? me.bloom : null,
        shots: Number.isSafeInteger(me.shots) ? me.shots : null,
        magazine: Number.isFinite(slot?.mag) ? slot.mag : null,
        ammo: ammoSnapshot(me.ammo),
        reload: Number.isFinite(me.reload) ? me.reload : null,
        position: vector3(me.pos), velocity: vector3(me.vel),
        crouch: Number.isFinite(me.crouch) ? me.crouch : null,
        grounded: typeof me.grounded === 'boolean' ? me.grounded : null,
        sprinting: typeof me.sprinting === 'boolean' ? me.sprinting : null,
        health: Number.isFinite(me.health) ? me.health : null },
      predictorBeforeReconcile: predicted ? {
        ads: Number.isFinite(predicted.ws?.ads) ? predicted.ws.ads : null,
        yaw: Number.isFinite(predicted.ps?.yaw) ? predicted.ps.yaw : null,
        pitch: Number.isFinite(predicted.ps?.pitch) ? predicted.ps.pitch : null,
        bloom: Number.isFinite(predicted.ws?.bloom) ? predicted.ws.bloom : null,
        shots: Number.isSafeInteger(predicted.ws?.shots) ? predicted.ws.shots : null,
        magazine: Number.isFinite(predictedSlot?.mag) ? predictedSlot.mag : null,
        ammo: ammoSnapshot(predicted.ammo),
        position: vector3(predicted.ps?.pos)
      } : null,
      selfCombatEvents: combat,
      acknowledgedFrame: acknowledgedFrame ? {
        sequence: acknowledgedFrame.sequence,
        sentYaw: acknowledgedFrame.after[0], sentPitch: acknowledgedFrame.after[1],
        serverYawDifferenceDegrees: Number.isFinite(me.yaw)
          ? normalizedDelta(acknowledgedFrame.after[0], me.yaw) * 180 / Math.PI : null,
        serverPitchDifferenceDegrees: Number.isFinite(me.pitch)
          ? (me.pitch - acknowledgedFrame.after[1]) * 180 / Math.PI : null
      } : null,
      acknowledgedShot: acknowledgedShot ? { sequence: acknowledgedShot.sequence,
        shots: acknowledgedShot.weapon.shots, delta: shotCountDelta } : null
    });
  }

  function targetSnapshot(target) {
    return target ? { index: target.index, distance: target.distance,
      origin: vector3(target.origin), point: vector3(target.point),
      hitboxCenter: vector3(target.hitboxCenter),
      position: vector3(target.position), velocity: vector3(target.velocity),
      bodyHeight: Number.isFinite(target.bodyHeight) ? target.bodyHeight : null,
      aimPart: target.aimPart, visibility: target.visibility, sampled: target.sampled } : null;
  }

  function aimBasis(yaw, pitch) {
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
    return { forward: [-sy * cp, sp, -cy * cp], right: [cy, 0, -sy], up: [sy * sp, cp, cy * sp] };
  }

  function angularMiss(target, yaw, pitch) {
    if (!target || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;
    const forward = aimBasis(yaw, pitch).forward;
    const dot = Math.max(-1, Math.min(1, forward.reduce((sum, value, i) => sum + value * target.direction[i], 0)));
    const radians = Math.acos(dot);
    return { degrees: radians * 180 / Math.PI,
      centerOffsetMeters: dot > 0 ? target.distance * Math.sin(radians) : null };
  }

  function predictedMiss(shot, target, yaw, pitch) {
    if (!shot || !target || !Number.isFinite(yaw) || !Number.isFinite(pitch) ||
        !Number.isFinite(shot.yaw) || !Number.isFinite(shot.pitch) ||
        !Array.isArray(shot.directions)) return null;
    const source = aimBasis(shot.yaw, shot.pitch), destination = aimBasis(yaw, pitch);
    const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
    let min = Infinity, max = 0, sum = 0, ahead = 0, behind = 0;
    for (const direction of shot.directions.slice(0, 32)) {
      if (!vector3(direction)) continue;
      const components = [dot(direction, source.right), dot(direction, source.up), dot(direction, source.forward)];
      const rotated = destination.forward.map((value, i) =>
        components[0] * destination.right[i] + components[1] * destination.up[i] + components[2] * value);
      const length = Math.hypot(...rotated);
      const alignment = length ? dot(rotated, target.direction) / length : -1;
      if (alignment <= 0) { behind++; continue; }
      const miss = target.distance * Math.sqrt(Math.max(0, 1 - Math.min(1, alignment * alignment)));
      min = Math.min(min, miss);
      max = Math.max(max, miss);
      sum += miss;
      ahead++;
    }
    return { pellets: ahead + behind, behind,
      minMeters: ahead ? min : null, meanMeters: ahead ? sum / ahead : null, maxMeters: ahead ? max : null };
  }

  function projectedPelletHits(shot, target, yaw, pitch) {
    const eye = vector3(shot?.eye), center = vector3(target?.hitboxCenter || target?.point);
    if (!eye || !center || !Array.isArray(shot.directions) ||
        !Number.isFinite(shot.yaw) || !Number.isFinite(shot.pitch) ||
        !Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;
    const source = aimBasis(shot.yaw, shot.pitch), destination = aimBasis(yaw, pitch);
    const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
    const halfWidth = target.aimPart === 'head' ? 0.14 : 0.25;
    const halfHeight = target.aimPart === 'head' ? 0.14 :
      Math.max(0.1, (Number.isFinite(target.bodyHeight) ? target.bodyHeight : 1.8) / 4 - 0.14);
    const half = [halfWidth, halfHeight, halfWidth];
    let hits = 0;
    for (const direction of shot.directions.slice(0, 32)) {
      if (!vector3(direction)) continue;
      const components = [dot(direction, source.right), dot(direction, source.up), dot(direction, source.forward)];
      const ray = destination.forward.map((value, i) =>
        components[0] * destination.right[i] + components[1] * destination.up[i] + components[2] * value);
      let near = 0, far = 600;
      for (let axis = 0; axis < 3; axis++) {
        const low = center[axis] - half[axis], high = center[axis] + half[axis];
        if (Math.abs(ray[axis]) < 1e-9) {
          if (eye[axis] < low || eye[axis] > high) { far = -1; break; }
        } else {
          const first = (low - eye[axis]) / ray[axis], last = (high - eye[axis]) / ray[axis];
          near = Math.max(near, Math.min(first, last));
          far = Math.min(far, Math.max(first, last));
          if (near > far) break;
        }
      }
      if (near <= far && far >= 0) hits++;
    }
    return hits;
  }

  function recordAimDecision(client, frame, target, shot, correction, buttons, yaw, pitch, reason) {
    const weapon = weaponSnapshot(client);
    const player = playerSnapshot(client);
    const sampled = runtime.sampleContexts.get(frame.s);
    runtime.sampleContexts.delete(frame.s);
    const targetNow = targetSnapshot(target);
    const sameTarget = sampled?.target && targetNow && sampled.target.index === targetNow.index;
    const selectionDriftMeters = sameTarget && sampled.target.position && targetNow.position
      ? Math.hypot(...targetNow.position.map((value, i) => value - sampled.target.position[i])) : null;
    recordTrace('aimDecisions', {
      at: performance.now(), match: runtime.trace.match, sequence: frame.s, tick: frame.vt,
      targetDistance: target ? Math.round(target.distance * 10) / 10 : null,
      weaponId: weapon.id, weaponRangeEnd: weapon.stats.rangeEnd ?? null,
      requestedPoint: options.point,
      localAds: weapon.ads === null ? null : Math.round(weapon.ads * 1000) / 1000,
      localSpeed: player.velocity ? Math.hypot(player.velocity[0], player.velocity[2]) : null,
      movingInput: Math.hypot(frame.mx, frame.mz) > 0.1,
      adsRequested: !!(buttons & 2), localShotPredicted: !!shot,
      correctionApplied: !!correction, fireSent: !!(buttons & 1), reason,
      input: { yaw: frame.yaw, pitch: frame.pitch, mx: frame.mx, mz: frame.mz, buttons: frame.buttons },
      outgoing: { yaw, pitch, buttons },
      weapon, player, target: targetNow,
      sampled: sampled ? { gate: sampled.reason, weaponAds: sampled.weaponAds,
        earlyAds: sampled.earlyAds, hipFire: sampled.hipFire,
        hipSeeded: sampled.hipSeeded, hipDeviationDegrees: sampled.hipDeviationDegrees,
        target: sampled.target, delayMs: Math.max(0, performance.now() - sampled.at),
        selectionDriftMeters } : null,
      correction: correction ? { yaw: correction.yaw, pitch: correction.pitch } : null,
      geometry: target ? {
        inputAim: angularMiss(target, frame.yaw, frame.pitch),
        outgoingAim: angularMiss(target, yaw, pitch),
        predictedInput: predictedMiss(shot, target, frame.yaw, frame.pitch),
        predictedOutgoing: predictedMiss(shot, target, yaw, pitch),
        projectedPelletHitsInput: projectedPelletHits(shot, target, frame.yaw, frame.pitch),
        projectedPelletHitsOutgoing: projectedPelletHits(shot, target, yaw, pitch)
      } : null
    });
  }

  function jitterAngle(value, amount) {
    // Deterministic-looking noise avoids a perfectly periodic aim signature.
    const phase = performance.now() / 1000 * 2.1 + runtime.stealth.phase + value * 17.3;
    return (Math.sin(phase) * 0.45 + Math.sin(phase * 2.7 + 1.3) * 0.3 + (Math.random() - 0.5) * 0.25) * amount;
  }

  function normalizedDelta(from, to) {
    return Math.atan2(Math.sin(to - from), Math.cos(to - from));
  }

  function aimTolerance(target) {
    return Math.min(OUTGOING_AIM_TOLERANCE, Math.atan2(0.15, Math.max(1, target.distance)));
  }

  function alignedWithTarget(state, target) {
    return !!target && state.ready && state.targetIndex === target.index &&
      Math.abs(normalizedDelta(state.yaw, target.yaw)) <= aimTolerance(target) &&
      Math.abs(state.pitch - target.pitch) <= aimTolerance(target);
  }

  function paceShot() {
    return !(options.rage && options.rapidFire);
  }

  function sampledTargetPreferred(current, sampled) {
    return sampled && (!current || current.index !== sampled.index ||
      Math.abs(normalizedDelta(current.yaw, sampled.yaw)) > MAX_OUTGOING_TURN ||
      Math.abs(current.pitch - sampled.pitch) > MAX_OUTGOING_TURN);
  }

  function stealthSkip() {
    const state = runtime.stealth;
    const now = performance.now();
    if (now < state.backoffUntil || now < state.cooldown) return true;
    if (state.deterministic >= 3) {
      state.deterministic = 0;
      state.backoffUntil = now + 450 + Math.random() * 550;
      return true;
    }
    return false;
  }

  function holdStealthShot(client, frame) {
    if (!options.stealth || !playable(client) || !frame ||
        ![frame.yaw, frame.pitch].every(Number.isFinite)) return frame;
    if (frame.buttons & INTERACT_BUTTON) return frame.buttons & 1
      ? { ...frame, buttons: frame.buttons & ~1 } : frame;
    const state = runtime.outgoingAim;
    const now = performance.now();
    if (options.rage) {
      state.pendingManualUntil = 0;
      if (!(frame.buttons & 1)) return frame;
      const tick = Number.isFinite(frame.vt) ? frame.vt : client.renderTick?.();
      const target = selectTarget(client, { ...frame, vt: tick });
      const reachable = target && state.yaw !== null && state.pitch !== null &&
        Math.abs(normalizedDelta(state.yaw, target.yaw)) <= MAX_OUTGOING_TURN &&
        Math.abs(state.pitch - target.pitch) <= MAX_OUTGOING_TURN;
      // Exact prior-frame alignment deadlocks on moving targets. Let one-turn
      // shots reach the outgoing rewrite, which checks current alignment and
      // holds any shot it cannot aim on the wire.
      if (!reachable) {
        runtime.sampleHoldReason = target ? 'aligning' : 'target-lost-at-sample';
        runtime.stealth.heldShots++;
        return { ...frame, buttons: frame.buttons & ~1 };
      }
      return frame;
    }
    if (state.pendingManualUntil && now > state.pendingManualUntil) state.pendingManualUntil = 0;
    const requestedFire = !!(frame.buttons & 1);
    if (!requestedFire && !state.pendingManualUntil) return frame;
    const tick = Number.isFinite(frame.vt) ? frame.vt : client.renderTick?.();
    const target = selectTarget(client, { ...frame, vt: tick });
    if (!target) {
      state.pendingManualUntil = 0;
      runtime.sampleHoldReason = 'target-lost-at-sample';
      return options.rage && requestedFire ? { ...frame, buttons: frame.buttons & ~1 } : frame;
    }
    const ready = alignedWithTarget(state, target);
    if (requestedFire && !options.rage && !ready) state.pendingManualUntil = now + 900;
    if (!requestedFire && !state.pendingManualUntil) return frame;
    if (!ready || (paceShot() && stealthSkip())) {
      if (requestedFire && !options.rage) state.pendingManualUntil = now + 900;
      if (!requestedFire) return frame;
      runtime.sampleHoldReason = !ready ? 'aligning' : 'stealth-delay';
      runtime.stealth.heldShots++;
      return { ...frame, buttons: frame.buttons & ~1 };
    }
    return requestedFire ? frame : { ...frame, buttons: frame.buttons | 1 };
  }

  function holdOnAimError(frame) {
    if (!options.silent || !options.stealth || !(frame?.buttons & 1)) return frame;
    runtime.stealth.heldShots++;
    return { ...frame, buttons: frame.buttons & ~1 };
  }

  function recordStealthShot(originalAngles, finalAngles) {
    const state = runtime.stealth;
    const now = performance.now();
    state.cooldown = now + 80 + Math.random() * 120;
    state.lastShotAt = now;
    const changed = Math.abs(normalizedDelta(originalAngles.yaw, finalAngles.yaw)) > 0.01 ||
      Math.abs(normalizedDelta(originalAngles.pitch, finalAngles.pitch)) > 0.01;
    if (changed) {
      state.deterministic++;
      state.misses = 0;
    } else if (++state.misses >= 4) {
      state.misses = 0;
      state.deterministic = Math.max(0, state.deterministic - 3);
    }
  }

  function applyStealth(frame, angles) {
    if (options.rage && options.rapidFire) return {
      yaw: angles.yaw, pitch: angles.pitch,
      original: { yaw: frame.yaw, pitch: frame.pitch }
    };
    // Exact landing is required; jitter is only large enough to break identical outgoing vectors.
    const jitter = 0.00045 + Math.random() * 0.00045;
    const yawDelta = normalizedDelta(frame.yaw, angles.yaw) + jitterAngle(angles.yaw, jitter);
    const pitchDelta = normalizedDelta(frame.pitch, angles.pitch) + jitterAngle(angles.pitch, jitter);
    return {
      yaw: frame.yaw + yawDelta,
      pitch: frame.pitch + pitchDelta,
      original: { yaw: frame.yaw, pitch: frame.pitch }
    };
  }

  function rewriteStealthFrames(client, frames) {
    const state = runtime.outgoingAim;
    let modified = false;
    const result = frames.map(frame => {
      if (!frame || ![frame.yaw, frame.pitch, frame.mx, frame.mz].every(Number.isFinite)) return frame;
      if ((frame.buttons & INTERACT_BUTTON) || options.agent && runtime.agent.action === 'loot-aim') {
        // Interaction and pickup use the player's real view. Match the next
        // turn to the angles that were actually sent during this frame.
        state.yaw = frame.yaw;
        state.pitch = frame.pitch;
        state.targetIndex = null;
        state.ready = false;
        return frame;
      }
      if (state.yaw === null) { state.yaw = frame.yaw; state.pitch = frame.pitch; }
      if (state.pendingManualUntil && performance.now() > state.pendingManualUntil) state.pendingManualUntil = 0;
      const shot = runtime.predictions.get(frame.s);
      runtime.predictions.delete(frame.s);
      const sampledTarget = runtime.sampleContexts.get(frame.s)?.liveTarget;
      let target = !(frame.buttons & 4) &&
        ((options.rage && client.predictor?.activeStats) || state.pendingManualUntil || (frame.buttons & 1))
        ? selectTarget(client, frame, shot?.eye) : null;
      if (options.rage && shot && (frame.buttons & 1) && !(frame.buttons & 4) &&
          sampledTargetPreferred(target, sampledTarget)) target = sampledTarget;
      let desired = target || { yaw: frame.yaw, pitch: frame.pitch };
      let correction = null;
      if (target && (frame.buttons & 1)) {
        // Do not defer a predicted shot to chase an unreachable correction.
        correction = compensateSpread(shot, target, state);
        desired = applyStealth(frame, correction || target);
      }
      const yawStep = Math.max(-MAX_OUTGOING_TURN, Math.min(MAX_OUTGOING_TURN,
        normalizedDelta(state.yaw, desired.yaw)));
      const nextYaw = Math.atan2(Math.sin(state.yaw + yawStep), Math.cos(state.yaw + yawStep));
      const nextPitch = state.pitch + Math.max(-MAX_OUTGOING_TURN, Math.min(MAX_OUTGOING_TURN,
        desired.pitch - state.pitch));
      state.yaw = nextYaw;
      state.pitch = nextPitch;
      state.targetIndex = target?.index ?? null;
      state.ready = !!target && Math.abs(normalizedDelta(nextYaw, desired.yaw)) <= aimTolerance(target) &&
        Math.abs(nextPitch - desired.pitch) <= aimTolerance(target);
      if (target) runtime.target = target;

      let buttons = frame.buttons;
      let reason = target ? 'sent' : 'no-target';
      if (buttons & 1) {
        const ready = target ? state.ready : !options.rage &&
          Math.abs(normalizedDelta(nextYaw, frame.yaw)) <= OUTGOING_AIM_TOLERANCE &&
          Math.abs(nextPitch - frame.pitch) <= OUTGOING_AIM_TOLERANCE;
        const paceHeld = ready && target && !shot && paceShot() && stealthSkip();
        if ((!ready || paceHeld) && !shot) {
          buttons &= ~1;
          runtime.stealth.heldShots++;
          reason = !ready ? (target ? 'aligning' : 'no-target') : 'stealth-delay';
        } else if (!ready && shot) {
          // The predictor has already advanced its shot seed, bloom, and cooldown.
          // Sending the bounded turn preserves the same Fire event for reconciliation.
          reason = target ? 'predicted-turn' : 'predicted-no-target';
        } else if (target) {
          runtime.rewrites++;
          if (correction) runtime.compensated++;
          recordStealthShot({ yaw: frame.yaw, pitch: frame.pitch }, { yaw: nextYaw, pitch: nextPitch });
          state.pendingManualUntil = 0;
        } else reason = 'manual-unassisted';
      }
      if (frame.buttons & 1) recordAimDecision(client, frame, target, shot, correction,
        buttons, nextYaw, nextPitch, reason);

      const delta = normalizedDelta(frame.yaw, nextYaw);
      if (buttons === frame.buttons && Math.abs(delta) < 1e-9 && Math.abs(nextPitch - frame.pitch) < 1e-9) return frame;
      const scale = Math.max(1, Math.hypot(frame.mx, frame.mz));
      const mx = frame.mx / scale, mz = frame.mz / scale;
      modified = true;
      return { ...frame, buttons, yaw: nextYaw, pitch: nextPitch,
        mx: Math.cos(delta) * mx + Math.sin(delta) * mz,
        mz: -Math.sin(delta) * mx + Math.cos(delta) * mz };
    });
    return modified ? result : frames;
  }

  function rewriteFrames(client, frames) {
    runtime.target = null;
    if (!playable(client) || !Array.isArray(frames)) return frames;
    if (options.stealth) return rewriteStealthFrames(client, frames);

    let modified = false;
    const result = frames.map(frame => {
      if (!(frame.buttons & 1) || (frame.buttons & (4 | INTERACT_BUTTON)) ||
          ![frame.yaw, frame.pitch, frame.mx, frame.mz].every(Number.isFinite)) return frame;
      const shot = runtime.predictions.get(frame.s);
      runtime.predictions.delete(frame.s);
      const sampledTarget = runtime.sampleContexts.get(frame.s)?.liveTarget;
      let target = selectTarget(client, frame, shot?.eye);
      if (options.rage && shot && sampledTargetPreferred(target, sampledTarget))
        target = sampledTarget;
      if (!target) {
        const buttons = options.rage && !shot ? frame.buttons & ~1 : frame.buttons;
        recordAimDecision(client, frame, null, shot, null, buttons, frame.yaw, frame.pitch,
          options.rage ? shot ? 'predicted-no-target' : 'no-target' : 'manual-unassisted');
        if (buttons !== frame.buttons) {
          modified = true;
          return { ...frame, buttons };
        }
        return frame;
      }
      if (options.stealth && stealthSkip()) {
        // A deferred shot must not become an unassisted shot on the wire.
        modified = true;
        runtime.stealth.heldShots++;
        recordAimDecision(client, frame, target, shot, null, frame.buttons & ~1,
          frame.yaw, frame.pitch, 'stealth-delay');
        return { ...frame, buttons: frame.buttons & ~1 };
      }
      const correction = compensateSpread(shot, target);
      if (correction) runtime.compensated++;
      const rawAngles = correction || target;
      const angles = options.stealth ? applyStealth(frame, rawAngles) : { ...rawAngles, original: { yaw: frame.yaw, pitch: frame.pitch } };
      const delta = angles.yaw - frame.yaw;
      const scale = Math.max(1, Math.hypot(frame.mx, frame.mz));
      const mx = frame.mx / scale, mz = frame.mz / scale;
      modified = true;
      runtime.target = target;
      runtime.rewrites++;
      recordStealthShot(angles.original, angles);
      recordAimDecision(client, frame, target, shot, correction, frame.buttons,
        angles.yaw, angles.pitch, 'sent');
      // Prediction retains frame references. Clone only the outgoing frame and preserve world movement.
      return {
        ...frame, yaw: angles.yaw, pitch: angles.pitch,
        mx: Math.cos(delta) * mx + Math.sin(delta) * mz,
        mz: -Math.sin(delta) * mx + Math.cos(delta) * mz
      };
    });
    return modified ? result : frames;
  }

  const hookedPredictors = new WeakSet();
  function attachPredictor(client) {
    const predictor = client.predictor;
    if (!predictor || typeof predictor.predict !== 'function' || hookedPredictors.has(predictor)) return;
    hookedPredictors.add(predictor);
    const original = predictor.predict;
    replaceMethod(predictor, 'predict', function (frame, ...args) {
      const sampled = runtime.pendingSampleContext;
      runtime.pendingSampleContext = null;
      if (runtime.client === client && sampled && Number.isSafeInteger(frame?.s)) {
        runtime.sampleContexts.set(frame.s, sampled);
        while (runtime.sampleContexts.size > 64)
          runtime.sampleContexts.delete(runtime.sampleContexts.keys().next().value);
      }
      const result = Reflect.apply(original, this, [frame, ...args]);
      if (runtime.client === client && result?.weapon?.fired) {
        // These are the exact pre-recoil shot directions produced by the shared game kernel.
        runtime.predictions.set(frame.s, {
          yaw: frame.yaw, pitch: frame.pitch, eye: [...result.eye],
          directions: result.weapon.dirs.map(direction => [...direction])
        });
        recordTrace('localShots', { at: performance.now(), match: runtime.trace.match,
          sequence: frame.s, tick: frame.vt, yaw: frame.yaw, pitch: frame.pitch,
          inputMovement: [frame.mx, frame.mz], weapon: weaponSnapshot(client), player: playerSnapshot(client),
          eye: [...result.eye], directions: result.weapon.dirs.map(direction => [...direction]) });
        while (runtime.predictions.size > 16) runtime.predictions.delete(runtime.predictions.keys().next().value);
      }
      return result;
    });
    clientRestores.push(() => hookedPredictors.delete(predictor));
  }

  function canFireDuringAdsRamp(client, frame, target, weapon, ws) {
    if (!options.rapidFire || weapon.pellets !== 1 || (frame.buttons & (4 | 32 | 128)) ||
        !Number.isFinite(ws.ads) || !Number.isFinite(ws.bloom) ||
        !Number.isFinite(ws.switching) || ws.switching > 1 / 30 ||
        ![weapon.hipSpread, weapon.adsSpread, weapon.moveSpread].every(Number.isFinite) ||
        target.distance > Math.min(40, Number.isFinite(weapon.rangeEnd) ? weapon.rangeEnd : 40))
      return false;
    const player = ownState(client);
    if (player?.sprinting) return false;
    const ads = Math.max(0, Math.min(1, ws.ads));
    // The captured kernel adds at most the full movement term to the ADS blend.
    // Keep one degree for differences between sampled aim and outgoing aim.
    const airborne = player?.grounded === true ? 0 : 2.5 * (1 - 0.5 * ads);
    const spread = Math.max(0, weapon.hipSpread) * (1 - ads) +
      Math.max(0, weapon.adsSpread) * ads +
      Math.max(0, weapon.moveSpread) * (1 - 0.6 * ads) +
      Math.max(0, ws.bloom) * (1 - 0.7 * ads) + airborne;
    const currentYaw = runtime.outgoingAim.yaw ?? frame.yaw;
    const currentPitch = runtime.outgoingAim.pitch ?? frame.pitch;
    const turn = Math.max(Math.abs(normalizedDelta(currentYaw, target.yaw)),
      Math.abs(currentPitch - target.pitch));
    return turn + (spread + 1) * Math.PI / 180 <= MAX_OUTGOING_TURN;
  }

  function nextShotSpreadScale(client, ws) {
    const predictor = client.predictor;
    const { shotSeed, mulberry32 } = runtime.physics;
    if (typeof shotSeed !== 'function' || typeof mulberry32 !== 'function' ||
        !Number.isSafeInteger(predictor?.seed) || !Number.isSafeInteger(predictor?.index) ||
        !Number.isSafeInteger(ws.shots) || ws.shots < 0) return { scale: 1, seeded: false };
    try {
      // The shared kernel consumes this first random number for the next
      // projectile's radial spread. Never record the match seed in a trace.
      const random = mulberry32(shotSeed(predictor.seed, predictor.index, ws.shots + 1))();
      if (Number.isFinite(random) && random >= 0 && random < 1)
        return { scale: Math.sqrt(random), seeded: true };
    } catch { /* Use the full spread bound when the client kernel differs. */ }
    return { scale: 1, seeded: false };
  }

  function hipShotPlan(client, frame, target, weapon, ws) {
    const player = ownState(client);
    if (weapon.pellets !== 1 || target.distance > Math.min(options.hipRange, HIP_RANGE_LIMIT) ||
        player?.grounded !== true ||
        Math.hypot(player.vel?.[0] || 0, player.vel?.[2] || 0) > 0.5 ||
        runtime.seedSync.status === 'diverged' ||
        (frame.buttons & (4 | 32 | 128)) ||
        ![weapon.hipSpread, weapon.adsSpread, weapon.moveSpread,
          ws.ads, ws.bloom, ws.switching].every(Number.isFinite) ||
        ws.switching > 1 / 30) return null;
    // Aim is released for this frame. ADS may take several frames to fall to
    // zero, so bound the entire transition using both spread endpoints and
    // the full movement term. The captured kernel uses sqrt(U) for radius.
    const movement = Math.max(0, weapon.moveSpread);
    const bloom = Math.max(0, ws.bloom);
    const spreadDegrees = Math.max(
      Math.max(0, weapon.hipSpread) + movement + bloom,
      Math.max(0, weapon.adsSpread) + 0.4 * movement + 0.3 * bloom
    );
    const sample = nextShotSpreadScale(client, ws);
    const deviationDegrees = spreadDegrees * sample.scale;
    const radius = deviationDegrees * Math.PI / 180;
    // Longitude changes faster near vertical aim. Keep a degree in reserve for
    // sample-to-send target motion and local/server state disagreement.
    const yawRadius = radius / Math.cos(Math.min(1.54, Math.abs(target.pitch) + radius));
    const budget = MAX_OUTGOING_TURN - Math.PI / 180;
    const currentYaw = runtime.outgoingAim.yaw ?? frame.yaw;
    const currentPitch = runtime.outgoingAim.pitch ?? frame.pitch;
    return {
      eligible: Math.max(yawRadius, radius) <= budget,
      ready: Math.abs(normalizedDelta(currentYaw, target.yaw)) + yawRadius <= budget &&
        Math.abs(currentPitch - target.pitch) + radius <= budget,
      seeded: sample.seeded,
      deviationDegrees: Math.round(deviationDegrees * 100) / 100
    };
  }

  function agentNote(action, goal = null, distance = null) {
    const agent = runtime.agent;
    agent.action = action;
    agent.goal = goal;
    const now = performance.now();
    const key = [action, goal?.kind, goal?.index ?? '-', Math.round((distance || 0) / 10)].join(':');
    if (agent.lastTraceKey === key && now - agent.lastTraceAt < 750) return;
    agent.lastTraceKey = key;
    agent.lastTraceAt = now;
    recordTrace('agentDecisions', { at: now, match: runtime.trace.match, action,
      goal: goal ? { kind: goal.kind, index: goal.index ?? null } : null,
      distanceMeters: Number.isFinite(distance) ? Math.round(distance * 10) / 10 : null,
      stuckCount: agent.stuckCount });
  }

  function stormCircle(storm, tick) {
    if (!storm || storm.state === 'pending' || !Array.isArray(storm.center) ||
        !storm.center.slice(0, 2).every(Number.isFinite) || !Number.isFinite(storm.radius)) return null;
    if (storm.state !== 'shrinking' || storm.stage < 0 ||
        !Array.isArray(storm.nextCenter) || !storm.nextCenter.slice(0, 2).every(Number.isFinite) ||
        !Number.isFinite(storm.nextRadius) || !Number.isFinite(tick) ||
        !Number.isFinite(storm.startsAt) || !Number.isFinite(storm.endsAt))
      return { center: storm.center, radius: storm.radius };
    const span = Math.max(1, storm.endsAt - storm.startsAt);
    const t = Math.max(0, Math.min(1, 1 - (storm.endsAt - tick) / span));
    return { center: [storm.center[0] + (storm.nextCenter[0] - storm.center[0]) * t,
      storm.center[1] + (storm.nextCenter[1] - storm.center[1]) * t],
      radius: storm.radius + (storm.nextRadius - storm.radius) * t };
  }

  function agentTerrainHeight(terrain, x, z) {
    const heights = terrain?.heights;
    if (!heights || heights.length < 385 * 385) return null;
    const u = Math.max(0, Math.min(383.999999, (x + 768) / 4));
    const v = Math.max(0, Math.min(383.999999, (z + 768) / 4));
    const col = Math.floor(u), row = Math.floor(v), blendX = u - col, blendZ = v - row;
    const index = row * 385 + col;
    const near = heights[index] + (heights[index + 1] - heights[index]) * blendX;
    const far = heights[index + 385] + (heights[index + 386] - heights[index + 385]) * blendX;
    return Math.max(-1.3, near + (far - near) * blendZ);
  }

  function agentRouteClearance(world, me, direction, hasLineOfSight) {
    const origin = me.pos, length = 4, radius = 0.32;
    if (typeof world?.grid?.get !== 'function' || !Array.isArray(world.boxes) ||
        !(world.cellSize > 0)) {
      const eye = [origin[0], origin[1] + 0.55, origin[2]];
      return hasLineOfSight(world, eye,
        [eye[0] + length * direction[0], eye[1], eye[2] + length * direction[1]]) ? length : 0;
    }
    const endX = origin[0] + length * direction[0], endZ = origin[2] + length * direction[1];
    if (Math.abs(endX) > 767.5 || Math.abs(endZ) > 767.5) return 0;
    const cell = world.cellSize, columns = Math.ceil(1536 / cell) + 1;
    const gridIndex = value => Math.max(0, Math.min(columns - 1, Math.floor((value + 768) / cell)));
    const minX = gridIndex(Math.min(origin[0], endX) - radius);
    const maxX = gridIndex(Math.max(origin[0], endX) + radius);
    const minZ = gridIndex(Math.min(origin[2], endZ) - radius);
    const maxZ = gridIndex(Math.max(origin[2], endZ) + radius);
    const nearby = new Set();
    for (let row = minZ; row <= maxZ; row++) for (let col = minX; col <= maxX; col++)
      for (const index of world.grid.get(row * columns + col) || []) nearby.add(index);
    const boxes = [...nearby].map(index => world.boxes[index]).filter(box =>
      box && Array.isArray(box.min) && Array.isArray(box.max));
    let foot = origin[1];
    for (let step = 1; step <= 16; step++) {
      const x = origin[0] + direction[0] * step / 4;
      const z = origin[2] + direction[1] * step / 4;
      const ground = agentTerrainHeight(world.terrain, x, z);
      if (ground !== null) {
        if (ground > foot + 0.5) return (step - 1) / 4;
        if (ground > foot + 0.01) {
          const slope = Math.hypot(
            (agentTerrainHeight(world.terrain, x + 1, z) -
              agentTerrainHeight(world.terrain, x - 1, z)) / 2,
            (agentTerrainHeight(world.terrain, x, z + 1) -
              agentTerrainHeight(world.terrain, x, z - 1)) / 2);
          if (slope > 1.25) return (step - 1) / 4;
        }
        foot = ground;
      }
      const overlapping = boxes.filter(box => x + radius > box.min[0] &&
        x - radius < box.max[0] && z + radius > box.min[2] && z - radius < box.max[2]);
      let nextFoot = foot;
      for (const box of overlapping)
        if (box.max[1] > nextFoot && box.max[1] <= foot + 0.5 &&
            box.min[1] < foot + 1.8) nextFoot = box.max[1];
      if (overlapping.some(box => box.min[1] < nextFoot + 1.8 &&
          box.max[1] > nextFoot + 0.0001)) return (step - 1) / 4;
      foot = nextFoot;
    }
    return length;
  }

  function agentWaypoint(client, me, direction, detouring = false) {
    const { getCollisionWorld, hasLineOfSight } = runtime.physics;
    const side = runtime.agent.sidestep;
    const angles = detouring ? [side * 1.2, -side * 1.2, side * 0.7, -side * 0.7] :
      [0, side * 0.6, -side * 0.6, side * 1.2, -side * 1.2];
    const rotated = angle => [direction[0] * Math.cos(angle) - direction[1] * Math.sin(angle),
      direction[0] * Math.sin(angle) + direction[1] * Math.cos(angle)];
    if (typeof getCollisionWorld !== 'function' || typeof hasLineOfSight !== 'function')
      return rotated(angles[0]);
    const world = getCollisionWorld();
    if (!world) return rotated(angles[0]);
    let best = null, bestClearance = 0;
    for (const angle of angles) {
      const [x, z] = rotated(angle);
      const clearance = agentRouteClearance(world, me, [x, z], hasLineOfSight);
      if (clearance === 4) return [x, z];
      if (clearance > bestClearance) { best = [x, z]; bestClearance = clearance; }
    }
    return bestClearance >= 0.75 ? best : null;
  }

  function agentInput(client, frame) {
    const agent = runtime.agent;
    agent.target = null;
    agent.scan = null;
    if (!options.agent || !playable(client) || ![frame.yaw, frame.pitch, frame.mx, frame.mz].every(Number.isFinite)) {
      if (agent.action !== 'off') agentNote('off');
      return frame;
    }
    if (Math.hypot(frame.mx, frame.mz) > 0.1 || frame.buttons & (1 | 2 | 4 | 8 | 16 | 64 | 128 | 256 | 512)) {
      agent.lastPosition = null;
      agent.navigationGoalKey = null;
      agent.lastGoalDistance = null;
      agent.detourUntil = 0;
      agentNote('manual-override');
      return frame;
    }
    const me = ownState(client);
    if (!vector3(me?.pos)) return frame;
    const weapon = client.predictor?.activeStats;
    const slot = client.predictor?.slots?.[client.predictor.active];
    const tick = typeof client.renderTick === 'function' ? Math.round(client.renderTick()) : frame.vt;
    const scan = { tick: Number.isFinite(tick) ? tick : null, range: options.range,
      visibleOnly: options.visibleOnly, physicsAvailable: !!(runtime.physics.getCollisionWorld && runtime.physics.hasLineOfSight),
      observed: 0, counts: {}, closest: null, selected: null };
    const target = selectTarget(client, { ...frame, vt: tick }, null, scan);
    agent.target = target;
    agent.scan = scan;
    const storm = stormCircle(client.latest?.storm, client.latest?.t);
    const stormDistance = storm ? Math.hypot(me.pos[0] - storm.center[0], me.pos[2] - storm.center[1]) : 0;
    let goal = null, action = 'engage', stopAt = 0, sprint = false;
    if (storm && stormDistance > storm.radius - 8) {
      goal = { kind: 'storm', position: [storm.center[0], storm.center[1]] };
      action = 'storm'; sprint = true;
    } else if (target && weapon && !(slot && slot.mag <= 0 &&
        !(client.predictor?.ammo?.[weapon.ammo] > 0))) {
      const classDistance = { sniper: 150, rifle: 70, smg: 30, pistol: 25, shotgun: 13 };
      const ideal = classDistance[weapon.class] || 45;
      const range = Number.isFinite(weapon.rangeEnd) ? weapon.rangeEnd * 0.8 : ideal;
      stopAt = Math.max(10, Math.min(ideal, range));
      if (target.distance > stopAt + 5) {
        goal = { kind: 'opponent', index: target.index, position: [target.position[0], target.position[2]] };
        action = 'approach'; sprint = true;
      }
    } else {
      const ammoType = weapon?.ammo;
      const reserve = client.predictor?.ammo?.[ammoType] || 0;
      if (slot && slot.mag <= 0 && reserve <= 0) {
        let nearest = null, nearestDistance = 40;
        for (const item of client.loot?.items?.values?.() || []) {
          if (item?.kind !== 'ammo' || item.ammo !== ammoType || !vector3(item.pos)) continue;
          const distance = Math.hypot(item.pos[0] - me.pos[0], item.pos[2] - me.pos[2]);
          if (distance < nearestDistance) { nearest = item; nearestDistance = distance; }
        }
        if (nearest) {
          goal = { kind: 'ammo', id: nearest.id, position: [nearest.pos[0], nearest.pos[2]],
            height: nearest.pos[1] };
          action = nearestDistance < 2.1 ? 'loot-aim' : 'loot-travel';
        }
      }
      if (!goal && slot && slot.mag <= 0 && reserve <= 0) {
        agentNote('no-ammo');
        return frame;
      }
      if (!goal) {
        let nearest = null, nearestDistance = Math.min(options.range, 250);
        for (const { snap } of client.remoteFrames || []) {
          if (!enemy(client, snap, true)) continue;
          const distance = Math.hypot(snap.p[0] - me.pos[0], snap.p[2] - me.pos[2]);
          if (distance < nearestDistance) { nearest = snap; nearestDistance = distance; }
        }
        if (nearest) {
          goal = { kind: 'opponent', index: nearest.i, position: [nearest.p[0], nearest.p[2]] };
          action = 'search'; sprint = true; stopAt = 10;
        }
      }
    }
    if (!goal) {
      agent.lastPosition = null;
      agent.navigationGoalKey = null;
      agent.lastGoalDistance = null;
      agent.detourUntil = 0;
      agentNote(target ? 'engage' : 'idle', target ? { kind: 'opponent', index: target.index } : null,
        target?.distance ?? null);
      return frame;
    }
    const dx = goal.position[0] - me.pos[0], dz = goal.position[1] - me.pos[2];
    const distance = Math.hypot(dx, dz);
    const goalKey = [goal.kind, goal.index ?? goal.id ?? '-',
      Math.round(goal.position[0] / 10), Math.round(goal.position[1] / 10)].join(':');
    if (agent.navigationGoalKey !== goalKey) {
      agent.navigationGoalKey = goalKey;
      agent.lastPosition = null;
      agent.lastGoalDistance = null;
      agent.detourUntil = 0;
      agent.stuckCount = 0;
    }
    if (distance < 0.001) { agentNote(action, goal, distance); return frame; }
    if (action === 'loot-aim') {
      agentNote(action, goal, distance);
      const eye = [me.pos[0], me.pos[1] + 1.62, me.pos[2]];
      const pitch = Math.atan2(goal.height + 0.15 - eye[1], distance);
      const yaw = Math.atan2(-dx, -dz);
      const fromYaw = agent.lootYaw ?? frame.yaw, fromPitch = agent.lootPitch ?? frame.pitch;
      const nextYaw = fromYaw + Math.max(-MAX_OUTGOING_TURN, Math.min(MAX_OUTGOING_TURN, normalizedDelta(fromYaw, yaw)));
      const nextPitch = fromPitch + Math.max(-MAX_OUTGOING_TURN, Math.min(MAX_OUTGOING_TURN, pitch - fromPitch));
      agent.lootYaw = nextYaw; agent.lootPitch = nextPitch;
      const aligned = Math.abs(normalizedDelta(nextYaw, yaw)) < 0.03 && Math.abs(nextPitch - pitch) < 0.03;
      const now = performance.now();
      const interact = aligned && client.target?.target?.kind === 'item' &&
        client.target.target.id === goal.id && now >= agent.nextInteractAt;
      if (interact) agent.nextInteractAt = now + 850;
      return { ...frame, yaw: nextYaw, pitch: nextPitch,
        buttons: interact ? frame.buttons | INTERACT_BUTTON : frame.buttons };
    }
    agent.lootYaw = agent.lootPitch = null;
    if (distance <= stopAt + 1) { agentNote(action, goal, distance); return frame; }
    const now = performance.now();
    if (agent.lastPosition && now - agent.lastPositionAt > 650) {
      const progress = Math.hypot(me.pos[0] - agent.lastPosition[0], me.pos[2] - agent.lastPosition[1]);
      const goalProgress = agent.lastGoalDistance - distance;
      if (goalProgress > 0.9) {
        agent.detourUntil = 0;
        agent.stuckCount = 0;
      } else if (now >= agent.detourUntil &&
          (progress < 0.25 || agent.detourUntil > 0 && goalProgress < 0.1)) {
        agent.sidestep *= -1;
        agent.detourUntil = now + 1600;
        agent.stuckCount++;
      } else if (now >= agent.detourUntil) {
        agent.detourUntil = 0;
      }
      agent.lastPosition = [me.pos[0], me.pos[2]];
      agent.lastPositionAt = now;
      agent.lastGoalDistance = distance;
    } else if (!agent.lastPosition) {
      agent.lastPosition = [me.pos[0], me.pos[2]];
      agent.lastPositionAt = now;
      agent.lastGoalDistance = distance;
    }
    const detouring = now < agent.detourUntil;
    agentNote(detouring ? 'detour' : action, goal, distance);
    const direction = agentWaypoint(client, me, [dx / distance, dz / distance], detouring);
    if (!direction) { agentNote('blocked', goal, distance); return frame; }
    // The captured movement kernel maps camera-relative mx/mz into world x/z.
    const mx = Math.cos(frame.yaw) * direction[0] - Math.sin(frame.yaw) * direction[1];
    const mz = -Math.sin(frame.yaw) * direction[0] - Math.cos(frame.yaw) * direction[1];
    return { ...frame, mx, mz, buttons: sprint ? frame.buttons | 16 : frame.buttons };
  }

  function rageInput(client, frame) {
    if (!options.rage) return frame;
    if (frame.buttons & INTERACT_BUTTON) {
      runtime.sampleGate = { reason: runtime.autoPickupRequested ? 'ammo-pickup' : 'interaction', target: null, scan: null };
      return frame.buttons & 1 ? { ...frame, buttons: frame.buttons & ~1 } : frame;
    }
    if (!playable(client)) {
      runtime.sampleGate = { reason: 'unplayable', target: null, scan: null };
      return frame;
    }
    const predictor = client.predictor;
    const weapon = predictor?.activeStats;
    const slot = predictor?.slots?.[predictor.active];
    if (!weapon || !slot || !predictor.ws) {
      runtime.sampleGate = { reason: 'weapon-unavailable', target: null, scan: null };
      return frame;
    }
    const scopedButtons = (frame.buttons & ~(1 | 16)) | 2;
    const tick = typeof client.renderTick === 'function' ? Math.round(client.renderTick()) : undefined;
    const scan = { tick: Number.isFinite(tick) ? tick : null, range: options.range,
      visibleOnly: options.visibleOnly, physicsAvailable: !!(runtime.physics.getCollisionWorld && runtime.physics.hasLineOfSight),
      observed: 0, counts: {}, closest: null, selected: null };
    const target = options.agent && runtime.agent.scan
      ? runtime.agent.target : selectTarget(client, { ...frame, vt: tick }, null, scan);
    if (options.agent && runtime.agent.scan) Object.assign(scan, runtime.agent.scan);
    if (options.agent && ['approach', 'search', 'storm', 'loot-travel', 'loot-aim', 'detour', 'blocked'].includes(runtime.agent.action)) {
      runtime.sampleGate = { reason: 'agent-' + runtime.agent.action, target, scan };
      return frame.buttons & 1 ? { ...frame, buttons: frame.buttons & ~1 } : frame;
    }
    if (options.agent && runtime.agent.action === 'engage') {
      const velocity = vector3(ownState(client)?.vel) || [0, 0, 0];
      if (Math.hypot(velocity[0], velocity[2]) > 0.5) {
        runtime.sampleGate = { reason: 'agent-settle', target, scan };
        return { ...frame, buttons: (frame.buttons & ~(1 | 16)) | 2 };
      }
    }
    const ws = predictor.ws;
    if (ws.reload > 0 || slot.mag <= 0) {
      const reserve = predictor.ammo?.[weapon.ammo] || 0;
      const reason = reserve > 0 || ws.reload > 0 ? 'reload' : 'no-ammo';
      runtime.sampleGate = { reason, target, scan };
      // Keep the player's own ADS choice, but do not force ADS or cancel sprint
      // while the server reloads or the magazine is empty.
      const buttons = (frame.buttons & ~1) | (slot.mag <= 0 && reserve > 0 && !(ws.reload > 0) ? 32 : 0);
      return buttons === frame.buttons ? frame : { ...frame, buttons };
    }
    if (!target) {
      // Do not hold ADS or suppress sprint while travelling between targets.
      runtime.sampleGate = { reason: 'no-target', target: null, scan };
      return frame.buttons & 1 ? { ...frame, buttons: frame.buttons & ~1 } : frame;
    }
    const hip = options.hipFire ? hipShotPlan(client, frame, target, weapon, ws) : null;
    const hipFire = !!hip?.eligible;
    let buttons = hipFire ? frame.buttons & ~(1 | 2 | 16) : scopedButtons;
    let reason = 'fire-request';
    const earlyAds = !hipFire && Number.isFinite(ws.ads) && ws.ads < 0.995 &&
      canFireDuringAdsRamp(client, frame, target, weapon, ws);
    if (hipFire && !hip.ready) reason = 'hip-align';
    else if (!hipFire && Number.isFinite(ws.ads) && ws.ads < 0.995 && !earlyAds) reason = 'ads-ramp';
    else if (weapon.fireMode !== 'auto' && (ws.trigger || ws.cooldown > 1 / 30 + 1e-9)) reason = 'cooldown';
    else buttons |= 1;
    runtime.sampleGate = { reason, target, scan, earlyAds: earlyAds && !!(buttons & 1),
      hipFire, hipSeeded: !!hip?.seeded,
      hipDeviationDegrees: hip?.deviationDegrees ?? null };
    return { ...frame, buttons };
  }

  function recordFireGate(client, original, prepared) {
    const gate = runtime.sampleGate;
    if (!gate || !options.rage) return;
    const reason = gate.reason === 'fire-request'
      ? (prepared.buttons & 1 ? 'fire-sampled' : runtime.sampleHoldReason || 'aim-hold') : gate.reason;
    const counters = runtime.trace.counters;
    counters.rageSamples++;
    counters.gateReasons[reason] = (counters.gateReasons[reason] || 0) + 1;
    for (const [name, count] of Object.entries(gate.scan?.counts || {})) {
      if (name !== 'eligible') counters.targetRejects[name] = (counters.targetRejects[name] || 0) + count;
    }
    const now = performance.now(), weapon = weaponSnapshot(client);
    const sampled = { at: now, reason, weaponAds: weapon.ads, earlyAds: !!gate.earlyAds,
      hipFire: !!gate.hipFire, hipSeeded: !!gate.hipSeeded,
      hipDeviationDegrees: gate.hipDeviationDegrees ?? null,
      target: targetSnapshot(gate.target), liveTarget: gate.target };
    runtime.pendingSampleContext = sampled;
    if (Number.isSafeInteger(original.s)) {
      runtime.sampleContexts.set(original.s, sampled);
      while (runtime.sampleContexts.size > 64) runtime.sampleContexts.delete(runtime.sampleContexts.keys().next().value);
    }
    const key = [reason, gate.hipFire ? 'hip' : gate.earlyAds ? 'early-ads' : 'full-ads',
      gate.target?.index ?? '-', weapon.id ?? '-',
      Math.round((gate.target?.distance || 0) / 25)].join(':');
    if (runtime.lastGateTrace?.key === key && now - runtime.lastGateTrace.at < 250) return;
    runtime.lastGateTrace = { key, at: now };
    const aim = runtime.outgoingAim;
    const target = gate.target;
    const yawGap = target && Number.isFinite(aim.yaw)
      ? Math.abs(normalizedDelta(aim.yaw, target.yaw)) : null;
    const pitchGap = target && Number.isFinite(aim.pitch)
      ? Math.abs(aim.pitch - target.pitch) : null;
    recordTrace('fireGates', { at: now, match: runtime.trace.match, sequence: original.s,
      tick: original.vt, reason, earlyAds: !!gate.earlyAds,
      hipFire: !!gate.hipFire, hipSeeded: !!gate.hipSeeded,
      hipDeviationDegrees: gate.hipDeviationDegrees ?? null,
      originalButtons: original.buttons, sampledButtons: prepared.buttons,
      inputMovement: [original.mx, original.mz], weapon, player: playerSnapshot(client),
      target: targetSnapshot(target), scan: gate.scan,
      aimState: { targetIndex: aim.targetIndex, ready: aim.ready,
        yawGapDegrees: yawGap === null ? null : yawGap * 180 / Math.PI,
        pitchGapDegrees: pitchGap === null ? null : pitchGap * 180 / Math.PI,
        withinOneTurn: yawGap !== null && pitchGap !== null &&
          yawGap <= MAX_OUTGOING_TURN && pitchGap <= MAX_OUTGOING_TURN } });
  }

  function autoReloadFrame(client, frame) {
    if (!options.ammo || (frame.buttons & INTERACT_BUTTON)) return frame;
    const predictor = client.predictor;
    const weapon = predictor?.activeStats;
    if (!predictor || !weapon || !Number.isInteger(predictor.active)) return frame;
    const slot = predictor.slots?.[predictor.active];
    const reserve = predictor.ammo?.[weapon.ammo];
    if (slot?.mag > 0 || !(reserve > 0) || predictor.ws?.reload > 0) return frame;
    // The server owns ammunition. Request a real reload instead of changing local prediction.
    return { ...frame, buttons: frame.buttons | 32 };
  }

  function autoPickupAmmoFrame(client, frame) {
    if (!options.ammo || options.agent && runtime.agent.action === 'loot-aim' ||
        (frame.buttons & (1 | INTERACT_BUTTON)) ||
        client.you == null || client.latest?.phase === 'finished' ||
        client.input?.enabled === false || client.disposed || client.paused ||
        client.localDead?.() || client.localDowned?.()) return frame;
    const me = ownState(client);
    if (me?.mode !== 'ground' || me.downed || me.spectating != null) return frame;
    const ref = client.target?.target;
    if (ref?.kind !== 'item') return frame;
    const item = client.loot?.items?.get?.(ref.id);
    const predictor = client.predictor;
    const weapon = predictor?.activeStats;
    const ammoType = weapon?.ammo;
    const reserve = predictor?.ammo?.[ammoType];
    const cap = AMMO_CAPS[ammoType] ||
      Math.max(40, 4 * (weapon?.magSize || 0));
    if (item?.kind !== 'ammo' || item.ammo !== ammoType ||
        !Number.isFinite(reserve) || reserve >= cap) return frame;
    const now = performance.now();
    if (runtime.ammoPickup.id === ref.id && now < runtime.ammoPickup.nextAt) return frame;
    runtime.ammoPickup = { id: ref.id, nextAt: now + 850 };
    runtime.autoPickupRequested = true;
    recordTrace('ammoPickups', { at: now, match: runtime.trace.match,
      ammoType: AMMO_TYPES.includes(ammoType) ? ammoType : 'other',
      amount: Number.isFinite(item.amount) ? item.amount : null,
      reserveBefore: reserve });
    return { ...frame, buttons: frame.buttons | INTERACT_BUTTON };
  }

  function replaceMethod(object, name, replacement) {
    const original = object[name];
    object[name] = replacement;
    clientRestores.push(() => { if (object[name] === replacement) object[name] = original; });
    return original;
  }

  function attachClient(client) {
    if (runtime.stopped || runtime.client === client) return client;
    detachClient();
    runtime.client = client;
    runtime.trace.match++;
    archiveState.finalizedMatch = null;
    recordSettings('match-start');
    runtime.rewrites = 0;
    runtime.compensated = 0;
    runtime.stealth.heldShots = 0;
    runtime.outgoingAim = { yaw: null, pitch: null, targetIndex: null, ready: false, pendingManualUntil: 0 };
    runtime.predictions.clear();
    runtime.sampleContexts.clear();
    runtime.pendingSampleContext = null;
    seenServerEvents.clear();
    runtime.server = { shots: 0, hits: 0, headshots: 0, kills: 0, damage: 0 };
    runtime.seedSync = { status: 'unknown', aligned: 0, diverged: 0 };
    runtime.target = null;
    runtime.ammoPickup = { id: null, nextAt: 0 };
    runtime.agent = { action: 'off', goal: null, lastTraceAt: 0, lastTraceKey: '',
      lastPosition: null, lastPositionAt: 0, sidestep: 1, nextInteractAt: 0,
      navigationGoalKey: null, lastGoalDistance: null, detourUntil: 0, stuckCount: 0 };
    runtime.sampleGate = null;
    runtime.lastGateTrace = null;
    runtime.lastServerSnapshot = null;
    runtime.error = runtime.aimRejected ? 'Server rejected aim assistance / aim disabled' : '';
    const checkRejection = () => {
      const connectionError = client.connection?.error;
      const aimError = /aim assistance|anti-cheat/i.test(connectionError || '');
      const connectionState = client.connection?.state;
      const record = { at: new Date().toISOString(), match: runtime.trace.match,
        state: ['connected', 'connecting', 'kicked', 'disconnected', 'closed', 'error',
          'idle', 'reconnecting'].includes(connectionState) ? connectionState : 'other',
        errorKind: aimError ? 'aim-assistance' : connectionError ? 'other' : null,
        aimRejected: runtime.aimRejected };
      recordTrace('connectionStates', record);
      if (runtime.client !== client || client.connection?.state !== 'kicked') return;
      if (!aimError) return;
      recordTrace('kicks', { ...record, match: runtime.trace.match,
        lastSequence: runtime.trace.frames.at(-1)?.sequence });
      runtime.aimRejected = true;
      runtime.predictions.clear();
      setOptions({ silent: false, rage: false });
      runtime.error = 'Server rejected aim assistance / aim disabled';
      void archiveTrace(true);
    };
    if (typeof client.connection?.onState === 'function') {
      const unsubscribe = client.connection.onState(checkRejection);
      if (typeof unsubscribe === 'function') clientRestores.push(unsubscribe);
    }
    checkRejection();
    if (typeof client.ingestEvents === 'function') {
      const originalEvents = client.ingestEvents;
      replaceMethod(client, 'ingestEvents', function (snapshot, ...rest) {
        if (runtime.client === client && !runtime.stopped) {
          try { recordServerSnapshot(client, snapshot); }
          catch (error) { recordTrace('errors', { at: new Date().toISOString(),
            where: 'server-snapshot', type: error?.name || 'Error' }); }
          const occurrences = new Map();
          let currentOwnShot = null;
          for (const event of snapshot.events || []) {
            if (event?.type === 'shot') currentOwnShot = null;
            if (event?.type === 'impact') {
              if (currentOwnShot && currentOwnShot.shot.impacts.length < 32) {
                const point = vector3(event.pos);
                if (point) currentOwnShot.shot.impacts.push({ point,
                  normal: vector3(event.normal),
                  material: safeWeaponId(event.material) || 'other' });
              }
              continue;
            }
            if (!['shot', 'hit'].includes(event?.type)) currentOwnShot = null;
            if (event?.by !== client.you) continue;
            const signature = JSON.stringify([event.t ?? snapshot.t, event]);
            const ordinal = (occurrences.get(signature) || 0) + 1;
            occurrences.set(signature, ordinal);
            const key = signature + '#' + ordinal;
            if (seenServerEvents.has(key)) continue;
            seenServerEvents.add(key);
            if (seenServerEvents.size > 1024) seenServerEvents.delete(seenServerEvents.values().next().value);
            if (['shot', 'hit', 'kill'].includes(event.type)) {
              const numericFields = {};
              for (const field of ['target', 'victim', 'to', 'sequence', 's']) {
                if (Number.isSafeInteger(event[field])) numericFields[field] = event[field];
              }
              const directions = Array.isArray(event.dirs) && event.dirs.length <= 32 &&
                event.dirs.every(direction => vector3(direction))
                ? event.dirs.map(direction => [...direction]) : null;
              const row = { at: performance.now(), match: runtime.trace.match,
                tick: event.t ?? snapshot.t, snapshotTick: Number.isFinite(snapshot.t) ? snapshot.t : null,
                type: event.type, fields: numericFields,
                damage: Number.isFinite(event.damage) ? event.damage : null,
                head: event.head === true,
                shot: event.type === 'shot' ? {
                  weaponId: safeWeaponId(event.weapon),
                  rarity: safeWeaponId(event.rarity),
                  origin: vector3(event.from), directions, impacts: []
                } : null };
              recordTrace('serverEvents', row);
              if (event.type === 'shot') currentOwnShot = row;
            }
            if (event.type === 'shot') runtime.server.shots++;
            if (event.type === 'hit') {
              runtime.server.hits++;
              if (event.head) runtime.server.headshots++;
              if (Number.isFinite(event.damage)) runtime.server.damage += event.damage;
            }
            if (event.type === 'kill') runtime.server.kills++;
          }
        }
        return Reflect.apply(originalEvents, this, [snapshot, ...rest]);
      });
    }
    recoverPhysics();
    attachPredictor(client);
    if (typeof client.input?.sample === 'function') {
      const originalSample = client.input.sample;
      replaceMethod(client.input, 'sample', function (...args) {
        const frame = Reflect.apply(originalSample, this, args);
        if (runtime.client !== client) return frame;
        let prepared = frame;
        runtime.sampleGate = null;
        runtime.sampleHoldReason = null;
        runtime.pendingSampleContext = null;
        runtime.autoPickupRequested = false;
        try { prepared = agentInput(client, prepared); }
        catch (error) { recordTrace('errors', { at: new Date().toISOString(),
          where: 'combat-agent', type: error?.name || 'Error' }); }
        try { prepared = autoPickupAmmoFrame(client, prepared); }
        catch (error) { recordTrace('errors', { at: new Date().toISOString(),
          where: 'ammo-pickup', type: error?.name || 'Error' }); }
        try { prepared = autoReloadFrame(client, prepared); }
        catch (error) { recordTrace('errors', { at: new Date().toISOString(),
          where: 'ammo-reload', type: error?.name || 'Error' }); }
        try {
          const sampled = holdStealthShot(client, rageInput(client, prepared));
          recordFireGate(client, frame, sampled);
          return sampled;
        }
        catch (error) { runtime.error = 'Rage hook: ' + error.message; return holdOnAimError(frame); }
      });
    }
    const connection = client.connection;
    if (typeof connection?.sendInput === 'function') {
      const original = connection.sendInput;
      replaceMethod(connection, 'sendInput', function (matchId, frames, ...rest) {
        let outgoing = frames;
        if (runtime.client === client && matchId === client.start?.matchId) {
          const alreadyPredicted = new Set(Array.isArray(frames)
            ? frames.filter(frame => runtime.predictions.has(frame?.s)).map(frame => frame.s) : []);
          try { outgoing = rewriteFrames(client, frames); }
          catch (error) {
            runtime.error = 'Aim hook: ' + error.message;
            if (Array.isArray(frames)) {
              const held = frames.map(frame => options.rage && alreadyPredicted.has(frame?.s)
                ? frame : holdOnAimError(frame));
              if (held.some((frame, index) => frame !== frames[index])) outgoing = held;
            }
          }
        }
        if (runtime.client === client) recordFrames(frames, outgoing);
        return Reflect.apply(original, this, [matchId, outgoing, ...rest]);
      });
    }
    Promise.resolve(client.ready).then(() => attachRenderer(client), error => {
      if (runtime.client === client) runtime.error = 'Game load failed: ' + (error?.message || error);
    });
    return client;
  }

  function recoverLoadedClient() {
    if (runtime.stopped || (runtime.client && !runtime.client.disposed)) return;
    for (const canvas of document.querySelectorAll('canvas')) {
      const key = Object.keys(canvas).find(name => name.startsWith('__reactFiber'));
      let fiber = key ? canvas[key] : null;
      for (let depth = 0; fiber && depth < 15; depth++, fiber = fiber.return) {
        for (let hook = fiber.memoizedState, count = 0; hook && count < 60; hook = hook.next, count++) {
          const client = hook.memoizedState?.current;
          if (client?.canvas !== canvas || !client.connection || !client.remoteFrames || client.disposed || !client.input) continue;
          runtime.hookReady = true;
          attachClient(client);
          recoverPhysics();
          return;
        }
      }
    }
  }

  function recoverPhysics() {
    if (runtime.physics.hasLineOfSight || physicsImportStarted || physicsAttempts >= 3 ||
        performance.now() < physicsRetryAt || Array.isArray(window.TURBOPACK)) return;
    physicsImportStarted = true;
    physicsAttempts++;
    // A local module can import the already-loaded kernel without fetching any files.
    const id = 'bridgezone-local-tools-' + Date.now() + '-' + physicsAttempts;
    const path = 'static/chunks/' + id + '.js';
    window.TURBOPACK.push([path, id, context => {
      const physics = context.i(54145);
      for (const name of ['getCollisionWorld', 'hasLineOfSight', 'raycastWorld', 'shotSeed', 'mulberry32'])
        runtime.physics[name] = physics[name];
      physicsImportStarted = false;
      if (runtime.error.startsWith('Physics hook:')) runtime.error = '';
    }]);
    const pending = window.TURBOPACK.push([path, { otherChunks: [], runtimeModuleIds: [id] }]);
    pending?.catch?.(error => {
      physicsImportStarted = false;
      physicsRetryAt = performance.now() + 1000;
      runtime.error = 'Physics hook: ' + error.message;
    });
  }

  function attachRenderer(client) {
    if (runtime.client !== client || client.disposed || runtime.stopped) return;
    const pipeline = client.engine?.pipeline;
    if (!pipeline || pipeline === runtime.pipeline || runtime.stopped) return;
    runtime.pipeline = pipeline;
    const original = pipeline.render;
    replaceMethod(pipeline, 'render', function (...args) {
      const result = Reflect.apply(original, this, args);
      if (runtime.client === client) {
        try { drawOverlay(client); runtime.renderedAt = performance.now(); }
        catch (error) { runtime.error = 'Xray hook: ' + error.message; }
      }
      return result;
    });
  }

  function wrapFactory(factory) {
    return function (context, ...args) {
      const wrappedContext = new Proxy(context, {
        get(target, name, receiver) {
          if (name !== 's') return Reflect.get(target, name, receiver);
          return function (exports, moduleId, ...extra) {
            if (moduleId !== 54145 && moduleId !== 97294) {
              return Reflect.apply(target.s, target, [exports, moduleId, ...extra]);
            }
            const entries = exports.slice();
            for (let i = 0; i < entries.length; i += 3) {
              if (entries[i + 1] !== 0) continue;
              const key = entries[i], value = entries[i + 2];
              if (moduleId === 54145 &&
                  ['getCollisionWorld', 'hasLineOfSight', 'raycastWorld', 'shotSeed', 'mulberry32'].includes(key))
                runtime.physics[key] = value;
              if (moduleId === 97294 && key === 'createZoneClient' && typeof value === 'function') {
                runtime.hookReady = true;
                entries[i + 2] = function (...params) {
                  const client = Reflect.apply(value, this, params);
                  try { attachClient(client); } catch (error) { runtime.error = 'Client hook: ' + error.message; }
                  return client;
                };
              }
            }
            return Reflect.apply(target.s, target, [entries, moduleId, ...extra]);
          };
        }
      });
      return Reflect.apply(factory, this, [wrappedContext, ...args]);
    };
  }

  const wrappedFactories = new WeakMap();
  function wrapChunk(chunk) {
    if (!Array.isArray(chunk)) return chunk;
    return chunk.map(entry => {
      if (typeof entry !== 'function') return entry;
      if (!wrappedFactories.has(entry)) {
        const wrapped = wrapFactory(entry);
        wrappedFactories.set(entry, wrapped);
        wrappedFactories.set(wrapped, wrapped);
      }
      return wrappedFactories.get(entry);
    });
  }

  // The observed runtime replaces the initial array with {push: registerChunk}.
  // Intercept the replacement as well as dispatcher changes on each container.
  const containers = new WeakSet();
  function interceptContainer(container) {
    if (!container || typeof container.push !== 'function' || containers.has(container)) return container;
    containers.add(container);
    let dispatcher = container.push;
    const descriptor = Object.getOwnPropertyDescriptor(container, 'push');
    if (Array.isArray(container)) {
      for (let i = 0; i < container.length; i++) container[i] = wrapChunk(container[i]);
    }
    function interceptedPush(...chunks) {
      return Reflect.apply(dispatcher, this, runtime.stopped ? chunks : chunks.map(wrapChunk));
    }
    Object.defineProperty(container, 'push', {
      configurable: true, enumerable: descriptor?.enumerable ?? true,
      get: () => interceptedPush,
      set: value => { if (value !== interceptedPush) dispatcher = value; }
    });
    restores.push(() => {
      if (container.push !== interceptedPush) return;
      delete container.push;
      if (descriptor || dispatcher !== Array.prototype.push) {
        Object.defineProperty(container, 'push', {
          value: dispatcher, configurable: true, writable: true, enumerable: descriptor?.enumerable ?? true
        });
      }
    });
    return container;
  }
  const queueDescriptor = Object.getOwnPropertyDescriptor(window, 'TURBOPACK');
  let queue = interceptContainer(window.TURBOPACK || []);
  Object.defineProperty(window, 'TURBOPACK', {
    configurable: true, enumerable: queueDescriptor?.enumerable ?? true,
    get: () => queue,
    set: value => { queue = interceptContainer(value); }
  });
  restores.push(() => {
    delete window.TURBOPACK;
    Object.defineProperty(window, 'TURBOPACK', {
      value: queue, configurable: true, writable: true, enumerable: queueDescriptor?.enumerable ?? true
    });
  });

  function project(point, camera, bounds) {
    const view = camera.matrixWorldInverse.elements;
    const proj = camera.projectionMatrix.elements;
    const [x, y, z] = point;
    const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
    const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
    const vz = view[2] * x + view[6] * y + view[10] * z + view[14];
    const vw = view[3] * x + view[7] * y + view[11] * z + view[15];
    const w = proj[3] * vx + proj[7] * vy + proj[11] * vz + proj[15] * vw;
    if (!Number.isFinite(w) || w <= 0.001) return null;
    const nx = (proj[0] * vx + proj[4] * vy + proj[8] * vz + proj[12] * vw) / w;
    const ny = (proj[1] * vx + proj[5] * vy + proj[9] * vz + proj[13] * vw) / w;
    const nz = (proj[2] * vx + proj[6] * vy + proj[10] * vz + proj[14] * vw) / w;
    if (nz < -1 || nz > 1) return null;
    return [bounds.left + (nx + 1) * bounds.width / 2, bounds.top + (1 - ny) * bounds.height / 2];
  }

  function drawOverlay(client) {
    if (!painter || runtime.stopped) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (width !== innerWidth || height !== innerHeight || pixelRatio !== dpr) {
      width = innerWidth; height = innerHeight; pixelRatio = dpr;
      overlay.width = Math.round(width * dpr); overlay.height = Math.round(height * dpr);
      painter.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    painter.clearRect(0, 0, width, height);
    const camera = client.engine?.pipeline.ctx.camera;
    if ((!options.xray && !options.loot) || !camera || client.disposed || client.paused || client.cinema?.active) return;
    const bounds = client.canvas.getBoundingClientRect();
    if (!camera.matrixWorldInverse?.elements || !camera.projectionMatrix?.elements || bounds.width <= 0 || bounds.height <= 0) return;
    const me = ownState(client);
    painter.save();
    try {
    painter.beginPath(); painter.rect(bounds.left, bounds.top, bounds.width, bounds.height); painter.clip();
    painter.font = '600 11px ui-monospace, monospace';
    painter.textAlign = 'center';
    const labelRects = [];
    function labelAt(text, x, y, color) {
      const w = painter.measureText(text).width + 10;
      let top = y - 19;
      for (let tries = 0; tries < 6; tries++) {
        if (!labelRects.some(r => x - w / 2 < r.x + r.w && x + w / 2 > r.x && top < r.y + 16 && top + 16 > r.y)) break;
        top -= 18;
      }
      if (top < bounds.top) top = bounds.top;
      labelRects.push({ x: x - w / 2, y: top, w });
      painter.fillStyle = '#0a101de0'; painter.fillRect(x - w / 2, top, w, 16);
      painter.fillStyle = color; painter.fillText(text, x, top + 12);
    }
    for (const { snap } of options.xray ? client.remoteFrames || [] : []) {
      if (!enemy(client, snap)) continue;
      const feet = project(snap.p, camera, bounds);
      const head = project([snap.p[0], snap.p[1] + bodyHeight(snap.c), snap.p[2]], camera, bounds);
      if (!feet || !head) continue;
      const boxHeight = Math.abs(feet[1] - head[1]);
      const boxWidth = Math.max(8, boxHeight * 0.42);
      const x = head[0] - boxWidth / 2, y = Math.min(head[1], feet[1]);
      if (x + boxWidth < bounds.left || x > bounds.right || y + boxHeight < bounds.top || y > bounds.bottom) continue;
      const chosen = runtime.target?.index === snap.i;
      const color = chosen ? '#ffbb55' : (snap.f & 256 ? '#8997b0' : '#59f6d2');
      painter.strokeStyle = color; painter.lineWidth = chosen ? 2 : 1;
      painter.fillStyle = chosen ? '#ffbb551c' : '#59f6d212';
      painter.fillRect(x, y, boxWidth, boxHeight); painter.strokeRect(x, y, boxWidth, boxHeight);
      const distance = me?.pos ? Math.round(Math.hypot(...snap.p.map((value, i) => value - me.pos[i]))) : null;
      const name = String(client.names?.get(snap.i) || 'Player ' + (snap.i + 1));
      const label = name.slice(0, 22) + (distance === null ? '' : ' / ' + distance + 'm');
      labelAt(label, head[0], y, color);
    }
    if (options.loot && me?.pos && client.loot) {
      const loot = client.loot;
      const now = performance.now();
      if (lootCacheClient !== client || now - lootCacheAt >= 200) {
        const nearby = [];
        const activeAmmo = client.predictor?.activeStats?.ammo;
        for (const item of loot.items?.values() || []) {
          if (!['weapon', 'ammo'].includes(item.kind) || !Array.isArray(item.pos) ||
              item.pos.length !== 3 || !item.pos.every(Number.isFinite)) continue;
          const distance = Math.hypot(...item.pos.map((value, i) => value - me.pos[i]));
          if (distance <= 100) nearby.push({ id: item.id, kind: 'item', pos: item.pos,
            distance, rarity: item.kind === 'ammo' ? 'ammo' : item.rarity,
            priority: item.kind === 'ammo' && typeof activeAmmo === 'string' &&
              item.ammo === activeAmmo ? 1 : 0 });
        }
        for (const crate of loot.crates || []) {
          if (loot.opened?.has(crate.id) || !Array.isArray(crate.pos) ||
              crate.pos.length !== 3 || !crate.pos.every(Number.isFinite)) continue;
          const distance = Math.hypot(...crate.pos.map((value, i) => value - me.pos[i]));
          if (distance <= 100) nearby.push({ id: crate.id, kind: 'crate', pos: crate.pos,
            distance, rarity: 'legendary', priority: 0 });
        }
        nearby.sort((a, b) => b.priority - a.priority || a.distance - b.distance);
        lootCache = nearby;
        lootCacheAt = now;
        lootCacheClient = client;
      }
      const colors = { common: '#ccd4df', uncommon: '#87ea9a', rare: '#75baff',
        epic: '#c69aff', legendary: '#ffbd58', ammo: '#59f6d2' };
      let visible = 0;
      for (const item of lootCache) {
        if (item.kind === 'item' && !loot.items?.has(item.id)) continue;
        if (item.kind === 'crate' && loot.opened?.has(item.id)) continue;
        const screen = project([item.pos[0], item.pos[1] + 0.3, item.pos[2]], camera, bounds);
        if (!screen || screen[0] < bounds.left || screen[0] > bounds.right || screen[1] < bounds.top || screen[1] > bounds.bottom) continue;
        const description = loot.describe?.({ kind: item.kind, id: item.id }, false);
        const text = String(description?.label || (item.kind === 'crate' ? 'Crate' :
          item.rarity === 'ammo' ? 'Ammo' : 'Weapon')).slice(0, 30) + ' / ' + Math.round(item.distance) + 'm';
        const color = colors[item.rarity] || '#ccd4df';
        painter.strokeStyle = color; painter.strokeRect(screen[0] - 3, screen[1] - 3, 6, 6);
        labelAt(text, screen[0], screen[1] - 2, color);
        if (++visible >= 24) break;
      }
    }
    } finally { painter.restore(); }
    updateStatus();
  }

  function syncControls() {
    if (!root) return;
    for (const name of ['xray', 'loot', 'silent', 'rage', 'rapidFire', 'hipFire', 'agent',
      'smartAim', 'visibleOnly', 'stealth', 'ammo'])
      root.querySelector('[name="' + name + '"]').checked = options[name];
    for (const name of ['fov', 'range', 'hipRange', 'point'])
      root.querySelector('[name="' + name + '"]').value = options[name];
    root.querySelector('[name="smooth"]').value = options.smooth;
    root.querySelector('[data-value="fov"]').textContent = options.fov + ' deg';
    root.querySelector('[data-value="range"]').textContent = options.range + ' m';
    root.querySelector('[data-value="hipRange"]').textContent = options.hipRange + ' m';
    root.querySelector('[data-value="smooth"]').textContent = options.smooth.toFixed(2);
    root.querySelector('[name="fov"]').disabled = options.rage;
    root.querySelector('[name="hipRange"]').disabled = !options.hipFire;
    root.querySelector('[name="smartAim"]').disabled = options.point !== 'auto';
    for (const name of ['silent', 'rage']) root.querySelector('[name="' + name + '"]').disabled = runtime.aimRejected;
  }

  function updateStatus() {
    if (!status || performance.now() - updatedAt < 200) return;
    updatedAt = performance.now();
    const client = runtime.client;
    if (runtime.aimRejected) status.textContent = 'Server rejected aim assistance / aim disabled';
    else if (runtime.error) status.textContent = runtime.error;
    else if (archiveState.error) status.textContent = 'Trace archive: ' + archiveState.error;
    else if (!client || client.disposed) status.textContent = runtime.hookReady ? 'Hook ready / waiting for a match' : 'Waiting for the game client';
    else if (!runtime.pipeline) status.textContent = 'Client captured / loading renderer';
    else if (client.cinema?.active) status.textContent = 'Cinematic / tools paused until gameplay';
    else if (performance.now() - runtime.renderedAt > 2500) status.textContent = 'Client captured / rendering paused';
    else status.textContent = 'Active / ' + (client.remoteFrames || []).filter(({ snap }) => enemy(client, snap)).length + ' opponents tracked';
    const targetName = runtime.target ? (client?.names?.get(runtime.target.index) || 'Player ' + (runtime.target.index + 1)) : '--';
    const targetRange = runtime.target && Number.isFinite(runtime.target.distance)
      ? ' @ ' + Math.round(runtime.target.distance) + ' m' : '';
    const targetPart = runtime.target?.aimPart ? ' / ' + runtime.target.aimPart.toUpperCase() : '';
    const metrics = 'AIM ' + runtime.rewrites + ' redirected / ' + runtime.stealth.heldShots +
      ' fire frames held / SERVER ' + runtime.server.hits + ' hits, ' + runtime.server.shots +
      ' shots / AGENT ' + (options.agent ? runtime.agent.action : 'off') +
      ' / SEED ' + runtime.seedSync.status;
    root.querySelector('[data-live-metrics]').textContent = metrics;
    stats.textContent = 'TARGET ' + targetName + targetRange + targetPart +
      ' / ' + runtime.compensated + ' shot corrections / ' + metrics +
      (archiveState.savedAt ? ' / trace saved ' + new Date(archiveState.savedAt).toLocaleTimeString() : '');
  }

  function resumeGame() {
    const canvas = runtime.client?.canvas;
    if (!canvas || document.pointerLockElement === canvas) return;
    try {
      const request = canvas.requestPointerLock?.();
      if (request && typeof request.catch === 'function') request.catch(() => {});
    } catch { /* The game can still restore pointer lock with a canvas click. */ }
  }

  function mount() {
    if (host || runtime.stopped || !zonePage()) return;
    host = document.createElement('div');
    host.id = 'bridgezone-tools';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{color-scheme:dark;font:13px system-ui,sans-serif;color:#edf5ff}
      *{box-sizing:border-box}canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
      aside{position:absolute;top:20px;right:20px;width:300px;max-width:calc(100vw - 32px);max-height:calc(100vh - 40px);pointer-events:auto;background:#0b101ded;border:1px solid #334454;border-top:2px solid #59f6d2;border-radius:12px;box-shadow:0 14px 50px #0008;overflow:auto}
      header{padding:17px 18px 13px;border-bottom:1px solid #25313e;display:flex;justify-content:space-between;align-items:center;gap:10px}
      .header-actions{display:flex;gap:6px}.resume{color:#081019;background:#59f6d2;border-color:#59f6d2}
      small{display:block;font:10px ui-monospace,monospace;letter-spacing:2px;color:#59f6d2;margin-bottom:4px}h2{font-size:18px;letter-spacing:-.5px;margin:0}
      button{font:inherit;color:#9ab0c5;border:1px solid #354252;background:#111b28;border-radius:5px;cursor:pointer;padding:5px 8px}
      .body{padding:6px 18px 14px}label{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 0;cursor:pointer}
      label.feature{border-bottom:1px solid #25313e;font-weight:600}.key{font:10px ui-monospace,monospace;color:#8997b0;margin-left:6px}
      input[type=checkbox]{width:17px;height:17px;accent-color:#59f6d2;cursor:pointer}input[type=range]{width:100%;accent-color:#59f6d2;margin:0 0 7px}
      .setting{padding-bottom:7px}.setting label{padding-bottom:7px;font-size:12px;color:#afbdd0}output{font:11px ui-monospace,monospace;color:#59f6d2}
      select{background:#182231;border:1px solid #354252;color:#edf5ff;border-radius:5px;padding:5px 8px}
      .note{font-size:11px;line-height:1.5;color:#8997b0;margin:8px 0 0}.status{border-top:1px solid #25313e;background:#081019;padding:11px 18px;color:#59f6d2;font:11px ui-monospace,monospace;line-height:1.6}.stats{color:#8997b0;font-size:10px;overflow-wrap:anywhere}
      .live-metrics{padding:8px 18px;border-bottom:1px solid #25313e;color:#59f6d2;font:10px ui-monospace,monospace;line-height:1.4;display:flex;align-items:center;justify-content:space-between;gap:8px}
      .live-metrics button{flex:none;font-size:10px;padding:3px 5px}.trace-actions{display:flex;gap:4px;flex:none}
      .show-tools{position:absolute;top:20px;right:20px;pointer-events:auto;border-color:#59f6d2;color:#59f6d2;background:#0b101ded}
      .show-tools[hidden]{display:none}
    </style><canvas aria-hidden="true"></canvas><aside aria-label="BridgeZone tools">
      <header><div><small>BRIDGEZONE / LOCAL TOOLS v${VERSION}</small><h2>Xray + Silent AIM</h2></div><div class="header-actions"><button class="resume" type="button" data-resume-game>Resume</button><button type="button" data-hide-panel aria-label="Hide tools panel">Hide</button></div></header>
      <div class="live-metrics"><span data-live-metrics>Waiting for a match</span><div class="trace-actions"><button type="button" data-download-trace aria-label="Save match trace">Save</button><button type="button" data-download-archive aria-label="Download latest automatically saved trace">Saved</button></div></div>
      <div class="body">
        <label class="feature">Xray boxes <span class="key">F8</span><input aria-label="Xray boxes" name="xray" type="checkbox"></label>
        <label class="feature">Loot + crate vision<input aria-label="Loot vision" name="loot" type="checkbox"></label>
        <label class="feature">Silent AIM <span class="key">F9</span><input aria-label="Silent AIM" name="silent" type="checkbox"></label>
        <label class="feature">Rage / 360 + auto fire<input aria-label="Rage mode" name="rage" type="checkbox"></label>
        <label class="feature">Fast fire when ready<input aria-label="Fast fire" name="rapidFire" type="checkbox"></label>
        <label class="feature">Adaptive hip fire<input aria-label="Adaptive hip fire" name="hipFire" type="checkbox"></label>
        <label class="feature">Combat agent <span class="key">Auto move</span><input aria-label="Combat agent" name="agent" type="checkbox"></label>
        <div class="setting"><label for="fov">Normal aim cone (half-angle)<output data-value="fov"></output></label><input id="fov" name="fov" aria-label="Aim cone" type="range" min="1" max="90" step="1"></div>
        <div class="setting"><label for="range">Maximum range<output data-value="range"></output></label><input id="range" name="range" aria-label="Maximum range" type="range" min="10" max="600" step="10"></div>
        <div class="setting"><label for="hipRange">Hip-fire max distance<output data-value="hipRange"></output></label><input id="hipRange" name="hipRange" aria-label="Hip-fire max distance" type="range" min="10" max="40" step="10"></div>
        <label>Target point<select name="point" aria-label="Target point"><option value="auto">Auto / clear point</option><option value="head">Head</option><option value="chest">Chest</option></select></label>
        <label>Adaptive Auto point<input name="smartAim" aria-label="Adaptive Auto point" type="checkbox"></label>
        <label>Skip targets behind cover<input name="visibleOnly" aria-label="Skip targets behind cover" type="checkbox"></label>
        <label class="feature">Anticheat stealth<input name="stealth" aria-label="Anticheat stealth" type="checkbox"></label>
        <label class="feature">Ammo assist / reload + pickup<input name="ammo" aria-label="Ammo assist" type="checkbox"></label>
        <div class="setting"><label for="smooth">Aim smoothing<output data-value="smooth"></output></label><input id="smooth" name="smooth" aria-label="Aim smoothing" type="range" min="0.1" max="0.95" step="0.05"></div>
        <p class="note">Insert: show/hide. Resume restores game controls. F/E takes priority. Combat agent starts on and moves toward visible enemies, available ammo, or the safe zone; your movement or action keys override it. It stops to shoot inside effective weapon range. Head and Chest are exact choices; Auto may adapt. Hip fire is limited to stationary shots within 40 m because longer and moving hip shots had poor results in the last trace. Predicted spread correction is a local estimate; only server hits confirm accuracy. Server spread, recoil, cover and weapon limits remain. Traces save locally during play; use Saved to export the latest archive.</p>
      </div><div class="status"><div role="status"></div><div class="stats"></div></div>
    </aside><button type="button" class="show-tools" data-show-panel hidden aria-label="Show tools panel">Show tools</button>`;
    document.documentElement.appendChild(host);
    overlay = root.querySelector('canvas'); painter = overlay.getContext('2d');
    panel = root.querySelector('aside'); status = root.querySelector('[role="status"]'); stats = root.querySelector('.stats');
    showButton = root.querySelector('[data-show-panel]');
    panel.hidden = !panelVisible;
    showButton.hidden = panelVisible;
    root.querySelector('[data-hide-panel]').addEventListener('click', () => {
      panelVisible = false; panel.hidden = true; showButton.hidden = false;
      resumeGame();
    });
    root.querySelector('[data-resume-game]').addEventListener('click', resumeGame);
    showButton.addEventListener('click', () => {
      panelVisible = true; panel.hidden = false; showButton.hidden = true;
    });
    function downloadTrace(payload) {
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'bridgezone-trace-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      root.appendChild(link);
      link.click();
      setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 1000);
    }
    root.querySelector('[data-download-trace]').addEventListener('click', () => {
      try {
        downloadTrace(exportTrace());
      } catch (error) {
        runtime.error = 'Trace export: ' + (error?.message || error);
        updatedAt = -Infinity;
        updateStatus();
      }
    });
    root.querySelector('[data-download-archive]').addEventListener('click', async () => {
      try {
        const payload = await latestArchivedTrace();
        if (!payload) throw new Error('No saved trace yet');
        downloadTrace(payload);
      } catch (error) {
        runtime.error = 'Saved trace: ' + (error?.message || error);
        updatedAt = -Infinity;
        updateStatus();
      }
    });
    root.addEventListener('input', event => {
      const control = event.target;
      if (!control.name) return;
      const value = control.type === 'checkbox' ? control.checked : control.type === 'range' ? Number(control.value) : control.value;
      setOptions({ [control.name]: value });
    });
    for (const name of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'wheel']) {
      root.addEventListener(name, event => event.stopPropagation());
    }
    syncControls();
    updatedAt = -Infinity;
    updateStatus();
  }

  function onKey(event) {
    onInteractionKey(event);
    const target = event.composedPath?.()[0] || event.target;
    if (!zonePage() || event.repeat || event.ctrlKey || event.altKey || event.metaKey || target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName)) return;
    if (!['F8', 'F9', 'Insert'].includes(event.code)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.code === 'F8') setOptions({ xray: !options.xray });
    if (event.code === 'F9') setOptions({ silent: !options.silent });
    if (event.code === 'Insert') {
      panelVisible = !panelVisible;
      if (panel) panel.hidden = !panelVisible;
      if (showButton) showButton.hidden = panelVisible;
    }
  }

  function recordInteractionEvent(phase, key = null, event = null) {
    if (!zonePage()) return;
    const canvas = runtime.client?.canvas;
    const path = event?.composedPath?.();
    recordTrace('interactions', {
      at: performance.now(), match: runtime.trace.match, phase, key,
      repeat: event ? !!event.repeat : null,
      pointerLocked: canvas ? document.pointerLockElement === canvas : null,
      clientAttached: !!runtime.client,
      inputEnabled: runtime.client?.input?.enabled !== false,
      fromToolsPanel: Array.isArray(path) ? path.includes(root) : null
    });
  }

  function onInteractionKey(event) {
    if (event.code === 'KeyF' || event.code === 'KeyE')
      recordInteractionEvent(event.type || 'keydown', event.code, event);
  }

  window.addEventListener('keyup', onInteractionKey, true);
  restores.push(() => window.removeEventListener('keyup', onInteractionKey, true));
  function onPointerLockChange() { recordInteractionEvent('pointerlockchange'); }
  document.addEventListener('pointerlockchange', onPointerLockChange);
  restores.push(() => document.removeEventListener('pointerlockchange', onPointerLockChange));

  window.addEventListener('keydown', onKey, true);
  restores.push(() => window.removeEventListener('keydown', onKey, true));
  function onStorage(event) {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    try { setOptions(event.newValue ? migrateSavedSettings(JSON.parse(event.newValue)) : defaults, false); }
    catch { /* Ignore invalid saved settings. */ }
  }
  window.addEventListener('storage', onStorage);
  restores.push(() => window.removeEventListener('storage', onStorage));
  const onPageHide = () => { void archiveTrace(true); };
  window.addEventListener('pagehide', onPageHide);
  restores.push(() => window.removeEventListener('pagehide', onPageHide));
  window.__bridgeZoneTools = {
    version: VERSION, options, runtime, setOptions,
    attachClient(client, physics) {
      if (physics) {
        for (const name of ['getCollisionWorld', 'hasLineOfSight', 'raycastWorld', 'shotSeed', 'mulberry32'])
          runtime.physics[name] = physics[name];
      }
      runtime.hookReady = true;
      return attachClient(client);
    },
    inspect: () => ({ version: VERSION, hookReady: runtime.hookReady, captured: !!runtime.client, renderer: !!runtime.pipeline,
      aimRejected: runtime.aimRejected,
      opponents: runtime.client?.remoteFrames?.length || 0, rewrites: runtime.rewrites, compensated: runtime.compensated,
      heldShots: runtime.stealth.heldShots, agent: { action: runtime.agent.action,
        goal: runtime.agent.goal?.kind ?? null }, seedSync: { ...runtime.seedSync },
      server: { ...runtime.server }, archive: { supported: !!window.indexedDB,
        savedAt: archiveState.savedAt, error: archiveState.error },
      error: runtime.error, options: { ...options } }),
    trace: traceSnapshot,
    exportTrace,
    saveTrace: () => archiveTrace(true),
    latestArchivedTrace,
    destroy() {
      if (runtime.stopped) return;
      runtime.stopped = true;
      clearInterval(timer);
      detachClient();
      restoreHooks(restores);
      host?.remove();
      document.removeEventListener('DOMContentLoaded', mount);
      if (window.__bridgeZoneTools?.runtime === runtime) delete window.__bridgeZoneTools;
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  timer = setInterval(() => {
    if (document.readyState === 'loading') return;
    if (!zonePage()) {
      if (host) host.style.display = 'none';
      if (runtime.client) detachClient();
      return;
    }
    mount();
    if (host) host.style.display = '';
    if (runtime.client?.disposed) detachClient();
    try {
      recoverLoadedClient();
      if (runtime.client) recoverPhysics();
    } catch (error) { runtime.error = 'Late client hook: ' + error.message; }
    const client = runtime.client;
    if (client && !client.disposed) { attachPredictor(client); attachRenderer(client); }
    if (client && !client.disposed) {
      if (client.latest?.phase === 'finished' && archiveState.finalizedMatch !== runtime.trace.match) {
        archiveState.finalizedMatch = runtime.trace.match;
        void archiveTrace(true);
      } else void archiveTrace(false);
    }
    if (!client || client.disposed || performance.now() - runtime.renderedAt > 2500) painter?.clearRect(0, 0, width, height);
    updateStatus();
  }, 500);
})();
