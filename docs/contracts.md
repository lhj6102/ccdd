# Implementation contracts

Version 4 replaces global configuration with folder-owned Artifacts. `@ccdd/core` exports public definitions and a pure logical-path resolver; it has no runtime dependencies, CLI or database. `@ccdd/project` packages three bounded contexts: Project Validation, Broker and Executors. `@ccdd/default-tools` optionally supplies script tools. All packages target Node 22 LTS, 22.19.0 or later on that major line.

## Static folder declarations

A regular `ccdd.json` marks its containing folder as an Artifact. A root marker follows the same rule; it is never a workspace-wide configuration object. Discovery recursively searches `--repo`, excluding `.git`, `node_modules` and symlink directories. These discovery exclusions do not change whole-workspace integrity monitoring.

Allowed fields are `name`, `critics`, `views`, `mounts`, `basis`, `stale` and `envRequirements`. Unknown fields fail validation. Omitted Critics, views and mounts are empty. Names are unique across the workspace and match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. Critic IDs use that grammar locally and are unique within their owner. Public CLI, history and graph IDs are `artifact/local-critic`.

Critics declare `id`, `title`, `profile` and `payload.instruction`. Their target is the owner. Users do not declare `target` or `deps`. Agent, Human and Runtime profiles retain their existing evaluation contracts. A basis is an explicit accepted input with no Critics. An ordinary Artifact without Critics is UNREVIEWED, including an empty folder.

Discovery parses JSON and fingerprints declared files. It never imports JS/TS configuration, runs factories, executes a view or performs source preparation. Old global config files are not loaded. Config factories, `artifactTypes`, groups, generated Artifacts, sources and frozen JSON preparation are removed. There is no compatibility loader. See [the migration guide](migration-v4.md).

## Relationships and observation scope

Three relationships point from input Artifact to consuming Artifact:

1. The nearest marked descendants of a folder are automatic child dependencies.
2. `mounts: { "alias": "artifact-name" }` adds logical connections and dependencies.
3. References in each owner's Critic instructions add dependencies.

Unmarked subfolders are material of their nearest marked ancestor. Children retain their own config, views and Critics; none are merged into the parent. Repeated mounts share the same canonical Artifact identity and evidence. An alias that shadows another global name or an existing physical entry is rejected. Unknown targets and references are errors.

The existing `{artifactId}` instruction syntax resolves either an owner's mount alias or a workspace-unique name. Escapes are unchanged: `\{name}` and `{{name}}` display literal braces without creating a reference; JSON strings escape the backslash. Reference parsing never expands file contents. Agent instructions identify the actual registered tools, and Human instruction links select that canonical Artifact's Human tools. Unmatched braces remain ordinary text.

A review admits its target and explicit instruction references, plus their child and mount closure. A referenced Artifact's own Critic instructions do not silently grant further observation access. Each tool remains bound to its owner. Agent reviews require a successful content or empty observation for the target and explicit references; merely admitting a child or mount does not require observing it. Listings and launch receipts are not content observations.

`resolveScopePath(scope, artifactId, path)` follows child prefixes and mount aliases without creating filesystem entries. Every hop consumes path components, so a finite path terminates even through cycles. Absolute paths, traversal, empty path components and control characters are rejected. Default tools resolve logical paths before passing actual paths to ordinary programs. Custom scripts receive the same scope and may use the pure resolver exported by Core.

## Script views

`views.agentTools` and `views.humanTools` map local tool names to `{metadata, script}`. Metadata retains `description`, `inputSchema`, `resultKinds`, `observation`, optional `timeoutMs` and `executionPaths`. Descriptions may interpolate only `{artifactName}`. Artifacts are directories; a view selects any file inside its allowed folder scope. Installing a tool library registers nothing.

A script declares a fixed `command` and string `args`. There is no shell interpolation. Review arguments are validated against the registered JSON schema and sent to stdin as:

```json
{
  "version": 1,
  "context": {
    "artifactId": "service",
    "artifactPath": "/workspace/service",
    "outputDir": "/external/run/call/output",
    "tmpDir": "/external/run/call/tmp",
    "scope": {
      "service": { "path": "/workspace/service", "children": {}, "mounts": { "style": "coding-style" } },
      "coding-style": { "path": "/workspace/style", "children": {}, "mounts": {} }
    }
  },
  "args": { "path": "style/rules.md" }
}
```

The cwd is the tool owner's physical folder. `node` uses the current Node executable; bare programs resolve through installed `node_modules/.bin` from that folder to the workspace root, then PATH. Explicit executable paths resolve from the owner. Arguments never select a new executable. Imported script libraries and bundled runtimes must be covered by workspace-relative `metadata.executionPaths`; declarations hash their content. Unlike those shared runtime paths, `stale.paths` and environment paths are owner-relative.

Stdout must contain one existing `ToolResult` JSON value. Stderr is diagnostic output. A minimal result is:

```json
{"content":[{"type":"text","text":"Observed text"}],"observation":{"kind":"content"}}
```

Supported blocks are text, JSON, PNG/JPEG/WebP images and launch receipts. Actual result kinds must match metadata. Text/JSON output is bounded; images must contain valid supported bytes, at most 4 MiB. File image outputs must be regular files inside the external output directory, without symlink traversal; normalized results embed their bytes. A launch alone cannot claim a content observation. Successful normalization and observation persistence precede returning the result. Failed execution, malformed output or audit failure records no successful observation.

A script can explicitly return an author-controlled domain error on stdout **with exit 0**:

```json
{"isError":true,"content":[{"type":"text","text":"Unknown skill 16145"}]}
```

This opt-in result has exactly one nonblank text block (at most 64 KiB in UTF-8),
no observation and no extra fields. Error text is independent of successful
`resultKinds`, so even an image-only tool can report a domain error. Pi and MCP
receive it as a tool error, not an observation; it cannot satisfy required content
inspection. Audited calls and stored evaluation tool calls carry `isError: true`
without storing the error text. Human tools expose the same result and audit flag;
`tools check --execute` reports the domain error as a failed check.

Authors must deliberately choose safe public text. Never forward caught exception
text, stderr, credentials or environment values into this result. Nonzero exits,
crashes, malformed results and arbitrary stderr still use credential-safe generic
diagnostics, even if stdout contains an error-shaped value. Audit persistence
must succeed before an authored error can reach a reviewer.

This is an additive stdout/result contract, not a config or stdin schema change.
Existing success results, manifests and SQLite records need no migration. Changing
a script to opt in changes its mandatory execution input hash (and its consumers'
ValidationInput keys); no timing, error message or result flag enters content
identity. ValidationInput remains version 2; historical input versions remain
result-only. Coordinated releases already include the executor package version in
ValidationInput, so deployment changes do not silently reuse different executors.

Each invocation gets private external output, temporary, home and cache directories. Provider secrets and Node preload hooks are not inherited. Timeouts, cancellation, output limits and process-group cleanup remain mandatory. Main-process exit also cleans surviving descendants. Desktop launchers deliberately hand an application session to the reviewer; launch is not a verdict. Custom scripts are trusted workspace code, not an OS sandbox, and must honor their scope and keep input unchanged.

Stored manifests contain only serializable metadata and declarations. Execution rediscovers static config from the recorded workspace and requires an exact manifest/scope match. Static preflight lists definitions without invoking user scripts. Explicit `tools check --execute` exercises a real process. Blind A/B comparison is a user-script procedure, demonstrated in the [folder example](../examples/artifact-folders/README.md), not a presentation setting or special Executor.

## Input identity and evidence

Local material identity hashes content, names, entry types, executable bits and empty directories. Separate child Artifacts are hashed through their relations rather than twice as parent material. `.git` and installed `node_modules` are excluded from default Artifact material; the complete workspace still has its independent integrity proof. Declare used installed runtimes in `executionPaths`.

`stale: {"kind":"file-hash","paths":[...]}` narrows material to literal owner-relative files/directories, without globs. Missing selected paths have a distinct identity. Config, local view entry files and Runtime test entry files remain mandatory inputs. Environment scripts and their declared `inputs`, view execution inputs, and typed child/mount/instruction relations also participate. Dynamic imports or other files beyond these boundaries must be declared; mutable external services need an appropriate conservative strategy.

Strongly connected components group cycles into a finite condensation graph. Hash each component's sorted members, local identities, internal relationships and dependency-component hashes; derive each Artifact's identity from its canonical name and component hash. Changes to a referenced component invalidate its consumers. Unrelated Artifact changes preserve evidence. Neither review IDs nor completion times contribute to input identity. Repeating an unchanged review therefore does not invalidate consumers.

A version 2 ValidationInput combines the effective Critic definition, current target/dependency identities, executor package version, Node version/platform/architecture and integrity policy. `stale: {"kind":"always"}` permits only current-request evidence for that Artifact and its consumers. `--force` similarly requires a new review for selected Critics while preserving applicable dependency evidence.

Only actual semantic GREEN/RED results with the current input version are evidence. The latest semantic verdict for a matching input wins; RED is not hidden by an earlier GREEN. Operational ERROR is not a semantic verdict. Historical inputs remain queryable as stored results but never satisfy new inputs or resume execution.

A Critic's PASS describes its matching actual result. Final Artifact/project satisfaction separately requires every owned Critic and every required Artifact in the dependency closure. Explicit bases need no fabricated review. A cycle is not evidence: all non-basis members still need matching actual PASS results. Traversal uses visited sets and per-query memoization, with no persistent stale flag or invalidation queue.

## Selection and scheduling

Individual verification executes the selected Critic or the selected Artifact's Critics as soon as their input and execution environment are ready. It never waits for dependency PASS. `--recursive` includes Critics across the required dependency closure, including cycles. `--all` covers every Artifact. Multiple evaluations run concurrently within the Broker's executor limit.

Successful selected results are preserved if other required evidence is missing; the Run is INCOMPLETE. The same result can satisfy a later request after the remaining evidence arrives. Run status distinguishes review execution (`QUEUED`, `RUNNING`, `WAITING_HUMAN`, `ERROR`) from semantic results (`GREEN`, `RED`) and unfinished validation obligations (`INCOMPLETE`). No blocked or reused ticket is fabricated.

Project queries compare current input and actual evidence in a readonly transaction. They create no database, ticket, alarm or output and execute no scripts or Providers. Completed Runs reference the evidence they consumed, preserving their historical interpretation. `run show` and stored-result queries do not need the current workspace or reconcile owners. A terminal INCOMPLETE Run does not add omitted Critics when resumed; submit a new request.

## Workspace contract

All reviews and diagnostics use the supplied workspace directly. There is no
workspace mode option, input copy, publication cache, or remote snapshot transfer.
Git and commits are not required. Users may create a worktree themselves and pass
it with `--repo`. CCDD neither creates nor manages that worktree.

Every directory entry participates, including ignored/untracked files, `.git`,
dependencies, and empty directories. No implicit exclusion list is used. Keep the
entire workspace unchanged from admission through completion, including Human
waiting. Editors, build tools, and reviewers must write output outside that input.

CCDD monitors filesystem events and metadata, and by default verifies the full
content hash at action boundaries. Detected changes, including ordinary
edit-and-restore or create-and-delete, invalidate the review with `ERROR`, never
a semantic `RED`. Monitoring stays alive throughout Human waiting; a dead worker
invalidates its unfinished Run when inspected. A result retains its input hash,
but does not preserve old source after later edits.

The snapshot hash is SHA-256 over sorted relative paths, entry types, file
content hashes, executable permission bits, and relative symlink targets.
Timestamps, inode numbers and write-permission bits are excluded from content
identity but tracked separately for mutation detection. Internal relative
symlinks are supported; escaping, absolute, dangling symlinks and special files
are rejected. Config discovery does not follow symlink directories, and the default readers reject symlink file traversal.

CCDD state must be outside the workspace, including through symlinks. Review
output lives at `stateDir/runs/<runId>/<requestId>/`. Concurrent reviews can share
the unchanged supplied workspace and retain independent output directories.
This is cooperative local execution, not an OS sandbox. Event/metadata checks
cannot prove the absence of every adversarial transient write on every
filesystem. Unsupported monitoring fails closed.

`prepareWorkspace({repoPath,stateDir,integrity?,signal?})` returns
`{descriptor,signal,assertUnchanged,close}` without writing to the input or
creating a workspace cache. Version 2 descriptors have no `mode` and identify
the canonical supplied path as both `sourcePath` and `path`. Reopening checks
that same path and its recorded integrity proof. Historical review records remain readable, but Project version 4 never
resumes their execution or accepts their input keys as current evidence.

Acquisition validates input with its observer active. Human claims, registered
tools and results use that observer; user code is followed by a fresh integrity
boundary before accepting output. Resuming an already prepared Claim or
submitting a result performs no user code between acquisition and handoff;
Broker completion commits with authoritative transaction checks.

One observer owns at most one integrity scan at a time. Explicit assertions share
only a queued traversal that starts after their call; late callers wait for a fresh
successor batch. A metadata-only poll cannot satisfy a content-policy boundary.
Filesystem events still retry the active scan and changes remain latched.
Sequential boundaries remain fresh. Closing an observer drains its owned scan,
and waiting callers cannot restart work after closure or cancellation.

### Optional metadata integrity

Content integrity remains the default. `prepareWorkspace({...,integrity:'metadata'})`
explicitly selects a weaker policy for a cooperative local filesystem. The first
capture still hashes all input bytes. The descriptor additionally records
`integrity:'metadata'` and `structureHash`, the SHA-256 identity of the same ordered
entries with file-content fields removed. Old descriptors without `integrity`
retain strict content validation and their existing evidence identity.

When reopening a metadata-policy descriptor, CCDD registers the watcher before
inspecting every current path. Metadata tuples must match the full-capture
`baselineMetadataHash`, and names, entry types, executable bits, empty directories,
and symlink targets must match `structureHash`. Symlink containment checks still apply. Every subsequent boundary performs the same
complete metadata and structure traversal. No entry is ignored and no extra
certificate file is created. Ordinary edits, restoration, replacement, permission
changes, or structural changes invalidate the review; malformed or missing policy
proofs fail closed rather than silently enabling the optimization.
An explicit action boundary starts a fresh traversal after its call; it cannot
inherit a background scan that began before the action, even if notifications
have not yet arrived.

This policy assumes trusted persisted descriptors and metadata that reflects file
changes. It cannot prove unchanged file bytes across a process gap when the
filesystem reports unchanged metadata for different same-size contents, including
coarse timestamps or deliberately spoofed stat information. An unchanged metadata
tuple is not a cryptographic content proof. Keep content integrity on such storage
or whenever this weaker assumption is unacceptable.

`reopenWorkspace(descriptor,{integrity:'content'})` forces actual byte hashing at
acquisition and every boundary even for a metadata-policy descriptor. The returned
runtime handle reflects the effective content policy without mutating the stored
source descriptor. Reopening a strict descriptor with a metadata override is
rejected; an explicit new metadata-policy capture is required.

The Project CLI accepts `--integrity content|metadata` for `verify`, `status`, and
`plan`; the default is `content`. Nondefault integrity participates in the effective
Critic identity, so metadata-policy review evidence cannot satisfy a strict query,
and strict evidence is not silently substituted for a metadata-policy request.
The new validation-input version also separates version 4 evidence from historical keys.

## Broker and Executors

The Broker owns SQLite tickets, claims, events, results and process ownership. A request-scoped worker owns one Run. Only its live process identity/token may execute requests; cancellation and owner death become operational failures. Independent Runs can inspect the same unchanged workspace with independent external output. There is no daemon, automatic queue scanner or remote transfer service.

Runtime currently supports fixed `node --test` entry paths. Paths are owner-relative logical paths, including mounts; the Executor resolves them to real files and runs with the owner's cwd. Actual assertion failure returns RED; missing input, unsupported profile, process failure or broken execution is ERROR. Standard output and diagnostics are bounded. State, caches and temporary paths stay external through the supplied environment.

Agent execution uses Pi with the exact requested Provider, model and reasoning settings. The only admitted observation operations are scoped view tools. The original payload remains immutable; a digested instruction adds reviewer-specific tool references. The Agent must return the structured verdict, summary and evidence and satisfy required observations. No shell, arbitrary file access or hidden reasoning is persisted as review evidence. Authentication files remain outside the workspace.

### Final Agent response recovery

Pi validates the final assistant text as exactly one JSON value, at most 1 MiB in
UTF-8, against the supplied final schema. Invalid text receives a bounded category:
`empty` (including whitespace), `not_json`, `wrapped_json` (a JSON value inside a
single code fence or surrounding text), `schema_mismatch`, or `over_size` (also used for the existing normalized
256,000-character persisted review-result envelope limit).
Size is checked before parsing or wrapper detection. Wrapper detection only
classifies syntax; it never extracts or accepts a verdict. Even exactly one
surrounding `json` fence requires repair, preserving the strict final-result
contract instead of silently choosing a value from mixed content.

An invalid final result permits exactly one additional assistant turn in the same
Agent context, with the same Provider, model, reasoning and original execution
deadline. Executable tools are removed and transport requests normally set tool
selection to `none`; Anthropic retains only the historical tool definitions
required to serialize its existing tool-use/result messages. Bedrock requires
historical tool configuration and does not offer a compatible `none` choice, so
it retains wire definitions with `auto` while local execution remains disabled.
Even an unsolicited tool call
cannot invoke an observation or start another turn. No new evidence, semantic guidance or
preferred verdict is supplied. The fixed prompt is:

`Your final response did not match the required schema: <safe category and paths>. Return only one JSON value matching the schema.`

Schema details contain only up to eight distinct validator `schemaPath`/`keyword`
pairs (at most 160/40 characters each), stopping diagnostic traversal at eight
reported errors, including repeated array errors. This detailed traversal is
limited to simple object/array final schemas; composed or referenced schemas
receive category-only diagnostics to avoid TypeBox buffering nested errors.
Values with more than 256 object/array entries also use category-only diagnostics
to avoid keyword-local buffers such as unexpected-property lists. No instance paths, property names from the
response, parameter values, validation messages, parse errors or raw response
text are logged. The same bounded description appears in
`PROVIDER_RESULT_INVALID` if the repaired result is still invalid. Incomplete or
failed Provider messages retain their existing error classifications rather than
being treated as format errors. Exact response identity checks apply to the repair
as well. Cancellation and timeout remain operational errors, not verdicts.

The review schema includes nonblank summary/evidence strings, string length
bounds and evidence-count bounds, so those shape errors also reach repair.
An additional safe check preserves the existing UTF-16 code-unit length limits
(TypeBox uses graphemes) and applies the same normalized persisted-result size
check as the Broker, including tool-call metadata and the actual duration captured
for the accepted candidate. That exact duration is persisted, excluding subsequent
diagnostic-drain and cleanup latency. Immutable tool metadata is normalized and
its serialized size counted once across candidate inspections.
An envelope already too large because of immutable tool metadata cannot be
repaired by changing evidence; the one attempt still fails closed.
Only a strictly valid repaired response can proceed to ordinary result and required
observation checks. The verdict remains the model's own; CCDD does not rewrite it.
The original transcript exists only in memory for continuation and is reset when
the invocation ends. Successful final results are stored as before; invalid raw
responses and repair prompts are never stored.

Repair activity is diagnostic history, not an additional evaluation or evidence.
It does not alter ValidationInput version 2 or add repair state to reuse keys.
A coordinated release's executor package version already changes input identity;
do not deploy modified package contents under the existing published version.
No package version is changed by this feature patch. A repaired GREEN/RED result
is reusable under normal identity rules; an ERROR is never semantic evidence.
Reused evidence points to its original evaluation/run, whose audit events describe
the repair; a reuse-only run does not invent repair or usage events.
Human claims and result submission are unchanged and never invoke this repair.
The MCP observation-tool path is unchanged: it does not own Pi final responses.
Doctor uses the shared Pi invocation and may repair formatting, but its nonce and
actual-observation verification remain mandatory.

Human execution notifies an explicitly registered alarm and waits for a person's claim and result. CCDD never fabricates Human or Provider verdicts. The sections below retain the local lifecycle and integrity contracts.

## Human lifecycle

Claim is now asynchronous: an explicit claim action first creates a **Try Claim**
reservation while `claimedBy` remains empty. The client prepares the exact input,
runs the admitted Artifacts' environment scripts, and preflights its registered Human tools.
Only successful preparation confirms Claim. Local CLI and monitor actions use the
same preparation contract. Preparation failure or cancellation releases only that
attempt and returns a diagnostic to the reviewer; the request remains
WAITING_HUMAN with no semantic verdict and no request ERROR.

Try Claim stores an attempt ID, reviewer, and expiry (two minutes by default), and
is renewed during preparation. Begin, renew, confirmation, and release compare
the current attempt transactionally. Expired attempts cannot renew or confirm;
late releases cannot clear a newer attempt. Read projections treat expired
reservations as available without changing stored state. A subsequent explicit
begin action can retire them. Claim confirmation also checks the snapshot/config
identities and the complete set of admitted environment and tool readiness receipts.

Local preparation records the current phase, attempt ID, preceding attempt ID,
start/phase times, last heartbeat, and bounded completed phase timings in the
Broker. Existing input scans report file/byte progress at most once per second
plus scan boundaries; progress does not add a scan or bypass integrity checks.
Phases cover fixed-input validation, manifest verification, environment checks,
tool preflight, final input validation, and assignment confirmation. Claim
preparation renews its reservation and heartbeat while those checks run.

The latest attempt remains inspectable after release or confirmation. Monitor
GETs project its stored state, deriving expiry and elapsed time without changing
the reservation or executing code. The Human Claim panel shows phase, elapsed
time, heartbeat, scan progress, and phase timings. Released or expired attempts
show retry guidance; a subsequent attempt has its own identity and explicitly
references the preceding attempt. A delayed HTTP response does not keep an ended
attempt displayed as preparing. These diagnostics describe preparation, not a
viewer's rendering readiness or a semantic review result.

Each Artifact's `ccdd.json` may declare `envRequirements: { [id]: {description, script,
timeoutMs?, inputs?} }`. `script` is a safe path relative to the owning Artifact folder, pointing to a Node script. A zero
exit code means ready; other exits, timeout, or excessive output fail preparation.
The default timeout is 30 seconds (maximum 900 seconds). The script and additional
declared input hashes are part of Human effective definitions. Helpers/data read
by checks must be listed in `inputs`. Checks run only during explicit preparation,
never during GET, config loading, Project queries, or ordinary preflight listing.
They use the reviewer's allowlisted environment and external output/tmp paths,
with bounded diagnostics. Provider credentials and Node preload hooks are excluded.
Checks diagnose external dependencies; CCDD does not automatically install them.

The worker persists WAITING_HUMAN, invokes registered alarms, and records delivery. A local inbox writes to `stateDir/human-inbox.jsonl`; alarm failure causes ERROR.

Human waiting retains the monitoring worker. Another local CLI process can
inspect Artifacts, claim the request, and submit
`{reviewerId,result:{verdict,summary,evidence}}`. Only the claimant may complete
it and only once. Input integrity is revalidated at completion, and the existing
worker settles the selected scope using its saved execution configuration.

Human tool execution requires the active claimant and a WAITING_HUMAN request. The Broker reopens and validates the recorded workspace, matches stored Artifact definitions against its config, resolves registered tools, and validates workspace/claim again after execution. Only safe tool name, Artifact ID and operation metadata are persisted. Launch errors do not become RED or complete the review; input mutation invalidates the review with ERROR. Human result submission requires a nonempty summary and at least one nonblank evidence entry.

Human waiting keeps its worker and input monitoring alive. Human completion requires a live owner. Changes or owner death invalidate the review. Result files and notification output must be outside the reviewed workspace.

An idle Human wait uses the live filesystem observer and periodic metadata checks;
it does not perform a full content scan on each Broker scheduling iteration.
Under the default content policy, full content checks remain at acquisition,
execution/notification boundaries, explicit Human actions, and result submission. Metadata-policy input uses complete
metadata and structure checks at these boundaries after its initial full capture.
Human waiting time alone is not an execution boundary.

The observer schedules a fallback metadata check after the preceding fallback
finishes, with a delay of ten times that check's duration, at least one second and
at most thirty seconds. Filesystem events still request immediate checks. A
missed event can therefore take longer to appear as an operational error, while
the selected policy's checks before accepting explicit actions and results remain
unchanged. Closing, cancellation, or invalidation stops fallback scheduling.

## Diagnostics and monitor

`doctor` diagnoses readiness, not project quality. Runtime startup checks do not run project tests. Agent readiness performs a real Provider roundtrip and reads a private nonce through a private script Artifact outside the workspace. It never substitutes that result for project evaluation. Human readiness checks alarm registration without notifying a reviewer. `tools check` lists static tools; only `--execute` calls the selected script against monitored input.

The optional loopback monitor displays saved review state, owner overlays and folder locations. Graphs show owned Critics, containment, mounts, instruction edges and cycles. Waiting for execution is separate from missing final validation evidence. Explicit current-input inspection is a POST delegated to Project Validation; its answer is not stored as stale state. GET never evaluates config, executes scripts, reconciles workers or mutates stored review state.

Human claim, tool and result POSTs delegate to the Broker with origin/CSRF and browser-reviewer checks. Historical reviews are result-only: no live tool, claim, workspace preview or resume route. The monitor owns no execution scheduler. User-managed worktrees are accepted as supplied input; no transfer, copy or virtual filesystem materialization occurs.


### Execution telemetry

Request-scoped Broker event data carries execution diagnostics, not semantic evidence:

- `artifact.tool.completed`: `name`, `artifactId`, `operation`, `startedAt` (UTC),
  `durationMs` (monotonic elapsed milliseconds) and `outcome` (`success` or `error`).
  Timing starts after registered-tool/argument validation and includes executable
  resolution, process execution, result normalization and observation auditing. It
  excludes telemetry persistence. Registered invocations that fail, time out or
  abort still notify the Executor; a canceled or already terminal request does not
  accept late events. Invalid names/arguments never start a measured invocation.
- `human.tool.executed`: the same timing/outcome fields, saved only after workspace
  integrity and claimant checks, including ordinary execution failure. No timing
  is accepted after a lost claim or input-integrity failure.
- `executor.usage`: one event per completed, identity-validated Pi assistant message
  carrying `provider`, `model` and `usage`. Allowed counters are `input`, `output`,
  `cacheRead`, `cacheWrite`, `cacheWrite1h`, `reasoning` and `totalTokens`; only
  present nonnegative safe integers reported by Pi are retained. Missing/invalid
  fields are omitted, not estimated or replaced with zeros. Pi may itself report
  zero counters when the underlying Provider does not expose usage; these are not
  a claim of independently measured billing. Usage is emitted as each message completes, with pending writes drained when
  the Agent attempt settles, including a later Provider or final-schema failure.

- `executor.final.invalid`: bounded `attempt` (`initial` or `repair`) and `category`
  from the final-response categories above. Audit data deliberately omits schema
  paths as well as response content; safe schema paths are only used in the
  transient repair instruction and terminal diagnostic error.
- `executor.final.repair`: `outcome` (`started`, `succeeded` or `failed`), recording
  the one repair turn even when the eventual evaluation fails. The Broker accepts
  only those fields and fixed event messages, never arbitrary executor text.
  Provider usage includes the repair message's reported counters. These events
  use the same best-effort persistence and cancellation boundaries as other
  diagnostics; a started event without completion is not a claim of success.

`reasoning` is a subset of `output`, and `cacheWrite1h` a subset of `cacheWrite`;
never sum every field as disjoint counts. Provider cache accounting varies, so
CCDD retains Pi's reported total instead of computing one. It never records cost,
price estimates, raw responses, prompts or hidden reasoning for telemetry.

Broker run views and readonly `run show`/stored-run queries expose safe event data.
Their existing latest-500-event window remains unchanged: this is diagnostic
history, not an exhaustive billing ledger. No aggregates are fabricated for reused
evidence, Runtime execution or older runs that lack telemetry.

Telemetry is never added to Artifact/SCC hashes, ValidationInput, reuse keys,
`ReviewResult.toolCalls` or the Project's semantic `ValidationEvidence` projection.
It adds only event types and JSON payload fields in existing SQLite storage;
no schema/identity version or data migration is needed. Existing stored state and
its evidence remain valid under the existing executor-version identity rules.

Telemetry persistence is best-effort, independent of successful observation delivery.
Rejected or unresponsive optional sinks do not change the evaluation verdict,
status or evidence reuse. Writes have a separate 100 ms bound, run independently,
and do not consume a completed evaluation's deadline. One fixed-text
`executor.telemetry.failed` event reports incomplete diagnostics when storage is
still available; no system can guarantee that warning if its event store itself
is unavailable. Underlying callbacks cannot be forcibly canceled, so consumers
must also bound their own I/O. User cancellation still applies during the bounded
drain. Existing mandatory observation/Human execution audit failures remain
operational failures; that preexisting evidence requirement is not telemetry.
