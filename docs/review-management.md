# Machine resources and review management

CCDD 6.1 provides these machine resource and review-management contracts.
Install matching packages and follow the [upgrade steps](releases.md#upgrading-to-61)
before replacing a running 6.0 installation.

## Local configuration

CCDD reads **resources.json**, independently of credentials, at
`$CCDD_CONFIG_HOME/resources.json`, otherwise
`$XDG_CONFIG_HOME/ccdd/resources.json`, otherwise
`~/.config/ccdd/resources.json`. The machine database is
`$CCDD_STATE_HOME/resources.sqlite`, otherwise
`~/.local/state/ccdd/resources.sqlite`. All CCDD processes and repositories
must use the same local configuration and state root to share authority.
Do not set a different state home per request or repository.

```json
{
  "identityCapacity": 100,
  "defaultProviderCapacity": 4,
  "providers": {
    "openai-codex": {
      "capacity": 60,
      "models": { "gpt-6-luna": 60 }
    },
    "opencode-go": { "capacity": 4 }
  }
}
```

This is an example, not a universal recommendation of 60 sessions. Omitted
configuration means identity capacity **100**, provider fallback **4**, and no
model-specific cap. Every capacity must be a positive safe integer. A model
cap only adds a constraint to its provider cap. Runtime executor starts use
the finite `$runtime` provider pool. Human alarms/claims do not acquire a
provider slot or consume execution starts. Credentials never belong in this
file. `readResourceConfiguration()` and `resourcePaths()` expose these rules.

Each owner identity declares `stale.weight`, an integer **1–100**, default
**25**. The sum of running weights cannot exceed local `identityCapacity`,
which may be raised or lowered. A weight above capacity fails config/plan
before any identity script starts. Simple FIFO head-of-line waiting prevents
heavy identities from being overtaken. Provider FIFO lanes are independent,
so a busy provider does not block another provider.

```json
{
  "name": "calculation",
  "stale": {
    "kind": "identity",
    "script": { "command": "node", "args": ["identity.mjs"] },
    "weight": 50
  }
}
```

The SQLite authority atomically reserves provider/model/repository slots and
budget attempts. Leases have random tokens, PID/process-start identity and
heartbeats. A stale heartbeat does **not** reclaim a live or paused process.
Dead owners are reclaimed using process identity. Tracked detached child
process groups must stop before their lease is released/reclaimed; zombies
are not running holders. PID reuse does not grant a new process the old token.
SQLite busy waits are bounded at five seconds; failures are reported, never
retried in an infinite busy loop. Waiting is cancellable. Releasing the same
lease twice does nothing. Arbitrary detached processes created outside CCDD's
launch contract are not a supported way to retain resource authority.

Optional SDK `admission` is an additional precondition, not a replacement for
machine admission. It cannot raise capacities or bypass a budget. It must
implement its own cancellable wait and idempotent release.

## Repository policy and migration

Only the repository root `ccdd.json` may declare:

```json
{
  "name": "project",
  "reviewPolicy": {
    "dependencyGates": "green",
    "maxConcurrentExecutors": 2
  }
}
```

`dependencyGates` is `green` (default) or `ignore`. Inspect, plan, submit,
worker readiness and coalescing use the same effective policy. Explicit
`ignoreGates` overrides the default; `--ignore-gates` explicitly bypasses it.
GREEN dependencies unlock execution, RED produces BLOCKED, and operational
ERROR keeps dependents WAIT_DEPENDENCY. Same-SCC dependencies never gate.
Repository caps and explicit SDK/CLI caps are only additional tighter limits;
provider and model limits remain authoritative. Their machine key is the
SHA-256 of the canonical repository path, never caller labels such as `demo`
or `local`.

| Previous option or behavior | Current behavior |
| --- | --- |
| `identityConcurrency`, `--identity-concurrency` | Rejected with an actionable message; use local capacity plus Artifact weight. |
| Implicit `maxConcurrentExecutors: 4` / CLI concurrency 4 | Removed. Machine fallback is 4 only when local provider capacity is absent. |
| `maxConcurrentExecutors`, `--concurrency N` | Optional stricter cap; cannot create an independent larger pool. |
| Old saved `worker.json` | Resume fails explicitly; stop old workers and submit using the new protocol. |
| Consumer native worker pool size | Remains an explicit consumer concern; never inferred from identity concurrency or CPU count. |

**Stop all 6.0 workers before upgrading.** New workers and saved worker files
use `resources-1`; old active owners in the same state are rejected, old Runs
cannot be resumed, and old active candidates cannot be coalesced. New code
cannot retroactively make an old running executable obey machine leases.
Format **6** remains additive: completed evidence is readable/reusable and
missing provenance is `null`. Do not delete state or change its format marker.

There is no package/Pi/capacity salt in semantic keys. Byte-identical existing
configuration keeps its default identity. Owner identities depend on their
returned value, not scheduler weight or local capacities. Default file-hash
Artifacts continue hashing raw `ccdd.json` material: editing a root policy in
that file is an explicit input edit, not an invisible package-version change.
Owners must include meaningful profile/tool semantics in their identity.

## Durable execution budgets

```ts
const run = await broker.submitProject({
  selection: { kind: 'all' },
  maxExecutions: 8,
});
await broker.run(run.id);
const budget = broker.executionBudget(run.id);
```

```sh
ccdd-project verify --all --max-executions 8 --wait
ccdd-project verify --all --max-executions 0 --wait
```

The cap belongs to the **submission**, not an executor object, process or
retry. An immediately executable plan above the cap is rejected before a Run
is published. Gated future starts and fallback after abandoned coalescing are
checked again by machine admission. Reuse and joining an existing execution
consume no new start; `0` means reuse/coalesce only, never new execution.

A unique attempt first reserves its slot and budget in one SQLite transaction.
Before invocation, the authority marks it `started`. This marker, not optional
`executor.started` telemetry, consumes the start. Definitely prestart
reservations can be `refunded`; started or ambiguously started attempts never
refund. Terminal attempts still count. Every retry obtains a new token and
uses the same stored cap. Budgets are immutable and survive process restart.

The machine reservation, repository RUNNING transition, machine start marker,
invocation and repository terminal commit are ordered but are not a fictional
cross-database transaction. A crash before the start marker can refund its
reservation; a crash after the marker is conservatively consumed, even if no
Provider request actually left the process. Orphaned submission records are
harmless immutable ledger entries, not reusable review results. Preserve the
machine database while Runs or retryable history still refer to its budgets.

## Original execution provenance

Successful requests, compact results/references, changes and reuse expose:

```ts
executionProvenance: {
  attemptId: string;
  capturedAt: string;
  binding: 'declared-runtime-pin';
  inputs: { path: string; structuralSha256: string }[];
  files: { path: string; rawContentSha256: string; executable: number }[];
} | null
```

`inputs` retains the structured path/type/executable-mode/content digest of
**declared executionPaths**. `files` separately identifies raw SHA-256 content
of regular files, including executable mode. A symlink is not labeled a
regular file; internal links are covered by the structural digest. External
or escaping links fail. No current binary hash fills in historical provenance.
Reuse always retains the original request's hashes, timestamp and attempt ID.
A result without declared runtime capture, including historical evidence,
reports `null` rather than an invented verified binary.

Before executor invocation, CCDD captures only declared runtime material into
shared content-addressed `runtime-content/` under the machine state root. It
never copies the reviewed workspace. Captured trees are verified against the
manifest and again before/after use. Fixed registered command/argv paths inside
a declaration launch from that pinned tree. Runtime script relative imports
and native siblings must be included in its declarations. Undeclared relative
imports are not implicitly copied or rewritten.

Script requests additionally receive `context.executionPaths`, mapping each
declared workspace-relative name to the captured absolute path. Custom tools
must use these pinned paths (or relative siblings of their pinned entry)
when launching declared runtimes, not reconstruct original workspace paths.
For example, `context.executionPaths['runtime/native-cli']` is the attempt's
binary, while `context.artifactPath` continues pointing at review material.
Do not substitute the caller's current native binary for the original result.

This binds the supported declared runtime launch contract; it is **not an OS
sandbox** against hostile scripts, direct arbitrary host opens, or malicious
same-UID modification of private state. Custom executors/scripts that bypass
the contract cannot claim verified execution of their arbitrary files.
Workspace mutation and captured-tree mismatch fail closed. The cache is
private local runtime data, not repository review input or credentials.

## Offline load check

```sh
ccdd-project load-check --concurrency 60 --requests 120 --output-dir ./output
ccdd-project load-check --concurrency 100 --requests 200 --output-dir ./output
```

`loadCheck({concurrency, requests, outputDir, signal})` is also exported by
Project. It runs a synthetic executor against **real registered script tools**
in a generated, unique fixture and a dedicated diagnostic resource authority.
It does not inspect/review user content or consume provider sessions. Synthetic
GREEN cannot satisfy ordinary gates or reuse: diagnostic state is marked and
normal Broker/history/query entry points reject it.

The driver and tool children self-check provider-module import and standard
Node network guards. Reported coverage is limited to that controlled process
and generated tools, not arbitrary binaries or an OS-level network sandbox.
The report includes actual tool latency p50/p90/max, event-loop maximum delay,
throughput, observed peak concurrency, failures, and a drained compact changes
cursor. It reports measured values rather than treating a requested limit as
observed concurrency. Keep `report.json` and state as diagnostic evidence;
never copy their synthetic verdicts into production state.

### Multiple roots share one budget

Use one submission for a batch, not one independent cap per member:

```ts
await broker.submitProject({
  selection: { kind: 'critics', criticIds: ['a/check', 'b/check', 'a/check'] },
  recursive: false,
  maxExecutions: 2,
});
// Also supported: { kind: 'artifacts', artifactIds: ['a', 'b'] }.
```

IDs are unioned and deduplicated. Dependency identity/gate scope is retained;
without `recursive`, dependencies are not implicitly selected for execution.
CLI `--critics a/check,b/check` and `--artifacts a,b` have the same semantics.

### Failed attempts and cleanup

`RequesterRequest.attemptId` and `executionProvenance` describe the current
started attempt even when it ends in ERROR, timeout or cancellation. Before
start they are null. Retry clears the current reference and creates a new
attempt, never replacing the previous ledger entry. `executionBudget(runId)`
returns all attempts with their original provenance; changed-result cursors
retain the attempt/provenance associated with that individual transition.
Successful reuse still references the original successful attempt only.

CCDD's managed subprocess launcher first starts an inert group leader, records
its PID/start identity, then grants permission to launch the user command.
A registration failure or parent disconnect before that permission cannot
start user work. Cancellation, registration failure and release wait for owned
process cleanup. A bounded cleanup failure retains a `releasing` lease until
later recovery confirms the tracked group stopped; no slot is freed while it
is running. Cleanup diagnostics are separate events and never replace the
original execution failure. This does not contain scripts that deliberately
escape their registered process group.

### Real-project diagnostic scenarios

The standalone generated fixture is optional. To test a real, unchanged
project through its actual identities, registered tools and dependency graph:

```ts
await loadCheck({
  project: {
    repoPath: '/absolute/path/to/isolated-diagnostic-project',
    selection: { kind: 'all' },
    recursive: true,
    scenario: {
      steps: [
        { operation: 'describe', args: {} },
        { operation: 'tooltips', args: {} },
        { operation: 'recommended_character', args: {} },
        { operation: 'damage_summary',
          argsFrom: { step: 2, pointer: '/content/0/data' } },
      ],
      syntheticResult: { verdict: 'GREEN', reason: 'Explicit diagnostic fixture' },
    },
  },
  concurrency: 60,
  processes: 1,
  resourceMode: 'isolated',
  outputDir: '/absolute/path/to/diagnostic-output',
});
```

`operation` selects that operation on the current Critic's target. Alternatively
`tool` names an exact registered tool. `argsFrom` selects a JSON Pointer into an
earlier **raw ToolResult**, indexed from zero. It is not an expression language;
missing references, forward references and schema-invalid arguments fail.
Know which content block contains the intended JSON before choosing its index.
`scenario.critics[criticId]` may override steps; `criticResults[criticId]` may
override the explicit synthetic result. A missing required pass field is a
preflight error, not something CCDD invents. Every selected Critic's tools and
literal argument/result schemas are checked before identity/tool execution.
Dynamic previous-result arguments are checked before their destination call.

Only Agent Critics with registered agent tools are accepted by this diagnostic.
It does not issue Provider calls. Default dependency gates remain active unless
`ignoreGates` is explicit; synthetic results satisfy only this marked diagnostic
Run. Arbitrary custom required semantic payloads must be explicitly supplied
and pass the original schema, even though the output is synthetic.

The source project is not copied, rewritten or given production evidence. Its
identity/tool scripts still own their declared behavior; prepare isolated
consumer-specific output/memo paths before diagnostics when those scripts use
fixed external paths. No generic diagnostic flag can make arbitrary author
code harmless. Keep existing consumer guards and demonstrate their coverage.

```sh
ccdd-project load-check --repo /path/to/diagnostic-project \
  --scenario-file scenario.json --concurrency 60 --processes 2 \
  --resource-mode isolated --output-dir /path/to/diagnostic-output --json
```

`scenario.json` contains `selection`, optional `recursive`/`ignoreGates`, and
`scenario` as above. `processes` creates independent diagnostic state per worker;
all workers share the same diagnostic machine pool. `resourceMode: 'shared'`
opts into the existing machine authority/configuration without changing either;
`concurrency` never raises that shared authority. Reports distinguish these
modes. A Node import/network guard covers the driver and Node identity/tool
children, not arbitrary native network code or a hostile OS-level bypass.

Diagnostic drivers use a runner-owned `tmp/` beneath their unique output root,
passed explicitly as TMPDIR/TMP/TEMP through the filtered child environment.
They do not inherit a caller's arbitrary temp root or unrelated secrets.
Identity capture temp directories and tool CCDD_TMP_DIR directories stay within
that diagnostic/output scope; the report and per-process guard proofs record
the observed temporary root. Parallel diagnostic workers have distinct temp
roots. Evidence and source are not removed by temporary script cleanup.

Timeout values use positive safe-integer milliseconds up to 2,147,483,647, the Node timer limit; existing defaults and cancellation semantics are unchanged.
