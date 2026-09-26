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

Arguments must remain an object of at most 64 KiB. Schema mismatches normally return
the first five TypeBox validation errors, bounded to 4 KiB of UTF-8 text, with instance
JSON Pointer paths, keywords and short reasons. The empty pointer `""` means the
root object. Missing and unexpected/invalid property names accompany the parent
object path. Names are JSON-quoted, individually bounded and marked when truncated;
additional diagnostics or property names are explicitly marked as omitted. If
TypeBox's unescaped path matches several actual locations, escaped alternatives
are reported rather than choosing one arbitrarily. To avoid TypeBox's exhaustive
error-generation costs, invalid arguments with arrays over 512 items or more than
2048 visited JSON nodes instead receive an explicit diagnostic-budget notice
(with the array path when available). This limits diagnostics, not admission:
valid arguments within 64 KiB still pass regardless of those diagnostic budgets.

These runner-owned diagnostics never echo argument values, raw TypeBox messages,
or arbitrary error parameters. Pi returns them as tool errors so the reviewer can
correct its call; MCP returns the same text with `isError: true`. The shared safe
failure mapper recognizes only errors actually created by argument validation,
not matching exception text or a caller-supplied error code. Invalid arguments do
not execute the script, record observations or start execution telemetry. The
non-object/oversize guard and credential-safe handling of unrelated errors are
unchanged.

The cwd is the tool owner's physical folder. `node` uses the current Node executable; bare programs resolve through installed `node_modules/.bin` from that folder to the workspace root, then PATH. Explicit executable paths resolve from the owner. Arguments never select a new executable. Imported script libraries and bundled runtimes must be covered by workspace-relative `metadata.executionPaths`; declarations hash their content. Unlike those shared runtime paths, `stale.paths`, identity entry/input paths and environment paths are owner-relative.

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

This stdout/result contract does not change script stdin. Under default identity,
changing a script changes its execution input hash and consumer keys. Under
owner identity, the returned value alone controls the local identity. Timing,
error messages and result flags do not contribute to identity. ValidationInput
is version 3 and has no package/runtime version salt.

Each invocation gets private external output, temporary, home and cache directories. Provider secrets and Node preload hooks are not inherited. Timeouts, cancellation, output limits and process-group cleanup remain mandatory. Main-process exit also cleans surviving descendants. Desktop launchers deliberately hand an application session to the reviewer; launch is not a verdict. Custom scripts are trusted workspace code, not an OS sandbox, and must honor their scope and keep input unchanged.

Stored manifests contain only serializable metadata and declarations. Execution rediscovers static config from the recorded workspace and requires an exact manifest/scope match. Static preflight lists definitions without invoking user scripts. Explicit `tools check --execute` exercises a real process. Blind A/B comparison is a user-script procedure, demonstrated in the [folder example](../examples/artifact-folders/README.md), not a presentation setting or special Executor.

## Requester results and audit lookup

**5.0: breaking default output change.** Requester
results are compact by default. This is not a 4.x-compatible change; existing
callers that consume audit fields must explicitly request full detail.

A completed requester result contains `verdict`, owner-defined response fields,
and `reference: {runId, requestId, stateDir}`. A reused result in a Run also has
`reusedFrom` pointing to the original reference. There are no built-in summary,
reason or evidence fields. `stateDir` is an absolute local state location, not a
URL or credential. Request wrappers retain IDs, inputKey, status and operational
errors. Run wrappers retain status, workspace integrity and projected validation.
An unfinished request has `result: null`; Run-level references use `requestId: null`.

A compact Run, query or plan emits each result exactly once in its top-level
`results` array. Its request, Critic and plan-item entries use `result: {requestId}`
references rather than repeating owner text. A standalone request contains its
result directly. A Run's nested validation has no second results array.

Resolve a reference using `projectRun(reference.stateDir, reference.runId)` or
`ccdd-project run show RUN_ID --state-dir STATE_DIR --json`; find the request by
ID in `requests`. These readonly audit queries always return full detail and do
not need the current source or an Executor. Reused/coalesced results point to the
original request; no duplicate review ticket is fabricated.

`toolCalls` (all calls, arguments and observation receipts), criteria/payload,
config/input snapshots, timestamps, ownership, stdout/stderr and telemetry stay
in the stored audit. Projection never rewrites these records. Required-observation
checks run before projection; missing observations fail with ERROR. The explicit
overall result-size limit still fails oversized results rather than silently
dropping calls. There is no tool-call count truncation.

### Owner response schemas

A Critic may declare `passSchema` for GREEN and `failSchema` for RED. Both are
optional JSON Schema objects describing additional top-level fields. Without a
schema for that verdict, only `{"verdict":"GREEN"}` or `{"verdict":"RED"}`
is accepted. CCDD adds the required verdict field to the selected schema.

```json
{
  "failSchema": {
    "type": "object",
    "properties": {
      "reasons": { "type": "array", "items": { "type": "string" },
        "description": "Concrete reasons the criteria were not met." }
    },
    "required": ["reasons"],
    "additionalProperties": false
  }
}
```

Schemas use the same supported object JSON Schema dialect as tool arguments.
Top-level `additionalProperties` must be omitted or false. Top-level composition
(`allOf`, `anyOf`, `oneOf`, `not`) is rejected at config load; composition inside
owner-defined properties is allowed. `$ref` and conditional keywords are not
part of the supported dialect. `verdict`, `reference`,
`reusedFrom`, `provider`, `model`, `stdout`, `stderr`, `durationMs`, `exitCode` and
`toolCalls` are reserved. Owner fields are preserved without semantic rewriting
or string/count truncation. Overall transport limits remain explicit errors.
Agent and Human results use the same verdict-specific schema. An invalid Agent
final response receives at most one format-only repair turn; Human submissions
are rejected for correction, never automatically rewritten. Runtime results are
verdict-only (plus stored process audit); schemas requiring extra Runtime result
fields cannot be fulfilled by the built-in Runtime executor.

Public requester surfaces:

- `createBroker({repoPath, stateDir, ...})`: compact results from submission,
  execution, Run/request reads and lists, cancellation/failure, and Human
  claim/completion. Set `detail: "full"` on the Broker for its previous full
  execution envelopes. Workers and Human-action adapters opt into this mode.
- `inspectProject(...)`: `{plan}` by default; `detail: "full"` returns
  `{snapshot, plan}` with the full internal semantic evidence projection.
- Public `queryProject` / `planProject` require `{stateDir, ...options}` to make
  evidence references resolvable; `detail: "full"` preserves the internal query
  shape. Their history input is `projectHistory(stateDir, {detail: "full"})`, not
  compact requester history. Internal Project Validation queries remain full.
- `projectHistory(stateDir, options?)`, `projectRuns(stateDir, options?)`, and
  `projectRequests(stateDir, runId?, options?)` default to compact; pass
  `{detail: "full"}` to restore their stored/semantic views. `projectRun` is the
  full-audit lookup and does not need an option.
- CLI `verify`, `status`, `plan`, `history`, `request`, Run lists and actions use
  compact output, including plain text. `--full` restores the detailed payload;
  `run show` always displays full JSON even without `--json`. Full status/plan
  and history retain their existing semantic evidence shapes, not inline tool
  traces: use the referenced Run for complete audit details.
- Monitor current-input queries and verdicts use compact results; explicit
  request-detail pages still include reviewer instructions and operational UI
  metadata. Their results carry the same audit references. Artifact MCP serves
  observation tools only, not requester review results; its tool protocol and
  audit recording are unchanged.

CCDD 6.0.0 requires a fresh state directory: all store entry points reject
previous-major/unmarked state without reading or migrating its records. ValidationInput
version 3 is a one-time key transition; package/runtime version changes alone do
not invalidate identity thereafter. See [migration](migration-v5.md).

## Input identity and evidence

Local material identity hashes content, names, entry types, executable bits and empty directories. Separate child Artifacts are hashed through their relations rather than twice as parent material. `.git` and installed `node_modules` are excluded from default Artifact material; the complete workspace still has its independent integrity proof. Declare used installed runtimes in `executionPaths`.

`stale: {"kind":"file-hash","paths":[...]}` narrows material to literal owner-relative files/directories, without globs. Missing selected paths have a distinct identity. Config, local view entry files and Runtime test entry files remain mandatory inputs. Environment scripts and their declared `inputs`, view execution inputs, and typed child/mount/instruction relations also participate. Dynamic imports or other files beyond these boundaries must be declared; mutable external services need an appropriate conservative strategy.

### Owner-defined identity

An owner can replace all automatic local identity inputs with an opaque equivalence string:

```json
"stale": {
  "kind": "identity",
  "script": { "command": "node", "args": ["identity.mjs"] },
  "inputs": ["identity-rules.json"],
  "timeoutMs": 30000
}
```

Only `kind`, `script`, optional `inputs` and optional `timeoutMs` are accepted; a script accepts only `command` and `args`. Unknown fields fail configuration validation. `inputs` is a list of at most 64 unique owner-relative literal paths (files or directories, no globs); omission and an empty list are allowed. Entry files and inputs cannot escape the owner or traverse symlinks. Internal relative symlinks within a declared input directory follow the same rules as execution inputs. Inputs must exist.

Supported commands are `node` with an owner-relative entry file as the first argument (additional arguments are passed to that script), or an owner-relative executable whose command path is itself the entry file. `node` uses the current Node executable and the environment-script import host. Inline `-e`/`-p`, flags before the Node entry, absolute executable paths and PATH interpreter lookup are not supported: every identity must have a scoped entry file. Other interpreters may be invoked through an owner-provided executable entry. Declared `inputs` are scoped and checked for existence, but neither their contents nor the entry file are automatically hashed. Include their relevant semantics in the returned identity value.

Scripts use the environment-requirement executor: owner cwd, a credential-filtered environment, external temporary/output directories, bounded output, process-group cleanup, cancellation and a timeout. `timeoutMs` is an integer from 1 to 900000, default 30000. Temporary output is removed after each invocation. The workspace must remain unchanged; the normal workspace integrity checks still apply. These are trusted owner scripts, not an OS sandbox, and must treat the workspace as read-only.

Stdout must contain exactly 1–128 characters from `[A-Za-z0-9._:-]`, optionally followed by one LF newline. Empty output, whitespace, CRLF, extra lines, invalid bytes, excessive output, a nonzero exit or timeout fail current-input validation with an Artifact-specific error. No default-identity fallback occurs. Stderr is not part of the value and is not forwarded as an identity diagnostic.

The own hash is `inputHash({id, value})`, where `value` is stdout without its
optional final LF. Only the owner's value and Artifact ID participate locally.
No Artifact/Critic definition, identity script, declared input, tool/profile,
environment, criteria, integrity policy, package version or runtime version is
automatically mixed back in. The owner must encode every distinction that should
invalidate review in the returned value. Identical output deliberately permits
reuse despite such changes. Safety, scoping and workspace-integrity checks still
run; identity does not bypass execution safety.

Dependency identities and cycle connectivity still propagate. A changed required
dependency invalidates its consumers. Default identity retains material,
configuration, owned Critic definitions, declared execution/environment inputs
and integrity policy coverage; only package/runtime version salts are removed.

Current `plan`/`status` and saved Run validation artifacts expose `identity: "script"` and `value`, in JSON and plain text. Run snapshots retain `artifactIdentities` so even a fully reused Run records the equivalence decision. Stored Run queries never re-execute the identity script. Current-input preparation computes identities and validation inputs only for the selected targets and their dependency closure; JSON and plain-text validation output use that same scope. A whole-project selection prepares every Artifact. Scoped hashes are identical to the corresponding whole-project hashes. Preparation does execute opted-in identity scripts, including for `status`/`plan` and explicit monitor inspection, but static `config check`, `graph`, config discovery and monitor GETs do not. Foreground CLI preparation handles SIGINT/SIGTERM through cancellation: it terminates identity process groups, removes disposable output and exits with code 2 and `Project validation cancelled.`. Replay-validated reuse and tool-result replay receipts are separate ideas, not part of this mode.

Strongly connected components group cycles into a finite condensation graph. Hash each component's sorted members, local identities, internal relationships and dependency-component hashes; derive each Artifact's identity from its canonical name and component hash. Changes to a referenced component invalidate its consumers. Unrelated Artifact changes preserve evidence. Neither review IDs nor completion times contribute to input identity. Repeating an unchanged review therefore does not invalidate consumers.

A version 3 ValidationInput key is `inputHash({version: 3, criticId, target, deps})`: only the Critic ID and current target/dependency Artifact identities are inputs. Default Artifacts carry definition and integrity coverage inside their identities; owner Artifacts use their returned values. Package version, Node version, platform and architecture are not automatic salts. `stale: {"kind":"always"}` permits only current-request evidence for that Artifact and its consumers. `--force` similarly requires a new review for selected Critics while preserving applicable dependency evidence.

Only actual semantic GREEN/RED results with the current input version are evidence. The latest semantic verdict for a matching input wins; RED is not hidden by an earlier GREEN. Operational ERROR is not a semantic verdict. Matching GREEN and RED are both reused without executing again. RED remains unsatisfied. Use `--force` for a fresh review; ERROR is never reused. State from 4.x is rejected on opening; use a fresh state directory.

A Critic's PASS describes its matching actual result. Final Artifact/project satisfaction separately requires every owned Critic and every required Artifact in the dependency closure. Explicit bases need no fabricated review. A cycle is not evidence: all non-basis members still need matching actual PASS results. Traversal uses visited sets and per-query memoization, with no persistent stale flag or invalidation queue.

## Selection and scheduling

In 6.0, selected Critics execute only after dependency Critics outside the same SCC have current GREEN evidence, unless `ignoreGates` / `--ignore-gates` is explicit. Basis/no-Critic dependencies do not gate. RED yields BLOCKED; operational failure yields WAIT_DEPENDENCY, without executing or fabricating a child verdict. SCC peers execute together after external gates pass. `--recursive` includes Critics across the required dependency closure, including cycles. `--all` covers every Artifact. Multiple evaluations run concurrently within the Broker's executor limit.

Successful selected results are preserved if other required evidence is missing; the Run is INCOMPLETE. The same result can satisfy a later request after the remaining evidence arrives. Run status distinguishes review execution (`QUEUED`, `RUNNING`, `WAITING_HUMAN`, `ERROR`) from semantic results (`GREEN`, `RED`) and unfinished validation obligations (`INCOMPLETE`). No blocked or reused ticket is fabricated. Identical active Critic/input requests across Runs in the same state directory coalesce: the follower waits for and adopts the original request result. Its cancellation does not cancel the source. Source cancellation/error fails the follower without fabricating a verdict. A
follower never executes or hosts another Run. It coalesces only onto a request
with a live Run owner, or an unowned QUEUED request inside its submission grace
lease. `createBroker({coalescingGraceMs})` configures that lease for newly submitted
Runs (integer 0–300000 ms). The default is 15000 ms: enough for the CLI worker's
15-second startup budget while bounding abandonment; normal SDK/CLI callers
start within milliseconds. The persisted source Run's submission time and lease
control eligibility, not the follower's configuration or arrival time. Zero grace
disables unowned coalescing. Invalid/missing lease metadata or a future submission
time expires eligibility immediately. Each Broker also bounds observed remaining
grace with a monotonic deadline, so a wall-clock rollback cannot prolong its wait.

When the lease expires without an owner, the follower removes that shared
reference and replans inside a write transaction. It first checks for another
owned/leased matching active request; otherwise it creates a ticket in its own
Run. Racing followers therefore share one execution. The abandoned source's
records remain untouched. If its caller later runs it, its already-queued ticket
may execute again (even if matching evidence now exists); cancel abandoned Runs
rather than revive them when that is not desired. New submissions reuse matching
GREEN/RED evidence normally. A dead source worker is reconciled as WORKER_EXITED;
partial execution is not replayed. `--force` opts out of both stored-result reuse and active coalescing.

Current-input inspection (`inspectProject`, CLI `plan`/`status`, and explicit
monitor inspection) reads completed evidence and matching active requests in one
readonly transaction. Plan items use `COALESCE` when submission would adopt an
active request instead of creating a ticket. The item's existing `requestId`
identifies that source; an unowned leased source additionally has
`leaseExpiresAt`, the ISO UTC submission-time-plus-grace deadline. Compact output
keeps only these references, not a source envelope or duplicate result. The
`counts.coalesce` counter counts these items; `counts.execute` counts only new
executions. `ACTIVE` continues to describe attempts already attached to a saved
Run, not prospective adoption by a new submission. Forced Critics remain
`EXECUTE`. Matching completed evidence still takes precedence as `REUSE`.

Inspection and submission share candidate matching/order and one Broker-owned
eligibility function: matching version-3 Critic/input, nonterminal source Run,
live PID/process-identity owner, or unowned QUEUED source within its valid lease.
Owned RUNNING and WAITING_HUMAN requests are also eligible. Inspection performs
only the liveness check: a dead owner is treated as ineligible as if reconciled,
but no status, owner, event or scheduling revision is written. Submission still
persists WORKER_EXITED and removes the dead owner's token under its transaction.
Zero grace, future/invalid timestamps and invalid/missing lease metadata fail
closed in both paths.

A plan is a point-in-time quote, not a reservation. Source completion, owner
exit, lease expiry, or clock changes before submission can change the answer.
`leaseExpiresAt` is the wall-clock upper bound; a waiting Broker additionally
retains its own monotonic bound, which can expire sooner after clock rollback.
A fresh readonly inspection has no access to another Broker's process-local
lease observations and never renews or persists a lease. Pure `planProject`
continues to use only its supplied history/attempts; use `inspectProject` for a
current-state coalescing quote.

Project queries compare prepared current input and actual evidence in a readonly transaction. They create no database, ticket or alarm and execute no review tools or Providers. Preparing an opted-in owner identity runs its script with disposable external output; other current-input preparation remains script-free. Completed Runs reference the evidence they consumed, preserving their historical interpretation. `run show` and stored-result queries do not need the current workspace or reconcile owners. A terminal INCOMPLETE Run does not add omitted Critics when resumed; submit a new request.

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
that same path and its recorded integrity proof. Only the current major state format is accepted; 4.x state is neither read nor migrated.

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
`plan`; the default is `content`. Default Artifact identity includes integrity policy, so content and metadata
reviews have distinct keys. Owner identity controls this distinction itself;
encode policy in its value when reviews should not be considered equivalent.
Execution safety always enforces the requested policy independently of reuse.

## Broker and Executors

The Broker owns SQLite tickets, claims, events, results and process ownership. A request-scoped worker owns one Run. Only its live process identity/token may execute requests; cancellation and owner death become operational failures. Independent Runs can inspect the same unchanged workspace with independent external output. There is no daemon, automatic queue scanner or remote transfer service.

Runtime currently supports fixed `node --test` entry paths. Paths are owner-relative logical paths, including mounts; the Executor resolves them to real files and runs with the owner's cwd. Actual assertion failure returns RED; missing input, unsupported profile, process failure or broken execution is ERROR. Standard output and diagnostics are bounded. State, caches and temporary paths stay external through the supplied environment.

Agent execution uses Pi with the exact requested Provider, model and reasoning settings. The only admitted observation operations are scoped view tools. The original payload remains immutable; a digested instruction adds reviewer-specific tool references. The Agent must return the structured verdict and any owner-schema response fields and satisfy required observations. No shell, arbitrary file access or hidden reasoning is persisted as review evidence. Authentication files remain outside the workspace.

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

The verdict-specific owner schema governs result fields and descriptions; CCDD
adds no summary/evidence requirements. The same normalized persisted-result size
check as the Broker includes tool-call metadata and the actual accepted duration.
Immutable audit metadata is normalized and counted once across inspections.
An envelope already too large because of immutable tool metadata cannot be
repaired by shortening owner fields; the single repair still fails closed.
Only a strictly valid repaired response can proceed to ordinary result and required
observation checks. The verdict remains the model's own; CCDD does not rewrite it.
The original transcript exists only in memory for continuation and is reset when
the invocation ends. Successful final results are stored as before; invalid raw
responses and repair prompts are never stored.

Repair activity is diagnostic history, not an additional evaluation or evidence.
It does not add repair state to version 3 reuse keys. Package/runtime version
changes alone do not invalidate identity.
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
`{reviewerId,result:{verdict,...ownerFields}}`. Only the claimant may complete
it and only once. Input integrity is revalidated at completion, and the existing
worker settles the selected scope using its saved execution configuration.

Human tool execution requires the active claimant and a WAITING_HUMAN request. The Broker reopens and validates the recorded workspace, matches stored Artifact definitions against its config, resolves registered tools, and validates workspace/claim again after execution. Only safe tool name, Artifact ID and operation metadata are persisted. Launch errors do not become RED or complete the review; input mutation invalidates the review with ERROR. Human result submission validates the selected owner response schema exactly. The monitor accepts additional fields as a JSON object; it rejects invalid or oversized input and never truncates it.

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
within current-format (5.0) state, no schema/identity change or migration is
needed for telemetry. Only current-format state and its evidence remain valid
under Artifact-identity reuse rules; 4.x directories are rejected, not migrated.

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

Tool completion payload counters (`artifact.tool.completed`, and
`human.tool.executed` for Human calls) include `contentBytes` and
`contentBytesByType` with `text`, `json`, `image`, and `launch` counters. The total
is the sum of those counters across every normalized response block. Text uses
UTF-8 bytes; JSON uses UTF-8 bytes of its serialized data; images use decoded
binary bytes (not base64 transport overhead); launch uses the serialized
`{"kind":"launch","launched":true}` observation shown to the provider. Counts
exclude protocol framing and observation metadata. Author-controlled errors count
their returned text; failures with no validated response count zero. These are
optional operational diagnostics only, never identity, reuse keys, or verdicts.

### Temporary output and explicit pruning

Artifact tool registries own their `tool-output-*` directory and, when no run
root is supplied, the enclosing `ccdd-tools-*` temporary root. They remove these
on close, abort, and failed initialization. Callers must close registries in a
`finally` block after successful or failed calls. Output files remain usable
until that close; normalized image responses have already loaded their bytes.
Caller-supplied run roots are never removed by registry cleanup.

Automatic history pruning is **off**. Invoke `pruneProject(stateDir)` from
`@ccdd/project`, or `ccdd-project prune --state-dir PATH [--json]`, to remove
transient output explicitly. Only terminal requests in terminal runs with no
worker owner are eligible. The operation removes these known request subtrees:
`output`, `tmp`, `home`, `cache`, `human-tools`, `preparation`, and `tool-output-*`.
It skips active, waiting, queued, and owned runs, does not traverse directory
symlinks, and never scans unrelated system temporary directories. Unknown paths,
worker files, stored results, request records, events, and tool-call audit remain
untouched. The SQLite store is never vacuumed or truncated. Keep an application
file outside these declared scratch subtrees if it must remain as audit evidence.

Explicit pruning is currently **Linux-only** and requires `/proc/self/fd`.
Other platforms fail closed before deletion; ordinary owned temporary-root
cleanup remains cross-platform. Prune pins the state root and opens each run and
request directory through a parent descriptor using `O_DIRECTORY|O_NOFOLLOW`.
Consequently, replacing a checked parent pathname with a symlink cannot redirect
scratch deletion. Each scratch entry is atomically moved into a private mode-0700
quarantine, then its device/inode is compared with the pre-move identity before
any recursive removal. A mismatched entry is **preserved** in quarantine and the
operation fails with its recovery path; it is not restored over a potentially
replaced source. Quarantines left after failure/crash require manual inspection,
not automatic deletion. A failed or crashed prune may also leave a
`prune_claims` row whose `id` is the quarantine directory name (for example,
`.prune-Ab12Cd`). Rerunning prune does not recover that directory or clear its
claim. After verifying that its prune process has stopped, inspect and recover
any required files, then manually remove the quarantine and delete only its
matching row from `broker.sqlite` with a parameterized
`DELETE FROM prune_claims WHERE id = ?` using that exact directory name. An
interrupted transaction may have rolled the row back; deleting an absent claim
is harmless. Do not clear claims belonging to active prune operations.
This assumes the state root and private quarantine are
trusted; it is not isolation against another process with the same account or
root privileges deliberately modifying quarantine contents.

Eligibility checks, the operational `prune_claims` record, and quarantine moves
use short per-request transactions. Terminal runs cannot restart; nonterminal or
owned runs cannot be claimed for pruning. Bulk recursive removal happens after
commit, without holding SQLite's global writer lock, so other runs can persist
results during slow deletion. Completed audit tables are never modified by prune.
General bounded retry of result persistence on unrelated `SQLITE_BUSY` contention
is a separate follow-up; this operation does not extend database lock time across
delete latency.

Scheduler regression coverage measures the actual Broker loop: unchanged Human
waiting ticks hydrate zero JSON bytes and invoke no planner, including ownership
polling. A separate process submits a Human completion through the public Broker
API and the waiting worker settles successfully. The consumer-sized SQL helper
comparison (1,086,059 versus 51 returned bytes per tick) is only a microbenchmark,
not a measurement of complete scheduler work or physical disk I/O.

Coalesced followers use the same lightweight status revision as other idle Runs.
Their unchanged idle ticks hydrate zero JSON bytes and make zero plans. A cached
monotonic deadline additionally wakes planning at the earliest pending unowned
source lease expiry, even without a status revision. It bounds the existing
lightweight wait timer; it does not restore full-record polling. Source-owner
death is checked without JSON hydration and reconciled without replay. Polling
and prune database entry points reject non-current state before table changes.

## Concurrency controls

`createBroker({ maxConcurrentExecutors })` accepts a positive safe integer,
with default 4, limiting non-Human executions **per Run**, not across Brokers or
Runs. Human preparation/alarms do not consume these slots. Project verify CLI
accepts `--concurrency N` and persists it in worker configuration so detached
execution and resume retain the choice. These scheduling options are not reuse
identity inputs.

Owner identity scripts run with a separate bounded pool, default 4.
`inspectProject({ identityConcurrency })`, `createBroker({ identityConcurrency })`
and `broker.submitProject({ identityConcurrency })` accept a positive safe
integer; a submission override wins over the Broker default. Direct snapshots
accept an optional seventh argument `{ identityConcurrency }` after selection.
CLI status/plan/verify use `--identity-concurrency N`. Use 1 for sequential
execution. Owner values are assembled in Artifact order, so successful snapshot
keys and identity presentation are independent of script completion order.

The bound applies to owner identity invocations within one snapshot call. It is
not a global process limit: an identity script that starts P child processes
allows about `identityConcurrency × (1 + P)` processes, plus their threads, and
concurrent inspect or submit calls each have their own pool. Consumers with
heavy identity probes should start with a small value.

Each script retains its own timeout. Cancellation or any script failure cancels
in-flight peers, stops dispatching queued owners, and awaits their cleanup before
rejecting. No partial snapshot, fallback identity or review Run is returned.
Identity scripts must compute their values independently; parallel scheduling
does not provide synchronization for owner-created shared side effects.


## Normalized state and live requester changes (6.0)

State format 6 is fresh-only: no migration or compatibility path. Definitions, prepared inputs, workspace descriptors and audit results are immutable content-addressed nodes. Mutable Run/request records contain small lifecycle headers and references. Requests are indexed by readiness and identity. Membership counters and reverse gate edges drive status transitions; no full plan or definition hydration is required for an isolated transition. Event rows are append-only.

`broker.changes(runId, {after: 0, limit: 100})` returns `{runId,status,cursor,hasMore,changes}`. Each change has its monotonic cursor, requestId, criticId, status, optional compact semantic result/reference, and operational error fields. Drain pages until `hasMore` is false, then retain the returned cursor. A rolled-back transition creates no visible cursor. Telemetry notifications can wake `onChange` without adding lifecycle changes; querying the cursor then returns an empty page. Returned values are detached from stored state. The cursor is scoped to this local state database, not an identity/reuse key.

Use `onChange` to schedule a coalesced cursor drain, not `getRun` on each telemetry event. Compact `getRun`/`listRuns` are whole-Run snapshots with O(returned membership) work; they omit definition/audit hydration but are not constant-time streaming APIs. Full audit is loaded explicitly behind result references. Readonly monitor access remains readonly.

`broker.retryRequest(id)` requeues only ERROR against the same immutable input after its worker settles. Dependent WAIT_DEPENDENCY requests receive no verdict and release once the retry is GREEN. Changed source input requires a new submission and is re-planned under its new identity; an existing Run never silently changes its snapshot. Blocked reused descendant evidence remains auditable but is not current satisfaction. `--force` does not bypass gates.

The admission boundary follows dependency readiness and precedes QUEUED-to-RUNNING. An optional `Admission.acquire({requestId,runId,kind,provider?,model?}, {signal,waiting})` returns a lease with idempotent `release()`. Waiting reports a bounded QUEUED admission reason, supports cancellation, and releases a late-acquired slot or any terminal execution path. The default is FIFO local admission at maxConcurrentExecutors. Machine-wide provider pools and holder leases are reserved for 6.1, not implemented here.

Gate construction uses only direct edges of the SCC condensation, not a materialized transitive closure. BLOCKED and release states propagate through those edges; SCC peers share external gates. Construction visits each Artifact relation once plus emitted Critic gate references. Transitions visit affected memberships/edges, independent of unrelated Run/project size. Multiple Critics on an Artifact still require one obligation per dependency Critic.

Telemetry remains a bounded synchronous SQLite append in 6.0; there is no off-thread drain. It never rewrites Run/request definitions or advances the lifecycle changes cursor. `blockedReason` in a changes page reflects the current request state, not a historical reason-at-cursor snapshot.
