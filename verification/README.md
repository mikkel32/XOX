# Verification receipts

The JSON files here preserve observed input frames, locally predicted shots,
server events, and connection changes from private bot matches. Read
[`FINDINGS.md`](../FINDINGS.md) before interpreting a trace: local prediction,
server confirmation, and a session without a recorded kick are different claims.

`live-result.json` is an older summary without a raw event transcript. The
`live-trace-*.json` files are bounded in-memory exports; the two 1.5.5 files
are snapshots from the same match. `live-test-bootstrap.js` is a developer-only
attachment helper used during an already-loaded game test.

Run `node verification/analyze-trace.mjs "C:\path\to\bridgezone-trace.json"`
from the repository root to inspect Fire gates, button changes, F/E and pointer
lock evidence, ambiguous shot pairs, recorded seed-sync fallbacks, and server
events. The user-supplied 1.5.8 no-fire trace is
summarized in [FINDINGS.md](../FINDINGS.md); it is not copied into this folder.

Raw screenshots are intentionally kept out of this public repository. Some
show browser context and a private lobby invite URL. The receipts contain no
session token or match ID, and the [findings document](../FINDINGS.md) provides
their SHA-256 hashes and outcome summaries.
