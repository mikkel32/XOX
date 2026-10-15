# XOX

BridgeZone client tools and reproducible findings from private bot-match tests.
This repository contains a Tampermonkey userscript, an unpacked Microsoft Edge
extension built from the same source, local tests, and the saved JSON traces.

> [!IMPORTANT]
> **Current version: 1.5.5.** The portable local suite reports 48 passes and 3
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
| Loot vision | Marks nearby weapons and unopened crates by rarity. |
| Silent AIM | Redirects outgoing firing frames while preserving the local camera and movement. Filters teammates, spectators, dead or downed players, range, and cover. |
| Rage | Selects a clear target across 360 degrees, aims down sights, fires, and requests normal reloads from available reserve ammo. |
| Trace export | Saves bounded outgoing frames, local predictions, server events, and connection changes from the panel. |

F8 toggles Xray, F9 toggles Silent AIM, and Insert toggles the panel. **Show tools**
reopens it on keyboards without Insert. Settings persist locally and synchronize
between tabs. In 1.5.5, Xray, loot vision, Silent AIM, and Stealth start enabled;
Rage starts disabled unless saved settings override them. After an aim-related
server removal, Aim and Rage are disabled and remain off across the next match.

## Install

### Edge: unpacked extension

1. Open `edge://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select this repository's [`extension/`](extension/) directory, which contains
   `manifest.json`.
3. Refresh the Zone page. Keep the Tampermonkey variant disabled on that page so
   the two copies do not compete.

After editing the source, build the extension and open its toolbar popup to click
**Reload extension**, then refresh Zone. The popup cannot write files in the
repository; run the build command locally first. Edge also supports **Reload**
on the extension card as a [local update flow](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading).

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
node --test tests/*.test.cjs
```

`extension/build-extension.cmd` is a Windows wrapper and
`extension/build-extension.sh` is a shell wrapper. Both accept `--check` or
`--watch`. Watch mode rebuilds after source edits; use the popup's reload button
and refresh Zone to load each new build.

The generated `extension/bridgezone-main.js` should exactly match the userscript.
The portable local suite passed **48 tests with 3 skips** on 2026-10-15. Three
tests use locally captured client bundles that are intentionally not mirrored
here. Tests validate local behavior and
fixtures, not a live server outcome.

## Observed results

| Version | Server-confirmed result | Match outcome |
| --- | --- | --- |
| 1.4.0 | 11 shots, 4 hits, 54.6 damage | Removed for detected aim assistance; summary receipt only |
| 1.5.1 | No authoritative counter saved | Removed for detected aim assistance |
| 1.5.3 | 44 shots, 8 hits, 1 kill | Removed for detected aim assistance; [trace](verification/live-trace-v1.5.3-2026-10-15.json) |
| 1.5.4 | 19 shots, 13 hits, 2 kills; then 51 shots, 14 hits in a separate match | No kick before bot elimination in either bounded match; [first](verification/live-trace-v1.5.4-2026-10-15.json), [second](verification/live-trace-v1.5.4-active-2026-10-15.json) |
| 1.5.5 | 1 shot, 1 hit | Short match, no recorded kick; [two exports](verification/live-trace-v1.5.5-2026-10-15.json) from the **same** match |

See [FINDINGS.md](FINDINGS.md) for the trace checksums, method, interpretation,
and what remains unverified.

## Scope and provenance

The browser client sends `zone:input` frames and receives a `zone:kicked` event
when the server rejects a match. The server's detector and authoritative physics
are not in this repository. A visible local tracer can follow the unmodified
camera even when an outgoing frame changes; server-confirmed events are the
meaningful result. The client contract may also change after the 2026-10-08
capture used to develop these hooks.

The [source manifest](research/manifest.json) records the 39 public client files
examined, with source URLs and SHA-256 hashes. Their third-party JavaScript is
not republished here. Raw screenshots remain local because some reveal private
lobby invite URLs and browser context. The JSON receipts and all original project
code are included. This is an independent project and does not claim affiliation
with BridgeGame.
