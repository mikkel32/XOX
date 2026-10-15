'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'bridgezone-tools.user.js'), 'utf8');
const close = (actual, expected, epsilon = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} differs from ${expected}`);
};

function documentHarness() {
  const listeners = new Map();
  const timers = new Map();
  const canvases = [];
  const downloads = [];
  const painter = { clearRect() {}, setTransform() {} };
  const controls = new Map();
  const root = {
    innerHTML: '',
    appendChild() {},
    addEventListener() {},
    querySelector(selector) {
      if (!controls.has(selector)) controls.set(selector, {
        events: new Map(),
        addEventListener(name, listener) { this.events.set(name, listener); }, getContext: () => painter,
        checked: false, value: '', textContent: '', hidden: false
      });
      return controls.get(selector);
    }
  };
  const document = {
    readyState: 'loading', currentScript: null,
    documentElement: { appendChild() {} },
    createElement: tag => ({ style: {}, attachShadow: () => root, remove() {},
      click() { if (tag === 'a') downloads.push({ href: this.href, download: this.download }); } }),
    querySelectorAll(selector) {
      assert.equal(selector, 'canvas');
      return canvases;
    },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    }
  };
  let nextTimer = 1;
  return {
    document, canvases, listeners, timers, controls, downloads,
    setInterval(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
    mount() {
      document.readyState = 'complete';
      listeners.get('DOMContentLoaded')?.();
    },
    tick() { for (const callback of timers.values()) callback(); }
  };
}

function harness(initialChunks = [], savedSettings) {
  const windowListeners = new Map();
  const dom = documentHarness();
  const documentListeners = dom.listeners;
  const storage = new Map();
  if (savedSettings !== undefined) storage.set('bridgezone.tools.v2', JSON.stringify(savedSettings));
  const modules = new Map();
  const registration = [];
  const createdBlobs = [], revokedUrls = [];
  const queue = [...initialChunks];
  const window = {
    TURBOPACK: queue,
    addEventListener(name, listener) { windowListeners.set(name, listener); },
    removeEventListener(name, listener) {
      if (windowListeners.get(name) === listener) windowListeners.delete(name);
    }
  };
  const context = vm.createContext({
    window, document: dom.document, console,
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); }
    },
    performance: { now: () => 1000 },
    Blob,
    URL: {
      createObjectURL(blob) { createdBlobs.push(blob); return 'blob:trace'; },
      revokeObjectURL(url) { revokedUrls.push(url); }
    },
    setTimeout(callback) { callback(); return 1; },
    setInterval: dom.setInterval,
    clearInterval: dom.clearInterval
  });
  vm.runInContext(source, context, { filename: 'bridgezone-tools.user.js' });
  const loaderContext = {
    s(entries, id) {
      assert.equal(this, loaderContext, 'export registration keeps its receiver');
      registration.push({ id, entries });
      const exports = modules.get(id) || {};
      for (let i = 0; i < entries.length; i += 3) exports[entries[i]] = entries[i + 2];
      modules.set(id, exports);
    }
  };
  function dispatcher(...chunks) {
    assert.equal(this, queue, 'loader dispatcher keeps the queue receiver');
    for (const chunk of chunks) for (const entry of chunk) {
      if (typeof entry === 'function') entry(loaderContext);
    }
    return chunks.length;
  }
  queue.push = dispatcher;
  for (const chunk of queue) dispatcher.call(queue, chunk);
  function register(id, exports) {
    const entries = Object.entries(exports).flatMap(([name, value]) => [name, 0, value]);
    queue.push([null, id, ctx => ctx.s(entries, id)]);
    return modules.get(id);
  }
  return {
    window, queue, modules, registration, dispatcher, register, storage, createdBlobs, revokedUrls,
    windowListeners, documentListeners, ...dom,
    api: window.__bridgeZoneTools
  };
}

function opponent(i = 1, patch = {}) {
  return { i, p: [2, 0, -10], v: [0, 0, 0], yaw: 0, pitch: 0,
    m: 'ground', c: 0, f: 128, ...patch };
}

function fakeClient(patch = {}) {
  const sent = [];
  const rendered = [];
  const connection = {
    sendInput(...args) {
      assert.equal(this, connection, 'sendInput retains its receiver');
      sent.push(args);
      return 'sent';
    }
  };
  const pipeline = {
    render(...args) {
      assert.equal(this, pipeline, 'render retains its receiver');
      rendered.push(args);
      return 'rendered';
    }
  };
  const client = {
    connection, start: { matchId: 'test-match', mode: 'solo', roster: [{ index: 1, bot: true }] },
    you: 0, ready: Promise.resolve(), engine: { pipeline },
    paused: false, disposed: false, input: { enabled: true },
    predictorReady: false, predictor: null,
    latest: { phase: 'ground', me: {
      index: 0, pos: [0, 0, 0], crouch: 0, mode: 'ground', health: 100,
      spectating: null, downed: false
    } },
    remoteFrames: [{ index: 1, snap: opponent() }],
    eliminated: new Set(), team: { isAlly: () => false },
    localDead: () => false, localDowned: () => false,
    ...patch
  };
  return { client, sent, rendered, originalSend: connection.sendInput, originalRender: pipeline.render };
}

function attach(h, fake = fakeClient()) {
  const originalFactory = () => fake.client;
  const exports = h.register(97294, { createZoneClient: originalFactory });
  assert.notEqual(exports.createZoneClient, originalFactory);
  assert.equal(exports.createZoneClient({ arbitrary: true }), fake.client);
  // Existing behavior tests opt in explicitly; production defaults remain disabled.
  h.api.setOptions({ silent: true, visibleOnly: false, rage: false, range: 350, point: 'head' });
  h.api.setOptions({ stealth: false, smooth: 1 });
  return fake;
}

function frame(patch = {}) {
  return { yaw: 0, pitch: 0, mx: 1, mz: 1, buttons: 1, s: 23, vt: 100, custom: 'retained', ...patch };
}

function send(fake, frames = [frame()], matchId = fake.client.start.matchId, ...rest) {
  const result = fake.client.connection.sendInput(matchId, frames, ...rest);
  assert.equal(result, 'sent');
  return fake.sent.at(-1)[1];
}

test('stealth turns over several frames, fires when aligned, and returns without a snap', () => {
  const h = harness();
  const fake = attach(h);
  h.api.setOptions({ stealth: true, smooth: 1 });
  h.api.runtime.stealth.backoffUntil = 0;
  h.api.runtime.stealth.cooldown = 0;
  h.api.runtime.stealth.deterministic = 0;
  const exactYaw = Math.atan2(-2, 10), exactPitch = Math.atan2(0.04, Math.hypot(2, 10));
  const outputs = [];
  for (let sequence = 100; sequence < 105; sequence++) {
    outputs.push(send(fake, [frame({ s: sequence })])[0]);
    if (outputs.at(-1).buttons & 1) break;
  }
  assert.ok(outputs.length >= 2, 'the first shot waits for a bounded turn');
  assert.ok(outputs.slice(0, -1).every(output => !(output.buttons & 1)));
  const fired = outputs.at(-1);
  assert.equal(fired.buttons & 1, 1);
  close(fired.yaw, exactYaw, 0.001);
  close(fired.pitch, exactPitch, 0.001);
  let previousYaw = 0;
  for (const output of outputs) {
    assert.ok(Math.abs(output.yaw - previousYaw) <= 8 * Math.PI / 180 + 1e-9);
    previousYaw = output.yaw;
  }
  assert.equal(h.api.runtime.stealth.deterministic, 1);
  assert.ok(h.api.runtime.stealth.cooldown >= 1080);
  const returnFrame = send(fake, [frame({ s: 110, buttons: 0 })])[0];
  assert.ok(Math.abs(returnFrame.yaw - fired.yaw) <= 8 * Math.PI / 180 + 1e-9);
  assert.ok(Math.abs(returnFrame.yaw) < Math.abs(fired.yaw));

  for (let shot = 2; shot <= 3; shot++) {
    h.api.runtime.stealth.cooldown = 0;
    let output;
    for (let attempt = 0; attempt < 5; attempt++) {
      output = send(fake, [frame({ s: 120 + shot * 10 + attempt })])[0];
      if (output.buttons & 1) break;
    }
    assert.equal(output.buttons & 1, 1);
  }
  assert.equal(h.api.runtime.stealth.deterministic, 3);
  h.api.runtime.stealth.cooldown = 0;
  const threshold = [frame({ s: 104 })];
  const heldThreshold = send(fake, threshold);
  assert.equal(heldThreshold[0].buttons & 1, 0, 'backoff must not send a straight shot');
  assert.equal(h.api.runtime.stealth.backoffUntil > 1000, true);
  const unchanged = [frame({ s: 100 })];
  const heldDuringBackoff = send(fake, unchanged);
  assert.equal(heldDuringBackoff[0].buttons & 1, 0);
  assert.ok(h.api.runtime.stealth.heldShots >= 2);
  assert.equal(h.api.runtime.stealth.deterministic, 0);
  h.api.destroy();
});

function worldMovement(value) {
  const scale = Math.max(1, Math.hypot(value.mx, value.mz));
  const mx = value.mx / scale, mz = value.mz / scale;
  return [Math.cos(value.yaw) * mx - Math.sin(value.yaw) * mz,
    -Math.sin(value.yaw) * mx - Math.cos(value.yaw) * mz];
}

test('a ninety-degree target takes bounded outgoing turns and preserves movement', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true, stealth: true });
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [-30, 0, 0] }) }];
  let previousYaw = 0;
  let firedAt = null;
  for (let tick = 0; tick < 35; tick++) {
    const original = frame({ s: 400 + tick, mx: 0.4, mz: 0.7 });
    const output = send(fake, [original])[0];
    const change = Math.atan2(Math.sin(output.yaw - previousYaw), Math.cos(output.yaw - previousYaw));
    assert.ok(Math.abs(change) <= 8 * Math.PI / 180 + 1e-9, `tick ${tick} turned ${change}`);
    const before = worldMovement(original), after = worldMovement(output);
    close(after[0], before[0]);
    close(after[1], before[1]);
    previousYaw = output.yaw;
    if (output.buttons & 1) { firedAt = tick; break; }
  }
  assert.ok(firedAt >= 10 && firedAt < 20, `first shot at tick ${firedAt}`);
  assert.equal(h.api.runtime.rewrites, 1);
  h.api.setOptions({ rage: false });
  for (let tick = 0; tick < 30; tick++) {
    const output = send(fake, [frame({ s: 500 + tick, buttons: 0 })])[0];
    const change = Math.atan2(Math.sin(output.yaw - previousYaw), Math.cos(output.yaw - previousYaw));
    assert.ok(Math.abs(change) <= 8 * Math.PI / 180 + 1e-9);
    previousYaw = output.yaw;
  }
  close(previousYaw, 0);
  h.api.destroy();
});

test('a single manual click fires once after the outgoing aim aligns', () => {
  let samples = 0;
  const input = { enabled: true, sample: () => frame({ s: 600 + samples,
    buttons: samples++ === 0 ? 1 : 0 }) };
  const h = harness();
  const fake = attach(h, fakeClient({ input }));
  h.api.setOptions({ stealth: true });
  const sent = [];
  for (let tick = 0; tick < 8; tick++) {
    const local = fake.client.input.sample();
    sent.push(send(fake, [local])[0]);
  }
  const fire = sent.filter(output => output.buttons & 1);
  assert.equal(fire.length, 1);
  close(fire[0].yaw, Math.atan2(-2, 10), 0.001);
  assert.ok(sent.findIndex(output => output.buttons & 1) >= 2);
  assert.equal(h.api.runtime.rewrites, 1);
  assert.equal(h.api.runtime.outgoingAim.pendingManualUntil, 0);
  h.api.destroy();
});

test('an unreachable spread correction does not discard a locally predicted shot', () => {
  const h = harness();
  const fake = rageClient();
  const spread = 8 * Math.PI / 180;
  fake.client.predictor.predict = input => ({ eye: [0, 1.62, 0],
    weapon: { fired: true, dirs: [[Math.sin(spread), 0, -Math.cos(spread)]] } });
  attach(h, fake);
  h.api.setOptions({ rage: true, stealth: true });
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [-20, 0, -34.641] }) }];
  for (let tick = 0; tick < 12; tick++) send(fake, [frame({ s: 700 + tick, buttons: 0 })]);
  assert.equal(h.api.runtime.outgoingAim.ready, true);
  const previousYaw = h.api.runtime.outgoingAim.yaw;
  const sampled = fake.client.input.sample('sample-argument');
  assert.equal(sampled.buttons & 1, 1);
  fake.client.predictor.predict(sampled);
  const output = send(fake, [sampled])[0];
  assert.equal(output.buttons & 1, 1, 'the server and local predictor both see this shot');
  assert.equal(h.api.runtime.compensated, 0, 'the excessive correction is omitted');
  assert.equal(h.api.runtime.predictions.size, 0);
  const turn = Math.atan2(Math.sin(output.yaw - previousYaw), Math.cos(output.yaw - previousYaw));
  assert.ok(Math.abs(turn) <= 8 * Math.PI / 180 + 1e-9);
  h.api.destroy();
});

test('captures exports from queued chunks and after the loader replaces push', () => {
  const marker = {};
  const h = harness([[null, 44, ctx => ctx.s(['marker', 0, marker], 44)]]);
  assert.equal(h.modules.get(44).marker, marker);
  const fake = attach(h);
  assert.equal(h.api.runtime.client, fake.client);
  assert.equal(h.api.runtime.hookReady, true);
  assert.equal(h.registration.at(-1).id, 97294);
  assert.equal(h.queue.push([null, 45, ctx => ctx.s(['late', 0, marker], 45)]), 1);
  assert.equal(h.modules.get(45).late, marker);
});

test('rewrites Fire=1 only, clones outbound frames, and preserves protocol and movement', () => {
  const h = harness();
  const fake = attach(h);
  for (const movement of [[1, 1], [1, 0], [0, -1], [-1, 1], [0.2, 0.3], [0, 0]]) {
    const input = Object.freeze(frame({ mx: movement[0], mz: movement[1] }));
    const inputs = Object.freeze([input]);
    const output = send(fake, inputs, 'test-match', 'extra-argument');
    assert.notEqual(output, inputs);
    assert.notEqual(output[0], input);
    assert.equal(input.yaw, 0);
    assert.equal(input.pitch, 0);
    assert.equal(input.mx, movement[0]);
    assert.equal(input.mz, movement[1]);
    assert.equal(output[0].s, 23);
    assert.equal(output[0].vt, 100);
    assert.equal(output[0].buttons, 1);
    assert.equal(output[0].custom, 'retained');
    assert.equal(fake.sent.at(-1)[0], 'test-match');
    assert.equal(fake.sent.at(-1)[2], 'extra-argument');
    close(output[0].yaw, Math.atan2(-2, 10));
    close(output[0].pitch, Math.atan2(0.04, Math.hypot(2, 10)));
    const before = worldMovement(input), after = worldMovement(output[0]);
    close(after[0], before[0]);
    close(after[1], before[1]);
  }
  for (const buttons of [0, 2, 16, 32, 512]) {
    const inputs = [frame({ buttons })];
    assert.equal(send(fake, inputs), inputs, `buttons=${buttons} cannot trigger aim`);
  }
  const mixed = [frame({ buttons: 2 }), frame({ buttons: 3 })];
  const output = send(fake, mixed);
  assert.equal(output[0], mixed[0]);
  assert.notEqual(output[1], mixed[1]);
});

test('treats bot and human targets equally and uses health only when present', () => {
  const h = harness();
  const fake = attach(h);
  let expected;
  for (const bot of [true, false]) {
    fake.client.start.roster = [{ index: 1, bot }];
    const output = send(fake)[0];
    assert.notEqual(output.yaw, 0);
    if (expected === undefined) expected = output.yaw;
    else close(output.yaw, expected);
  }
  fake.client.remoteFrames[0].snap.hp = 0;
  const inputs = [frame()];
  assert.equal(send(fake, inputs), inputs);
  fake.client.remoteFrames[0].snap.hp = 100;
  assert.notEqual(send(fake, inputs), inputs);
});

test('filters self, allies, eliminated, dead, plane, downed, and malformed opponents', () => {
  const h = harness();
  const fake = attach(h);
  const rejected = [
    opponent(0), opponent(2), opponent(3), opponent(4, { m: 'dead' }),
    opponent(5, { m: 'plane' }), opponent(6, { f: 256 }),
    opponent(7, { p: [NaN, 0, -10] }), opponent(8, { p: [0, -10] }),
    opponent('9')
  ];
  fake.client.team.isAlly = index => index === 2;
  fake.client.eliminated.add(3);
  fake.client.remoteFrames = rejected.map(snap => ({ index: snap.i, snap }));
  const inputs = [frame()];
  assert.equal(send(fake, inputs), inputs);
  fake.client.remoteFrames.push({ index: 10, snap: opponent(10) });
  assert.notEqual(send(fake, inputs), inputs);
  assert.equal(h.api.runtime.target.index, 10);
});

test('enforces aim cone and range and chooses the closest angular target', () => {
  const h = harness();
  const fake = attach(h);
  const inputs = [frame()];
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [30, 0, -10] }) }];
  h.api.setOptions({ fov: 25 });
  assert.equal(send(fake, inputs), inputs);
  h.api.setOptions({ fov: 90 });
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [2, 0, -400] }) }];
  assert.equal(send(fake, inputs), inputs);
  fake.client.remoteFrames = [{ snap: opponent(1) }, { snap: opponent(2, { p: [0.1, 0, -20] }) }];
  send(fake, inputs);
  assert.equal(h.api.runtime.target.index, 2);
});

test('uses rewind samples without mutating render snapshots and skips missing samples', () => {
  const h = harness();
  const fake = attach(h);
  const current = fake.client.remoteFrames[0].snap;
  const before = structuredClone(current);
  const calls = [];
  fake.client.interpolator = {
    sample(index, tick, output) {
      calls.push([index, tick]);
      output.p[0] = -2;
      return true;
    }
  };
  const output = send(fake)[0];
  assert.ok(output.yaw > 0);
  assert.deepEqual(current, before);
  assert.deepEqual(calls, [[1, 100]]);
  fake.client.interpolator.sample = () => false;
  const inputs = [frame()];
  assert.equal(send(fake, inputs), inputs);
});

test('uses predicted feet and crouch when available and supports chest selection', () => {
  const h = harness();
  const fake = attach(h);
  fake.client.predictorReady = true;
  fake.client.predictor = { ps: { pos: [1, 0, 0], crouch: 1, mode: 'ground' } };
  h.api.setOptions({ point: 'chest' });
  const output = send(fake)[0];
  close(output.yaw, Math.atan2(-1, 10));
  close(output.pitch, Math.atan2(1.8 * 0.75 - 0.14 - 1, Math.hypot(1, 10)));
});

test('passes inputs through for inactive, spectator, dead, and unsupported local states', () => {
  const cases = [
    client => { client.you = null; },
    client => { client.paused = true; },
    client => { client.disposed = true; },
    client => { client.input.enabled = false; },
    client => { client.latest.me.spectating = 1; },
    client => { client.latest.me.downed = true; },
    client => { client.latest.me.health = 0; },
    client => { client.localDead = () => true; },
    client => { client.localDowned = () => true; },
    client => { client.latest.phase = 'finished'; },
    client => { client.latest.me.mode = 'parachute'; },
    client => { client.latest.me.mode = 'freefall'; },
    client => { client.latest.me.pos = [NaN, 0, 0]; }
  ];
  for (const change of cases) {
    const h = harness();
    const fake = attach(h);
    change(fake.client);
    const inputs = [frame()];
    assert.equal(send(fake, inputs), inputs, change.toString());
  }
  const h = harness();
  const fake = attach(h);
  const inputs = [frame()];
  assert.equal(send(fake, inputs, 'another-match'), inputs);
  assert.equal(send(fake, [frame({ yaw: NaN })])[0].yaw, NaN);
});

test('captures module 54145 visibility exports and respects collision results', () => {
  const h = harness();
  const fake = attach(h);
  h.api.setOptions({ visibleOnly: true });
  const inputs = [frame()];
  assert.equal(send(fake, inputs), inputs, 'unknown collision world cannot select a target');
  const world = {};
  const calls = [];
  let visible = false;
  const collision = () => world;
  const lineOfSight = (actualWorld, origin, point) => {
    assert.equal(actualWorld, world);
    calls.push({ origin: [...origin], point: [...point] });
    return visible;
  };
  const exports = h.register(54145, { getCollisionWorld: collision, hasLineOfSight: lineOfSight });
  assert.equal(exports.getCollisionWorld, collision);
  assert.equal(h.api.runtime.physics.hasLineOfSight, lineOfSight);
  assert.equal(send(fake, inputs), inputs);
  visible = true;
  assert.notEqual(send(fake, inputs), inputs);
  assert.deepEqual(calls.at(-1).origin, [0, 1.62, 0]);
  close(calls.at(-1).point[1], 1.66);
});

test('disabling aim preserves inputs; destroy restores methods, loader, and listeners', async () => {
  const h = harness();
  const fake = attach(h);
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(fake.client.engine.pipeline.render, fake.originalRender);
  assert.equal(fake.client.engine.pipeline.render('argument'), 'rendered');
  assert.deepEqual(fake.rendered, [['argument']]);
  const inputs = [frame()];
  send(fake, inputs);
  assert.equal(h.api.runtime.rewrites, 1);
  h.api.setOptions({ silent: false, xray: false });
  assert.equal(send(fake, inputs), inputs);
  assert.equal(h.api.runtime.target, null);
  assert.equal(h.storage.size, 1);
  assert.equal(JSON.parse([...h.storage.values()][0]).silent, false);
  h.api.destroy();
  assert.equal(fake.client.connection.sendInput, fake.originalSend);
  assert.equal(fake.client.engine.pipeline.render, fake.originalRender);
  assert.equal(h.queue.push, h.dispatcher);
  assert.equal(h.window.__bridgeZoneTools, undefined);
  assert.equal(h.windowListeners.has('keydown'), false);
  assert.equal(h.documentListeners.has('DOMContentLoaded'), false);
  assert.equal(send(fake, inputs), inputs);
});

function rageClient(patch = {}) {
  const sampled = Object.freeze(frame({ buttons: 16 | 64 | 8 }));
  const input = {
    enabled: true,
    sample(...args) {
      assert.equal(this, input);
      assert.deepEqual(args, ['sample-argument']);
      return sampled;
    }
  };
  const predictor = {
    ps: { pos: [0, 0, 0], mode: 'ground', crouch: 0, health: 100 },
    ws: { trigger: false, cooldown: 0 },
    active: 0, slots: [{ mag: 10 }], ammo: { light: 50 },
    activeStats: { fireMode: 'auto', ammo: 'light', pellets: 1, magSize: 10 }
  };
  const fake = fakeClient({ input, predictor, predictorReady: true, renderTick: () => 100.4, ...patch });
  return { ...fake, sampled, originalSample: input.sample };
}

test('stealth holds Rage and manual Fire before prediction when a target is present', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true, stealth: true });
  h.api.runtime.stealth.cooldown = 2000;
  const held = fake.client.input.sample('sample-argument');
  assert.equal(held.buttons & 1, 0);
  assert.equal(held.buttons & 2, 2, 'aiming down sights remains active');
  assert.equal(fake.sampled.buttons, 16 | 64 | 8, 'the game sample is not mutated');
  assert.equal(send(fake, [held])[0].buttons & 1, 0);
  assert.equal(h.api.runtime.stealth.heldShots, 1);
  h.api.runtime.stealth.cooldown = 0;
  let ready;
  for (let attempt = 0; attempt < 8; attempt++) {
    ready = fake.client.input.sample('sample-argument');
    const outgoing = send(fake, [frame({ ...ready, s: 200 + attempt })])[0];
    if (ready.buttons & 1) {
      assert.equal(outgoing.buttons & 1, 1);
      assert.notEqual(outgoing.yaw, 0);
      break;
    }
  }
  assert.equal(ready.buttons & 1, 1, 'Rage fires after the outgoing turn aligns');
  h.api.destroy();

  const manual = Object.freeze(frame({ s: 94 }));
  const input = { enabled: true, sample: () => manual };
  const manualHarness = harness();
  const manualFake = attach(manualHarness, fakeClient({ input }));
  manualHarness.api.setOptions({ stealth: true });
  manualHarness.api.runtime.stealth.cooldown = 2000;
  assert.equal(manualFake.client.input.sample().buttons & 1, 0);
  assert.equal(manual.buttons & 1, 1);
  manualHarness.api.destroy();
});

test('aim hook errors hold Fire instead of sending an unassisted shot', () => {
  const h = harness();
  const original = Object.freeze(frame({ s: 72 }));
  const input = { enabled: true, sample: () => original };
  const fake = attach(h, fakeClient({ input }));
  h.api.setOptions({ stealth: true });
  Object.defineProperty(fake.client, 'remoteFrames', {
    get() { throw new Error('broken snapshots'); }
  });
  const sampled = fake.client.input.sample();
  assert.equal(sampled.buttons & 1, 0);
  assert.match(h.api.runtime.error, /Rage hook: broken snapshots/);
  const outgoing = send(fake, [original]);
  assert.equal(outgoing[0].buttons & 1, 0);
  assert.match(h.api.runtime.error, /Aim hook: broken snapshots/);
  assert.equal(h.api.runtime.stealth.heldShots, 2);
  assert.equal(original.buttons & 1, 1);
  h.api.destroy();
});

test('Rage scans behind the player and samples autofire with ADS', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true, range: 600 });
  fake.client.remoteFrames = [
    { snap: opponent(2, { p: [2, 0, 10] }) }
  ];
  const sampled = fake.client.input.sample('sample-argument');
  assert.notEqual(sampled, fake.sampled);
  assert.equal(fake.sampled.buttons, 16 | 64 | 8);
  assert.equal(sampled.buttons & 1, 1);
  assert.equal(sampled.buttons & 2, 2);
  assert.equal(sampled.buttons & 16, 0);
  assert.equal(sampled.buttons & 64, 64);
  assert.equal(sampled.buttons & 8, 8);
  send(fake, [sampled]);
  assert.equal(h.api.runtime.target.index, 2);
  assert.ok(Math.abs(fake.sent.at(-1)[1][0].yaw) > Math.PI / 2);
  assert.equal(h.api.runtime.compensated, 0);
});

test('Rage prefers a nearer aim angle and stays inside useful weapon range', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true, range: 600 });
  fake.client.predictor.activeStats.rangeEnd = 35;
  fake.client.remoteFrames = [
    { snap: opponent(1, { p: [0.1, 0, -40] }) },
    { snap: opponent(2, { p: [2, 0, 10] }) },
    { snap: opponent(3, { p: [0, 0, -60] }) }
  ];
  const sampled = fake.client.input.sample('sample-argument');
  send(fake, [sampled]);
  assert.equal(h.api.runtime.target.index, 1, 'the reachable target near the current aim wins');
  fake.client.remoteFrames = [{ snap: opponent(3, { p: [0, 0, -60] }) }];
  assert.equal(fake.client.input.sample('sample-argument').buttons & 1, 0,
    'Rage does not spend ammunition beyond useful sidearm range');
});

test('Rage pulses semi, pump, and bolt triggers while auto holds Fire without manufacturing ammo', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true });
  const p = fake.client.predictor;
  for (const fireMode of ['semi', 'pump', 'bolt']) {
    p.activeStats.fireMode = fireMode;
    p.ws.trigger = false;
    p.ws.cooldown = 1 / 30;
    assert.equal(fake.client.input.sample('sample-argument').buttons & 1, 1, fireMode);
    p.ws.trigger = true;
    assert.equal(fake.client.input.sample('sample-argument').buttons & 1, 0, fireMode);
    p.ws.trigger = false;
    p.ws.cooldown = 0.3;
    assert.equal(fake.client.input.sample('sample-argument').buttons & 1, 0, fireMode);
  }
  p.activeStats.fireMode = 'auto';
  p.ws.trigger = true;
  assert.equal(fake.client.input.sample('sample-argument').buttons & 1, 1);
  p.ammo.light = 0;
  assert.equal(fake.client.predictor.ammo.light, 0, 'arrange a low reserve before the next sample');
  const remaining = fake.client.input.sample('sample-argument');
  assert.equal(fake.client.predictor.slots[0].mag, 10);
  assert.equal(fake.client.predictor.ammo.light, 0);
  assert.equal(remaining.buttons & 1, 1, 'remaining real rounds may still fire');
  assert.equal(remaining.buttons & 2, 2);
  p.slots[0].mag = 0;
  assert.equal(fake.client.input.sample('sample-argument').buttons & 1, 0,
    'Rage does not send Fire after real ammunition is exhausted');
});

test('auto reload sends the server reload input without changing predicted ammunition', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ ammo: true, rage: false, silent: false });
  fake.client.predictor.activeStats.magSize = 30;
  fake.client.predictor.slots[0].mag = 0;
  fake.client.predictor.ammo.light = 20;
  const reload = fake.client.input.sample('sample-argument');
  assert.equal(reload.buttons & 32, 32);
  assert.equal(fake.client.predictor.slots[0].mag, 0);
  assert.equal(fake.client.predictor.ammo.light, 20);
  fake.client.predictor.ammo.light = 0;
  assert.equal(fake.client.input.sample('sample-argument').buttons & 32, 0);
  h.api.setOptions({ ammo: false });
  fake.client.predictor.ammo.light = 20;
  assert.equal(fake.client.input.sample('sample-argument').buttons & 32, 0);
});

test('Rage does not fire without a clear target and low smoothing settings migrate to exact aim', () => {
  const h = harness([], { silent: true, rage: true, xray: false, loot: false, smooth: 0.1 });
  h.api.setOptions({ rage: false });
  assert.equal(h.api.options.silent, true, 'startup retains saved Silent AIM');
  assert.equal(h.api.options.rage, false, 'startup disables saved rage');
  assert.equal(h.api.options.smooth, 1, 'saved low smoothing migrates to exact aim');
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true, ammo: true });
  fake.client.remoteFrames = [];
  const result = fake.client.input.sample('sample-argument');
  assert.equal(result.buttons & 1, 0, 'Rage does not blind-fire without a target');
  fake.client.remoteFrames = [{ snap: opponent() }];
  const firing = fake.client.input.sample('sample-argument');
  assert.equal(firing.buttons & 1, 1, 'Rage still fires when a target is selectable');
  h.api.destroy();
});

test('Rage leaves sampled controls intact without a target or in gated states', () => {
  const cases = [
    (h, fake) => h.api.setOptions({ rage: false }),
    (h, fake) => h.api.setOptions({ silent: false }),
    (h, fake) => { fake.client.you = null; },
    (h, fake) => { fake.client.paused = true; },
    (h, fake) => { fake.client.disposed = true; },
    (h, fake) => { fake.client.input.enabled = false; },
    (h, fake) => { fake.client.cinema = { active: true }; },
    (h, fake) => { fake.client.predictor.ps.mode = 'parachute'; },
    (h, fake) => { fake.client.predictor.ps.downed = true; },
    (h, fake) => { fake.client.predictor.ps.spectating = 2; },
    (h, fake) => { fake.client.latest.phase = 'finished'; },
    (h, fake) => { fake.client.predictor.activeStats = null; }
  ];
  for (const change of cases) {
    const h = harness();
    const fake = attach(h, rageClient());
    h.api.setOptions({ rage: true });
    change(h, fake);
    assert.equal(fake.client.input.sample('sample-argument'), fake.sampled, change.toString());
  }
});

test('automatic clear-point targeting falls back from blocked head to chest', () => {
  const h = harness();
  const fake = attach(h);
  h.api.setOptions({ rage: true, point: 'auto', visibleOnly: true });
  const points = [];
  h.register(54145, {
    getCollisionWorld: () => ({}),
    hasLineOfSight(world, origin, point) {
      points.push([...point]);
      return point[1] < 1.3;
    }
  });
  const input = frame();
  const output = send(fake, [input])[0];
  assert.equal(points.length, 2);
  close(points[0][1], 1.66);
  close(points[1][1], 1.21);
  close(output.pitch, Math.atan2(1.21 - 1.62, Math.hypot(2, 10)));
});

const physicsPath = path.join(__dirname, '..', 'research', '3ep-katvfqbjo.js');

test('captured single-projectile spread is inverted against the actual game function', {
  skip: !fs.existsSync(physicsPath) && 'Captured game physics is optional for portable tests'
}, () => {
  const kernel = fs.readFileSync(physicsPath, 'utf8');
  const start = kernel.indexOf('function tW('), end = kernel.indexOf('function tU(', start);
  assert.ok(start >= 0 && end > start, 'captured spread function remains identifiable');
  const spread = vm.runInNewContext(kernel.slice(start, end) + ';tW', {
    tt: Math.PI / 180, ta: (value, min, max) => Math.min(max, Math.max(min, value))
  });
  const direction = (yaw, pitch) => [
    -Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)
  ];
  const perturb = (yaw, pitch, degrees, random) => {
    let index = 0;
    return spread(direction(yaw, pitch), degrees, () => random[index++]);
  };
  const h = harness();
  const fake = rageClient();
  const random = [0.61, 0.17], degrees = 8;
  let shotEye = [0, 1.62, 0];
  let result;
  const originalPredict = function (input, context, fraction) {
    assert.equal(this, fake.client.predictor);
    assert.deepEqual(context, { kernel: 'context' });
    assert.equal(fraction, 0.5);
    result = {
      eye: [...shotEye],
      weapon: { fired: true, dirs: [perturb(input.yaw, input.pitch, degrees, random)] }
    };
    return result;
  };
  fake.client.predictor.predict = originalPredict;
  attach(h, fake);
  h.api.setOptions({ rage: true });
  const cases = [
    [0, 0, 2.4, 0.1], [0.4, -0.5, -2.1, -0.9],
    [-2.7, 0.7, 1.3, 1], [3, 1, -0.8, -1.1], [-0.5, 0.2, 0, 0]
  ];
  for (const [index, [yaw, pitch, targetYaw, targetPitch]] of cases.entries()) {
    shotEye = [index * 0.2, 1.62 + index * 0.1, 0];
    const targetDirection = direction(targetYaw, targetPitch);
    fake.client.remoteFrames = [{ snap: opponent(1, { p: [
      shotEye[0] + targetDirection[0] * 20,
      shotEye[1] + targetDirection[1] * 20 - 1.66,
      shotEye[2] + targetDirection[2] * 20
    ] }) }];
    const original = Object.freeze(frame({ yaw, pitch, s: 100 + index }));
    const prediction = fake.client.predictor.predict(original, { kernel: 'context' }, 0.5);
    assert.equal(prediction, result);
    assert.ok(h.api.runtime.predictions.has(original.s));
    const localShot = h.api.trace().localShots.at(-1);
    assert.equal(localShot.sequence, original.s);
    localShot.directions[0].forEach((value, axis) => close(value, result.weapon.dirs[0][axis]));
    const output = send(fake, Object.freeze([original]))[0];
    const actualDirection = perturb(output.yaw, output.pitch, degrees, random);
    actualDirection.forEach((value, axis) => close(value, targetDirection[axis]));
    assert.equal(original.yaw, yaw);
    assert.equal(original.pitch, pitch);
    assert.equal(original.mx, 1);
    assert.equal(original.mz, 1);
    const before = worldMovement(original), after = worldMovement(output);
    close(after[0], before[0]);
    close(after[1], before[1]);
    assert.equal(h.api.runtime.predictions.size, 0);
  }
  assert.equal(h.api.runtime.compensated, cases.length);
  assert.equal(h.api.inspect().compensated, cases.length);
  assert.equal(h.api.runtime.rewrites, cases.length);
  assert.equal(h.api.trace().localShots.length, cases.length);
  h.api.destroy();
  assert.equal(fake.client.predictor.predict, originalPredict);
  assert.equal(fake.client.input.sample, fake.originalSample);
});

test('multiple projectile predictions retain center aim and do not count exact compensation', () => {
  const h = harness();
  const fake = rageClient();
  fake.client.predictor.predict = () => ({
    eye: [0, 1.62, 0], weapon: { fired: true, dirs: [[0, 0, -1], [0.1, 0, -0.99]] }
  });
  attach(h, fake);
  const input = frame();
  fake.client.predictor.predict(input);
  const output = send(fake, [input])[0];
  close(output.yaw, Math.atan2(-2, 10));
  assert.equal(h.api.runtime.compensated, 0);
});

const runtimePath = path.join(__dirname, '..', 'research', 'turbopack-37jd2rjmtu1y9.js');

test('captured Turbopack runtime preserves grouped exports and array-to-object loader handoff', {
  skip: !fs.existsSync(runtimePath) && 'Captured runtime is optional for portable tests'
}, async () => {
  const raw = fs.readFileSync(runtimePath, 'utf8');
  const runtimeStart = raw.indexOf('(()=>{');
  assert.ok(runtimeStart >= 0);
  const sandbox = {
    console, Promise, URL, DOMException,
    document: { readyState: 'loading', currentScript: null, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    performance: { now: () => 1000 },
    addEventListener() {}, removeEventListener() {}, setInterval: () => 1, clearInterval() {},
    location: { href: 'https://www.bridgegame.ai/zone/play/', pathname: '/zone/play/' }
  };
  sandbox.window = sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  const api = sandbox.__bridgeZoneTools;
  // Remove only captured entry metadata; all actual runtime implementation executes unchanged.
  vm.runInContext(raw.slice(runtimeStart), context, { filename: path.basename(runtimePath) });
  assert.equal(Array.isArray(sandbox.TURBOPACK), false);
  const fake = fakeClient();
  sandbox.__fake = fake.client;
  vm.runInContext(`
    TURBOPACK.push(['synthetic.js', 54145, 97294, 42, context => {
      context.s(['getCollisionWorld', 0, () => ({}), 'hasLineOfSight', 0, () => true], 54145);
      context.s(['createZoneClient', 0, params => params], 97294);
      context.s(['getter', () => 7, 'direct', 0, 8, 'setter', () => 9, () => {}], 42);
    }]);
    TURBOPACK.push(['entry.js', 99, context => {
      const exports = context.i(42);
      window.__runtimeResult = {
        client: context.i(97294).createZoneClient(window.__fake),
        physics: context.i(54145), getter: exports.getter, direct: exports.direct, setter: exports.setter
      };
    }]);
    TURBOPACK.push(['start.js', { otherChunks: [], runtimeModuleIds: [99] }]);
  `, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sandbox.__runtimeResult.client, fake.client);
  assert.equal(sandbox.__runtimeResult.getter, 7);
  assert.equal(sandbox.__runtimeResult.direct, 8);
  assert.equal(sandbox.__runtimeResult.setter, 9);
  assert.equal(api.runtime.client, fake.client);
  assert.equal(api.runtime.physics.hasLineOfSight, sandbox.__runtimeResult.physics.hasLineOfSight);
  api.setOptions({ silent: true, rage: false, visibleOnly: true, point: 'head' });
  const inputs = [frame()];
  assert.notEqual(send(fake, inputs), inputs);
  api.destroy();
  assert.equal(fake.client.connection.sendInput, fake.originalSend);
});

test('timer recovers an initialized React client ref and ignores unrelated or disposed refs', async () => {
  const h = harness();
  const unrelatedCanvas = {};
  const unrelated = fakeClient();
  unrelated.client.canvas = {};
  unrelatedCanvas.__reactFiber$other = {
    memoizedState: { memoizedState: { current: unrelated.client }, next: null }
  };
  const disposedCanvas = {};
  const disposed = fakeClient({ canvas: disposedCanvas, disposed: true });
  disposedCanvas.__reactFiber$disposed = {
    memoizedState: { memoizedState: { current: disposed.client }, next: null }
  };
  h.canvases.push(unrelatedCanvas, disposedCanvas);
  h.mount();
  assert.equal(h.timers.size, 1);
  h.tick();
  assert.equal(h.api.runtime.client, null);
  assert.equal(unrelated.client.connection.sendInput, unrelated.originalSend);
  assert.equal(disposed.client.connection.sendInput, disposed.originalSend);

  const canvas = {};
  const fake = rageClient({ canvas });
  // The real ref lives on an ancestor component after another state hook.
  canvas.__reactFiber$late = {
    memoizedState: null,
    return: {
      memoizedState: {
        memoizedState: 'unrelated-state',
        next: { memoizedState: { current: fake.client }, next: null }
      },
      return: null
    }
  };
  h.canvases.push(canvas);
  h.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.api.runtime.client, fake.client);
  assert.equal(h.api.runtime.hookReady, true);
  assert.notEqual(fake.client.connection.sendInput, fake.originalSend);
  assert.notEqual(fake.client.input.sample, fake.originalSample);
  assert.notEqual(fake.client.engine.pipeline.render, fake.originalRender);
  assert.equal(h.api.runtime.error, '');
  const wrappedSend = fake.client.connection.sendInput;
  const wrappedSample = fake.client.input.sample;
  const wrappedRender = fake.client.engine.pipeline.render;
  h.tick();
  h.tick();
  assert.equal(fake.client.connection.sendInput, wrappedSend);
  assert.equal(fake.client.input.sample, wrappedSample);
  assert.equal(fake.client.engine.pipeline.render, wrappedRender);
  h.api.setOptions({ silent: true, rage: false, stealth: false, visibleOnly: false, point: 'head' });
  assert.notEqual(send(fake, [frame()])[0].yaw, 0);
  assert.equal(h.api.runtime.rewrites, 1, 'recovery does not stack duplicate input hooks');
  h.api.destroy();
  assert.equal(h.timers.size, 0);
  assert.equal(fake.client.connection.sendInput, fake.originalSend);
  assert.equal(fake.client.input.sample, fake.originalSample);
  assert.equal(fake.client.engine.pipeline.render, fake.originalRender);
});

test('late recovery imports an already initialized physics module through the real runtime without fetch', {
  skip: !fs.existsSync(runtimePath) && 'Captured runtime is optional for portable tests'
}, async () => {
  const raw = fs.readFileSync(runtimePath, 'utf8');
  const dom = documentHarness();
  let networkRequests = 0;
  const sandbox = {
    console, Promise, URL, DOMException, document: dom.document,
    localStorage: { getItem: () => null, setItem() {} },
    performance: { now: () => 1000 },
    addEventListener() {}, removeEventListener() {},
    setInterval: dom.setInterval, clearInterval: dom.clearInterval,
    location: { href: 'https://www.bridgegame.ai/zone/play/', pathname: '/zone/play/' },
    TURBOPACK: [], __physicsInitializations: 0,
    fetch() { networkRequests++; throw new Error('late recovery cannot fetch'); }
  };
  sandbox.window = sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  // Initialize the real loader and kernel before the userscript is evaluated.
  vm.runInContext(raw.slice(raw.indexOf('(()=>{')), context);
  vm.runInContext(`
    TURBOPACK.push(['existing-kernel.js', 54145, context => {
      window.__physicsInitializations++;
      context.s(['getCollisionWorld', 0, () => ({}), 'hasLineOfSight', 0, () => true], 54145);
    }]);
    TURBOPACK.push(['existing-entry.js', 101, context => {
      window.__existingPhysics = context.i(54145);
    }]);
    TURBOPACK.push(['existing-start.js', { otherChunks: [], runtimeModuleIds: [101] }]);
  `, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sandbox.__physicsInitializations, 1);
  vm.runInContext(source, context);
  const api = sandbox.__bridgeZoneTools;
  assert.equal(api.runtime.physics.hasLineOfSight, undefined);
  const canvas = {};
  const fake = fakeClient({ canvas });
  canvas.__reactFiber$late = {
    memoizedState: { memoizedState: { current: fake.client }, next: null }
  };
  dom.canvases.push(canvas);
  dom.mount();
  dom.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.runtime.client, fake.client);
  assert.equal(api.runtime.physics.getCollisionWorld, sandbox.__existingPhysics.getCollisionWorld);
  assert.equal(api.runtime.physics.hasLineOfSight, sandbox.__existingPhysics.hasLineOfSight);
  assert.equal(api.runtime.error, '');
  assert.equal(sandbox.__physicsInitializations, 1, 'cached physics module executes only once');
  assert.equal(networkRequests, 0);
  api.setOptions({ silent: true, rage: false, visibleOnly: true, point: 'head' });
  const inputs = [frame()];
  assert.notEqual(send(fake, inputs), inputs, 'recovered collision functions enable targeting');
  dom.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sandbox.__physicsInitializations, 1);
  assert.equal(networkRequests, 0);
  api.destroy();
  assert.equal(dom.timers.size, 0);
  assert.equal(fake.client.connection.sendInput, fake.originalSend);
});

test('server telemetry counts authoritative self events, ignores other authors, and deduplicates replay', () => {
  const h = harness();
  const fake = fakeClient();
  const received = [];
  const originalEvents = function (snapshot, extra) {
    assert.equal(this, fake.client);
    assert.equal(extra, 'event-argument');
    received.push(snapshot);
    return 'ingested';
  };
  fake.client.ingestEvents = originalEvents;
  fake.client.team.isAlly = index => index === 2;
  attach(h, fake);
  const events = Object.freeze([
    { type: 'shot', t: 100, by: 0, weapon: 'sidearm' },
    { type: 'hit', t: 100, by: 0, target: 1, head: true, damage: 25 },
    { type: 'kill', t: 100, by: 0, victim: 1 },
    { type: 'shot', t: 100, by: 2, weapon: 'sidearm' },
    { type: 'hit', t: 100, by: 2, target: 1, head: true, damage: 20 },
    { type: 'kill', t: 100, by: 2, victim: 1 },
    { type: 'hit', t: 100, by: 3, target: 0, head: false, damage: 15 }
  ].map(Object.freeze));
  const snapshot = Object.freeze({ t: 100, events });
  const wrapped = fake.client.ingestEvents;
  assert.notEqual(wrapped, originalEvents);
  assert.equal(wrapped.call(fake.client, snapshot, 'event-argument'), 'ingested');
  assert.deepEqual({ ...h.api.runtime.server }, { shots: 1, hits: 1, headshots: 1, kills: 1, damage: 25 });
  assert.equal(fake.client.ingestEvents(snapshot, 'event-argument'), 'ingested');
  assert.deepEqual({ ...h.api.runtime.server }, { shots: 1, hits: 1, headshots: 1, kills: 1, damage: 25 });
  const subsequent = {
    t: 102,
    events: [{ type: 'shot', t: 102, by: 0 }, { type: 'hit', t: 102, by: 0, target: 4, head: false, damage: 10 }]
  };
  fake.client.ingestEvents(subsequent, 'event-argument');
  assert.deepEqual({ ...h.api.runtime.server }, { shots: 2, hits: 2, headshots: 1, kills: 1, damage: 35 });
  assert.equal(received.length, 3, 'original event ingestion still runs for replay');
  assert.equal(received[0], snapshot);
  assert.equal(received[1], snapshot);
  h.api.destroy();
  assert.equal(fake.client.ingestEvents, originalEvents);
});

test('server telemetry preserves identical pellet hits within one snapshot while deduplicating replay', () => {
  const h = harness();
  const fake = fakeClient({ ingestEvents: () => 'ingested' });
  attach(h, fake);
  const hit = { type: 'hit', t: 100, by: 0, target: 1, head: false, damage: 16 };
  const snapshot = { t: 100, events: [hit, { ...hit }] };
  fake.client.ingestEvents(snapshot);
  assert.equal(h.api.runtime.server.hits, 2, 'two pellets may deal identical damage in the same tick');
  assert.equal(h.api.runtime.server.damage, 32);
  fake.client.ingestEvents(structuredClone(snapshot));
  assert.equal(h.api.runtime.server.hits, 2);
  assert.equal(h.api.runtime.server.damage, 32);
});

test('new clients reset server telemetry and retired client events do not affect current counters', () => {
  const h = harness();
  const first = fakeClient({ ingestEvents: () => 'first-result' });
  attach(h, first);
  const snapshot = { t: 100, events: [{ type: 'shot', t: 100, by: 0 }] };
  first.client.ingestEvents(snapshot);
  assert.equal(h.api.runtime.server.shots, 1);
  const second = fakeClient({ ingestEvents: () => 'second-result' });
  attach(h, second);
  assert.deepEqual({ ...h.api.runtime.server }, { shots: 0, hits: 0, headshots: 0, kills: 0, damage: 0 });
  assert.equal(first.client.ingestEvents({ t: 102, events: [{ type: 'shot', t: 102, by: 0 }] }), 'first-result');
  assert.equal(h.api.runtime.server.shots, 0);
  assert.equal(second.client.ingestEvents(snapshot), 'second-result');
  assert.equal(h.api.runtime.server.shots, 1, 'new match can reuse an event value from the previous client');
});

test('automatic targeting prefers chest at long range or high speed and head for near slow targets', () => {
  const h = harness();
  const fake = attach(h);
  h.api.setOptions({ point: 'auto', rage: true, range: 600 });
  const scenarios = [
    { pos: [2, 0, -60], velocity: [0, 0, 0], height: 1.21 },
    { pos: [2, 0, -20], velocity: [4.1, 0, 0], height: 1.21 },
    { pos: [2, 0, -20], velocity: [0, 4.1, 0], height: 1.21 },
    { pos: [2, 0, -20], velocity: [0, 0, 0], height: 1.66 },
    { pos: [2, 0, -20], velocity: [4, 0, 0], height: 1.66 }
  ];
  for (const scenario of scenarios) {
    fake.client.remoteFrames = [{ snap: opponent(1, { p: scenario.pos, v: scenario.velocity }) }];
    const output = send(fake)[0];
    close(output.pitch, Math.atan2(scenario.height - 1.62, Math.hypot(scenario.pos[0], scenario.pos[2])));
  }
});

test('Jump fire frames and active movement actions are not silently rotated', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true });
  const jump = Object.freeze(frame({ buttons: 1 | 4 }));
  const inputs = Object.freeze([jump]);
  assert.equal(send(fake, inputs), inputs);
  assert.equal(jump.yaw, 0);
  assert.equal(jump.mx, 1);
  assert.equal(h.api.runtime.rewrites, 0);
  for (const action of ['vault', 'mantle']) {
    fake.client.predictor.ps[action] = 0.25;
    const actionFrame = frame();
    const actionFrames = [actionFrame];
    assert.equal(send(fake, actionFrames), actionFrames);
    assert.equal(fake.client.input.sample('sample-argument'), fake.sampled);
    fake.client.predictor.ps[action] = 0;
  }
});

test('fallback authoritative vault and mantle snapshot objects suppress aim when prediction is unavailable', () => {
  for (const action of ['vault', 'mantle']) {
    const h = harness();
    const fake = attach(h);
    fake.client.latest.me[action] = { left: 0.25 };
    const inputs = [frame()];
    assert.equal(send(fake, inputs), inputs, `snapshot ${action}.left is an active movement action`);
    fake.client.latest.me[action] = { left: 0 };
    assert.notEqual(send(fake, inputs), inputs, `completed ${action} action allows aim again`);
  }
});

test('rematches sharing a connection restore retired hooks before wrapping the next client', async () => {
  const h = harness();
  const first = rageClient({ ingestEvents: () => 'first-events' });
  const originalFirstEvents = first.client.ingestEvents;
  attach(h, first);
  await new Promise(resolve => setImmediate(resolve));
  const firstSendWrapper = first.client.connection.sendInput;
  assert.notEqual(firstSendWrapper, first.originalSend);
  assert.notEqual(first.client.input.sample, first.originalSample);
  assert.notEqual(first.client.engine.pipeline.render, first.originalRender);
  assert.notEqual(first.client.ingestEvents, originalFirstEvents);

  const second = rageClient({ connection: first.client.connection, ingestEvents: () => 'second-events' });
  const originalSecondEvents = second.client.ingestEvents;
  attach(h, second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.client.input.sample, first.originalSample);
  assert.equal(first.client.engine.pipeline.render, first.originalRender);
  assert.equal(first.client.ingestEvents, originalFirstEvents);
  assert.notEqual(second.client.connection.sendInput, firstSendWrapper);
  assert.equal(h.api.runtime.client, second.client);
  assert.equal(h.api.runtime.pipeline, second.client.engine.pipeline);
  const inputs = [frame()];
  assert.equal(second.client.connection.sendInput('test-match', inputs), 'sent');
  assert.equal(first.sent.length, 1, 'shared original transport is called once');
  assert.equal(h.api.runtime.rewrites, 1, 'rematch does not chain old rewrite hooks');
  h.api.destroy();
  assert.equal(second.client.connection.sendInput, first.originalSend);
  assert.equal(second.client.input.sample, second.originalSample);
  assert.equal(second.client.engine.pipeline.render, second.originalRender);
  assert.equal(second.client.ingestEvents, originalSecondEvents);
});

test('retired asynchronous ready resolution or rejection cannot replace the active renderer', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const h = harness();
    let resolveOld, rejectOld;
    const oldReady = new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    const first = fakeClient({ ready: oldReady });
    attach(h, first);
    const second = attach(h);
    await new Promise(resolve => setImmediate(resolve));
    const activeRenderer = second.client.engine.pipeline.render;
    h.api.runtime.error = 'current-error';
    if (outcome === 'resolve') resolveOld();
    else rejectOld(new Error('retired load failed'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.api.runtime.client, second.client);
    assert.equal(h.api.runtime.pipeline, second.client.engine.pipeline);
    assert.equal(second.client.engine.pipeline.render, activeRenderer);
    assert.equal(first.client.engine.pipeline.render, first.originalRender);
    assert.equal(h.api.runtime.error, 'current-error');
    h.api.destroy();
    assert.equal(second.client.engine.pipeline.render, second.originalRender);
  }
});

test('whole-host initialization waits for zone navigation and scopes hotkeys and settings updates', () => {
  const h = harness();
  h.window.location = { pathname: '/about/' };
  const canvas = {};
  const fake = rageClient({ canvas });
  canvas.__reactFiber$navigation = { memoizedState: { memoizedState: { current: fake.client }, next: null } };
  h.canvases.push(canvas);
  h.mount();
  h.tick();
  assert.equal(h.api.runtime.client, null);
  const keys = h.windowListeners.get('keydown');
  let prevented = 0;
  const event = {
    code: 'F9', target: { tagName: 'DIV' },
    preventDefault() { prevented++; }, stopImmediatePropagation() {}
  };
  keys(event);
  assert.equal(h.api.options.silent, true);
  assert.equal(prevented, 0);
  h.window.location.pathname = '/zone/play/';
  h.tick();
  assert.equal(h.api.runtime.client, fake.client);
  keys({ ...event, composedPath: () => [{ tagName: 'INPUT' }] });
  assert.equal(h.api.options.silent, true, 'shadow-root editable controls do not toggle aim');
  keys(event);
  assert.equal(h.api.options.silent, false);
  assert.equal(prevented, 1);
  const storageBefore = [...h.storage.values()];
  h.windowListeners.get('storage')({ key: 'bridgezone.tools.v2', newValue: JSON.stringify({ silent: true, loot: false }) });
  assert.equal(h.api.options.silent, true);
  assert.equal(h.api.options.loot, false);
  assert.deepEqual([...h.storage.values()], storageBefore, 'cross-tab settings changes do not echo to storage');
  h.window.location.pathname = '/about/';
  h.tick();
  assert.equal(h.api.runtime.client, null);
  assert.equal(fake.client.connection.sendInput, fake.originalSend);
  h.api.destroy();
  assert.equal(h.windowListeners.has('storage'), false);
});

test('A-to-B-to-A client reattachment resumes predictor shot capture after restoring the same predictor', () => {
  const h = harness();
  const first = rageClient();
  let predictions = 0;
  const originalPredict = function (input) {
    assert.equal(this, first.client.predictor);
    predictions++;
    return { eye: [0, 1.62, 0], weapon: { fired: true, dirs: [[0, 0, -1]] } };
  };
  first.client.predictor.predict = originalPredict;
  attach(h, first);
  const firstWrapper = first.client.predictor.predict;
  assert.notEqual(firstWrapper, originalPredict);
  first.client.predictor.predict(frame({ s: 101 }));
  assert.equal(h.api.runtime.predictions.has(101), true);

  const second = attach(h);
  assert.equal(h.api.runtime.client, second.client);
  assert.equal(first.client.predictor.predict, originalPredict);
  assert.equal(h.api.runtime.predictions.size, 0);
  first.client.predictor.predict(frame({ s: 102 }));
  assert.equal(h.api.runtime.predictions.size, 0, 'retired predictor calls are no longer captured');

  attach(h, first);
  assert.equal(h.api.runtime.client, first.client);
  assert.notEqual(first.client.predictor.predict, originalPredict);
  assert.notEqual(first.client.predictor.predict, firstWrapper);
  const input = Object.freeze(frame({ s: 103 }));
  first.client.predictor.predict(input);
  assert.equal(h.api.runtime.predictions.has(103), true, 'reattachment must register the restored predictor again');
  const output = send(first, [input])[0];
  assert.notEqual(output, input);
  assert.equal(h.api.runtime.predictions.size, 0);
  assert.equal(h.api.runtime.compensated, 1);
  assert.equal(predictions, 3, 'the original predictor is called exactly once at each stage');
  h.api.destroy();
  assert.equal(first.client.predictor.predict, originalPredict);
  assert.equal(first.client.connection.sendInput, first.originalSend);
});

function connectionState(fake, state = 'connected', error = '') {
  const listeners = new Set();
  Object.assign(fake.client.connection, {
    state, error,
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
  return {
    listeners,
    emit(nextState, nextError = '') {
      fake.client.connection.state = nextState;
      fake.client.connection.error = nextError;
      for (const listener of listeners) listener();
    }
  };
}

test('bounded trace connects outgoing frames, server events, and a rejection without credentials', () => {
  const h = harness();
  const fake = fakeClient({ ingestEvents(snapshot) { return snapshot; } });
  const state = connectionState(fake);
  attach(h, fake);
  const original = frame({ s: 41 });
  const outgoing = send(fake, [original])[0];
  fake.client.ingestEvents({ t: 100, events: [
    { t: 100, by: 0, type: 'shot' },
    { t: 100, by: 0, type: 'hit', damage: 12 }
  ] });
  state.emit('kicked', 'aim assistance was detected');
  const trace = h.api.trace();
  assert.equal(trace.match, 1);
  assert.equal(trace.frames.at(-1).sequence, 41);
  assert.deepEqual(Array.from(trace.frames.at(-1).before), [0, 0, 1, 1]);
  assert.equal(trace.frames.at(-1).after[0], outgoing.yaw);
  assert.deepEqual(Array.from(trace.serverEvents, event => event.type), ['shot', 'hit']);
  assert.equal(trace.kicks.at(-1).lastSequence, 41);
  assert.equal(JSON.stringify(trace).includes('test-match'), false, 'match identifiers stay out of the trace');
  const exported = JSON.parse(h.api.exportTrace());
  assert.equal(exported.formatVersion, 1);
  assert.equal(exported.scriptVersion, '1.5.5');
  assert.equal(exported.trace.kicks.at(-1).lastSequence, 41);
  assert.equal(JSON.stringify(exported).includes('test-match'), false);
  trace.frames[0].before[0] = 999;
  assert.equal(h.api.trace().frames[0].before[0], 0, 'callers cannot mutate retained evidence');
  for (let batch = 0; batch < 17; batch++) {
    const frames = Array.from({ length: 256 }, (_, index) =>
      frame({ s: batch * 256 + index, buttons: 0 }));
    send(fake, frames);
  }
  assert.equal(h.api.trace().frames.length, 4096);
  assert.equal(h.api.trace().frames.at(-1).sequence, 4351);
  h.api.destroy();
});

test('Save trace button downloads the current local evidence', async () => {
  const h = harness();
  h.mount();
  const click = h.controls.get('[data-download-trace]').events.get('click');
  assert.equal(typeof click, 'function');
  click();
  assert.equal(h.downloads.length, 1);
  assert.match(h.downloads[0].download, /^bridgezone-trace-.*\.json$/);
  assert.equal(h.downloads[0].href, 'blob:trace');
  assert.equal(h.createdBlobs[0].type, 'application/json');
  assert.equal(h.revokedUrls[0], 'blob:trace');
  const payload = JSON.parse(await h.createdBlobs[0].text());
  assert.equal(payload.scriptVersion, '1.5.5');
  assert.equal(payload.trace.match, 0);
  h.api.destroy();
});

test('new pages retain Silent AIM, migrate legacy settings, and keep Rage off', () => {
  for (const saved of [undefined, { silent: true, rage: true, xray: false, loot: false, range: 120, fov: 25, smooth: 0.1 }]) {
    const h = harness([], saved);
    assert.equal(h.api.options.silent, true);
    h.api.setOptions({ rage: false });
    assert.equal(h.api.options.rage, false);
    assert.equal(h.api.options.fov, 90);
    assert.equal(h.api.options.smooth, 1);
    assert.equal(h.api.inspect().aimRejected, false);
    if (saved) {
      assert.equal(h.api.options.xray, false);
      assert.equal(h.api.options.loot, false);
      assert.equal(h.api.options.range, 120);
    }
    const fake = fakeClient();
    h.api.setOptions({ silent: true, stealth: false, visibleOnly: false, fov: 90 });
    h.api.attachClient(fake.client);
    const inputs = [frame()];
    assert.notEqual(send(fake, inputs), inputs, 'Silent AIM is active by default');
    assert.equal(h.api.runtime.rewrites, 1);
    h.api.destroy();
  }
});

test('server aim rejection disables and persists aim across settings updates and a new client', () => {
  const h = harness();
  const fake = rageClient();
  const state = connectionState(fake);
  attach(h, fake);
  h.api.setOptions({ silent: true, rage: true });
  h.api.runtime.predictions.set(1, {});
  state.emit('kicked', 'aim assistance was detected');
  assert.equal(h.api.inspect().aimRejected, true);
  assert.equal(h.api.options.silent, false);
  assert.equal(h.api.options.rage, false);
  assert.equal(h.api.runtime.predictions.size, 0);
  assert.equal(JSON.parse([...h.storage.values()][0]).silent, false);
  assert.equal(JSON.parse([...h.storage.values()][0]).rage, false);
  const inputs = [frame()];
  assert.equal(send(fake, inputs), inputs, 'the rejected client still blocks outgoing aim');
  assert.equal(fake.client.input.sample('sample-argument'), fake.sampled);
  h.api.setOptions({});
  h.mount();
  assert.equal(h.controls.get('[name="silent"]').disabled, true);
  assert.equal(h.controls.get('[name="rage"]').disabled, true);
  const keys = h.windowListeners.get('keydown');
  keys({ code: 'F9', target: { tagName: 'DIV' }, preventDefault() {}, stopImmediatePropagation() {} });
  h.api.setOptions({ silent: true, rage: true });
  h.windowListeners.get('storage')({ key: 'bridgezone.tools.v2', newValue: '{"silent":true,"rage":true,"loot":false}' });
  assert.equal(h.api.options.silent, false);
  assert.equal(h.api.options.rage, false);
  assert.equal(h.api.options.loot, false, 'unrelated settings remain editable');
  assert.equal(send(fake, inputs), inputs);
  const next = attach(h);
  assert.equal(state.listeners.size, 0, 'retired connection subscription is removed');
  assert.equal(h.api.options.silent, false);
  assert.equal(send(next, inputs), inputs, 'the next client still leaves aim disabled');
  assert.equal(h.api.runtime.aimRejected, true, 'a new client cannot clear the rejection gate');
  h.api.destroy();
});

test('attachment checks an already rejected connection with or without a state subscription', () => {
  for (const subscribe of [true, false]) {
    const h = harness();
    const fake = fakeClient();
    const state = connectionState(fake, 'kicked', 'anti-cheat');
    if (!subscribe) delete fake.client.connection.onState;
    attach(h, fake);
    assert.equal(h.api.inspect().aimRejected, true);
    assert.equal(h.api.options.silent, false);
    const next = fakeClient();
    attach(h, next);
    assert.equal(h.api.inspect().aimRejected, true, 'a new client retains the rejection');
    assert.equal(h.api.options.silent, false);
    h.api.setOptions({ rage: false });
    assert.equal(h.api.options.rage, false);
    h.api.destroy();
    assert.equal(state.listeners.size, 0);
  }
});

test('retired connection events do not reject the active client and unrelated kicks do not latch', () => {
  const h = harness();
  const first = fakeClient();
  const old = connectionState(first);
  attach(h, first);
  const second = fakeClient();
  const current = connectionState(second);
  attach(h, second);
  old.emit('kicked', 'aim assistance was detected');
  current.emit('kicked', 'lobby closed');
  assert.equal(h.api.inspect().aimRejected, false);
  h.api.destroy();
  assert.equal(current.listeners.size, 0);
});

test('destroy remains complete when an unsubscribe throws and repeated calls preserve a replacement', () => {
  const h = harness();
  const fake = fakeClient();
  fake.client.connection.onState = () => () => { throw new Error('unsubscribe failed'); };
  attach(h, fake);
  const old = h.api;
  old.destroy();
  assert.equal(old.runtime.client, null);
  assert.equal(fake.client.connection.sendInput, fake.originalSend);
  assert.equal(h.windowListeners.size, 0);
  assert.equal(h.documentListeners.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.window.__bridgeZoneTools, undefined);
  const replacement = { marker: true };
  const newQueue = { push() {} };
  h.window.__bridgeZoneTools = replacement;
  h.window.TURBOPACK = newQueue;
  old.destroy();
  assert.equal(h.window.__bridgeZoneTools, replacement);
  assert.equal(h.window.TURBOPACK, newQueue);
});

test('Insert before mounting applies the initial hidden state and the next Insert shows the panel', () => {
  const h = harness();
  const keys = h.windowListeners.get('keydown');
  const event = { code: 'Insert', target: { tagName: 'DIV' }, preventDefault() {}, stopImmediatePropagation() {} };
  keys(event);
  h.mount();
  const panel = h.controls.get('aside');
  const showButton = h.controls.get('[data-show-panel]');
  assert.equal(panel.hidden, true);
  assert.equal(showButton.hidden, false);
  keys(event);
  assert.equal(panel.hidden, false);
  assert.equal(showButton.hidden, true);
  h.controls.get('button').events.get('click')();
  assert.equal(panel.hidden, true);
  assert.equal(showButton.hidden, false);
  showButton.events.get('click')();
  assert.equal(panel.hidden, false);
  assert.equal(showButton.hidden, true);
  h.api.destroy();
});

test('settings deletion resets defaults without echoing storage and malformed patches are ignored', () => {
  const h = harness();
  h.api.setOptions({ silent: true, rage: true, xray: false, loot: false, range: 100 });
  const stored = [...h.storage.values()];
  const storage = h.windowListeners.get('storage');
  storage({ key: 'unrelated', newValue: null });
  assert.equal(h.api.options.range, 100);
  for (const key of ['bridgezone.tools.v2', null]) {
    storage({ key, newValue: null });
    assert.equal(h.api.options.silent, true);
    assert.equal(h.api.options.rage, false);
    assert.equal(h.api.options.xray, true);
    assert.equal(h.api.options.loot, true);
    assert.equal(h.api.options.range, 600);
  }
  assert.deepEqual([...h.storage.values()], stored);
  for (const patch of [null, undefined, 'invalid', 42]) assert.doesNotThrow(() => h.api.setOptions(patch));
  assert.equal(h.api.options.silent, true);
  h.api.destroy();
});
