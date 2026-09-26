# Migrating to 6.0

CCDD 6.0.0 is a breaking release. Upgrade all installed CCDD packages together;
Project and default-tools require core `>=6.0.0 <7`. Node.js 22 LTS (22.19.0 or
later) remains required. See the [release notes](releases/v6.0.0.md) for measured
performance and its limits, and [contracts](contracts.md) for API details.

## Start with fresh state format 6

Finish or cancel active reviews using their original installation. Use a **new
external state directory** for 6.0, then restart workers and the monitor with the
new packages and that directory. All state entry points reject older formats,
including 5.x; there is no migration or compatibility-read path. Do not change
SQLite `user_version` to bypass the check. Keep old audit records with their
matching old installation if needed. They are not imported as reusable evidence
into the fresh store.

Definitions, manifests, prepared inputs, workspace descriptors and audit results
now live in immutable content-addressed nodes. Mutable Run/request headers hold
lifecycle fields and references. Reads authenticate canonical SHA-256 hashes,
node structure and child references; result verdicts must match their lifecycle
status. Local writes and external database changes invalidate encoded caches.
Do not edit database records or references manually. Full audit remains available
through explicit full views and original result references.

## Account for dependency-GREEN gates

By default, each Critic waits for current GREEN evidence from dependency Critics
outside its strongly connected component (SCC). Basis inputs and Artifacts with
no Critics do not add gates. SCC peers can execute together after external gates
pass; independent chains can run in parallel.

- RED dependencies make descendants `BLOCKED`, without execution or fabricated
  verdicts. Operational failure leaves descendants `WAIT_DEPENDENCY`.
- A stored descendant result remains auditable but does not satisfy a currently
  unmet gate. Force requests fresh evaluation but still respects gates.
- Plans expose gate reasons and `counts.gated`; `counts.execute` counts only
  immediately executable work. Keep handling `COALESCE` and `counts.coalesce`.
- To deliberately evaluate selected Critics without dependency gates, pass
  `ignoreGates: true` to inspect/submission APIs or `--ignore-gates` to CLI
  `plan`/`verify`. This does not disable workspace integrity checks.

Dependencies must have current evidence or be included in the intended execution
scope. Revisit workflows that previously assumed every selected Critic starts
immediately, including workflows that used force as an unconditional rerun.

## Retry operational errors without changing input

`broker.retryRequest(requestId)` requeues only `ERROR` requests after their Run's
worker ownership has settled. It retains the same immutable input and does not
start a worker itself; execute/resume the Run through the normal worker path.
A GREEN retry releases waiting descendants. RED is a semantic result, not an
operational error eligible for this API.

If reviewed code, configuration or declared inputs changed, submit a **new Run**.
New identities are re-planned normally. Do not use retry to substitute changed
input into an existing Run or bypass workspace validation.

## Move live consumers to the changes API

Use `broker.onChange` to schedule a coalesced drain of
`broker.changes(runId, { after, limit })`. Start with `after: 0`, process each
page's `changes`, retain its returned `cursor`, and continue while `hasMore`.
Persist/use that cursor only with the same state database and stream you read.
The default limit is 100; valid limits are 1 through 1,000. An unknown Run returns
`null`.

A page contains `{runId, status, cursor, hasMore, changes}`. Changes identify the
request and Critic, lifecycle status, compact semantic result/audit reference,
and operational error fields. Reads use a consistent SQLite snapshot; rollback
exposes no provisional change. Returned data belongs to the caller.

Telemetry can notify `onChange` without advancing the lifecycle cursor: an empty
page is expected. `blockedReason` reflects the current request state, not its
historical reason at the cursor. Do not infer a telemetry history from these
pages. Cross-process lifecycle changes are visible through cursor reads; the
in-process callback is not a replacement for arranging reads when external
workers are the source of updates.

Compact `getRun` and `listRuns` are **whole-Run snapshots**. They avoid reconstructing
full immutable audit definitions, but membership-sized output still has
output-sized cost. Use them for explicit snapshots, not on every tool/telemetry
event. Load full audit only when needed through full detail or result references.

## Integrate admission only where needed

`createBroker({ admission })` accepts a hook with
`acquire({requestId, runId, kind, provider?, model?}, {signal, waiting})`, returning
a lease with idempotent `release()`. Acquisition follows dependency readiness and
precedes RUNNING. Honor cancellation, report waiting with `waiting(reason)`, and
make release safe to repeat. Waiting requests remain QUEUED with an admission
reason; cancellation, late acquisition and terminal paths release slots.

The default is a FIFO pool local to each Broker, using `maxConcurrentExecutors`
(default 4), alongside the per-Run dispatch bound. Runs sharing that Broker
share its default admission capacity; separate Brokers do not. Human preparation
and alarms do not consume these executor slots. Machine-wide provider pools and
cross-process pool configuration are not implemented in 6.0.

## Keep performance expectations bounded

Incremental lifecycle work is proportional to affected memberships and gate
edges, not a universal constant for arbitrary fanout. Snapshot/audit reads remain
output-sized. Telemetry is still a bounded synchronous SQLite append, not an
off-thread queue. The published offline matrix uses synthetic Provider transport
and actual tools, not real Provider/model reviews; its single-run results are
not confidence bounds or identical-unloaded-latency guarantees. The network
tripwire covers patched parent APIs only, not all child-process/native networking.
