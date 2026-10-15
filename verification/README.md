# Verification receipts

The JSON files here preserve observed input frames, locally predicted shots,
server events, and connection changes from private bot matches. Read
[`FINDINGS.md`](../FINDINGS.md) before interpreting a trace: local prediction,
server confirmation, and a session without a recorded kick are different claims.

`live-result.json` is an older summary without a raw event transcript. The
`live-trace-*.json` files are bounded in-memory exports; the two 1.5.5 files
are snapshots from the same match. `live-test-bootstrap.js` is a developer-only
attachment helper used during an already-loaded game test.

Raw screenshots are intentionally kept out of this public repository. Some
show browser context and a private lobby invite URL. The receipts contain no
session token or match ID, and the [findings document](../FINDINGS.md) provides
their SHA-256 hashes and outcome summaries.
