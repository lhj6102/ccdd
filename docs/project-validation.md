# Project validation and result interfaces

The Project adapter discovers static Artifact declarations, derives relationships
and obtains actual results from the local compute service. It does not decide
whether two explicit identities are equivalent. See [identity caching](identity-cache.md)
and [7.x migration](migration-v7.md) before upgrading an existing installation.

## Select and execute

```sh
ccdd config check --repo ./project
ccdd graph --repo ./project --compact --json
ccdd plan implementation --recursive
ccdd verify implementation --recursive --wait
ccdd verify --critics-file critics.json --wait
ccdd verify --artifacts-file artifacts.txt --recursive --wait
```

Selector files accept a JSON string array or one ID per line, including a UTF-8
BOM and CRLF. Empty lines are ignored and IDs are stably deduplicated. Invalid
IDs use ordinary selection validation. Conflicting selectors fail rather than
silently merging different scopes. Reads and catalog expansion are bounded.

Individual verification runs selected Critics. Recursive verification includes
their required dependency closure. Missing other required results makes final
validation INCOMPLETE without discarding completed selected results. GREEN
dependency gates apply outside a strongly connected component; cycle peers can
run together. `--ignore-gates` explicitly bypasses those execution gates.

The same explicit identity reuses GREEN or RED across different repositories,
paths and profiles; RED remains unsatisfied. No identity function means no
reusable result. A Run can still use its own freshly completed noncached result
for final satisfaction. `--force` starts a new uncached execution and does not
replace a shared result. Completed cached evidence takes precedence over an
active matching job; otherwise a matching active identity is quoted as COALESCE.
A plan is a point-in-time observation, never a reservation of a result or budget.

## Prepare once, then submit

```ts
import { prepareProject, disposePreparedProject, createBroker, createExecutorRegistry } from '@ccdd/ccdd/project';

const prepared = await prepareProject({
  repoPath: '/absolute/project', stateDir: '/absolute/external-state',
  selection: { kind: 'all' }, recursive: true,
});
console.log(prepared.plan);
const broker = createBroker({ repoPath: '/absolute/project', stateDir: '/absolute/external-state', executors: createExecutorRegistry() });
try {
  const run = await broker.submitPrepared(prepared, { requesterId: 'local', maxExecutions: 4 });
  await broker.run(run.id);
} finally {
  disposePreparedProject(prepared);
  await broker.close();
}
```

The handle is valid only in its creating session. Mutation of the public plan
cannot change its internal frozen input. Submission verifies the workspace and
rechecks cache/admission state without invoking the identity script a second
time. A changed or forged preparation is rejected. This is not a persistent
cache of identity-function outputs.

## Select a declared profile

A Critic can provide `profileVariants` in addition to its default `profile`:

```json
"profileVariants": {
  "careful": { "kind": "agent", "provider": "YOUR_PROVIDER", "model": "YOUR_MODEL", "reasoning": "high", "timeoutMs": 120000 }
}
```

Use `verify ... --profile careful`, or SDK `profile: 'careful'`. The SDK also
accepts a map of qualified Critic IDs to declared names. Unknown names and
out-of-scope mappings fail before submission. Each selected variant is a full
validated profile, not an arbitrary source-file patch. A shared identity hit
returns the original execution's profile; the selected profile is recorded as
`requestedProfile`. Encode profile distinctions in identity when required.

## Read results without internal DB access

```sh
ccdd run show RUN_ID --state-dir STATE
ccdd request show REQUEST_ID --state-dir STATE
ccdd run stream RUN_ID --state-dir STATE --after 0
ccdd verify --all --recursive --wait --stream
ccdd run summary RUN_ID --state-dir STATE
ccdd request summary REQUEST_ID --state-dir STATE
ccdd run compare LEFT_RUN RIGHT_RUN --state-dir STATE
```

`--stream` emits NDJSON and is separate from the existing single JSON/full output
modes. `verify --stream` requires `--wait`. `run stream` follows an existing Run
without invoking its worker. API clients can apply backpressure directly:

```ts
import { streamProjectResults, projectRunSummary } from '@ccdd/ccdd/project';
for await (const event of streamProjectResults(stateDir, runId, { after: savedCursor, signal })) {
  await consume(event);
  savedCursor = event.cursor;
}
console.log(projectRunSummary(stateDir, runId));
```

A result event includes cursor, Run/request references, terminal state, semantic
fields where present and original-execution attribution. Consumers deduplicate
by cursor when resuming. Returning, timing out or aborting this iterator does
not cancel the computation. Explicit `run cancel` detaches the Run's subscriber;
other subscribers keep their shared computation.

`projectChanges` returns bounded read-only lifecycle pages. Telemetry callbacks
do not flood that lifecycle cursor. `projectRequestSummary` reports all recorded
attempts; `projectRunSummary` counts actual starts, tool calls and reported usage
without billing a reused/coalesced execution again. `sourceSummary` attributes
shared work. Missing usage is `unreported`, or `partial` when mixed with reported
attempts, never fabricated zero usage. `compareProjectRuns` accepts two stored
Run references, including separate state directories; it is read-only and does
not automatically classify a changed verdict as a code regression.

Current `plan`/`status` preparation can execute explicit identity functions in
the selected dependency scope. Static discovery, `config check`, `graph`, stored
Run/history reads and monitor GET requests do not run them. Original records
remain readable after their repository is removed. Historical audit references
into the cache are subject to its storage lifetime, not guaranteed permanence.

## Large graphs and execution safety

`graph --compact --json` is an opt-in projection without duplicated execution
schemas; the original `graph --json` remains available. The monitor groups
families by default, pages their member list in groups of 100 and prevents
expanding more than 200 members into the graph at once. Individual instances
remain accessible from the paged list. Layout runs outside the main browser
thread where Worker is available.

Reviews use the supplied unchanged workspace, including during Human waiting.
CCDD does not create/link worktrees or lock external editors. Output and state
must remain outside reviewed input. `--integrity metadata` is an explicit weaker
filesystem validation assumption, not a different cache key. Tool permissions,
Human claim ownership, observation requirements and result validation remain in
force for actual executions.
