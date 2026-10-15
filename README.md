# XOX

BridgeZone client tools and reproducible findings from private bot-match tests.
This repository contains a Tampermonkey userscript, an unpacked Microsoft Edge
extension built from the same source, local tests, and the saved JSON traces.

> [!IMPORTANT]
> **Current version: 1.5.14.** The portable local suite reports 80 passes and 6
> skips without the optional captured client archive. Live traces include both server anti-cheat
> removals and short matches without one. They do **not** prove a general bypass.

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
| Silent AIM | Redirects outgoing firing frames while preserving the local camera and movement. Filters teammates, spectators, dead or downed players, range, and cover. |
| Rage | Selects a clear target across 360 degrees up to the range slider, scopes when a target is available, and fires after aim alignment. It normally waits for full ADS; Fast fire can take a correctable close shot sooner. Explicit Head and Chest choices are respected for every weapon. Auto can adapt between head and chest for distant or moving targets. Target choice weighs turn, target speed, and distance against the active weapon's damage-falloff range without imposing a hard cutoff. Once a shot is predicted, the send path keeps Fire and reuses its sampled target if the current target disappears or changes substantially, to avoid desynchronizing shot state. Sprint remains available without a target, during reload, or with an empty magazine. Server reach and hit validation still apply. |
| Fast fire | Skips XOX's local stealth delay and added aim jitter when Rage is enabled. It can request a close single-projectile shot during ADS ramp when a conservative spread bound fits inside the existing 8-degree outgoing turn. It still follows local aim alignment, weapon cooldown, and server ammunition. |
| Shot correction | Adjusts outgoing aim for a predicted single-projectile deviation. For multi-pellet weapons, it tests the average and each pellet offset against the selected hitbox, then uses the angle predicted to intersect it with the most pellets. Server spread and visible camera recoil may remain. |
| Ammo assist | Requests a normal reload and pulses Interact when the game's own pickup target is compatible ammo below the observed reserve cap. It never changes the local or server ammo count directly. |
| Trace export | Saves bounded per-shot target geometry, movement, weapon and ADS state, predicted ray deviation and pellet intersections, early-ADS shot status, aiming changes, settings, fire gates, F/E and pointer-lock state, button changes before send, server input acknowledgements, and combat events. |

F8 toggles Xray, F9 toggles Silent AIM, and Insert toggles the panel. **Show tools**
reopens it on keyboards without Insert. Settings persist locally and synchronize
between tabs. In 1.5.13, Xray, loot vision, Silent AIM, Adaptive Auto point, and Stealth start enabled;
Rage starts disabled unless saved settings override them. Fast fire is enabled
for Rage when it is turned on. After an aim-related
server removal, Aim and Rage are disabled and remain off across the next match.
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
The portable local suite passed **80 tests with 6 skips** on 2026-10-15. Six
tests use locally captured client bundles that are intentionally not mirrored
here. Tests validate local behavior and
fixtures, not a live server outcome.
Set `XOX_CLIENT_PHYSICS` to a local copy of the captured
`3ep-katvfqbjo.js` bundle to run the optional firing and spread checks. Each test
requires its SHA-256 to match the recorded [source manifest](research/manifest.json).

### Read a diagnostic trace

Click **Save trace** before leaving the match, then run:

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
server ADS and magazine state, and predictor state before reconciliation. The
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
| 1.5.14 | No live trace yet | Fast fire can request a close single-projectile shot before full ADS when a conservative spread bound fits inside the 8-degree outgoing turn. The captured client accepts Fire before ADS completes, and a 64-seed local replay landed the corrected ray inside the captured torso box. Server fire timing and hits await a new trace. |

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
releases its automatic ADS request while reloading; continuous scoped movement
still follows the game's speed rule. Neither perfect hits nor zero spread are
established by local geometry or tests.

The [source manifest](research/manifest.json) records the 39 public client files
examined, with source URLs and SHA-256 hashes. Their third-party JavaScript is
not republished here. Raw screenshots remain local because some reveal private
lobby invite URLs and browser context. The JSON receipts and all original project
code are included. This is an independent project and does not claim affiliation
with BridgeGame.
