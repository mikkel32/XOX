// ==UserScript==
// @name         BridgeZone - Xray and Silent AIM
// @namespace    local.bridgezone.tools
// @version      1.5.5
// @description  Xray, 360-degree Rage, auto fire, and server-consistent reloads.
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
  const VERSION = '1.5.5';
  const STORAGE_KEY = 'bridgezone.tools.v2';
  const MAX_OUTGOING_TURN = 8 * Math.PI / 180;
  const OUTGOING_AIM_TOLERANCE = 0.008;
  const defaults = { xray: true, loot: true, silent: true, rage: false, fov: 90, range: 600, point: 'auto', visibleOnly: true, stealth: true, smooth: 1, ammo: true };
  const options = { ...defaults };
  const runtime = {
    client: null, physics: {}, hookReady: false, stopped: false, aimRejected: false,
    rewrites: 0, compensated: 0, predictions: new Map(), target: null, error: '', pipeline: null, renderedAt: 0
  };
  runtime.stealth = { deterministic: 0, misses: 0, cooldown: 0, backoffUntil: 0, lastShotAt: 0, heldShots: 0, phase: Math.random() * Math.PI * 2 };
  runtime.outgoingAim = { yaw: null, pitch: null, targetIndex: null, ready: false, pendingManualUntil: 0 };
  runtime.server = { shots: 0, hits: 0, headshots: 0, kills: 0, damage: 0 };
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
    serverEvents: [],
    kicks: [],
    connectionStates: [],
    errors: []
  };

  function recordTrace(kind, entry, limit = 128) {
    const items = runtime.trace[kind];
    items.push(entry);
    if (items.length > limit) items.splice(0, items.length - limit);
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
        before: [before.yaw, before.pitch, before.mx, before.mz],
        after: [after.yaw, after.pitch, after.mx, after.mz]
      }, 4096);
    }
  }

  function traceSnapshot() {
    return { ...runtime.trace, frames: runtime.trace.frames.map(frame => ({ ...frame,
      before: [...frame.before], after: [...frame.after] })),
      localShots: runtime.trace.localShots.map(shot => ({ ...shot,
        eye: [...shot.eye], directions: shot.directions.map(direction => [...direction]) })),
      serverEvents: runtime.trace.serverEvents.map(event => ({ ...event })),
      connectionStates: runtime.trace.connectionStates.map(state => ({ ...state })),
      kicks: runtime.trace.kicks.map(kick => ({ ...kick })),
      errors: runtime.trace.errors.map(error => ({ ...error })) };
  }

  function restoreHooks(hooks) {
    while (hooks.length) {
      try { hooks.pop()(); }
      catch (error) { runtime.error = 'Cleanup hook: ' + (error?.message || error); }
    }
  }

  function detachClient() {
    restoreHooks(clientRestores);
    runtime.client = null;
    runtime.pipeline = null;
    runtime.renderedAt = 0;
    runtime.predictions.clear();
    runtime.target = null;
    lootCacheClient = null;
    lootCache = [];
  }

  function setOptions(patch, persist = true) {
    if (!patch || typeof patch !== 'object') return;
    const wasStealth = options.stealth;
    for (const name of ['xray', 'loot', 'silent', 'rage', 'visibleOnly', 'stealth', 'ammo']) {
      if (typeof patch[name] === 'boolean') options[name] = patch[name];
    }
    if (Number.isFinite(patch.fov)) options.fov = Math.max(1, Math.min(90, patch.fov));
    if (Number.isFinite(patch.range)) options.range = Math.max(10, Math.min(600, patch.range));
    if (['head', 'chest', 'auto'].includes(patch.point)) options.point = patch.point;
    if (Number.isFinite(patch.smooth)) options.smooth = Math.max(0, Math.min(1, patch.smooth));
    if (runtime.aimRejected) options.silent = options.rage = false;
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(options)); } catch { /* Storage is optional. */ }
    }
    syncControls();
    if (!options.xray && !options.loot) painter?.clearRect(0, 0, width, height);
    if (!options.silent || wasStealth !== options.stealth) {
      runtime.target = null;
      runtime.outgoingAim = { yaw: null, pitch: null, targetIndex: null, ready: false, pendingManualUntil: 0 };
    }
  }

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    // Keep saved aim settings and migrate narrow legacy cones to the current default.
    setOptions({ ...saved, smooth: 1, fov: Math.max(Number.isFinite(saved.fov) ? saved.fov : defaults.fov, defaults.fov) }, false);
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

  function selectTarget(client, frame, shotOrigin) {
    const me = ownState(client);
    if (!me?.pos?.every(Number.isFinite)) return null;
    const origin = shotOrigin || [me.pos[0], me.pos[1] + 1.62 - 0.62 * Math.max(0, Math.min(1, me.crouch || 0)), me.pos[2]];
    const cp = Math.cos(frame.pitch);
    const forward = [-Math.sin(frame.yaw) * cp, Math.sin(frame.pitch), -Math.cos(frame.yaw) * cp];
    const minDot = options.rage ? -1 : Math.cos(options.fov * Math.PI / 180);
    const weaponRange = client.predictor?.activeStats?.rangeEnd;
    const maxRange = options.rage && Number.isFinite(weaponRange)
      ? Math.min(options.range, Math.max(30, weaponRange * 1.35)) : options.range;
    const approachYaw = runtime.outgoingAim.yaw ?? frame.yaw;
    let best = null;
    let bestScore = Infinity;
    for (const { snap: current } of client.remoteFrames || []) {
      if (!enemy(client, current, true)) continue;
      let snap = current;
      if (client.interpolator?.sample && Number.isFinite(frame.vt)) {
        const sample = { ...current, p: [...current.p], v: [...(current.v || [0, 0, 0])] };
        // Match the server's rewind tick without changing the client's render snapshots.
        if (!client.interpolator.sample(current.i, frame.vt, sample)) continue;
        snap = sample;
      }
      if (!enemy(client, snap, true)) continue;
      const speed = Math.hypot(...(snap.v || [0, 0, 0]));
      const distanceToFeet = Math.hypot(...snap.p.map((value, i) => value - origin[i]));
      const preferred = options.point === 'auto' && (distanceToFeet > 50 || speed > 4) ? 'chest' : options.point;
      let point = aimPoint(snap, preferred);
      const delta = point.map((value, i) => value - origin[i]);
      const distance = Math.hypot(...delta);
      if (distance < 0.01 || distance > maxRange) continue;
      const dot = delta.reduce((sum, value, i) => sum + value * forward[i], 0) / distance;
      if (dot < minDot) continue;
      if (options.visibleOnly) {
        const { getCollisionWorld, hasLineOfSight } = runtime.physics;
        // If collision hooks are unavailable, don't select a target through unknown cover.
        if (!getCollisionWorld || !hasLineOfSight) continue;
        const world = getCollisionWorld();
        if (!hasLineOfSight(world, origin, point)) {
          if (options.point !== 'auto') continue;
          point = aimPoint(snap, preferred === 'chest' ? 'head' : 'chest');
          if (!hasLineOfSight(world, origin, point)) continue;
        }
      }
      const aimDelta = point.map((value, i) => value - origin[i]);
      const pitch = Math.atan2(aimDelta[1], Math.hypot(aimDelta[0], aimDelta[2]));
      if (Math.abs(pitch) > 1.54) continue;
      const yaw = Math.atan2(-aimDelta[0], -aimDelta[2]);
      // Favor targets that need little turning, then keep the current target stable.
      const score = options.rage
        ? Math.abs(normalizedDelta(approachYaw, yaw)) + 0.25 * distance / maxRange -
          (snap.i === runtime.outgoingAim.targetIndex ? 0.25 : 0)
        : 1 - dot;
      if (score >= bestScore) continue;
      bestScore = score;
      best = {
        index: snap.i, distance, direction: aimDelta.map(value => value / Math.hypot(...aimDelta)),
        yaw,
        pitch
      };
    }
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

  function compensateSpread(shot, target) {
    if (!shot || shot.directions.length !== 1) return null;
    const y = shot.yaw, p = shot.pitch, d = shot.directions[0];
    const forward = [-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
    const right = [Math.cos(y), 0, -Math.sin(y)];
    const up = [Math.sin(y) * Math.sin(p), Math.cos(p), Math.cos(y) * Math.sin(p)];
    const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
    const denom = dot(d, forward);
    if (denom <= 0 || !Number.isFinite(denom)) return null;
    const u = dot(d, right) / denom, m = dot(d, up) / denom;
    const arg = Math.hypot(1, u, m) * target.direction[1] / Math.hypot(1, m);
    if (!Number.isFinite(arg) || Math.abs(arg) > 1) return null;
    const pitch = Math.asin(arg) - Math.atan(m);
    if (Math.abs(pitch) > 1.54) return null;
    const a = -Math.cos(pitch) + m * Math.sin(pitch);
    const rawYaw = target.yaw + Math.atan2(u, -a);
    const yaw = Math.atan2(Math.sin(rawYaw), Math.cos(rawYaw));
    return { yaw, pitch };
  }

  function jitterAngle(value, amount) {
    // Deterministic-looking noise avoids a perfectly periodic aim signature.
    const phase = performance.now() / 1000 * 2.1 + runtime.stealth.phase + value * 17.3;
    return (Math.sin(phase) * 0.45 + Math.sin(phase * 2.7 + 1.3) * 0.3 + (Math.random() - 0.5) * 0.25) * amount;
  }

  function normalizedDelta(from, to) {
    return Math.atan2(Math.sin(to - from), Math.cos(to - from));
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
    const state = runtime.outgoingAim;
    const now = performance.now();
    if (options.rage) state.pendingManualUntil = 0;
    if (state.pendingManualUntil && now > state.pendingManualUntil) state.pendingManualUntil = 0;
    const requestedFire = !!(frame.buttons & 1);
    if (!requestedFire && !state.pendingManualUntil) return frame;
    const tick = Number.isFinite(frame.vt) ? frame.vt : client.renderTick?.();
    const target = selectTarget(client, { ...frame, vt: tick });
    if (!target) {
      state.pendingManualUntil = 0;
      return frame;
    }
    const ready = state.ready && state.targetIndex === target.index;
    if (requestedFire && !options.rage && !ready) state.pendingManualUntil = now + 900;
    if (!requestedFire && !state.pendingManualUntil) return frame;
    if (!ready || stealthSkip()) {
      if (requestedFire && !options.rage) state.pendingManualUntil = now + 900;
      if (!requestedFire) return frame;
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
      if (state.yaw === null) { state.yaw = frame.yaw; state.pitch = frame.pitch; }
      if (state.pendingManualUntil && performance.now() > state.pendingManualUntil) state.pendingManualUntil = 0;
      const shot = runtime.predictions.get(frame.s);
      runtime.predictions.delete(frame.s);
      const target = !(frame.buttons & 4) &&
        ((options.rage && client.predictor?.activeStats) || state.pendingManualUntil || (frame.buttons & 1))
        ? selectTarget(client, frame, shot?.eye) : null;
      let desired = target || { yaw: frame.yaw, pitch: frame.pitch };
      let correction = null;
      const wasReady = state.ready && state.targetIndex === target?.index;
      if (target && (frame.buttons & 1)) {
        const candidate = compensateSpread(shot, target);
        // Do not defer a locally predicted shot just to chase an unreachable spread correction.
        if (candidate && Math.abs(normalizedDelta(state.yaw, candidate.yaw)) <= MAX_OUTGOING_TURN &&
            Math.abs(candidate.pitch - state.pitch) <= MAX_OUTGOING_TURN) correction = candidate;
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
      state.ready = !!target && Math.abs(normalizedDelta(nextYaw, desired.yaw)) <= OUTGOING_AIM_TOLERANCE &&
        Math.abs(nextPitch - desired.pitch) <= OUTGOING_AIM_TOLERANCE;
      if (target) runtime.target = target;

      let buttons = frame.buttons;
      if (buttons & 1) {
        const ready = target ? (state.ready || wasReady) :
          Math.abs(normalizedDelta(nextYaw, frame.yaw)) <= OUTGOING_AIM_TOLERANCE &&
          Math.abs(nextPitch - frame.pitch) <= OUTGOING_AIM_TOLERANCE;
        if (!ready || (target && stealthSkip())) {
          buttons &= ~1;
          runtime.stealth.heldShots++;
        } else if (target) {
          runtime.rewrites++;
          if (correction) runtime.compensated++;
          recordStealthShot({ yaw: frame.yaw, pitch: frame.pitch }, { yaw: nextYaw, pitch: nextPitch });
          state.pendingManualUntil = 0;
        }
      }

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
      if (!(frame.buttons & 1) || (frame.buttons & 4) || ![frame.yaw, frame.pitch, frame.mx, frame.mz].every(Number.isFinite)) return frame;
      const shot = runtime.predictions.get(frame.s);
      runtime.predictions.delete(frame.s);
      const target = selectTarget(client, frame, shot?.eye);
      if (!target) return frame;
      if (options.stealth && stealthSkip()) {
        // A deferred shot must not become an unassisted shot on the wire.
        modified = true;
        runtime.stealth.heldShots++;
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
      const result = Reflect.apply(original, this, [frame, ...args]);
      if (runtime.client === client && result?.weapon?.fired) {
        // These are the exact pre-recoil shot directions produced by the shared game kernel.
        runtime.predictions.set(frame.s, {
          yaw: frame.yaw, pitch: frame.pitch, eye: [...result.eye],
          directions: result.weapon.dirs.map(direction => [...direction])
        });
        recordTrace('localShots', { at: performance.now(), match: runtime.trace.match,
          sequence: frame.s, yaw: frame.yaw, pitch: frame.pitch,
          eye: [...result.eye], directions: result.weapon.dirs.map(direction => [...direction]) });
        while (runtime.predictions.size > 16) runtime.predictions.delete(runtime.predictions.keys().next().value);
      }
      return result;
    });
    clientRestores.push(() => hookedPredictors.delete(predictor));
  }

  function rageInput(client, frame) {
    if (!options.rage || !playable(client)) return frame;
    const predictor = client.predictor;
    const weapon = predictor?.activeStats;
    const slot = predictor?.slots?.[predictor.active];
    if (!weapon || !slot || !predictor.ws) return frame;
    const tick = typeof client.renderTick === 'function' ? Math.round(client.renderTick()) : undefined;
    if (!selectTarget(client, { ...frame, vt: tick })) {
      // Rage owns Fire while enabled; suppress blind shots at cover or missing targets.
      return { ...frame, buttons: frame.buttons & ~1 };
    }
    const ws = predictor.ws;
    let buttons = (frame.buttons & ~(1 | 16)) | 2;
    if (slot.mag <= 0) {
      if (predictor.ammo?.[weapon.ammo] > 0) buttons |= 32;
    } else if (weapon.fireMode === 'auto' || (!ws.trigger && ws.cooldown <= 1 / 30 + 1e-9)) buttons |= 1;
    return { ...frame, buttons };
  }

  function autoReloadFrame(client, frame) {
    if (!options.ammo) return frame;
    const predictor = client.predictor;
    const weapon = predictor?.activeStats;
    if (!predictor || !weapon || !Number.isInteger(predictor.active)) return frame;
    const slot = predictor.slots?.[predictor.active];
    const reserve = predictor.ammo?.[weapon.ammo];
    if (slot?.mag > 0 || !(reserve > 0) || predictor.ws?.reload > 0) return frame;
    // The server owns ammunition. Request a real reload instead of changing local prediction.
    return { ...frame, buttons: frame.buttons | 32 };
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
    runtime.rewrites = 0;
    runtime.compensated = 0;
    runtime.stealth.heldShots = 0;
    runtime.outgoingAim = { yaw: null, pitch: null, targetIndex: null, ready: false, pendingManualUntil: 0 };
    runtime.predictions.clear();
    seenServerEvents.clear();
    runtime.server = { shots: 0, hits: 0, headshots: 0, kills: 0, damage: 0 };
    runtime.target = null;
    runtime.error = runtime.aimRejected ? 'Server rejected aim assistance / aim disabled' : '';
    const checkRejection = () => {
      const record = { at: new Date().toISOString(), state: client.connection?.state, error: client.connection?.error, aimRejected: runtime.aimRejected };
      recordTrace('connectionStates', record);
      if (runtime.client !== client || client.connection?.state !== 'kicked') return;
      if (!/aim assistance|anti-cheat/i.test(client.connection.error || '')) return;
      recordTrace('kicks', { ...record, match: runtime.trace.match,
        lastSequence: runtime.trace.frames.at(-1)?.sequence });
      runtime.aimRejected = true;
      runtime.predictions.clear();
      setOptions({ silent: false, rage: false });
      runtime.error = 'Server rejected aim assistance / aim disabled';
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
          const occurrences = new Map();
          for (const event of snapshot.events || []) {
            if (event?.by !== client.you) continue;
            const signature = JSON.stringify([event.t ?? snapshot.t, event]);
            const ordinal = (occurrences.get(signature) || 0) + 1;
            occurrences.set(signature, ordinal);
            const key = signature + '#' + ordinal;
            if (seenServerEvents.has(key)) continue;
            seenServerEvents.add(key);
            if (seenServerEvents.size > 1024) seenServerEvents.delete(seenServerEvents.values().next().value);
            if (['shot', 'hit', 'kill'].includes(event.type)) {
              recordTrace('serverEvents', { at: performance.now(), match: runtime.trace.match,
                tick: event.t ?? snapshot.t, type: event.type,
                damage: Number.isFinite(event.damage) ? event.damage : null,
                head: event.head === true });
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
        try { prepared = autoReloadFrame(client, frame); }
        catch (error) { recordTrace('errors', { at: new Date().toISOString(), where: 'ammo', message: String(error) }); }
        try { return holdStealthShot(client, rageInput(client, prepared)); }
        catch (error) { runtime.error = 'Rage hook: ' + error.message; return holdOnAimError(frame); }
      });
    }
    const connection = client.connection;
    if (typeof connection?.sendInput === 'function') {
      const original = connection.sendInput;
      replaceMethod(connection, 'sendInput', function (matchId, frames, ...rest) {
        let outgoing = frames;
        if (runtime.client === client && matchId === client.start?.matchId) {
          try { outgoing = rewriteFrames(client, frames); }
          catch (error) {
            runtime.error = 'Aim hook: ' + error.message;
            if (Array.isArray(frames)) {
              const held = frames.map(holdOnAimError);
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
      for (const name of ['getCollisionWorld', 'hasLineOfSight']) runtime.physics[name] = physics[name];
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
              if (moduleId === 54145 && ['getCollisionWorld', 'hasLineOfSight'].includes(key)) runtime.physics[key] = value;
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
      for (const item of loot.items?.values() || []) {
        if (item.kind !== 'weapon' || !Array.isArray(item.pos) || item.pos.length !== 3 || !item.pos.every(Number.isFinite)) continue;
        const distance = Math.hypot(...item.pos.map((value, i) => value - me.pos[i]));
        if (distance <= 100) nearby.push({ id: item.id, kind: 'item', pos: item.pos, distance, rarity: item.rarity });
      }
      for (const crate of loot.crates || []) {
        if (loot.opened?.has(crate.id) || !Array.isArray(crate.pos) || crate.pos.length !== 3 || !crate.pos.every(Number.isFinite)) continue;
        const distance = Math.hypot(...crate.pos.map((value, i) => value - me.pos[i]));
        if (distance <= 100) nearby.push({ id: crate.id, kind: 'crate', pos: crate.pos, distance, rarity: 'legendary' });
      }
      nearby.sort((a, b) => a.distance - b.distance);
      lootCache = nearby;
      lootCacheAt = now;
      lootCacheClient = client;
      }
      const colors = { common: '#ccd4df', uncommon: '#87ea9a', rare: '#75baff', epic: '#c69aff', legendary: '#ffbd58' };
      let visible = 0;
      for (const item of lootCache) {
        if (item.kind === 'item' && !loot.items?.has(item.id)) continue;
        if (item.kind === 'crate' && loot.opened?.has(item.id)) continue;
        const screen = project([item.pos[0], item.pos[1] + 0.3, item.pos[2]], camera, bounds);
        if (!screen || screen[0] < bounds.left || screen[0] > bounds.right || screen[1] < bounds.top || screen[1] > bounds.bottom) continue;
        const description = loot.describe?.({ kind: item.kind, id: item.id }, false);
        const text = String(description?.label || (item.kind === 'crate' ? 'Crate' : 'Weapon')).slice(0, 30) + ' / ' + Math.round(item.distance) + 'm';
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
    for (const name of ['xray', 'loot', 'silent', 'rage', 'visibleOnly', 'stealth', 'ammo']) root.querySelector('[name="' + name + '"]').checked = options[name];
    for (const name of ['fov', 'range', 'point']) root.querySelector('[name="' + name + '"]').value = options[name];
    root.querySelector('[name="smooth"]').value = options.smooth;
    root.querySelector('[data-value="fov"]').textContent = options.fov + ' deg';
    root.querySelector('[data-value="range"]').textContent = options.range + ' m';
    root.querySelector('[data-value="smooth"]').textContent = options.smooth.toFixed(2);
    root.querySelector('[name="fov"]').disabled = options.rage;
    for (const name of ['silent', 'rage']) root.querySelector('[name="' + name + '"]').disabled = runtime.aimRejected;
  }

  function updateStatus() {
    if (!status || performance.now() - updatedAt < 200) return;
    updatedAt = performance.now();
    const client = runtime.client;
    if (runtime.aimRejected) status.textContent = 'Server rejected aim assistance / aim disabled';
    else if (runtime.error) status.textContent = runtime.error;
    else if (!client || client.disposed) status.textContent = runtime.hookReady ? 'Hook ready / waiting for a match' : 'Waiting for the game client';
    else if (!runtime.pipeline) status.textContent = 'Client captured / loading renderer';
    else if (client.cinema?.active) status.textContent = 'Cinematic / tools paused until gameplay';
    else if (performance.now() - runtime.renderedAt > 2500) status.textContent = 'Client captured / rendering paused';
    else status.textContent = 'Active / ' + (client.remoteFrames || []).filter(({ snap }) => enemy(client, snap)).length + ' opponents tracked';
    const targetName = runtime.target ? (client?.names?.get(runtime.target.index) || 'Player ' + (runtime.target.index + 1)) : '--';
    const metrics = 'AIM ' + runtime.rewrites + ' redirected / ' + runtime.stealth.heldShots + ' fire frames held / SERVER ' + runtime.server.hits + ' hits, ' + runtime.server.shots + ' shots';
    root.querySelector('[data-live-metrics]').textContent = metrics;
    stats.textContent = 'TARGET ' + targetName + ' / ' + runtime.compensated + ' spread corrections / ' + metrics;
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
      header{padding:17px 18px 13px;border-bottom:1px solid #25313e;display:flex;justify-content:space-between;align-items:center}
      small{display:block;font:10px ui-monospace,monospace;letter-spacing:2px;color:#59f6d2;margin-bottom:4px}h2{font-size:18px;letter-spacing:-.5px;margin:0}
      button{font:inherit;color:#9ab0c5;border:1px solid #354252;background:#111b28;border-radius:5px;cursor:pointer;padding:5px 8px}
      .body{padding:6px 18px 14px}label{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 0;cursor:pointer}
      label.feature{border-bottom:1px solid #25313e;font-weight:600}.key{font:10px ui-monospace,monospace;color:#8997b0;margin-left:6px}
      input[type=checkbox]{width:17px;height:17px;accent-color:#59f6d2;cursor:pointer}input[type=range]{width:100%;accent-color:#59f6d2;margin:0 0 7px}
      .setting{padding-bottom:7px}.setting label{padding-bottom:7px;font-size:12px;color:#afbdd0}output{font:11px ui-monospace,monospace;color:#59f6d2}
      select{background:#182231;border:1px solid #354252;color:#edf5ff;border-radius:5px;padding:5px 8px}
      .note{font-size:11px;line-height:1.5;color:#8997b0;margin:8px 0 0}.status{border-top:1px solid #25313e;background:#081019;padding:11px 18px;color:#59f6d2;font:11px ui-monospace,monospace;line-height:1.6}.stats{color:#8997b0;font-size:10px;overflow-wrap:anywhere}
      .live-metrics{padding:8px 18px;border-bottom:1px solid #25313e;color:#59f6d2;font:10px ui-monospace,monospace;line-height:1.4;display:flex;align-items:center;justify-content:space-between;gap:8px}
      .live-metrics button{flex:none;font-size:10px;padding:3px 5px}
      .show-tools{position:absolute;top:20px;right:20px;pointer-events:auto;border-color:#59f6d2;color:#59f6d2;background:#0b101ded}
      .show-tools[hidden]{display:none}
    </style><canvas aria-hidden="true"></canvas><aside aria-label="BridgeZone tools">
      <header><div><small>BRIDGEZONE / LOCAL TOOLS v${VERSION}</small><h2>Xray + Silent AIM</h2></div><button aria-label="Hide tools panel">Hide</button></header>
      <div class="live-metrics"><span data-live-metrics>Waiting for a match</span><button type="button" data-download-trace aria-label="Save match trace">Save trace</button></div>
      <div class="body">
        <label class="feature">Xray boxes <span class="key">F8</span><input aria-label="Xray boxes" name="xray" type="checkbox"></label>
        <label class="feature">Loot + crate vision<input aria-label="Loot vision" name="loot" type="checkbox"></label>
        <label class="feature">Silent AIM <span class="key">F9</span><input aria-label="Silent AIM" name="silent" type="checkbox"></label>
        <label class="feature">Rage / 360 + auto fire<input aria-label="Rage mode" name="rage" type="checkbox"></label>
        <div class="setting"><label for="fov">Normal aim cone (half-angle)<output data-value="fov"></output></label><input id="fov" name="fov" aria-label="Aim cone" type="range" min="1" max="90" step="1"></div>
        <div class="setting"><label for="range">Maximum range<output data-value="range"></output></label><input id="range" name="range" aria-label="Maximum range" type="range" min="10" max="600" step="10"></div>
        <label>Target point<select name="point" aria-label="Target point"><option value="auto">Auto / clear point</option><option value="head">Head</option><option value="chest">Chest</option></select></label>
        <label>Skip targets behind cover<input name="visibleOnly" aria-label="Skip targets behind cover" type="checkbox"></label>
        <label class="feature">Anticheat stealth<input name="stealth" aria-label="Anticheat stealth" type="checkbox"></label>
        <label class="feature">Auto reload<input name="ammo" aria-label="Auto reload" type="checkbox"></label>
        <div class="setting"><label for="smooth">Aim smoothing<output data-value="smooth"></output></label><input id="smooth" name="smooth" aria-label="Aim smoothing" type="range" min="0.1" max="0.95" step="0.05"></div>
        <p class="note">Insert: show/hide. Rage picks a visible target within useful weapon range, aims down sights and fires on the ground. Auto reload uses available server ammo. Cover still blocks shots. Fire may wait while aim turns; the held count is input frames, not bullets. Local tracers can follow your view; use server hits to judge results.</p>
      </div><div class="status"><div role="status"></div><div class="stats"></div></div>
    </aside><button type="button" class="show-tools" data-show-panel hidden aria-label="Show tools panel">Show tools</button>`;
    document.documentElement.appendChild(host);
    overlay = root.querySelector('canvas'); painter = overlay.getContext('2d');
    panel = root.querySelector('aside'); status = root.querySelector('[role="status"]'); stats = root.querySelector('.stats');
    showButton = root.querySelector('[data-show-panel]');
    panel.hidden = !panelVisible;
    showButton.hidden = panelVisible;
    root.querySelector('button').addEventListener('click', () => {
      panelVisible = false; panel.hidden = true; showButton.hidden = false;
    });
    showButton.addEventListener('click', () => {
      panelVisible = true; panel.hidden = false; showButton.hidden = true;
    });
    root.querySelector('[data-download-trace]').addEventListener('click', () => {
      try {
        const blob = new Blob([window.__bridgeZoneTools.exportTrace()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'bridgezone-trace-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
        root.appendChild(link);
        link.click();
        setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 1000);
      } catch (error) {
        runtime.error = 'Trace export: ' + (error?.message || error);
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
    for (const name of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'keydown', 'keyup', 'wheel']) {
      root.addEventListener(name, event => event.stopPropagation());
    }
    syncControls();
    updatedAt = -Infinity;
    updateStatus();
  }

  function onKey(event) {
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

  window.addEventListener('keydown', onKey, true);
  restores.push(() => window.removeEventListener('keydown', onKey, true));
  function onStorage(event) {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    try { setOptions(event.newValue ? JSON.parse(event.newValue) : defaults, false); } catch { /* Ignore invalid saved settings. */ }
  }
  window.addEventListener('storage', onStorage);
  restores.push(() => window.removeEventListener('storage', onStorage));
  window.__bridgeZoneTools = {
    version: VERSION, options, runtime, setOptions,
    attachClient(client, physics) {
      if (physics) {
        for (const name of ['getCollisionWorld', 'hasLineOfSight']) runtime.physics[name] = physics[name];
      }
      runtime.hookReady = true;
      return attachClient(client);
    },
    inspect: () => ({ version: VERSION, hookReady: runtime.hookReady, captured: !!runtime.client, renderer: !!runtime.pipeline,
      aimRejected: runtime.aimRejected,
      opponents: runtime.client?.remoteFrames?.length || 0, rewrites: runtime.rewrites, compensated: runtime.compensated,
      heldShots: runtime.stealth.heldShots,
      server: { ...runtime.server }, error: runtime.error, options: { ...options } }),
    trace: traceSnapshot,
    exportTrace: () => JSON.stringify({ formatVersion: 1, scriptVersion: VERSION,
      capturedAt: new Date().toISOString(), trace: traceSnapshot() }, null, 2),
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
    if (!client || client.disposed || performance.now() - runtime.renderedAt > 2500) painter?.clearRect(0, 0, width, height);
    updateStatus();
  }, 500);
})();
