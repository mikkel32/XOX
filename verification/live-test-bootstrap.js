// Developer-only attachment for a game already loaded before the userscript.
(() => {
  const id = 'bridgezone-local-rage-test-v11';
  const path = 'static/chunks/bridgezone-local-rage-test-v11.js';
  window.TURBOPACK.push([path, id, context => {
    const physics = context.i(54145);
    for (const canvas of document.querySelectorAll('canvas')) {
      let fiber = canvas[Object.keys(canvas).find(key => key.startsWith('__reactFiber'))];
      for (let depth = 0; fiber && depth < 15; depth++, fiber = fiber.return) {
        for (let hook = fiber.memoizedState, count = 0; hook && count < 60; hook = hook.next, count++) {
          const client = hook.memoizedState?.current;
          if (!client?.connection || !client.remoteFrames || !client.engine) continue;
          window.__bridgeZoneTools.attachClient(client, physics);
          const evidence = {
            shots: 0, hits: 0, headshots: 0, kills: 0, damage: 0,
            events: [], startedAt: new Date().toISOString()
          };
          window.__zoneRageEvidence = evidence;
          const seen = new Set();
          window.__zoneStopEvidence = client.connection.onSnapshot(snapshot => {
            for (const event of snapshot.events || []) {
              if (event.by !== client.you) continue;
              const key = JSON.stringify(event);
              if (seen.has(key)) continue;
              seen.add(key);
              if (event.type === 'shot') evidence.shots++;
              if (event.type === 'hit') {
                evidence.hits++;
                evidence.damage += event.damage || 0;
                if (event.head) evidence.headshots++;
              }
              if (event.type === 'kill') evidence.kills++;
              if (evidence.events.length < 500) evidence.events.push(event);
            }
          });
          return;
        }
      }
    }
  }]);
  window.TURBOPACK.push([path, { otherChunks: [], runtimeModuleIds: [id] }]);
})();
