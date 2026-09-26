# Unreleased

## 6.0: normalized state and dependency gates

This is a breaking major release requiring a **new state directory**. Earlier state formats are rejected before use; no migration or compatibility path is provided.

Definitions, manifests, inputs and audit results are stored as immutable content-addressed nodes. Runs and requests store compact lifecycle metadata and references, rather than repeating large tool definitions in mutable JSON. Dispatch and completion adjust indexed memberships and counters without re-planning the entire project. Ready work is selected from the status index; affected dependency/follower memberships receive incremental updates. Gate construction uses direct SCC-condensation edges, with transitive blocking/release propagated through the chain rather than a transitive-closure table.

### Dependency-GREEN gating is now the default

- A Critic starts only when all dependency Critics outside its strongly connected component have current GREEN evidence. Basis/no-Critic inputs do not gate.
- RED dependencies produce BLOCKED descendants, with no execution or fabricated verdict. Operational failures leave descendants WAIT_DEPENDENCY.
- SCC peers execute together after external gates pass. Independent chains execute in parallel.
- Stored descendant results remain auditable but are not current satisfaction under an unmet gate. Force respects gates.
- `--ignore-gates` / SDK `ignoreGates` explicitly restores ungated execution.
- `broker.retryRequest(id)` retries an ERROR against the same immutable input after the worker settles. A successful retry releases waiting descendants. Changed code requires a new submission; its new identities are automatically re-planned, never silently substituted into an old Run.

Plans expose BLOCKED/WAIT_DEPENDENCY reasons and `counts.gated`; `counts.execute` counts only immediately executable work. Coalescing, source leases, owner reconciliation and readonly quote/submit parity remain enforced.

### Live requester API

Use `broker.changes(runId, {after, limit})` after an `onChange` notification. Drain `hasMore` pages and retain `cursor`. Reads cost the returned changes, not the Run's definitions. Telemetry is a bounded synchronous SQLite append (not an off-thread drain) and can notify without advancing this lifecycle cursor. blockedReason reflects current state, not historical reason-at-cursor. Rollbacks expose no provisional changes; results retain audit references and caller-owned copies.

Compact `getRun`/`listRuns` are explicit whole-Run snapshots, not streaming polling APIs. They no longer reconstruct full audit definitions merely to discard them, but their membership-sized output is necessarily not O(1). Consumers should move event-driven polling to `changes`.

### Admission boundary

An optional cancellable `Admission.acquire(request, {signal,waiting})` returns an idempotently released lease. It runs after dependency readiness, before RUNNING. Waiting stays QUEUED with an admission reason; cancellation and every terminal path release slots. Default admission is FIFO per Broker. A future machine-wide provider pool can implement this interface; 6.0 does not implement machine-wide pool configuration.

### Verification and performance scope

Scaling regressions compare 20/2,000 Critics and 1/1,000 Artifacts: isolated dispatch visits one membership and one Run counter, reads zero immutable definition bytes, and stores an approximately 850-byte request header. One hundred telemetry events create no lifecycle cursor rows. A 60-way, 180-Critic event-subscriber regression drains changes after every notification without whole-Run reads.

The guarded offline Pi harness in `scripts/benchmark-pi-streams.mjs` uses the real production executor, Pi Agent and Codex SSE parser, synthetic reasoning/encrypted items and streamed arguments, real tools from an external copied lab project, and a changed-results subscriber. It does not access credentials or call a Provider. Its verdicts are transport fixtures, not actual review evidence. Exact acceptance results and outstanding limitations belong in the PR; no release-performance claim should be inferred from a partial matrix.

Review hardening authenticates canonical content hashes and node/reference structure, invalidates encoded caches on local/external database changes, and rejects result/status mismatches. Compact snapshots read only membership-referenced evidence and skip discarded events. External evidence obeys the receiving Run gate; ignore-gates followers reject blocked source candidates consistently in quote and submission.

The offline network tripwire covers only patched parent-process APIs. It is not an OS-level denial for the process tree: DNS promises/Resolver, UDP, native code and child-process networking are outside its coverage. A zero counter refers only to the patched paths. The synthetic transport avoids credential/provider access by construction.
