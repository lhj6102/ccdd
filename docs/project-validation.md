# Project Validation

Current validation is computed from folder material and actual review records. `status` and `plan` read JSON, hash inputs and read history; they do not execute scripts, create state, or schedule reviews.

## Commands

```sh
ccdd-project config check
ccdd-project status [ARTIFACT | --critic ARTIFACT/CRITIC]
ccdd-project plan (ARTIFACT | --critic ARTIFACT/CRITIC | --all) [--recursive] [--force]
ccdd-project verify (ARTIFACT | --critic ARTIFACT/CRITIC | --all) [--recursive] [--force] [--wait]
ccdd-project graph [ARTIFACT]
ccdd-project history [ARTIFACT | --critic ARTIFACT/CRITIC]
```

Common options are `--repo PATH`, external `--state-dir PATH`, and `--json`. `ccdd` is an alias for this same command set; old `ccdd run --critic` and demo selectors are removed.

## Selection and evidence

Selecting a Critic executes only that Critic; selecting an Artifact executes its owned Critics. Input-ready Critics do not wait for dependencies to PASS. `--recursive` includes all Critics in the required child/mount/instruction dependency closure. `--all` includes every Artifact. `--force` requests fresh evidence for selected Critics, while applicable dependency evidence remains reusable.

Final satisfaction still requires the selected Artifact's complete criteria and its required dependency scope. Selected GREEN results remain evidence when the Run is INCOMPLETE. For a cycle A ↔ B, verifying A alone runs A and reports INCOMPLETE until B has matching evidence. Verifying B next can complete the required scope; recursive verification can run both concurrently. A cycle is never treated as a PASS.

An explicit `basis: true` has no Critics. Other no-Critic Artifacts are UNREVIEWED. A basis with an unmet dependency is INCOMPLETE. Review completion alone does not alter input identity. SCC hashing includes material, config, view/runtime entries, declared execution inputs and relationships; it excludes verdict IDs and times. Unrelated changes preserve reuse. The latest actual semantic result for identical input wins.

`stale: {"kind":"always"}` requires evidence from the current validation request and propagates through consuming identities. Narrow `file-hash` material paths are owner-relative, but cannot exclude configuration or script entry files. See [identity contracts](contracts.md#input-identity-and-evidence).

## Workspace and execution

Supply an unchanged workspace; CCDD does not create a worktree, copy or virtual mount directory. A detached worker owns the Run and monitors all input, including ignored files, installed dependencies and Human waiting. State and output remain external. A wait timeout leaves that worker running.

`--integrity content|metadata` is available on verify/status/plan. Content is the default. Metadata is an explicit weaker filesystem assumption after an initial full capture; its evidence cannot satisfy a content-policy query. See [the policy](contracts.md#optional-metadata-integrity).

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

Queries of stored runs/requests do not need current source or reconcile ownership. Historical input versions support result lookup only, never reuse, tools, claims or resume. A terminal INCOMPLETE Run keeps its original scope; submit a new verification to add missing evaluations. Completed Runs retain references to the evidence they consumed.

Human preparation checks admitted environment requirements and static tool definitions before confirming a claim. Only the claimant may call tools and submit a result; the worker must remain alive. See [reviewers](reviewers.md).

## Diagnostics and monitor

`doctor --critic ARTIFACT/CRITIC` diagnoses readiness. Agent diagnostics make a real Provider call using a private nonce, never a project verdict. `tools check --artifact ID --for agent|human` lists definitions; add `--tool NAME --execute --args JSON` for actual execution. `monitor` displays saved graphs and Human actions. GETs never execute scripts, reconcile owners or mutate state; explicit current-input inspection uses POST and returns a query-derived answer.

## Exit codes

With `verify --wait` or `run show --wait`: 0 means the scope is fulfilled, 1 means RED, 2 means ERROR, 3 means wait timeout and 4 means INCOMPLETE. Without waiting, 0 means accepted or already fulfilled; inspect the reported status. Immediate incomplete/error results return 4/2. `status` returns 1 when not satisfied; `plan` reports a valid plan with 0 even when work remains. Use `--json` for structured results.
