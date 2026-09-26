# Project Validation

Current validation is computed from folder material and actual review records. `status` and `plan` read JSON, derive identities and read history; they do not create state or schedule reviews. They execute owner identity scripts only when explicitly configured with `stale.kind: "identity"`; view tools, environment requirements and Providers remain unexecuted. `config check` and `graph` always remain script-free.

## Commands

```sh
ccdd-project config check
ccdd-project status [ARTIFACT | --critic ARTIFACT/CRITIC]
ccdd-project plan (ARTIFACT | --critic ARTIFACT/CRITIC | --all) [--recursive] [--force]
ccdd-project verify (ARTIFACT | --critic ARTIFACT/CRITIC | --all) [--recursive] [--force] [--wait]
ccdd-project graph [ARTIFACT]
ccdd-project history [ARTIFACT | --critic ARTIFACT/CRITIC]
```

Common options are `--repo PATH`, external `--state-dir PATH`, and `--json`. Review-result commands also accept `--full`. `ccdd` is an alias for this same command set; old `ccdd run --critic` and demo selectors are removed.

## Compact review results (5.0)

**Breaking change:** requester results default to `{verdict, ...ownerFields,
reference, reusedFrom?}`, not the full audit. There is no built-in reason,
summary or evidence. Runs/plans emit each result once in top-level `results`;
requests, Critics and plan items refer to it with `{requestId}`. Standalone
requests contain the compact result directly. `inputKey` stays on its wrapper.
Plain-text output shows owner result JSON and its audit reference.

```sh
# Normal requester result: verdict, owner fields and audit reference.
ccdd-project verify --all --wait --json
ccdd-project request show REQUEST_ID --json

# Explicit full payload and complete audit lookup.
ccdd-project verify --all --wait --json --full
ccdd-project request show REQUEST_ID --json --full
ccdd-project run show RUN_ID --state-dir /external/state --json
```

`reference` contains `{runId, requestId, stateDir}`. `run show` always returns the
full stored Run (also without `--json`), including request tool calls/arguments,
observation receipts, criteria snapshots and event telemetry. A reused result
references the original review. A Run reference without a particular review has
`requestId: null`. Readonly lookups continue working if the original workspace
was removed. State is still local; no new remote endpoint or upload is involved.

Programmatic callers can create a full-detail Broker with
`createBroker({repoPath, stateDir, detail: "full", executors})`. Stored lookup is
`projectRun(stateDir, runId)`. `inspectProject` returns only `{plan}` by default;
add `detail: "full"` if you need its prepared snapshot. Pure `queryProject` and
`planProject` now require `stateDir` in their options and consume full semantic
history from `projectHistory(stateDir, {detail: "full"})`. See the
[complete surface contract](contracts.md#requester-results-and-audit-lookup).

Stored audit is not removed, and required observation checks are unchanged.
Start with a fresh state directory for 5.0: 4.x state is rejected, not migrated.
ValidationInput version 3 is a one-time transition. Package and runtime upgrades
alone no longer invalidate review keys. See [migration](migration-v5.md).

## Selection and evidence

Selecting a Critic executes only that Critic; selecting an Artifact executes its owned Critics. Input-ready Critics do not wait for dependencies to PASS. `--recursive` includes all Critics in the required child/mount/instruction dependency closure. `--all` includes every Artifact. `--force` requests fresh evidence for selected Critics, while applicable dependency evidence remains reusable. Matching GREEN and RED are both reused; RED still fails satisfaction. Identical active requests across Runs in one state directory coalesce and share the original review result. Force bypasses coalescing. Follower cancellation leaves the source running; source cancellation or error fails the waiting follower without a semantic verdict.

Final satisfaction still requires the selected Artifact's complete criteria and its required dependency scope. Selected GREEN results remain evidence when the Run is INCOMPLETE. For a cycle A ↔ B, verifying A alone runs A and reports INCOMPLETE until B has matching evidence. Verifying B next can complete the required scope; recursive verification can run both concurrently. A cycle is never treated as a PASS.

An explicit `basis: true` has no Critics. Other no-Critic Artifacts are UNREVIEWED. A basis with an unmet dependency is INCOMPLETE. Review completion alone does not alter input identity. SCC hashing includes material, config, view/runtime entries, declared execution inputs and relationships; it excludes verdict IDs and times. Unrelated changes preserve reuse. The latest actual semantic result for identical input wins.

`stale: {"kind":"always"}` requires evidence from the current validation request and propagates through consuming identities. Narrow `file-hash` material paths are owner-relative, but cannot exclude configuration or script entry files. See [identity contracts](contracts.md#input-identity-and-evidence).

## Owner-defined equivalence

```json
"stale": {
  "kind": "identity",
  "script": { "command": "node", "args": ["identity.mjs"] },
  "inputs": ["identity-rules.json"],
  "timeoutMs": 30000
}
```

The script returns an opaque string of 1–128 characters from `[A-Za-z0-9._:-]`, with at most one trailing LF newline. CCDD does not interpret it. A repeated `verify` reuses matching prior actual evidence when the value and other identity conditions are unchanged, even after material or shared runtime changes. Add `--force` to require a new review of the selected Critics despite an unchanged value.

The entry file and declared `inputs` remain owner-relative and scoped, but are not automatically hashed. Only the returned value and Artifact ID define local owner identity. The owner must encode relevant script, criteria, tool/profile, environment and integrity differences in that value. Dependency identities still propagate. Default Artifacts retain automatic definition/material/execution/environment/integrity coverage. No package/runtime version salt is added in either mode.

Use `node` with the entry file first in `args`, followed by any script arguments, or an owner-relative executable as `command`. Inline Node programs, flags before the entry, absolute commands and PATH interpreter lookup are unsupported. Scripts use owner cwd and the environment-check executor with read-only workspace obligations, cancellation and disposable external output. Optional `timeoutMs` defaults to 30000 (range 1–900000). Optional `inputs` accepts up to 64 unique literal files/directories; unknown fields fail validation. Invalid/empty stdout, nonzero exit, timeout or workspace mutation fails validation, never falling back to ordinary file hashing.

`plan`, `status` and `run show` display `identity: script` and the value. Their JSON artifact entries include `identity` and `value`; persisted snapshots also retain the values for fully reused Runs. Saved Run inspection does not execute the function again. See the complete [owner identity contract](contracts.md#owner-defined-identity).

## Workspace and execution

Supply an unchanged workspace; CCDD does not create a worktree, copy or virtual mount directory. A detached worker owns the Run and monitors all input, including ignored files, installed dependencies and Human waiting. State and output remain external. A wait timeout leaves that worker running.

`--integrity content|metadata` is available on verify/status/plan. Content is the default. Metadata is an explicit weaker filesystem assumption after an initial full capture; default identity distinguishes it from content-policy evidence; owner identity must encode that distinction itself when desired. See [the policy](contracts.md#optional-metadata-integrity).

## Saved results and Human actions

```sh
ccdd-project run list
ccdd-project run show RUN_ID [--wait]
ccdd-project run resume RUN_ID [--wait]
ccdd-project run cancel RUN_ID
ccdd-project request list [--run RUN_ID]
ccdd-project request show REQUEST_ID
ccdd-project request claim REQUEST_ID --reviewer ID
ccdd-project request tool REQUEST_ID --reviewer ID --tool NAME --args JSON
ccdd-project request submit REQUEST_ID --reviewer ID --result-file /external/result.json
```

Queries of stored runs/requests do not need current source or reconcile ownership. Only current-major state is accepted; 4.x directories fail closed with an instruction to use a fresh directory. A terminal INCOMPLETE Run keeps its original scope; submit a new verification to add missing evaluations. Completed Runs retain references to the evidence they consumed.

Human preparation checks admitted environment requirements and static tool definitions before confirming a claim. Only the claimant may call tools and submit a result; the worker must remain alive. See [reviewers](reviewers.md).

## Diagnostics and monitor

`doctor --critic ARTIFACT/CRITIC` diagnoses readiness. Agent diagnostics make a real Provider call using a private nonce, never a project verdict. `tools check --artifact ID --for agent|human` lists definitions; add `--tool NAME --execute --args JSON` for actual execution. `monitor` displays saved graphs and Human actions. GETs never execute scripts, reconcile owners or mutate state; explicit current-input inspection uses POST and returns a query-derived answer.

## Exit codes

With `verify --wait` or `run show --wait`: 0 means the scope is fulfilled, 1 means RED, 2 means ERROR, 3 means wait timeout and 4 means INCOMPLETE. Without waiting, 0 means accepted or already fulfilled; inspect the reported status. Immediate incomplete/error results return 4/2. `status` returns 1 when not satisfied; `plan` reports a valid plan with 0 even when work remains. Use `--json` for structured results.
