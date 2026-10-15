'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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
  const rootListeners = new Map();
  const root = {
    innerHTML: '',
    appendChild() {},
    addEventListener(name, listener) { rootListeners.set(name, listener); },
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
    document, canvases, listeners, rootListeners, timers, controls, downloads,
    setInterval(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
    mount() {
      document.readyState = 'complete';
      listeners.get('DOMContentLoaded')?.();
    },
    tick() { for (const callback of timers.values()) callback(); }
  };
}

function harness(initialChunks = [], savedSettings, features = {}) {
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
    indexedDB: features.indexedDB,
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
    performance: { now: () => features.now?.() ?? 1000 },
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

function archiveDbHarness() {
  const records = new Map();
  let created = false;
  const db = {
    objectStoreNames: { contains: name => name === 'sessions' && created },
    createObjectStore(name) { assert.equal(name, 'sessions'); created = true; },
    transaction(name) {
      assert.equal(name, 'sessions');
      const tx = {
        objectStore() {
          return {
            put(record) { records.set(record.id, record); },
            delete(key) { records.delete(key); },
            getAllKeys() {
              const request = {};
              queueMicrotask(() => {
                request.result = [...records.keys()];
                request.onsuccess?.();
                queueMicrotask(() => tx.oncomplete?.());
              });
              return request;
            },
            getAll() {
              const request = {};
              queueMicrotask(() => { request.result = [...records.values()]; request.onsuccess?.(); });
              return request;
            }
          };
        }
      };
      return tx;
    }
  };
  return { records, indexedDB: { open() {
    const request = { result: db };
    queueMicrotask(() => { if (!created) request.onupgradeneeded?.(); request.onsuccess?.(); });
    return request;
  } } };
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
  // Most behavior tests isolate manual aim from the default combat agent.
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
  const sampled = Object.freeze(frame({ buttons: 16 | 8 }));
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
    ws: { trigger: false, cooldown: 0, ads: 1 },
    active: 0, slots: [{ mag: 10 }], ammo: { light: 50 },
    activeStats: { fireMode: 'auto', ammo: 'light', pellets: 1, magSize: 10 }
  };
  const fake = fakeClient({ input, predictor, predictorReady: true, renderTick: () => 100.4, ...patch });
  return { ...fake, sampled, originalSample: input.sample };
}

test('an F interact pulse survives Rage sampling and outgoing frames', () => {
  // The captured client maps KeyF/KeyE to Buttons.Interact (64). A pickup
  // needs that bit on the wire during the press and absent after release.
  for (const targetPresent of [false, true]) {
    const h = harness();
    const fake = rageClient();
    let buttons = 64, sequence = 1800;
    fake.client.input.sample = () => Object.freeze(frame({ s: sequence++, buttons }));
    attach(h, fake);
    h.api.setOptions({ rage: true, stealth: true, rapidFire: true });
    if (!targetPresent) fake.client.remoteFrames = [];

    const pressed = fake.client.input.sample();
    assert.equal(pressed.buttons & 64, 64, `sampled F with target=${targetPresent}`);
    const sentInteract = send(fake, [pressed])[0];
    assert.equal(sentInteract.buttons & 64, 64,
      `outgoing F with target=${targetPresent}`);
    close(sentInteract.yaw, pressed.yaw);
    close(sentInteract.pitch, pressed.pitch);
    close(sentInteract.mx, pressed.mx);
    close(sentInteract.mz, pressed.mz);
    buttons = 0;
    const released = fake.client.input.sample();
    assert.equal(released.buttons & 64, 0, `sampled F release with target=${targetPresent}`);
    assert.equal(send(fake, [released])[0].buttons & 64, 0,
      `outgoing F release with target=${targetPresent}`);
    h.api.destroy();
  }
});

test('manual Stealth preserves F interact while holding an unaligned Fire input', () => {
  const h = harness();
  const original = Object.freeze(frame({ s: 1810, buttons: 1 | 64 }));
  const fake = attach(h, fakeClient({ input: { enabled: true, sample: () => original } }));
  h.api.setOptions({ stealth: true });

  const sampled = fake.client.input.sample();
  assert.equal(sampled.buttons & 1, 0, 'Fire waits for the outgoing aim');
  assert.equal(sampled.buttons & 64, 64, 'F remains available while Fire waits');
  const outgoing = send(fake, [sampled])[0];
  assert.equal(outgoing.buttons & 1, 0);
  assert.equal(outgoing.buttons & 64, 64, 'F reaches the server input');
  assert.equal(original.buttons, 1 | 64, 'the game-owned input is not mutated');
  h.api.destroy();
});

test('Rage predicts before its final outgoing turn while manual Stealth still holds Fire', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true, stealth: true, rapidFire: true });
  const farFromAim = fake.client.input.sample('sample-argument');
  assert.equal(farFromAim.buttons & 1, 0, 'a target beyond one outgoing turn stays held');
  assert.equal(farFromAim.buttons & 2, 2, 'aiming down sights remains active');
  assert.equal(fake.sampled.buttons, 16 | 8, 'the game sample is not mutated');
  assert.equal(send(fake, [farFromAim])[0].buttons & 1, 0,
    'the outgoing frame stays held while the turn is incomplete');
  let predicted = false, sent = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const sampled = fake.client.input.sample('sample-argument');
    const outgoing = send(fake, [frame({ ...sampled, s: 200 + attempt })])[0];
    predicted ||= !!(sampled.buttons & 1);
    sent ||= !!(outgoing.buttons & 1);
    if (sent) break;
  }
  assert.equal(predicted, true, 'Rage enables prediction once aim is within one outgoing turn');
  assert.equal(sent, true, 'Rage sends Fire once the outgoing turn aligns');
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

test('fast fire skips local pacing but still waits for aim and real ammunition', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true, stealth: true, rapidFire: true });
  h.api.runtime.stealth.cooldown = 1e9;
  let fired = false;
  for (let sequence = 800; sequence < 810; sequence++) {
    const sampled = fake.client.input.sample('sample-argument');
    const output = send(fake, [frame({ ...sampled, s: sequence })])[0];
    if (output.buttons & 1) { fired = true; break; }
  }
  assert.equal(fired, true, 'local cooldown does not throttle ready Rage shots');
  fake.client.predictor.slots[0].mag = 0;
  fake.client.predictor.ammo.light = 0;
  assert.equal(fake.client.input.sample('sample-argument').buttons & 1, 0);
  h.api.destroy();
});

test('adaptive hip fire sends Fire without Aim when spread correction fits', () => {
  const h = harness();
  const fake = rageClient();
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -20] }) }];
  fake.client.predictor.ps.grounded = true;
  Object.assign(fake.client.predictor.ws, { ads: 0, bloom: 0, switching: 0 });
  Object.assign(fake.client.predictor.activeStats, {
    hipSpread: 3.2, adsSpread: 0.12, moveSpread: 1.6
  });
  const spread = 2 * Math.PI / 180;
  fake.client.predictor.predict = input => ({ eye: [0, 1.62, 0], weapon: {
    fired: !!(input.buttons & 1), dirs: [[
      -Math.sin(input.yaw + spread) * Math.cos(input.pitch),
      Math.sin(input.pitch),
      -Math.cos(input.yaw + spread) * Math.cos(input.pitch)
    ]]
  } });
  attach(h, fake);
  h.api.setOptions({ rage: true, stealth: true, rapidFire: true, hipFire: true, point: 'chest' });
  send(fake, [frame({ s: 600, buttons: 0 })]);
  const sampled = fake.client.input.sample('sample-argument');
  assert.equal(sampled.buttons & 3, 1, 'the planned shot fires without requesting scope');
  assert.equal(sampled.buttons & 16, 0, 'sprint is released for the firing frame');
  fake.client.predictor.predict(sampled);
  const outgoing = send(fake, [sampled])[0];
  assert.equal(outgoing.buttons & 3, 1);
  const decision = h.api.trace().aimDecisions.at(-1);
  assert.equal(decision.adsRequested, false);
  assert.equal(decision.sampled.hipFire, true);
  assert.equal(decision.sampled.hipSeeded, false);
  assert.equal(decision.correctionApplied, true);
  assert.ok(decision.geometry.predictedOutgoing.minMeters < 0.01);
  assert.equal(h.api.trace().fireGates.at(-1).hipFire, true);
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -100] }) }];
  assert.equal(fake.client.input.sample('sample-argument').buttons & 2, 2,
    'the default range cap preserves ADS for distant shots');
  h.api.setOptions({ hipRange: 120 });
  assert.equal(h.api.options.hipRange, 40, 'the live trace caps unscoped range at 40 m');
  assert.equal(fake.client.input.sample('sample-argument').buttons & 2, 2,
    'the distance control cannot force the inaccurate 100 m hip shot');
  h.api.destroy();
});

test('a wide seeded hip spread falls back to ADS without advancing the shot', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  const predictor = fake.client.predictor;
  predictor.ps.grounded = true;
  predictor.seed = 123;
  predictor.index = 0;
  Object.assign(predictor.ws, { ads: 1, bloom: 0, switching: 0, shots: 4 });
  Object.assign(predictor.activeStats, {
    hipSpread: 8, adsSpread: 0.1, moveSpread: 4
  });
  let random = 0.01;
  h.api.attachClient(fake.client, { shotSeed: () => 9, mulberry32: () => () => random });
  h.api.setOptions({ rage: true, hipFire: true });
  const narrow = fake.client.input.sample('sample-argument');
  assert.equal(narrow.buttons & 2, 0);
  assert.equal(h.api.runtime.sampleGate.hipSeeded, true);
  assert.equal(h.api.runtime.sampleGate.hipFire, true);
  random = 0.99;
  const wide = fake.client.input.sample('sample-argument');
  assert.equal(wide.buttons & 2, 2);
  assert.equal(h.api.runtime.sampleGate.hipFire, false);
  assert.equal(predictor.ws.shots, 4, 'planning does not consume the next shot');
  h.api.setOptions({ hipFire: false });
  assert.equal(fake.client.input.sample('sample-argument').buttons & 2, 2);
  h.api.destroy();
});

test('combat agent approaches an enemy, stops to fire, and yields to manual movement', () => {
  const h = harness();
  const fake = rageClient();
  let manual = false;
  fake.client.input.sample = () => frame({ s: 810, buttons: 0,
    mx: manual ? 1 : 0, mz: 0 });
  Object.assign(fake.client.predictor.ps, { vel: [0, 0, 0], grounded: true });
  Object.assign(fake.client.predictor.activeStats,
    { class: 'rifle', rangeEnd: 90, hipSpread: 3, adsSpread: 0.1, moveSpread: 1 });
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -120] }) }];
  attach(h, fake);
  h.api.setOptions({ agent: true, hipFire: false, stealth: true });
  assert.equal(h.api.options.rage, true);
  assert.equal(h.api.options.silent, true);
  const travel = fake.client.input.sample();
  assert.ok(Math.abs(travel.mx) < 1e-9 && travel.mz > 0.9);
  assert.equal(travel.buttons & 16, 16);
  assert.equal(travel.buttons & 3, 0, 'travel does not fire or scope');
  assert.equal(h.api.inspect().agent.action, 'approach');
  send(fake, [travel]);
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -30] }) }];
  fake.client.predictor.ps.vel = [0, 0, -2];
  const settling = fake.client.input.sample();
  assert.equal(settling.buttons & 3, 2, 'the agent waits for movement to settle');
  assert.equal(h.api.runtime.sampleGate.reason, 'agent-settle');
  fake.client.predictor.ps.vel = [0, 0, 0];
  const engage = fake.client.input.sample();
  assert.equal(engage.mx, 0);
  assert.equal(engage.mz, 0);
  assert.equal(engage.buttons & 3, 3, 'the agent stops and requests scoped Fire');
  assert.equal(h.api.inspect().agent.action, 'engage');
  manual = true;
  const overridden = fake.client.input.sample();
  assert.equal(overridden.mx, 1);
  assert.equal(overridden.mz, 0);
  assert.equal(h.api.inspect().agent.action, 'manual-override');
  h.api.setOptions({ rage: false });
  assert.equal(h.api.options.agent, false, 'turning off Rage also stops the agent');
  h.api.destroy();
});

test('combat agent takes a real side detour after stalling and resumes direct travel on progress', () => {
  let now = 1000;
  const h = harness([], undefined, { now: () => now });
  const fake = rageClient();
  fake.client.input.sample = () => frame({ s: 813, buttons: 0, mx: 0, mz: 0 });
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -120] }) }];
  Object.assign(fake.client.predictor.ps, { pos: [0, 0, 0], vel: [0, 0, 0], grounded: true });
  attach(h, fake);
  h.api.setOptions({ agent: true, hipFire: false });
  const direct = fake.client.input.sample();
  assert.ok(Math.abs(direct.mx) < 0.01 && direct.mz > 0.9);
  now += 700;
  const detour = fake.client.input.sample();
  assert.ok(Math.abs(detour.mx) > 0.7, 'stall changes the actual movement vector');
  assert.equal(h.api.inspect().agent.action, 'detour');
  assert.equal(h.api.runtime.sampleGate.reason, 'agent-detour');
  assert.equal(detour.buttons & 1, 0);
  assert.equal(h.api.trace().agentDecisions.at(-1).stuckCount, 1);
  fake.client.predictor.ps.pos = [1, 0, -2];
  now += 700;
  const resumed = fake.client.input.sample();
  assert.ok(Math.abs(resumed.mx) < 0.1 && resumed.mz > 0.9);
  assert.equal(h.api.inspect().agent.action, 'approach');
  assert.equal(h.api.runtime.agent.stuckCount, 0);
  h.api.destroy();
});

test('combat agent respects movement boxes that let shots through and steps over low cover', () => {
  const h = harness();
  const fake = rageClient();
  fake.client.input.sample = () => frame({ s: 814, buttons: 0, mx: 0, mz: 0 });
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -120] }) }];
  Object.assign(fake.client.predictor.ps, { pos: [0, 0, 0], vel: [0, 0, 0], grounded: true });
  attach(h, fake);
  const box = { min: [-0.5, 0, -2.2], max: [0.5, 1.6, -1.8], blocksShots: false };
  const columns = 193, grid = new Map();
  for (const col of [95, 96]) grid.set(95 * columns + col, [0]);
  const world = { cellSize: 8, boxes: [box], grid };
  h.register(54145, { getCollisionWorld: () => world, hasLineOfSight: () => true });
  h.api.setOptions({ agent: true });
  const around = fake.client.input.sample();
  assert.ok(Math.abs(around.mx) > 0.4 && around.mz > 0.5,
    'collision box changes the route even when the shot ray is clear');
  box.max[1] = 0.4;
  const over = fake.client.input.sample();
  assert.ok(Math.abs(over.mx) < 0.01 && over.mz > 0.9,
    'the movement kernel can step over a low box');
  h.api.destroy();
});

test('combat agent uses the longest safe short corridor when every full route is blocked', () => {
  const h = harness();
  const fake = rageClient();
  fake.client.input.sample = () => frame({ s: 816, buttons: 0, mx: 0, mz: 0 });
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -120] }) }];
  Object.assign(fake.client.predictor.ps, { pos: [0, 0, 0], vel: [0, 0, 0], grounded: true });
  attach(h, fake);
  const box = { min: [-10, 0, -1.1], max: [10, 2, -0.9] };
  const grid = new Map(), columns = 193;
  for (const col of [94, 95, 96, 97]) grid.set(95 * columns + col, [0]);
  const world = { cellSize: 8, boxes: [box], grid };
  h.register(54145, { getCollisionWorld: () => world, hasLineOfSight: () => true });
  h.api.setOptions({ agent: true });
  const partial = fake.client.input.sample();
  assert.ok(Math.abs(partial.mx) > 0.7 && partial.mz > 0.3,
    'a safe lateral corridor moves the agent instead of stopping at a distant wall');
  box.min[2] = -0.5;
  box.max[2] = -0.3;
  const blocked = fake.client.input.sample();
  assert.equal(blocked.mx, 0);
  assert.equal(blocked.mz, 0);
  assert.equal(h.api.inspect().agent.action, 'blocked');
  h.api.destroy();
});

test('combat agent holds a detour side until the full window or actual goal progress', () => {
  let now = 1000;
  const h = harness([], undefined, { now: () => now });
  const fake = rageClient();
  fake.client.input.sample = () => frame({ s: 815, buttons: 0, mx: 0, mz: 0 });
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -120] }) }];
  Object.assign(fake.client.predictor.ps, { pos: [0, 0, 0], vel: [0, 0, 0], grounded: true });
  attach(h, fake);
  h.api.setOptions({ agent: true });
  fake.client.input.sample();
  now += 700;
  const initial = fake.client.input.sample();
  fake.client.predictor.ps.pos = [1, 0, 0];
  now += 700;
  const held = fake.client.input.sample();
  assert.ok(initial.mx * held.mx > 0, 'sideways motion without goal progress keeps the same flank');
  assert.equal(h.api.inspect().agent.action, 'detour');
  fake.client.predictor.ps.pos = [2, 0, 0];
  now += 900;
  const switched = fake.client.input.sample();
  assert.ok(initial.mx * switched.mx < 0, 'the flank changes after its unsuccessful window');
  assert.equal(h.api.runtime.agent.stuckCount, 2);
  h.api.destroy();
});

test('combat agent moves toward the observed safe zone and does not fire while travelling', () => {
  const h = harness();
  const fake = rageClient();
  fake.client.input.sample = () => frame({ s: 811, buttons: 0, mx: 0, mz: 0 });
  Object.assign(fake.client.predictor.ps, { vel: [0, 0, 0], grounded: true });
  fake.client.latest.storm = { state: 'waiting', center: [100, 0], radius: 10 };
  fake.client.remoteFrames = [];
  attach(h, fake);
  h.api.setOptions({ agent: true });
  const move = fake.client.input.sample();
  assert.ok(move.mx > 0.9 && Math.abs(move.mz) < 1e-9);
  assert.equal(move.buttons & 16, 16);
  assert.equal(move.buttons & 3, 0);
  assert.equal(h.api.inspect().agent.action, 'storm');
  assert.equal(h.api.trace().agentDecisions.at(-1).goal.kind, 'storm');
  h.api.destroy();
});

test('combat agent leaves a manual F/E interaction on the wire', () => {
  const h = harness();
  const fake = rageClient();
  fake.client.input.sample = () => frame({ s: 815, buttons: 64, mx: 0, mz: 0 });
  Object.assign(fake.client.predictor.ps, { vel: [0, 0, 0], grounded: true });
  attach(h, fake);
  h.api.setOptions({ agent: true, stealth: true });
  const input = fake.client.input.sample();
  assert.equal(input.buttons & 64, 64);
  assert.equal(input.buttons & 1, 0);
  assert.equal(h.api.inspect().agent.action, 'manual-override');
  assert.equal(send(fake, [input])[0].buttons & 64, 64);
  h.api.destroy();
});

test('combat agent aims at nearby matching ammo before issuing Interact', () => {
  const h = harness();
  const fake = rageClient();
  fake.client.input.sample = () => frame({ s: 812, buttons: 0, mx: 0, mz: 0 });
  Object.assign(fake.client.predictor.ps, { vel: [0, 0, 0], grounded: true });
  fake.client.predictor.slots[0].mag = 0;
  fake.client.predictor.ammo.light = 0;
  fake.client.remoteFrames = [];
  fake.client.loot = { items: new Map([['ammo-1',
    { id: 'ammo-1', kind: 'ammo', ammo: 'light', pos: [0, 0, -1] }]]) };
  fake.client.target = { target: { kind: 'item', id: 'ammo-1' } };
  attach(h, fake);
  h.api.setOptions({ agent: true, ammo: true });
  const first = fake.client.input.sample();
  assert.equal(first.buttons & 64, 0, 'the first frame turns toward the item');
  let pickup = null;
  for (let i = 0; i < 16; i++) {
    pickup = fake.client.input.sample();
    if (pickup.buttons & 64) break;
  }
  assert.equal(pickup.buttons & 64, 64);
  assert.equal(pickup.buttons & 1, 0, 'pickup suppresses Fire');
  assert.equal(h.api.inspect().agent.action, 'loot-aim');
  fake.client.loot.items.clear();
  fake.client.target = { target: null };
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -30] }) }];
  const empty = fake.client.input.sample();
  assert.equal(h.api.inspect().agent.action, 'no-ammo');
  assert.equal(empty.mx, 0);
  assert.equal(empty.mz, 0, 'without ammo the agent does not rush an opponent');
  h.api.destroy();
});

test('authoritative shot-count divergence disables adaptive hip fire', () => {
  const h = harness();
  const fake = rageClient();
  Object.assign(fake.client.predictor.ps, { vel: [0, 0, 0], grounded: true });
  Object.assign(fake.client.predictor.ws, { ads: 0, bloom: 0, switching: 0 });
  Object.assign(fake.client.predictor.activeStats,
    { hipSpread: 2, adsSpread: 0.1, moveSpread: 1 });
  fake.client.ingestEvents = snapshot => snapshot;
  attach(h, fake);
  h.api.setOptions({ rage: true, hipFire: true });
  assert.equal(fake.client.input.sample('sample-argument').buttons & 2, 0);
  h.api.runtime.trace.localShots.push({ match: h.api.runtime.trace.match,
    sequence: 23, weapon: { shots: 1 } });
  fake.client.ingestEvents({ t: 100, me: { ack: 23, shots: 5 }, events: [] });
  assert.equal(h.api.inspect().seedSync.status, 'diverged');
  assert.equal(h.api.trace().serverSnapshots.at(-1).acknowledgedShot.delta, 4);
  assert.equal(fake.client.input.sample('sample-argument').buttons & 2, 2);
  h.api.destroy();
});

test('fast fire takes a correctable close shot during ADS ramp but waits when spread is too wide', () => {
  const h = harness();
  const fake = rageClient();
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -10] }) }];
  fake.client.predictor.ps.grounded = true;
  Object.assign(fake.client.predictor.ws, { ads: 0, bloom: 0, switching: 0 });
  Object.assign(fake.client.predictor.activeStats, {
    hipSpread: 3.2, adsSpread: 0.12, moveSpread: 1.6, rangeEnd: 90
  });
  const spread = 3 * Math.PI / 180;
  fake.client.predictor.predict = input => ({ eye: [0, 1.62, 0], weapon: {
    fired: !!(input.buttons & 1), dirs: [[
      -Math.sin(input.yaw + spread) * Math.cos(input.pitch),
      Math.sin(input.pitch),
      -Math.cos(input.yaw + spread) * Math.cos(input.pitch)
    ]]
  } });
  attach(h, fake);
  h.api.setOptions({ rage: true, stealth: true, rapidFire: true, hipFire: false, point: 'chest' });
  send(fake, [frame({ s: 610, buttons: 0 })]);
  const sampled = fake.client.input.sample('sample-argument');
  assert.equal(sampled.buttons & 3, 3, 'Fire and ADS are both requested before full ADS');
  fake.client.predictor.predict(sampled);
  const outgoing = send(fake, [sampled])[0];
  assert.equal(outgoing.buttons & 3, 3);
  assert.ok(Math.abs(outgoing.yaw) <= 8 * Math.PI / 180);
  const decision = h.api.trace().aimDecisions.at(-1);
  assert.ok(decision.geometry.predictedOutgoing.minMeters < 0.01);
  assert.equal(decision.sampled.earlyAds, true);
  assert.equal(decision.correctionApplied, true);

  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -100] }) }];
  assert.equal(fake.client.input.sample('sample-argument').buttons & 1, 0,
    'a distant shot keeps the full ADS accuracy gate');
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -10] }) }];
  Object.assign(fake.client.predictor.activeStats, { hipSpread: 8, adsSpread: 0, moveSpread: 4 });
  assert.equal(fake.client.input.sample('sample-argument').buttons & 1, 0,
    'an uncorrectable early spread remains held');
  h.api.destroy();
});

test('outgoing aim remains aligned when the sampled camera kicks', () => {
  const h = harness();
  const fake = rageClient();
  let cameraYaw = 0, cameraPitch = 0, sequence = 820;
  fake.client.input.sample = () => frame({
    s: sequence++, buttons: 0, yaw: cameraYaw, pitch: cameraPitch
  });
  attach(h, fake);
  h.api.setOptions({ rage: true, stealth: true, rapidFire: true });
  let aimed;
  for (let attempt = 0; attempt < 8; attempt++) {
    const sampled = fake.client.input.sample();
    aimed = send(fake, [sampled])[0];
    if (aimed.buttons & 1) break;
  }
  assert.equal(aimed.buttons & 1, 1);
  cameraYaw = 0.12;
  cameraPitch = 0.08;
  const kicked = fake.client.input.sample();
  const corrected = send(fake, [kicked])[0];
  assert.equal(corrected.buttons & 1, 1);
  close(corrected.yaw, aimed.yaw, 0.001);
  close(corrected.pitch, aimed.pitch, 0.001);
  close(kicked.yaw, cameraYaw);
  close(kicked.pitch, cameraPitch);
  h.api.destroy();
});

test('fast fire corrects predicted moving spread at long range without aim jitter', () => {
  const h = harness();
  const fake = rageClient();
  const spread = 1.6 * Math.PI / 180;
  fake.client.predictor.slots[0].weapon = 'longbow';
  fake.client.predictor.activeStats.rangeEnd = 35;
  fake.client.predictor.activeStats.moveSpread = 4;
  fake.client.predictor.activeStats.rpm = 45;
  fake.client.predictor.predict = input => ({ eye: [0, 1.62, 0], weapon: {
    fired: true, dirs: [[
      -Math.sin(input.yaw + spread) * Math.cos(input.pitch),
      Math.sin(input.pitch),
      -Math.cos(input.yaw + spread) * Math.cos(input.pitch)
    ]]
  } });
  attach(h, fake);
  h.api.setOptions({ rage: true, stealth: true, rapidFire: true, range: 600, point: 'auto' });
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [2, 0, -550] }) }];
  let input, outgoing;
  for (let sequence = 840; sequence < 848; sequence++) {
    input = frame({ ...fake.client.input.sample('sample-argument'), s: sequence, mx: 1, mz: 0 });
    if (input.buttons & 1) fake.client.predictor.predict(input);
    outgoing = send(fake, [input])[0];
    if (outgoing.buttons & 1) break;
  }
  assert.equal(outgoing.buttons & 1, 1);
  assert.equal(outgoing.buttons & 2, 2);
  assert.equal(h.api.runtime.compensated, 1);
  const decision = h.api.trace().aimDecisions.at(-1);
  assert.ok(decision.targetDistance > 500 && decision.targetDistance < 600);
  assert.equal(decision.weaponRangeEnd, 35);
  assert.equal(decision.weaponId, 'longbow');
  assert.equal(decision.weapon.idSource, 'slot');
  assert.equal(decision.localAds, 1);
  assert.equal(decision.movingInput, true);
  assert.equal(decision.adsRequested, true);
  assert.equal(decision.localShotPredicted, true);
  assert.equal(decision.correctionApplied, true);
  assert.equal(decision.fireSent, true);
  assert.equal(decision.target.aimPart, 'chest');
  assert.equal(decision.weapon.stats.rangeEnd, 35);
  assert.equal(decision.weapon.stats.moveSpread, 4);
  assert.equal(decision.weapon.stats.rpm, 45);
  assert.ok(decision.geometry.predictedInput.meanMeters > 10,
    'moving spread would miss the selected point without correction');
  assert.ok(decision.geometry.predictedOutgoing.meanMeters < 0.01,
    'the corrected local ray reaches the selected point');
  const correctedDirection = [
    -Math.sin(outgoing.yaw + spread) * Math.cos(outgoing.pitch),
    Math.sin(outgoing.pitch),
    -Math.cos(outgoing.yaw + spread) * Math.cos(outgoing.pitch)
  ];
  const toChest = [2, 1.21 - 1.62, -550];
  const distance = Math.hypot(...toChest);
  toChest.forEach((value, index) => close(correctedDirection[index], value / distance, 1e-6));
  const before = worldMovement(input), after = worldMovement(outgoing);
  close(after[0], before[0]);
  close(after[1], before[1]);
  h.api.destroy();
});

test('a moving target invalidates ready aim before prediction fires again', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true, stealth: true, rapidFire: true });
  for (let sequence = 900; sequence < 910; sequence++) {
    const sampled = fake.client.input.sample('sample-argument');
    send(fake, [frame({ ...sampled, s: sequence })]);
    if (h.api.runtime.outgoingAim.ready) break;
  }
  assert.equal(h.api.runtime.outgoingAim.ready, true);
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [-10, 0, -2] }) }];
  const changed = fake.client.input.sample('sample-argument');
  assert.equal(changed.buttons & 1, 0, 'stale ready state cannot fire at the old position');
  assert.equal(send(fake, [changed])[0].buttons & 1, 0,
    'an outgoing turn larger than the per-frame limit still holds Fire');
  h.api.destroy();
});

test('fast fire predicts and sends a distant shot after a small target movement', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true, stealth: true, rapidFire: true, range: 600, point: 'auto' });
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [2, 0, -550] }) }];
  const first = fake.client.input.sample('sample-argument');
  send(fake, [frame({ ...first, s: 920 })]);
  assert.equal(h.api.runtime.outgoingAim.ready, true);
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [2.35, 0, -550] }) }];
  const moved = fake.client.input.sample('sample-argument');
  assert.equal(moved.buttons & 1, 1,
    'small moving-target drift may be predicted before the final outgoing aim');
  const aligned = send(fake, [frame({ ...moved, s: 921 })])[0];
  assert.equal(aligned.buttons & 1, 1,
    'the final outgoing rewrite rechecks the current target and sends the aligned shot');
  assert.equal(fake.client.input.sample('sample-argument').buttons & 1, 1);
  h.api.destroy();
});

test('Rage drops unpredicted Fire when the target disappears after input sampling', () => {
  for (const stealth of [true, false]) {
    const h = harness();
    const fake = attach(h, rageClient());
    h.api.setOptions({ rage: true, stealth, rapidFire: true });
    for (let sequence = 970; sequence < 974; sequence++) {
      send(fake, [frame({ s: sequence, buttons: 0 })]);
    }
    const sampled = fake.client.input.sample('sample-argument');
    assert.equal(sampled.buttons & 1, 1);
    fake.client.remoteFrames = [];
    const outgoing = send(fake, [sampled])[0];
    assert.equal(outgoing.buttons & 1, 0, `stale ${stealth ? 'stealth' : 'direct'} target`);
    const decision = h.api.trace().aimDecisions.at(-1);
    assert.equal(decision.fireSent, false);
    assert.equal(decision.sampled.target.index, 1,
      'the trace preserves the sample-time target after it disappears at send time');
    assert.equal(decision.target, null);
    h.api.destroy();
  }
});

test('a predicted Rage shot keeps Fire and the sampled target when snapshots change before send', () => {
  for (const stealth of [true, false]) {
    const h = harness();
    const fake = rageClient();
    fake.client.input.sample = () => Object.freeze(frame({ s: undefined, vt: undefined, buttons: 16 }));
    fake.client.predictor.predict = input => ({ eye: [0, 1.62, 0],
      weapon: { fired: !!(input.buttons & 1), dirs: [[0, 0, -1]] } });
    attach(h, fake);
    h.api.setOptions({ rage: true, stealth, rapidFire: true });
    if (stealth) for (let sequence = 1200; sequence < 1204; sequence++)
      send(fake, [frame({ s: sequence, buttons: 0 })]);
    const sampled = fake.client.input.sample();
    assert.equal(sampled.buttons & 1, 1);
    const predicted = frame({ ...sampled, s: 1210, vt: 100 });
    fake.client.predictor.predict(predicted);
    fake.client.remoteFrames = [];
    const outgoing = send(fake, [predicted])[0];
    assert.equal(outgoing.buttons & 1, 1,
      `the ${stealth ? 'bounded' : 'direct'} send keeps the predicted shot`);
    const decision = h.api.trace().aimDecisions.at(-1);
    assert.equal(decision.localShotPredicted, true);
    assert.equal(decision.fireSent, true);
    assert.equal(decision.sampled.target.index, 1,
      'sample context is tied to the real sequence after the game adds it');
    assert.equal(decision.target.index, 1,
      'the sampled target is retained for this already predicted shot');
    h.api.destroy();
  }
});

test('trace measures target movement between sampling and outgoing aim', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true, stealth: true, rapidFire: true });
  for (let sequence = 980; sequence < 984; sequence++) {
    const sampled = fake.client.input.sample('sample-argument');
    send(fake, [frame({ ...sampled, s: sequence })]);
  }
  const sampled = fake.client.input.sample('sample-argument');
  assert.equal(sampled.buttons & 1, 1);
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [2.4, 0, -10] }) }];
  send(fake, [sampled]);
  const decision = h.api.trace().aimDecisions.at(-1);
  assert.equal(decision.sampled.target.index, decision.target.index);
  close(decision.sampled.selectionDriftMeters, 0.4, 1e-9);
  assert.equal(decision.sampled.delayMs, 0);
  h.api.destroy();
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

test('a send-time aim error preserves an already predicted Rage shot', () => {
  const h = harness();
  const fake = rageClient();
  fake.client.predictor.predict = input => ({ eye: [0, 1.62, 0],
    weapon: { fired: !!(input.buttons & 1), dirs: [[0, 0, -1]] } });
  attach(h, fake);
  h.api.setOptions({ rage: true, stealth: true });
  for (let sequence = 1300; sequence < 1304; sequence++)
    send(fake, [frame({ s: sequence, buttons: 0 })]);
  const sampled = fake.client.input.sample('sample-argument');
  assert.equal(sampled.buttons & 1, 1);
  const predicted = frame({ ...sampled, s: 1310 });
  fake.client.predictor.predict(predicted);
  Object.defineProperty(fake.client, 'remoteFrames', { get() { throw new Error('lost snapshots'); } });
  const outgoing = send(fake, [predicted])[0];
  assert.equal(outgoing.buttons & 1, 1);
  assert.match(h.api.runtime.error, /Aim hook: lost snapshots/);
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
  assert.equal(fake.sampled.buttons, 16 | 8);
  assert.equal(sampled.buttons & 1, 1);
  assert.equal(sampled.buttons & 2, 2);
  assert.equal(sampled.buttons & 16, 0);
  assert.equal(sampled.buttons & 64, 0);
  assert.equal(sampled.buttons & 8, 8);
  send(fake, [sampled]);
  assert.equal(h.api.runtime.target.index, 2);
  assert.ok(Math.abs(fake.sent.at(-1)[1][0].yaw) > Math.PI / 2);
  assert.equal(h.api.runtime.compensated, 0);
});

test('Rage prefers a nearer aim angle and honors the range slider beyond rangeEnd', () => {
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
  fake.client.remoteFrames = [{ snap: opponent(3, { p: [0, 0, -550] }) }];
  assert.equal(fake.client.input.sample('sample-argument').buttons & 1, 1,
    'weapon rangeEnd does not impose an extra client cutoff');
  fake.client.remoteFrames = [{ snap: opponent(3, { p: [0, -0.04, -600] }) }];
  assert.equal(fake.client.input.sample('sample-argument').buttons & 1, 1,
    'a target exactly 600 m from the firing eye is selectable');
  fake.client.remoteFrames = [{ snap: opponent(3, { p: [0, 0, -610] }) }];
  const outOfRange = fake.client.input.sample('sample-argument');
  assert.equal(outOfRange.buttons & 1, 0, 'the selected 600 m limit still applies');
  assert.equal(outOfRange.buttons & 2, 0, 'Rage releases scope without a target');
  assert.equal(outOfRange.buttons & 16, 16, 'sprint remains available while travelling');
  const gate = h.api.trace().fireGates.at(-1);
  assert.equal(gate.reason, 'no-target');
  assert.equal(gate.scan.closest.reason, 'range');
  assert.ok(gate.scan.closest.distance > 600);
});

test('Rage prefers a nearer weapon-range target over a distant target near the crosshair', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true, range: 600 });
  fake.client.predictor.activeStats.rangeEnd = 90;
  fake.client.remoteFrames = [
    { snap: opponent(1, { p: [0, 0, -250] }) },
    { snap: opponent(2, { p: [38, 0, -46] }) }
  ];
  fake.client.input.sample('sample-argument');
  assert.equal(h.api.runtime.sampleGate.target.index, 2);
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -250] }) }];
  fake.client.input.sample('sample-argument');
  assert.equal(h.api.runtime.sampleGate.target.index, 1,
    'long shots remain available when no closer target exists');
  h.api.destroy();
});

test('Rage scopes when a target appears and holds ADS through the weapon ramp', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true, stealth: true, rapidFire: true });
  const weapon = fake.client.predictor;
  weapon.ws.ads = 0;
  fake.client.remoteFrames = [];
  const waiting = fake.client.input.sample('sample-argument');
  assert.equal(waiting.buttons & 2, 0);
  assert.equal(waiting.buttons & 16, 16);
  assert.equal(waiting.buttons & 1, 0);
  fake.client.remoteFrames = [{ snap: opponent() }];
  weapon.ws.ads = 0.75;
  const ramping = fake.client.input.sample('sample-argument');
  assert.equal(ramping.buttons & 2, 2);
  assert.equal(ramping.buttons & 1, 0);
  for (let sequence = 960; sequence < 963; sequence++) {
    send(fake, [frame({ ...ramping, s: sequence })]);
  }
  weapon.ws.ads = 0.995;
  assert.equal(fake.client.input.sample('sample-argument').buttons & 1, 1);
  const counts = h.api.trace().counters.gateReasons;
  assert.equal(counts['no-target'], 1);
  assert.equal(counts['ads-ramp'], 1);
  assert.equal(counts['fire-sampled'], 1);
  h.api.destroy();
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

test('Rage keeps sprint available and releases automatic ADS during reload or empty reserve', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true, ammo: true });
  const predictor = fake.client.predictor;
  predictor.slots[0].mag = 0;
  const reload = fake.client.input.sample('sample-argument');
  assert.equal(reload.buttons & 32, 32);
  assert.equal(reload.buttons & (1 | 2), 0);
  assert.equal(reload.buttons & 16, 16);
  assert.equal(h.api.runtime.sampleGate.reason, 'reload');
  predictor.ws.reload = 1;
  const duringReload = fake.client.input.sample('sample-argument');
  assert.equal(duringReload.buttons & (1 | 2 | 32), 0);
  assert.equal(duringReload.buttons & 16, 16);
  predictor.ws.reload = 0;
  predictor.ammo.light = 0;
  const empty = fake.client.input.sample('sample-argument');
  assert.equal(empty.buttons & (1 | 2 | 32), 0);
  assert.equal(empty.buttons & 16, 16);
  assert.equal(h.api.runtime.sampleGate.reason, 'no-ammo');
  h.api.destroy();
});

test('ammo assist pulses Interact only for visible matching ammo below the reserve cap', () => {
  const h = harness();
  const fake = attach(h, rageClient({ target: { target: { kind: 'item', id: 'a1' } },
    loot: { items: new Map([['a1', { kind: 'ammo', ammo: 'light', amount: 30, pos: [0, 0, -1] }]]) } }));
  h.api.setOptions({ rage: true, ammo: true });
  const pickup = fake.client.input.sample('sample-argument');
  assert.equal(pickup.buttons & 64, 64);
  assert.equal(pickup.buttons & 1, 0);
  assert.equal(pickup.buttons & 16, 16);
  assert.equal(h.api.runtime.sampleGate.reason, 'ammo-pickup');
  assert.equal(h.api.trace().ammoPickups[0].reserveBefore, 50);
  assert.equal(h.api.trace().ammoPickups[0].amount, 30);
  assert.equal(send(fake, [pickup])[0].buttons & 64, 64);
  assert.equal(fake.client.input.sample('sample-argument').buttons & 64, 0,
    'the same item is not activated on every frame');
  fake.client.loot.items.get('a1').ammo = 'heavy';
  fake.client.target.target.id = 'a2';
  fake.client.loot.items.set('a2', { kind: 'ammo', ammo: 'heavy', amount: 30 });
  assert.equal(fake.client.input.sample('sample-argument').buttons & 64, 0);
  fake.client.loot.items.get('a2').ammo = 'light';
  fake.client.predictor.ammo.light = 240;
  assert.equal(fake.client.input.sample('sample-argument').buttons & 64, 0);
  fake.client.predictor.ammo.light = 20;
  assert.equal(fake.client.input.sample('sample-argument').buttons & 64, 64);
  h.api.setOptions({ ammo: false });
  fake.client.target.target.id = 'a3';
  fake.client.loot.items.set('a3', { kind: 'ammo', ammo: 'light', amount: 30 });
  assert.equal(fake.client.input.sample('sample-argument').buttons & 64, 0);
  h.api.destroy();
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
  assert.equal(points.length, 10);
  close(points[0][1], 1.66);
  close(points[9][1], 1.21);
  close(output.pitch, Math.atan2(1.21 - 1.62, Math.hypot(2, 10)));
  h.api.setOptions({ point: 'head' });
  points.length = 0;
  const blockedHead = send(fake, [frame({ s: 24 })])[0];
  assert.equal(points.length, 9, 'explicit Head searches inside the head but never tries the chest');
  assert.equal(blockedHead.buttons & 1, 0, 'a covered head is not replaced by a chest shot');
  h.api.setOptions({ point: 'chest' });
  points.length = 0;
  const clearChest = send(fake, [frame({ s: 25 })])[0];
  assert.equal(points.length, 1);
  assert.equal(clearChest.buttons & 1, 1);
});

test('a covered target records the first blocking world surface without changing Fire', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true, point: 'head', visibleOnly: true });
  let casts = 0;
  h.register(54145, {
    getCollisionWorld: () => ({ marker: 'world' }),
    hasLineOfSight: () => false,
    raycastWorld(world, origin, direction, maxDistance) {
      casts++;
      assert.equal(world.marker, 'world');
      close(Math.hypot(...direction), 1);
      assert.ok(maxDistance > 5);
      return { dist: 4, point: [0, 1, -4], normal: [0, 0, 1], material: 'concrete' };
    }
  });
  const sampled = fake.client.input.sample('sample-argument');
  assert.equal(sampled.buttons & 1, 0);
  assert.equal(casts, 1);
  const cover = h.api.trace().fireGates.at(-1).scan.closestCover;
  assert.equal(cover.preferredPart, 'head');
  assert.equal(cover.blocker.material, 'concrete');
  assert.equal(cover.blocker.distanceMeters, 4);
  assert.equal(h.api.trace().fireGates.at(-1).scan.coverCandidate, undefined);
  h.api.destroy();
});

test('a visible part of the requested head remains selectable behind cover', () => {
  const h = harness();
  const fake = attach(h);
  h.api.setOptions({ rage: true, point: 'head', visibleOnly: true });
  const points = [];
  h.register(54145, {
    getCollisionWorld: () => ({}),
    hasLineOfSight(world, origin, point) {
      points.push([...point]);
      return point[1] > 1.7;
    }
  });
  const output = send(fake, [frame()])[0];
  const target = h.api.trace().aimDecisions.at(-1).target;
  assert.equal(points.length, 2, 'a partially exposed head needs one extra visibility ray');
  assert.equal(output.buttons & 1, 1);
  assert.equal(target.aimPart, 'head');
  assert.equal(target.visibility, 'partial');
  close(target.point[1], 1.73);
  close(target.hitboxCenter[1], 1.66);
  close(output.pitch, Math.atan2(1.73 - 1.62, Math.hypot(2, 10)));
  assert.ok(target.point[1] < target.position[1] + target.bodyHeight,
    'the selected point stays inside the captured head hitbox');
  h.api.destroy();
});

test('a small diagonal head opening is used without changing the requested hitbox', () => {
  const h = harness();
  const fake = attach(h);
  h.api.setOptions({ rage: true, point: 'head', visibleOnly: true });
  h.register(54145, { getCollisionWorld: () => ({}),
    hasLineOfSight(world, origin, point) { return point[0] > 2.08 && point[1] > 1.72; } });
  const output = send(fake, [frame()])[0];
  const target = h.api.trace().aimDecisions.at(-1).target;
  assert.equal(output.buttons & 1, 1);
  assert.equal(target.aimPart, 'head');
  assert.equal(target.visibility, 'partial');
  assert.ok(target.point[0] > 2.08 && target.point[0] < 2.14);
  assert.ok(target.point[1] > 1.72 && target.point[1] < 1.8);
  h.api.destroy();
});

test('a side opening selects an interior head point without changing the requested part', () => {
  const h = harness();
  const fake = attach(h);
  h.api.setOptions({ rage: true, point: 'head', visibleOnly: true });
  const points = [];
  h.register(54145, {
    getCollisionWorld: () => ({}),
    hasLineOfSight(world, origin, point) {
      points.push([...point]);
      return point[0] > 2.05;
    }
  });
  const output = send(fake, [frame()])[0];
  const target = h.api.trace().aimDecisions.at(-1).target;
  assert.equal(points.length, 3);
  assert.equal(output.buttons & 1, 1);
  assert.equal(target.aimPart, 'head');
  assert.equal(target.visibility, 'partial');
  assert.ok(target.point[0] > 2.05 && target.point[0] < 2.14);
  assert.ok(Math.abs(target.point[2] + 10) < 0.14);
  h.api.destroy();
});

test('a fully visible head wins over a similarly placed partial opening', () => {
  const h = harness();
  const fake = attach(h);
  fake.client.remoteFrames = [
    { snap: opponent(1, { p: [2, 0, -10] }) },
    { snap: opponent(2, { p: [3, 0, -10] }) }
  ];
  h.api.setOptions({ rage: true, point: 'head', visibleOnly: true });
  h.register(54145, {
    getCollisionWorld: () => ({}),
    hasLineOfSight(world, origin, point) {
      return point[0] > 2.9 || point[1] > 1.7;
    }
  });
  const output = send(fake, [frame()])[0];
  const target = h.api.trace().aimDecisions.at(-1).target;
  assert.equal(output.buttons & 1, 1);
  assert.equal(target.index, 2);
  assert.equal(target.visibility, 'clear');
  h.api.destroy();
});

const physicsPath = process.env.XOX_CLIENT_PHYSICS ||
  path.join(__dirname, '..', 'research', '3ep-katvfqbjo.js');

test('captured weapon step accepts a shot before ADS completes', {
  skip: !fs.existsSync(physicsPath) && 'Captured game physics is optional for portable tests'
}, () => {
  const bytes = fs.readFileSync(physicsPath);
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'manifest.json'), 'utf8'))
    .files.find(entry => entry.file === '3ep-katvfqbjo.js').sha256;
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
  const kernel = bytes.toString('utf8');
  const startMarker = '"stepWeapon",0,', endMarker = ',"stormCircleAt",0';
  const start = kernel.indexOf(startMarker), end = kernel.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start);
  const stepWeapon = vm.runInNewContext(`(${kernel.slice(start + startMarker.length, end)})`, {
    te: 1 / 30, t: { Buttons: { Fire: 1, Aim: 2, Reload: 32 } },
    tG: () => 0, tU: () => [[0, 0, -1]], tn: () => 1
  });
  const state = { cooldown: 0, reload: 0, reloadTotal: 0, switching: 0,
    ads: 0, bloom: 0, burst: 0, trigger: false, shots: 0 };
  const weapon = { magSize: 30, reloadSeconds: 2, adsSeconds: 0.24,
    fireMode: 'auto', rpm: 760, recoilV: 0.5 };
  const player = { mode: 'ground', vault: 0, mantle: 0, sprinting: false,
    yaw: 0, pitch: 0 };
  const result = stepWeapon(state, weapon, { buttons: 3 }, player, 30, 90, 1, 0);
  assert.equal(result.fired, true);
  assert.ok(state.ads > 0 && state.ads < 1);
  assert.ok(state.cooldown > 0);
  const hipState = { cooldown: 0, reload: 0, reloadTotal: 0, switching: 0,
    ads: 0, bloom: 0, burst: 0, trigger: false, shots: 0 };
  const hipResult = stepWeapon(hipState, weapon, { buttons: 1 }, player, 30, 90, 1, 0);
  assert.equal(hipResult.fired, true, 'the captured kernel does not require Aim for Fire');
  assert.equal(hipState.ads, 0);
});

test('captured pre-ADS spread is corrected through the bounded outgoing path', {
  skip: !fs.existsSync(physicsPath) && 'Captured game physics is optional for portable tests'
}, () => {
  const bytes = fs.readFileSync(physicsPath);
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'manifest.json'), 'utf8'))
    .files.find(entry => entry.file === '3ep-katvfqbjo.js').sha256;
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
  const kernel = bytes.toString('utf8');
  const capturedFunction = name => {
    const start = kernel.indexOf(`function ${name}(`);
    const end = kernel.indexOf('function ', start + name.length + 10);
    assert.ok(start >= 0 && end > start);
    return kernel.slice(start, end);
  };
  const directions = vm.runInNewContext(['tl', 'tz', 'tW', 'tU'].map(capturedFunction).join('\n') + ';tU', {
    tt: Math.PI / 180, ta: (value, min, max) => Math.min(max, Math.max(min, value))
  });
  const weapon = { pellets: 1, pelletSpread: 0 };
  const h = harness();
  const fake = rageClient();
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -10] }) }];
  fake.client.predictor.ps.grounded = true;
  Object.assign(fake.client.predictor.ws, { ads: 0, bloom: 0, switching: 0 });
  Object.assign(fake.client.predictor.activeStats, {
    hipSpread: 3.2, adsSpread: 0.12, moveSpread: 1.6, rangeEnd: 90
  });
  let seed = 1;
  fake.client.predictor.predict = input => ({ eye: [0, 1.62, 0],
    weapon: { fired: true, dirs: directions(weapon, input.yaw, input.pitch, 4.8, seed) } });
  attach(h, fake);
  h.api.setOptions({ rage: true, stealth: true, rapidFire: true, hipFire: false, point: 'chest' });
  for (seed = 1; seed <= 64; seed++) {
    send(fake, [frame({ s: 7000 + seed * 2, buttons: 0 })]);
    const input = { ...fake.client.input.sample('sample-argument'), s: 7001 + seed * 2 };
    assert.equal(input.buttons & 1, 1, `seed ${seed} should reach prediction before ADS completes`);
    fake.client.predictor.predict(input);
    const output = send(fake, [input])[0];
    const ray = directions(weapon, output.yaw, output.pitch, 4.8, seed)[0];
    const distance = -10 / ray[2];
    assert.ok(ray[2] < 0 && Math.abs(distance * ray[0]) <= 0.25 &&
      1.62 + distance * ray[1] >= 0.9 && 1.62 + distance * ray[1] <= 1.52,
    `seed ${seed} should intersect the captured torso box`);
  }
  h.api.destroy();
});

test('captured shot seed selects correctable unscoped Longbow shots and scopes wider ones', {
  skip: !fs.existsSync(physicsPath) && 'Captured game physics is optional for portable tests'
}, () => {
  const bytes = fs.readFileSync(physicsPath);
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'manifest.json'), 'utf8'))
    .files.find(entry => entry.file === '3ep-katvfqbjo.js').sha256;
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
  const source = bytes.toString('utf8');
  const capturedFunction = name => {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('function ', start + name.length + 10);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
  };
  const kernel = vm.runInNewContext(
    ['ti', 'tl', 'tn', 'tz', 'tW', 'tU'].map(capturedFunction).join('\n') +
    ';({shotSeed:tn,mulberry32:tl,shotDirections:tU})',
    { tt: Math.PI / 180, ta: (value, min, max) => Math.min(max, Math.max(min, value)) }
  );
  const h = harness();
  const fake = rageClient();
  const predictor = fake.client.predictor;
  predictor.ps.grounded = true;
  predictor.index = 0;
  predictor.slots[0].weapon = 'longbow';
  Object.assign(predictor.ws, { ads: 0, bloom: 0, switching: 0, shots: 0 });
  Object.assign(predictor.activeStats, {
    hipSpread: 8, adsSpread: 0.1, moveSpread: 4
  });
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -30] }) }];
  fake.client.predictor.predict = input => ({ eye: [0, 1.62, 0], weapon: {
    fired: !!(input.buttons & 1),
    dirs: kernel.shotDirections({ pellets: 1 }, input.yaw, input.pitch, 12,
      kernel.shotSeed(predictor.seed, predictor.index, predictor.ws.shots + 1))
  } });
  attach(h, fake);
  h.api.attachClient(fake.client, kernel);
  h.api.setOptions({ rage: true, stealth: true, rapidFire: true,
    hipFire: true, hipRange: 40, point: 'head', range: 600 });
  let hip = 0, scoped = 0;
  for (let seed = 1; seed <= 96; seed++) {
    predictor.seed = seed;
    send(fake, [frame({ s: 10000 + seed * 2, buttons: 0 })]);
    const input = { ...fake.client.input.sample('sample-argument'), s: 10001 + seed * 2 };
    if (!(input.buttons & 1)) {
      assert.equal(input.buttons & 2, 2, 'wide samples use normal ADS');
      scoped++;
      continue;
    }
    assert.equal(input.buttons & 2, 0, 'safe samples do not request Aim');
    fake.client.predictor.predict(input);
    const output = send(fake, [input])[0];
    const decision = h.api.trace().aimDecisions.at(-1);
    const ray = kernel.shotDirections({ pellets: 1 }, output.yaw, output.pitch, 12,
      kernel.shotSeed(seed, predictor.index, predictor.ws.shots + 1))[0];
    const difference = decision.target.point.map((value, i) => value - decision.target.origin[i]);
    const travel = difference.reduce((sum, value, i) => sum + value * ray[i], 0);
    const miss = Math.hypot(...difference.map((value, i) => value - travel * ray[i]));
    assert.ok(miss < 0.001, `seed ${seed} should land on the locally selected Head point`);
    assert.equal(decision.sampled.hipSeeded, true);
    assert.equal(decision.target.aimPart, 'head');
    hip++;
  }
  assert.ok(hip > 10 && scoped > 10, `expected both modes, got hip ${hip}, ADS ${scoped}`);
  h.api.destroy();
});

test('captured single-projectile spread is inverted against the actual game function', {
  skip: !fs.existsSync(physicsPath) && 'Captured game physics is optional for portable tests'
}, () => {
  const bytes = fs.readFileSync(physicsPath);
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'manifest.json'), 'utf8'))
    .files.find(entry => entry.file === '3ep-katvfqbjo.js').sha256;
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected,
    'the optional physics bundle must match the captured public client');
  const kernel = bytes.toString('utf8');
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

test('captured eight-pellet spread lands a chest ray after outgoing correction', {
  skip: !fs.existsSync(physicsPath) && 'Captured game physics is optional for portable tests'
}, () => {
  const bytes = fs.readFileSync(physicsPath);
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'manifest.json'), 'utf8'))
    .files.find(entry => entry.file === '3ep-katvfqbjo.js').sha256;
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
  const kernel = bytes.toString('utf8');
  const capturedFunction = name => {
    const start = kernel.indexOf(`function ${name}(`);
    const end = kernel.indexOf('function ', start + name.length + 10);
    assert.ok(start >= 0 && end > start);
    return kernel.slice(start, end);
  };
  const pellets = vm.runInNewContext(['tl', 'tz', 'tW', 'tU'].map(capturedFunction).join('\n') + ';tU', {
    tt: Math.PI / 180, ta: (value, min, max) => Math.min(max, Math.max(min, value))
  });
  const weapon = { pellets: 8, pelletSpread: 3.6 };
  const h = harness();
  const fake = rageClient();
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -200] }) }];
  let seed = 1;
  fake.client.predictor.predict = input => ({ eye: [0, 1.62, 0],
    weapon: { fired: true, dirs: pellets(weapon, input.yaw, input.pitch, 3.2, seed) } });
  attach(h, fake);
  h.api.setOptions({ rage: true, point: 'chest', range: 600 });
  for (seed = 1; seed <= 32; seed++) {
    const input = frame({ s: 5000 + seed, yaw: 0, pitch: 0, buttons: 1 });
    fake.client.predictor.predict(input);
    const output = send(fake, [input])[0];
    const actual = pellets(weapon, output.yaw, output.pitch, 3.2, seed);
    assert.ok(actual.some(direction => {
      if (direction[2] >= 0) return false;
      const distance = -200 / direction[2];
      const x = distance * direction[0], y = 1.62 + distance * direction[1];
      return Math.abs(x) <= 0.25 && y >= 0.9 && y <= 1.52;
    }), `seed ${seed} should land at least one pellet in the captured torso box`);
  }
  h.api.destroy();
});

test('multiple projectile predictions center a pellet when their average misses the hitbox', () => {
  const h = harness();
  const fake = rageClient();
  fake.client.predictor.predict = () => ({
    eye: [0, 1.62, 0], weapon: { fired: true, dirs: [[0, 0, -1], [0.1, 0, -0.99]] }
  });
  attach(h, fake);
  const input = frame();
  fake.client.predictor.predict(input);
  send(fake, [input]);
  const decision = h.api.trace().aimDecisions.at(-1);
  assert.equal(decision.geometry.projectedPelletHitsInput, 0);
  assert.equal(decision.geometry.projectedPelletHitsOutgoing, 1,
    'centering one pellet lands a local ray that the average would miss');
  assert.ok(decision.geometry.predictedOutgoing.minMeters < 0.001);
  assert.equal(h.api.runtime.compensated, 1);
});

test('bounded stealth correction lands a predicted pellet without exceeding one turn', () => {
  const h = harness();
  const fake = rageClient();
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -200] }) }];
  fake.client.predictor.predict = () => ({
    eye: [0, 1.62, 0], weapon: { fired: true, dirs: [[0, 0, -1], [0.1, 0, -0.99]] }
  });
  attach(h, fake);
  h.api.setOptions({ rage: true, stealth: true, point: 'chest', range: 600 });
  const input = frame({ s: 24 });
  fake.client.predictor.predict(input);
  const output = send(fake, [input])[0];
  const decision = h.api.trace().aimDecisions.at(-1);
  assert.equal(output.buttons & 1, 1);
  assert.equal(decision.geometry.projectedPelletHitsInput, 0);
  assert.equal(decision.geometry.projectedPelletHitsOutgoing, 1);
  assert.ok(Math.abs(output.yaw) <= 8 * Math.PI / 180);
  assert.ok(Math.abs(output.pitch) <= 8 * Math.PI / 180);
  h.api.destroy();
});

test('multiple projectile correction keeps the average when it lands more pellets', () => {
  const h = harness();
  const fake = rageClient();
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -5] }) }];
  fake.client.predictor.predict = () => ({
    eye: [0, 1.62, 0], weapon: { fired: true, dirs: [[-0.02, 0, -1], [0.02, 0, -1]] }
  });
  attach(h, fake);
  const input = frame({ s: 26 });
  fake.client.predictor.predict(input);
  send(fake, [input]);
  const decision = h.api.trace().aimDecisions.at(-1);
  assert.equal(decision.geometry.projectedPelletHitsOutgoing, 2);
  assert.equal(decision.target.aimPart, 'head');
});

const runtimePath = process.env.XOX_CLIENT_RUNTIME ||
  path.join(__dirname, '..', 'research', 'turbopack-37jd2rjmtu1y9.js');

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
      context.s(['getCollisionWorld', 0, () => ({}), 'hasLineOfSight', 0, () => true,
        'raycastWorld', 0, () => null], 54145);
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
  assert.equal(api.runtime.physics.raycastWorld, sandbox.__existingPhysics.raycastWorld);
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
    { type: 'shot', t: 100, by: 0, weapon: 'sidearm', rarity: 'common',
      from: [0, 1, 0], dirs: [[0, 0, -1]] },
    { type: 'impact', t: 100, pos: [0, 1, -10], normal: [0, 0, 1], material: 'concrete' },
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
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.trace().serverEvents[0].shot)), {
    weaponId: 'sidearm', rarity: 'common', origin: [0, 1, 0],
    directions: [[0, 0, -1]], impacts: [{ point: [0, 1, -10],
      normal: [0, 0, 1], material: 'concrete' }]
  });
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

test('server snapshot compares acknowledged outgoing aim with server angles', () => {
  const h = harness();
  const fake = attach(h, fakeClient({ ingestEvents: snapshot => snapshot }));
  send(fake, [frame({ s: 77, buttons: 0, yaw: 0.2, pitch: -0.1 })]);
  fake.client.ingestEvents({ t: 105, me: { ack: 77, yaw: 0.22, pitch: -0.11 }, events: [] });
  const snapshot = h.api.trace().serverSnapshots.at(-1);
  assert.equal(snapshot.acknowledgedFrame.sequence, 77);
  close(snapshot.acknowledgedFrame.sentYaw, 0.2);
  close(snapshot.acknowledgedFrame.serverYawDifferenceDegrees, 0.02 * 180 / Math.PI);
  close(snapshot.acknowledgedFrame.serverPitchDifferenceDegrees, -0.01 * 180 / Math.PI);
  h.api.destroy();
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

test('explicit Head and Chest override Auto adaptation for every weapon', () => {
  const h = harness();
  const fake = attach(h, rageClient());
  h.api.setOptions({ rage: true, point: 'head', smartAim: true, range: 600 });
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -180], v: [5, 0, 0] }) }];
  fake.client.predictor.ps.vel = [4, 0, 0];
  for (const weapon of ['sniper', 'rifle', 'smg']) {
    fake.client.predictor.activeStats.class = weapon;
    fake.client.input.sample('sample-argument');
    assert.equal(h.api.runtime.sampleGate.target.aimPart, 'head', `${weapon} respects Head`);
    send(fake, [frame({ s: 1500 + ['sniper', 'rifle', 'smg'].indexOf(weapon), buttons: 1 })]);
    const decision = h.api.trace().aimDecisions.at(-1);
    assert.equal(decision.requestedPoint, 'head');
    assert.equal(decision.target.aimPart, 'head',
      `${weapon} sends Head on the wire`);
  }
  h.api.setOptions({ point: 'chest' });
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -20], v: [0, 0, 0] }) }];
  fake.client.predictor.ps.vel = [0, 0, 0];
  fake.client.input.sample('sample-argument');
  assert.equal(h.api.runtime.sampleGate.target.aimPart, 'chest');
  h.api.setOptions({ point: 'auto' });
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -80] }) }];
  fake.client.input.sample('sample-argument');
  assert.equal(h.api.runtime.sampleGate.target.aimPart, 'chest');
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -20] }) }];
  fake.client.input.sample('sample-argument');
  assert.equal(h.api.runtime.sampleGate.target.aimPart, 'head');
  h.api.setOptions({ smartAim: false });
  fake.client.remoteFrames = [{ snap: opponent(1, { p: [0, 0, -80] }) }];
  fake.client.input.sample('sample-argument');
  assert.equal(h.api.runtime.sampleGate.target.aimPart, 'head');
  h.api.setOptions({ smartAim: true });
  fake.client.remoteFrames = [
    { snap: opponent(1, { p: [0, 20, -40] }) },
    { snap: opponent(2, { p: [2, 0, -40] }) }
  ];
  fake.client.input.sample('sample-argument');
  assert.equal(h.api.runtime.sampleGate.target.index, 2,
    'a small yaw difference should not beat a large pitch correction');
  h.mount();
  assert.equal(h.controls.get('[name="smartAim"]').disabled, false);
  h.api.setOptions({ point: 'head' });
  assert.equal(h.controls.get('[name="smartAim"]').disabled, true);
  h.api.destroy();
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
  fake.client.sentAt = new Map([[41, 900]]);
  fake.client.rtt = 80;
  fake.client.ingestEvents({ t: 100, me: { ack: 41, active: 0,
    slots: [{ weapon: 'vanguard', mag: 29 }], ads: 0.9,
    ammo: { light: 150, heavy: 20 },
    pos: [0, 0, 0], vel: [1, 0, 0], health: 100 }, events: [
    { t: 100, by: 0, type: 'shot' },
    { t: 100, by: 0, type: 'hit', damage: 12 }
  ] });
  state.emit('kicked', 'aim assistance was detected');
  const trace = h.api.trace();
  assert.equal(trace.match, 1);
  assert.equal(trace.frames.at(-1).sequence, 41);
  assert.deepEqual(Array.from(trace.frames.at(-1).before), [0, 0, 1, 1]);
  assert.equal(trace.frames.at(-1).after[0], outgoing.yaw);
  assert.equal(trace.aimDecisions.at(-1).sequence, 41);
  assert.equal(trace.aimDecisions.at(-1).targetDistance > 10, true);
  assert.equal(trace.aimDecisions.at(-1).target.origin.length, 3);
  assert.equal(trace.aimDecisions.at(-1).geometry.outgoingAim.centerOffsetMeters < 1, true);
  assert.deepEqual(Array.from(trace.serverEvents, event => event.type), ['shot', 'hit']);
  assert.equal(trace.serverEvents.at(-1).snapshotTick, 100);
  assert.equal(trace.serverSnapshots.at(-1).ack, 41);
  assert.equal(trace.serverSnapshots.at(-1).weaponId, 'vanguard');
  assert.deepEqual({ ...trace.serverSnapshots.at(-1).server.ammo }, { light: 150, heavy: 20 });
  assert.equal(trace.serverSnapshots.at(-1).ackLatencyMs, 100);
  assert.equal(trace.counters.serverSnapshotsSeen, 1);
  assert.equal(trace.counters.highestAckByMatch[1], 41);
  assert.equal(trace.settings.some(setting => setting.reason === 'match-start'), true);
  assert.equal(trace.settings.at(-1).values.silent, false,
    'the trace records the post-rejection settings transition');
  assert.equal(trace.connectionStates.at(-1).errorKind, 'aim-assistance');
  assert.equal(trace.connectionStates.at(-1).error, undefined,
    'raw connection errors are not included in shared traces');
  assert.equal(trace.kicks.at(-1).lastSequence, 41);
  assert.equal(JSON.stringify(trace).includes('test-match'), false, 'match identifiers stay out of the trace');
  const exported = JSON.parse(h.api.exportTrace());
  assert.equal(exported.formatVersion, 2);
  assert.equal(exported.scriptVersion, '1.5.20');
  assert.equal(exported.trace.kicks.at(-1).lastSequence, 41);
  assert.equal(JSON.stringify(exported).includes('test-match'), false);
  trace.frames[0].before[0] = 999;
  trace.aimDecisions[0].target.origin[0] = 999;
  assert.equal(h.api.trace().frames[0].before[0], 0, 'callers cannot mutate retained evidence');
  assert.equal(h.api.trace().aimDecisions[0].target.origin[0], 0,
    'callers cannot mutate retained shot geometry');
  for (let batch = 0; batch < 17; batch++) {
    const frames = Array.from({ length: 256 }, (_, index) =>
      frame({ s: batch * 256 + index, buttons: 0 }));
    send(fake, frames);
  }
  assert.equal(h.api.trace().frames.length, 4096);
  assert.equal(h.api.trace().frames.at(-1).sequence, 4351);
  assert.equal(h.api.trace().retention.dropped.frames, 257,
    'the export reports older frames displaced by the bounded buffer');
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
  assert.equal(payload.scriptVersion, '1.5.20');
  assert.equal(payload.trace.match, 0);
  h.api.destroy();
});

test('active matches save bounded trace snapshots locally and Saved exports the archive', async () => {
  const archive = archiveDbHarness();
  let now = 1000;
  const h = harness([], undefined, { indexedDB: archive.indexedDB, now: () => now });
  const fake = attach(h);
  h.mount();
  h.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(archive.records.size, 1);
  let payload = JSON.parse(await h.api.latestArchivedTrace());
  assert.equal(payload.trace.match, 1);
  assert.equal(payload.trace.frames.length, 0);
  send(fake, [frame({ s: 99, buttons: 0 })]);
  now += 16000;
  h.tick();
  await new Promise(resolve => setImmediate(resolve));
  payload = JSON.parse(await h.api.latestArchivedTrace());
  assert.equal(payload.trace.frames.at(-1).sequence, 99);
  await h.controls.get('[data-download-archive]').events.get('click')();
  assert.equal(h.downloads.length, 1);
  assert.equal(JSON.parse(await h.createdBlobs[0].text()).trace.frames.at(-1).sequence, 99);
  assert.equal(h.api.inspect().archive.error, null);
  h.api.destroy();
});

test('new pages start the combat agent and migrate legacy settings without reviving rejected aim', () => {
  for (const saved of [undefined, { silent: true, rage: true, xray: false, loot: false, range: 120, fov: 25, smooth: 0.1 }]) {
    const h = harness([], saved);
    assert.equal(h.api.options.silent, true);
    assert.equal(h.api.options.rage, true);
    assert.equal(h.api.options.agent, true);
    h.api.setOptions({ rage: false });
    assert.equal(h.api.options.rage, false);
    assert.equal(h.api.options.agent, false);
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
  const rejected = harness([], { silent: false, rage: false, agent: false });
  assert.equal(rejected.api.options.silent, false);
  assert.equal(rejected.api.options.rage, false);
  assert.equal(rejected.api.options.agent, false);
  rejected.api.destroy();
  const disabled = harness([], { settingsRevision: 3, silent: true, rage: true, agent: false });
  assert.equal(disabled.api.options.agent, false);
  disabled.api.setOptions({ agent: true });
  assert.equal(disabled.api.options.agent, true);
  const persisted = JSON.parse([...disabled.storage.values()][0]);
  assert.equal(persisted.settingsRevision, 3);
  disabled.api.destroy();
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
    assert.equal(h.api.options.agent, false);
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
  h.controls.get('[data-hide-panel]').events.get('click')();
  assert.equal(panel.hidden, true);
  assert.equal(showButton.hidden, false);
  showButton.events.get('click')();
  assert.equal(panel.hidden, false);
  assert.equal(showButton.hidden, true);
  h.api.destroy();
});

test('the panel leaves gameplay keys alone and Resume restores pointer lock', () => {
  let lockRequests = 0;
  const canvas = { requestPointerLock() { lockRequests++; } };
  const h = harness();
  attach(h, fakeClient({ canvas }));
  h.mount();
  assert.equal(h.rootListeners.has('keydown'), false);
  assert.equal(h.rootListeners.has('keyup'), false);
  const gameplayKey = { type: 'keydown', code: 'KeyF', repeat: false,
    target: { tagName: 'CANVAS' }, composedPath: () => [canvas] };
  h.windowListeners.get('keydown')(gameplayKey);
  assert.equal(h.api.trace().interactions.at(-1).key, 'KeyF');
  assert.equal(h.api.trace().interactions.at(-1).pointerLocked, false);
  h.controls.get('[data-resume-game]').events.get('click')();
  assert.equal(lockRequests, 1);
  h.controls.get('[data-hide-panel]').events.get('click')();
  assert.equal(lockRequests, 2);
  h.document.pointerLockElement = canvas;
  h.listeners.get('pointerlockchange')();
  h.windowListeners.get('keyup')({ ...gameplayKey, type: 'keyup' });
  assert.equal(h.api.trace().interactions.at(-2).phase, 'pointerlockchange');
  assert.equal(h.api.trace().interactions.at(-1).pointerLocked, true);
  h.controls.get('[data-resume-game]').events.get('click')();
  assert.equal(lockRequests, 2, 'no new request is needed while locked');
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
    assert.equal(h.api.options.rage, true);
    assert.equal(h.api.options.agent, true);
    assert.equal(h.api.options.xray, true);
    assert.equal(h.api.options.loot, true);
    assert.equal(h.api.options.range, 600);
  }
  assert.deepEqual([...h.storage.values()], stored);
  for (const patch of [null, undefined, 'invalid', 42]) assert.doesNotThrow(() => h.api.setOptions(patch));
  assert.equal(h.api.options.silent, true);
  h.api.destroy();
});
