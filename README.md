# XOX

BridgeZone client tools and reproducible findings from private bot-match tests.
This repository contains a Tampermonkey userscript, an unpacked Microsoft Edge
extension built from the same source, local tests, and the saved JSON traces.

> [!IMPORTANT]
> **Current version: 1.5.20.** All 109 local tests pass with the captured client bundles. Checks cover combat-agent input, trace archiving, and server-reported ray comparison on provisional shot pairs. The agent has not yet been tested in a live match. Server-side zero spread is not established by client-side correction.

## Explore

| Area | What is here |
| --- | --- |
| [Findings](FINDINGS.md) | Version-by-version results, trace hashes, and limits of the evidence |
| [Userscript](bridgezone-tools.user.js) | The editable source for both installation routes |
| [Edge extension](extension/) | Manifest V3 package that runs at `document_start` in the page's `MAIN` world |
| [Tests](tests/) | Input, targeting, cleanup, trace, and extension packaging checks |
| [Trace receipts](verification/) | JSON exports of observed client inputs and server events |
| [Source manifest](research/manifest.json) | URLs, sizes, and hashes of captured public client bundles |

## Features

| Tool | Behavior |
| --- | --- |
| Xray | Draws player boxes, names, and distances, including opponents behind cover when they are present in client snapshots. |
| Loot vision | Marks nearby weapons, ammo, and unopened crates. Ammo for the active weapon appears first. |
| Silent AIM | Redirects outgoing firing frames while preserving the local camera and movement. Filters teammates, spectators, dead or downed players, range, and cover. When a hitbox center is covered, it checks interior edge and diagonal points for a clear shot within the requested hitbox. |
| Rage | Selects a clear target across 360 degrees up to the range slider and fires after aim alignment. Hip fire is limited to stationary single-projectile shots within 40 m; moving, wider, and distant shots use ADS. Explicit Head and Chest choices remain exact. Auto can adapt between head and chest. A predicted shot keeps Fire on the wire to avoid desynchronizing shot state. Sprint remains available without a target, during reload, or with an empty magazine. Server reach and hit validation still apply. |
| Combat agent | On by default with Silent AIM and Rage. It uses normal movement and action inputs to approach opponents, stop and settle before firing, move toward the safe zone, and seek compatible ammo when empty. Its short route probe checks the captured movement collision grid, body clearance, low steps, and terrain slopes; when every full route is blocked, it can take a shorter clear corridor. A stalled route takes a timed flank and checks actual goal progress. Your movement or action keys override its movement. It does not start matches or guarantee a win. |
| Fast fire | Skips XOX's local stealth delay and added aim jitter when Rage is enabled. It can request a close single-projectile shot during ADS ramp when a conservative spread bound fits inside the existing 8-degree outgoing turn. It still follows local aim alignment, weapon cooldown, and server ammunition. |
| Adaptive hip fire | Enabled for Rage by default up to 40 m. It requires a grounded, nearly stationary player and a bounded single-projectile correction. If the server's acknowledged shot count differs from the predicted count, it falls back to ADS. The 40 m limit follows the new live trace: longer unscoped shots missed in the paired sample. This does not zero server spread. |
| Shot correction | Adjusts outgoing aim for a predicted single-projectile deviation. For multi-pellet weapons, it tests the average and each pellet offset against the selected hitbox, then uses the angle predicted to intersect it with the most pellets. Server spread and visible camera recoil may remain. |
| Ammo assist | Requests a normal reload and pulses Interact when the game's own pickup target is compatible ammo below the observed reserve cap. It never changes the local or server ammo count directly. |
| Trace archive and export | Automatically saves bounded trace snapshots to browser IndexedDB every 15 seconds during a match, at match end, and on detach. Keeps the latest three local sessions; **Saved** downloads the latest archive even after a page reload. Traces include per-shot geometry, movement, weapon and ADS state, selected-point visibility, agent actions, server shot-count and acknowledged-angle comparisons, server-reported shot directions and impacts, first blocking world surfaces for cover rejections, settings, fire gates, F/E state, button changes, acknowledgements, and combat events. The analyzer marks shot pairs provisional. |

F8 toggles Xray, F9 toggles Silent AIM, and Insert toggles the panel. **Show tools**
reopens it on keyboards without Insert. Settings persist locally and synchronize
between tabs. Xray, loot vision, Silent AIM, Rage, combat agent, Adaptive Auto point, and Stealth start enabled. Existing ordinary settings receive a one-time migration to this default; a saved aim rejection remains off. Fast fire and adaptive hip fire are enabled. After an aim-related
server removal, Silent AIM, Rage, and the combat agent are disabled and remain
off across the next match.
F/E interaction takes priority over automatic aim and fire. Use **Resume** in the
panel after changing settings to restore the game's pointer lock.

## Install

### Edge: unpacked extension

1. Open `edge://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select this repository's [`extension/`](extension/) directory, which contains
   `manifest.json`.
3. Refresh the Zone page. Keep the Tampermonkey variant disabled on that page so
   the two copies do not compete.

For automatic development updates, run `node extension/build-extension.mjs --watch`
in the repository folder. It builds on changes and serves a loopback-only status
endpoint. An open Zone tab checks that endpoint through the extension, reloads
the extension after a successful build, and then refreshes the tab. Keep the
builder running while editing. The popup shows whether it is connected and has
a manual **Reload now** fallback. Edge also supports **Reload** on the extension
card as a [local update flow](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading). If the builder is stopped, refresh Zone after a manual reload.

### Tampermonkey

Open Tampermonkey Dashboard > Utilities > **Import from file**, select
[`bridgezone-tools.user.js`](bridgezone-tools.user.js), enable it, and refresh
Zone. Tampermonkey runs the installed script in each matching new tab. If Edge
blocks userscripts, follow [Tampermonkey's permission instructions](https://www.tampermonkey.net/faq.php#Q209).

## Build and verify

```sh
node extension/build-extension.mjs
node extension/build-extension.mjs --check
node --check bridgezone-tools.user.js
node --check extension/loader.js
node --check extension/bridgezone-main.js
node --check extension/dev-background.js
node --check extension/dev-reload.js
node --test tests/*.test.cjs
```

`extension/build-extension.cmd` is a Windows wrapper and
`extension/build-extension.sh` is a shell wrapper. Both accept `--check` or
`--watch`. The builder binds only to `127.0.0.1:43187`; it does not expose a
remote build endpoint. The extension's localhost permission is used only to
read build status while a Zone tab or popup is open.

The generated `extension/bridgezone-main.js` should exactly match the userscript.
The portable suite passes 98 tests and skips 7 that need locally captured
client bundles. Tests validate local behavior and fixtures, not a live server
outcome.
Set `XOX_CLIENT_PHYSICS` to a local copy of the captured
`3ep-katvfqbjo.js` bundle to run the optional firing and spread checks, and
`XOX_CLIENT_RUNTIME` to the captured `turbopack-37jd2rjmtu1y9.js` bundle to
run the optional loader checks. With both bundles, all 105 tests pass.
The physics tests require the bundle's SHA-256 to match the recorded
[source manifest](research/manifest.json).

### Read a diagnostic trace

Traces save automatically during play in browser storage. Click **Saved** to download the latest archive, including after a page reload; **Save** exports the current in-memory trace. Then run:

```sh
node verification/analyze-trace.mjs "C:\path\to\bridgezone-trace.json"
```

Add `--json` to produce a machine-readable report. Format v2 records why Rage
held Fire (`no-target`, `ads-ramp`, `cooldown`, `aim-hold`, or ammunition), the
closest rejected target and rejection reason, sample-to-send target changes,
settings changes, weapon and local player state, input and outgoing aim, and predicted projectile
distance from the selected aim point before and after correction. Retention
limits and dropped counts reveal when older observations have rolled out of the
buffer. Server snapshots also record input ACK sequence, observed ACK latency,
server ADS and magazine state, acknowledged yaw and pitch differences, and predictor state before reconciliation. Cover rejections include the first client-world blocking surface along the preferred hitbox-center ray. The
new interaction records show F/E key presses, pointer lock, and input-enabled
state without storing unrelated keys. Frame records distinguish sampled buttons
from the buttons finally sent to the server. The
report groups **outgoing Fire** by weapon, selected range, and movement, with
ACK coverage and server event totals shown separately. An ACK establishes that
an input sequence was covered; it does not prove a shot fired or hit. Server
combat events do not have a guaranteed input sequence, so the report does not
claim per-weapon hit rates. The analyzer separates missing local shot predictions
during recorded weapon cooldown from those without cooldown. New traces also
record automatic ammo pickup requests and server reserve increases separately;
they do not establish which request caused a reserve change. It also counts
retained locally predicted shots whose Fire bit was removed before send, and
shows requested versus selected aim points for each weapon. For multi-pellet
weapons, it summarizes local projected hitbox intersections before and after
correction; these are predictions rather than server-confirmed hits.
For own-player shots, 1.5.19 also captures server-reported ray directions,
origins, and subsequent impact positions. The analyzer rotates locally
predicted rays into the final outgoing aim and compares directions only for
unambiguously paired shots with compatible weapon and pellet count. It reports
angular differences and whether an impact was closer than the locally selected
point. These are diagnostic observations from server events, not proof of an
authoritative zero-spread setting or an individual hit.
Only allowlisted game-state fields are exported; match IDs and raw connection
errors are omitted. Older format v1 exports remain readable by the analyzer.

## Observed results

| Version | Server-confirmed result | Match outcome |
| --- | --- | --- |
| 1.4.0 | 11 shots, 4 hits, 54.6 damage | Removed for detected aim assistance; summary receipt only |
| 1.5.1 | No authoritative counter saved | Removed for detected aim assistance |
| 1.5.3 | 44 shots, 8 hits, 1 kill | Removed for detected aim assistance; [trace](verification/live-trace-v1.5.3-2026-10-15.json) |
| 1.5.4 | 19 shots, 13 hits, 2 kills; then 51 shots, 14 hits in a separate match | No kick before bot elimination in either bounded match; [first](verification/live-trace-v1.5.4-2026-10-15.json), [second](verification/live-trace-v1.5.4-active-2026-10-15.json) |
| 1.5.5 | 1 shot, 1 hit | Short match, no recorded kick; [two exports](verification/live-trace-v1.5.5-2026-10-15.json) from the **same** match |
| 1.5.6 | 88 shots, 27 hits, 6 kills | User-supplied trace from mixed weapons; no recorded kick. Its raw export is not mirrored here; see [findings](FINDINGS.md). |
| 1.5.7 | No live trace yet | Local tests cover range selection, continuous ADS input, moving-shot correction, and diagnostic export. Server hit rate, physical weapon range, and camera recoil remain unverified. |
| 1.5.8 | 0 shots, 0 hits | User-supplied trace recorded 202 alignment holds after ADS, with no outgoing Fire. No recorded kick; see [findings](FINDINGS.md). |
| 1.5.9 | 351 shots, 82 hits, 13 kills | User-supplied mixed-weapon trace; no recorded kick. F/E reached outgoing input. Saved Head targeting stayed active at long range, and Rage scoped during reload. Raw export is not mirrored; see [findings](FINDINGS.md). |
| 1.5.10 | 520 shots, 117 hits, 12 kills | User-supplied trace with Smart Rage aim and three automatic ammo pickup requests; no recorded kick. Retained input shows 11 locally predicted shots whose Fire bit was removed before send. Raw export is not mirrored; see [findings](FINDINGS.md). |
| 1.5.11 | 378 shots, 138 hits, 15 kills | User-supplied trace with no recorded kick. Head was selected, but 481 of 512 retained Fire decisions chose chest, including 15 of 17 Longbow decisions. No Fire removals occurred in the retained pre-send frames; raw export is not mirrored. |
| 1.5.12 | No live trace yet | Explicit Head and Chest now stay exact for all weapons; only Auto adapts to movement and range. The analyzer reports requested versus selected aim points. Local tests pass; server headshots and hit rate await a new trace. |
| 1.5.13 | No live trace yet | Optimizes predicted multi-pellet aim for hitbox intersections while preserving single-projectile correction and the existing fire cadence. Replay of three retained Breacher predictions changed each from zero to one locally projected pellet intersection; server effect awaits a new trace. |
| 1.5.14 | 188 shots, 83 hits, 53 head hits, 24 kills | User-supplied mixed-weapon match; no recorded kick. All retained outgoing Fire decisions selected Head. The guarded early-ADS path was not used in retained decisions, and moving shots show a provisional hit gap. Raw export is not mirrored; see [findings](FINDINGS.md). |
| 1.5.15 | 241 shots, 68 hits, 44 head hits, 12 kills | User-supplied mixed-weapon match; no recorded kick. 13 of 503 retained Fire decisions selected a partially visible point. All retained shots used ADS, so this trace cannot measure hip fire. Raw export is not mirrored; see [findings](FINDINGS.md). |
| 1.5.16 | 382 shots, 70 hits, 36 head hits, 11 kills | User-supplied mixed-weapon trace. Tick-aligned provisional pairs with retained decisions show 0/47 long-range hip hits at 100–149 m, 1/21 moving hip hits under 40 m, 2/3 still hip hits under 40 m, and 37/121 ADS hits. Pairing uses an inferred nine-tick offset and cannot prove individual causation. Raw export is not mirrored. |
| 1.5.17 | No live trace yet | Caps hip fire to stationary shots within 40 m, adds acknowledged shot-count diagnostics and an opt-in combat agent. Local tests pass; server hit rate and live agent behavior need a new trace. |
| 1.5.18 | No live trace yet | Enables the combat agent by default, tests extra hitbox interior points near cover, archives traces locally during play, and records acknowledged aim and cover blockers. Local tests pass; live hit rate and navigation remain unverified. |
| 1.5.19 | No live trace yet | Adds server-reported shot directions and ordered impacts to trace exports, plus provisional server/local ray comparison. Requires a new live trace to test actual ray agreement. |
| 1.5.20 | No live trace yet | Routes around movement collision boxes that can pass bullets, handles low steps and slopes, uses shorter clear corridors, and holds a flank through stalls. Local tests cover blocker, step, partial route, and stall cases; live navigation and server shot results need a new trace. |

See [FINDINGS.md](FINDINGS.md) for the trace checksums, method, interpretation,
and what remains unverified.

## Scope and provenance

The browser client sends `zone:input` frames and receives a `zone:kicked` event
when the server rejects a match. The server's detector and authoritative physics
are not in this repository. A visible local tracer can follow the unmodified
camera even when an outgoing frame changes; server-confirmed events are the
meaningful result. The client contract may also change after the 2026-10-08
capture used to develop these hooks.

Ammo and ADS movement speed are decided by the server. The client exposes
pickup and reload inputs, but no supported request for unlimited reserve or
full-speed ADS movement. Ammo assist gathers available ammunition, and Rage
releases its automatic ADS request while reloading. Adaptive hip fire removes
the Aim input on selected shots, so movement uses the unscoped rule for those
frames; other scoped frames still follow the game's speed rule. Neither perfect hits nor zero spread are
established by local geometry or tests.

The [source manifest](research/manifest.json) records the 39 public client files
examined, with source URLs and SHA-256 hashes. Their third-party JavaScript is
not republished here. Raw screenshots remain local because some reveal private
lobby invite URLs and browser context. The JSON receipts and all original project
code are included. This is an independent project and does not claim affiliation
with BridgeGame.
