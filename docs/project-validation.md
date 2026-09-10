# Project Validation CLI UX

CCDD configuration defines Artifacts, Critics, relationships, and input identity rules. The `ccdd-project` command in `@ccdd/project` handles current validation queries, actual validation requests, and history. The existing `ccdd` executable remains a compatibility interface in the same Project package.

## Agreed behavior

- Current validation requirements are checked recursively through the DAG. No per-Artifact staleState is stored, and no invalidation is propagated to downstream Artifacts.
- Actual validation history and the input identities of the last successful validation are retained. A Critic's input identity includes its evaluation conditions and the identities of its target and direct dependency Artifacts.
- Memoization is allowed within a query. Each query uses a consistent input observation; a new query context is used when reassessing after a new verdict is recorded.
- Individual validation starts ready selected Critics and reports blocked Critics as incomplete. It does not automatically request validation of predecessor Artifacts.
- Recursive validation includes necessary predecessor validations. Once a predecessor Artifact satisfies its validation requirements, a fresh query decides whether to reuse a downstream Critic's past verdict or request an actual review.
- Queries start no Provider calls, Human notifications, review tool execution, or review tickets. Actual reviews and Human actions require explicit execution commands.

## Core commands

| Command | User question and result |
| --- | --- |
| `ccdd-project status` | Checks current validation requirements for each Artifact in the project. |
| `ccdd-project status B` | Shows B's current verdict, reuse evidence for each Critic, and reasons for unmet requirements. |
| `ccdd-project status --critic C` | Shows the verdict applicable to a specific Critic's current input and its prerequisites. |
| `ccdd-project plan B` | Shows immediately executable reviews, reusable verdicts, and required predecessor validations for an individual validation of B. Creates no tickets. |
| `ccdd-project plan B --recursive` | Shows a plan including necessary predecessor validations. Downstream reviews are conditional: reuse or execution depends on predecessor results. |
| `ccdd-project verify B` | Requests ready Critics needed by B and reports blocked items. |
| `ccdd-project verify B --recursive` | Requests validation of B, including necessary predecessor validations. |
| `ccdd-project verify --critic C` | Requests only C. Enforces validation of C's deps without automatically adding other Critics or predecessor validations. |
| `ccdd-project verify --critic C --recursive` | Requests C and the predecessor Artifact validations needed to satisfy it. Does not automatically include other Critics targeting C's target. |
| `ccdd-project verify --all` | Requests the validation needed across the whole project. |

`plan` also supports `--critic C` and `--all`. An Artifact positional argument, `--critic`, and `--all` are mutually exclusive. `plan` and `verify` require an explicit target. With no target, `status` queries the whole project.

Artifact validation covers every required Critic targeting that Artifact. Critic validation covers only the selected Critic, so its success is not displayed as PASS for the entire Artifact. A basis is shown as an explicitly accepted starting point without creating an actual PASS verdict. An ordinary Artifact with no Critic does not automatically PASS either.

## Execution options

| Option | Meaning |
| --- | --- |
| `--recursive` | Extends the scope to necessary predecessor Artifact validations. Does not add downstream Artifact validations. |
| `--force` | Reviews the selected target Critics again without reusing their past verdicts. Preserves prerequisites; predecessors included recursively run only when needed. |
| `--wait` | Waits for the accepted validation's result. A wait timeout does not cancel validation. |
| `--timeout-ms N` | Sets the client's wait timeout. |
| `--copy`, `--lock` | Chooses how review input is fixed. New `verify` requests default to copy; lock requires an explicit choice. The mandatory-option contract of legacy `ccdd run` is separate. |
| `--json` | Returns structured output for automation. |
| `--repo PATH`, `--state-dir PATH` | Specifies the project and external validation history location. |

`plan --force` shows the plan for execution with the same option. When all applicable past PASS verdicts can be reused and no new validation is needed, `verify` returns reuse results with references to the original verdicts and creates no new review tickets.

A request without `--recursive` is not a reservation to execute missing predecessor validations automatically later. Once ready selected Critics finish, the remaining incomplete items are reported. The user can validate predecessors and submit another request, or request recursive validation.

## A → B example

Suppose `a-check` evaluates A, `b-against-a` evaluates B with A as a dependency, and `b-alone` evaluates B with no deps. A is stale, and neither B Critic has a currently reusable PASS.

```text
$ ccdd-project plan B
B: partially ready
  b-alone       ready
  b-against-a   prerequisite validation required: A / a-check
Ready 1 · Prerequisite validation required 1 · Reusable 0

$ ccdd-project verify B
Accepted a review request for b-alone.
Did not request b-against-a: validation of A / a-check is required.
Validation of B as a whole remains incomplete.

$ ccdd-project verify B --recursive
Accept review requests for the required a-check and b-alone.
Show b-against-a as waiting for prerequisite validation.
Once A satisfies validation, query again to decide whether to reuse a verdict or request a review.
```

This output illustrates behavior; it is not a record of an actual execution. The two `verify` examples are alternatives from the same initial conditions. They do not mean that executing them in sequence reruns an already passing `b-alone`.

Completion of A alone does not satisfy the prerequisite. Its required validations must pass for the current input; RED or an execution error prevents the dependent review from proceeding. Independent Critics continue, and actual verdicts already recorded are retained.

## Execution history and Human actions

A Review Request remains the unit users refer to as a review ticket. Assignment and progress of an active request are actual execution records, distinct from an Artifact's derived staleState.

| Command family | Role |
| --- | --- |
| `ccdd-project history [B]` | Shows actual verdict history, input identities, and original verdicts currently being reused. Also supports `--critic C`. |
| `ccdd-project run list` | Lists accepted execution groups. |
| `ccdd-project run show RUN_ID [--wait]` | Shows a specific execution group's input, requested scope, progress, and incomplete items, separate from the verdict on current source. |
| `ccdd-project run resume RUN_ID [--wait]` | Continues resumable unfinished execution with its original input and scope. |
| `ccdd-project run cancel RUN_ID` | Cancels unfinished work in the execution. |
| `ccdd-project request list` | Lists individual review tickets. Supports `--run RUN_ID`. |
| `ccdd-project request show REQUEST_ID` | Shows review instructions, fixed input, actual result, and evidence. |
| `ccdd-project request claim REQUEST_ID --reviewer ID` | Reserves Try Claim, checks the local input/environment, and confirms the Human assignment on success. |
| `ccdd-project request tool REQUEST_ID --reviewer ID --tool NAME --args JSON` | Executes a registered tool for a claimed Human request. |
| `ccdd-project request submit REQUEST_ID --reviewer ID --result-file PATH` | Submits an actual Human verdict and evidence. |

Human tool execution uses the existing request's fixed input and registered tools. Verdict submission preserves the Broker's existing claim and input integrity checks.

## Supporting commands

- `graph [B]`: Inspects Artifact and Critic definitions and relationships.
- `config check`: Checks configuration declarations, references, and DAG structure.
- `doctor`: Diagnoses the actual execution environment and Provider connection, separately from ordinary status queries.
- `tools check`: Checks registered tools and diagnoses actual behavior with explicit `--execute`.
- `monitor`: An optional UI for current validation queries, history, and explicit Human actions.

HTTP monitor GETs remain a read boundary for stored definitions, observations, and review information. Preparing a current-input observation is separate from an ordinary GET. GETs do not evaluate config, execute review tools, or change review state.

## Output and exit semantics

- `status` shows whether current validation requirements are satisfied. It distinguishes PASS, unreviewed input, required revalidation, and evidence of actual RED. Use `run show` for execution errors and active tickets.
- `plan` shows reusable, ready, and prerequisite-blocked items per Critic. The plan describes the input and records at query time; a later execution captures and evaluates input again.
- `verify` separately returns reused verdicts, accepted reviews, and incomplete items. Successful asynchronous acceptance is not displayed as an Artifact PASS.
- If only some Critics succeed in an execution and the requested scope's full requirements remain unmet, it is reported as incomplete.
- Current Artifact queries and Run queries answer different questions. If the original changes after a Run reviews it, the Run's actual result is not shown as PASS for the current original.

Automation exit codes for `status` are 0=validation satisfied, 1=unsatisfied, and 2=query error. `plan` returns 0 for a valid plan even when it contains blocked items, or 2 when no plan can be produced. `verify --wait` and `run show --wait` use 0=requested scope satisfied, 1=RED, 2=ERROR, 3=wait timeout, and 4=incomplete. For a new execution without `--wait`, 0 means successful acceptance. If any scope is still running, retrieve the result to see the final verdict.

## Differences from the legacy CLI

- Legacy `ccdd status RUN_ID` queries execution history. The new commands distinguish current verdicts with `status B` from fixed execution records with `run show RUN_ID`.
- Legacy `ccdd run --critic C` runs a selected Critic while bypassing prerequisite validation. The new `verify --critic C` enforces prerequisites. This is not a compatibility change that silently alters the old command's meaning.
- Legacy full Graph Runs require GREEN results in the same Run. Reuse in the new commands is a separate Project Validation responsibility that confirms input identity against actual past verdicts and references those original verdicts.
- The existing `ccdd` executable is included in the Project package. The definition-only core package has no executable or execution dependencies.

## Input identity and state storage

An Artifact's default strategy is `{kind:'file-hash'}`, which recursively hashes its own `path`. `{kind:'file-hash',paths:['spec.md','references']}` replaces that default path set. The hash includes file content, relative paths, file types, executable permissions, and empty directories; creation or deletion of declared extra paths also counts as a change. Globs and symlinks are not allowed. Declare every input that affects an Artifact's meaning. Groups include member content identities but do not automatically require member validation as a prerequisite.

`{kind:'always'}` reviews Critics using that Artifact again for every new validation request. Reviews completed within the same request can satisfy prerequisites, preventing infinite recursive execution. Reviews affected by changing external conditions, such as models or services, can use this strategy or `--force` when needed.

A change to a Critic's profile, instructions, or tool definitions requires revalidation even if target and direct dependency hashes are unchanged. Functions in TS configuration can reference imported values, so all module hashes recorded during configuration loading are conservatively included. Editing shared TS configuration can therefore require revalidation of some otherwise unrelated Critics. When multiple verdicts exist for the same input, the latest actual verdict applies; an older PASS cannot hide a later RED.

The separate Project package stores data outside the repo, by default at `~/.local/state/ccdd/<normalized-repo-path-hash>/broker.sqlite`. Override the location with `--state-dir` or `CCDD_STATE_HOME`.

| Stored information | Contents |
| --- | --- |
| Actual verdict | Critic ID, GREEN/RED, evidence, completion time, and actual request ID |
| Verdict's validation input | Target hash, direct dependency hashes, and effective Critic definition hash at the time |
| Execution and ticket history | Fixed input, selected scope, assignment and execution state, and verdict references consumed by completed executions |
| Input and output files | Input copies at `workspaces/<hash>` and review output at `runs/<runId>/<requestId>` |

Current Artifact staleState and query results are not stored. Memoization that compares the latest verdict's input with current input exists only within one query. On a project with no history, `status` and `plan` do not even create a database. Historical reviews without validation input hashes remain readable but are not assumed to establish reuse.

Completed Runs retain fixed verdict references. A later successful review does not retroactively make an earlier incomplete Run successful. `run resume` on a terminal INCOMPLETE Run does not add omitted predecessor validations; submit a new `verify` or `verify --recursive` request.

The monitor's Current Input view sends an authenticated POST to observe configuration and files only when the user clicks **Inspect current input**. It displays the result in the browser with an observation time. Automatic GETs observe execution records without rechecking current input or creating verdicts.

## Implementation verification record

On 2026-09-07, Windows / Node 24.18.0 passed TypeScript and Vue type checks, the production build, and 50 tests covering Project Validation, DAGs, groups, the monitor, and distribution contracts. Actual Node test execution and Human submission paths verified recursive progress, individual incompleteness, latest RED, always, input hash changes, and reuse of earlier verdicts.

`npm run test:packages` checks file boundaries of the three tarballs and performs actual production installs for configurations using default tools and configurations using only custom tools. The runtime installation stays outside reviewed input; the installed SDK and selected text tool files are included in reviewed input. Both configurations passed actual tool execution, validation by a separate worker, and PASS reuse without new tickets. These checks neither generate substitute Provider verdicts nor launch desktop programs.

During v2.0.0 release preparation, an isolated Linux / Node 24.18.0 clone passed the build, all 302 tests, and both production installation and execution checks for the three tarballs. There were zero failed, cancelled, or skipped tests. The release commit's final verification results are recorded in the Release's `verification.json`.

The full Windows test suite still has failures caused by assumptions about Unix paths, symlink permissions, and process termination. Separately, copy-mode validation that included the entire production installation folder and all dependencies as reviewed input did not finish within five minutes. The workspace contract of checking all input remains unchanged; performance improvements for large snapshots are outside this change.
