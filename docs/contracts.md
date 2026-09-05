# Implementation contracts — v0.8

One npm package, strict TypeScript compiled to Node 24 ESM, local SQLite persistence. Broker and Executors remain separate bounded contexts. A request-scoped worker runs one Run; no daemon, global broker-owner lock, or automatic queue scanner is required. The optional local monitor observes persisted requests and delegates explicit Human actions to the Broker. It does not own review execution.

## Workspace contract

`run` requires exactly one CLI flag: `--copy` (recommended) or `--lock`. `doctor` defaults to copy. Git and commits are not required. Every directory entry participates, including ignored/untracked files, `.git` and dependencies. No dependency manifest or implicit exclusion list is used.

- **Lock:** use the original source. Monitor filesystem events and metadata; verify the full content hash at boundaries. A detected change, including ordinary edit-and-restore or create-and-delete, invalidates the review with `ERROR`, never a semantic `RED`. Monitoring remains alive through Human waiting. A dead lock worker invalidates its unfinished Run when inspected.
- **Copy:** capture all current files in private staging; verify stable source and copied content before atomic publication. An unstable capture fails explicitly and can be retried. Same-hash inputs share one immutable cache directory, including concurrent submissions. Original edits after capture do not invalidate the copied review. No verdict caching occurs.

Snapshot hash is SHA-256 over sorted relative paths, entry types, file content hashes, executable permission bits, and relative symlink targets. Empty directories participate. Timestamps, inode numbers and write-permission bits are excluded from the content hash but metadata is separately tracked for mutation detection. Copies remove write permissions. Internal relative symlinks are supported; escaping, absolute, dangling symlinks and special files are rejected. Artifact definitions retain the stricter no-symlink policy.

CCDD state must be outside the source workspace, including through symlinks. Inputs live at `stateDir/workspaces/<hash>`; review output lives at `stateDir/runs/<runId>/<requestId>/`. Only one process publishes a hash at a time. Cache entries are revalidated before reuse and retained after review completion. Automatic cache eviction is not implemented; do not delete a cache while its reviews or Human requests still need it.

This is cooperative local execution, not an OS sandbox against a hostile process running as the same user. Event/metadata checks are conservative and cannot prove the absence of every adversarial transient write on every filesystem. Unsupported monitoring fails closed. Copy permissions do not isolate environment, network, external services or test side effects. Runtime output must use per-review paths rather than modify shared inputs. Lock results retain the input hash but do not preserve the old source after later edits.

`prepareWorkspace({repoPath,stateDir,mode,signal?})` and `reopenWorkspace(descriptor,{signal?})` return `{descriptor,signal,assertUnchanged(),close()}`. The serializable descriptor contains `{version:1,mode,sourcePath,path,hash,stateDir,baselineMetadataHash}`. It is stored with the Run and every request. Copy source need not remain present after capture.

## Repository configuration

`ccdd.config.json` is read from the prepared workspace. It declares `artifacts`, `artifactTypes` and a `critics` array whose order does not prescribe execution. Each Artifact has a type, safe relative path and optional `basis: true`. Each Critic has a unique ID, title, one `target` Artifact ID, a `deps` array of other Artifact IDs, profile and payload. The `deps → target` relations must form a DAG. A dependency must have required evaluators or be explicitly declared as a basis; a basis cannot also be a target. The old `dependsOn` and Critic-level `artifacts` fields are rejected with migration guidance. See [Artifact graph](artifact-graph.md).

```json
{
  "artifacts": {"tests":{"type":"code","path":"tests","basis":true},"implementation":{"type":"code","path":"implementation"}},
  "artifactTypes": {"code":{"viewer":"files","agentTools":{"list":{},"read":{}},"humanTools":{"list":{},"read":{}}}},
  "critics": [{
    "id":"runtime", "title":"테스트 런타임 통과", "target":"implementation", "deps":["tests"],
    "profile":{"kind":"runtime","command":"node","args":["--test","tests/example.test.mjs"]},
    "payload":{"instruction":"Run the actual test suite against the implementation."}
  }]
}
```

Agent profile: `{kind:'agent',provider:'openai-codex',model,reasoning,timeoutMs?}`. Human profile: `{kind:'human'}` with at least one registered alarm method. The demo Code Runner supports Node test paths. Configuration and payload are fixed with the input, including uncommitted edits.

## Artifact type tools and line reads

Each type explicitly declares the tools available to each reviewer audience:

```json
"code": {
  "viewer": "files",
  "agentTools": {
    "list": {"description": "{artifactName}의 파일 목록을 조회한다."},
    "read": {"description": "{artifactName}의 소스 텍스트를 줄 단위로 읽는다."}
  },
  "humanTools": {
    "list": {},
    "read": {},
    "open": {
      "description": "{artifactName}을 기본 프로그램으로 연다.",
      "command": "/usr/bin/open",
      "args": ["{artifactPath}"]
    }
  }
}
```

`agentTools` and `humanTools` are independent maps. Empty or omitted maps provide no capabilities to that audience. New Agent/Human submissions must have usable audience tools on every selected Artifact; Runtime keeps its own execution contract. Only the selected Critic is checked when `--critic` is used. A `files` type on a regular file cannot expose a list-only capability. Agent operations currently support read/list; Human supports those builtins plus registered command launchers. `text` supports read; `files` supports list/read, with the actual Artifact shape deciding which are exposed. Names remain flat `<toolName>_<artifactName>` tools. Pi and the optional stdio MCP adapter expose only the Agent registry. There is no payload `tool` discriminator.

Builtin entries may be `{}` to use the default description. Unlike old `tools` description overrides, omitted operations are disabled. Historical snapshots containing only `viewer`/`tools` retain their old passive read/list behavior, but new submissions must explicitly migrate to the audience maps. Adding one audience map disables legacy fallback for both audiences; an omitted counterpart remains unavailable.

Human command entries define fixed `command`, `args`, optional `timeoutMs` (1–120000, default 10000), and a description. Arguments must include a standalone `{artifactPath}` token; CCDD substitutes the scoped absolute path without a shell. A directory tool accepts an optional internal relative `path`; a file tool accepts no path. Browser callers never supply executables, argv, or environment. The launcher inherits only the desktop environment allowlist, not Provider credential variables. A launcher should return when the viewer has opened, such as `/usr/bin/open`, rather than wait for a whole interactive application session. Its successful exit confirms launch only, never Human observation or a verdict. Fixed commands are trusted repository configuration, not an OS sandbox; shared review inputs must remain unchanged.

The only description template placeholder is `{artifactName}`, replaced literally everywhere by the Artifact definition ID. Type/tool settings validate before review acceptance and also in the standalone Viewer. Explicit descriptions must be nonblank strings of at most 4000 characters. Unknown fields, unsupported operations and unsupported template braces are rejected. Registered tools operate only on their supplied Artifact paths.

Read inputs are `startLine` (integer >=1, default1) and `lineCount` (integer1–500, default80). Directory reads additionally require a nonempty `path` to a file inside that Artifact. File reads reject any path argument. Byte-read `offset`/`limit` and unknown arguments are rejected rather than reinterpreted. Directory listing keeps optional internal `path`, zero-based entry `offset` and entry `limit` (1–200).

Read results contain plain original text, `startLine`, `endLine` (null when no lines returned), actual `lineCount`, `truncated`, and `nextStartLine` (null at EOF). `totalLines` is returned when EOF is reached; early pages do not scan the entire remaining file merely to compute a total. LF/CRLF and UTF-8 text are preserved, and a trailing newline does not create an extra empty line. Empty files and requests past EOF return empty content with lineCount0.

Responses retain a 64KiB content bound. Pagination stops before a whole line that would exceed the remaining response budget and points to that line for continuation. A requested individual line larger than the bound fails explicitly rather than returning a partial line. The reader streams through the file and avoids loading all content into memory. Binary/invalid text and escaping paths fail.

Shared audit records used by both Pi and MCP include only successful operation names, arguments, and safe observation metadata (Artifact ID, operation and returned line range/count), never file contents. Agent inspection requires a successful read returning at least one line, or observing an actually empty file. Listing alone or reading beyond EOF of a nonempty file does not satisfy required observation. Provider prompts explain the review payload and Artifact scope before describing the available operations and line continuation.

CLI inspection uses `artifact REQUEST_ID ARTIFACT_ID --start-line N --line-count N`, adding `--file INTERNAL_PATH` for directory reads. Listing uses `--offset` and `--limit`. The same Viewer validates both CLI and Agent access.

## Request and execution

`prepareReviewRequests({repoPath,repoId,snapshotHash,criticId?})` creates explicit envelopes containing `{repoId,snapshotHash,criticId,title,artifacts:[{id,type,path}],artifactTypes,payload,profile,target,deps}`. Envelope `artifacts` is derived as `[target, ...deps]` and the broker validates supplied envelopes against the prepared input. `--critic` selects exactly one envelope and validates only its required executor.

The Artifact Runner creates scoped Viewer entry-point tools such as `read_why`, `read_spec`, `list_tests`, and `read_tests`. Having the entire repo available as execution input does not grant an Agent visibility into every Artifact. Agent review requires observed reads of every supplied Artifact, a real Provider response, and a valid structured result.

Executors receive the prepared input path, a distinct `runDir`, cancellation signal and event callback. Runtime environment sets `CCDD_OUTPUT_DIR`, `CCDD_TMP_DIR`, `TMPDIR`, `TMP`, `TEMP`, `HOME`, and `XDG_CACHE_HOME` to review-specific locations. Runtime cwd remains the input so relative imports work. A test failure is RED; an operational failure or detected input mutation is ERROR.

## Pi Agent execution

Only `src/executors` imports Pi runtime libraries. `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` are pinned to 0.85.1, reused as dependencies. The Broker delegates the common `ExecutorRegistry` contract (`src/contracts.ts`); it does not own LLM sessions. Human remains a durable broker workflow, and Runtime remains actual Node execution.

Pi receives only the request's Artifact tools. No coding harness, shell, write, network-browsing or general filesystem tools are added. `createAuditedArtifactTools` is the common execution wrapper; Pi's `prepareArguments` invokes its strict validation before Pi can coerce numeric strings or strip nulls. The same Viewer performs all filesystem scope checks.

CCDD resolves the exact Provider/model in Pi's installed catalog. Unsupported reasoning, including Pi mappings that substitute a different named effort, is rejected. `off` is accepted only for models without reasoning. A model absent from that version of the catalog is rejected, never replaced. Actual Provider access remains a runtime diagnostic because catalog presence does not prove account access.

The same Pi loop serves `doctor` and review. External cancellation and profile timeout abort the loop; aborted/error Provider messages cannot become verdicts. The final response must be complete JSON matching the requested schema, followed by CCDD's semantic shape and required-observation validation. Only safe lifecycle/tool metadata and final result are persisted; Provider thinking and raw errors are excluded.

Credentials come from Pi's supported Provider environment variables or explicit absolute credential-file paths. `--pi-auth-file` reads provider-keyed Pi credentials; `--codex-auth-file` explicitly bridges an existing unexpired Codex access token for `openai-codex`. File adapters are read-only; they never refresh or modify shared tokens. OAuth within five minutes of expiration is rejected. The issuer's login tool owns renewal. Configured credential files must stay outside reviewed input. Only paths and Human alarm settings are serialized for the worker; API key environment variables must be available to a resumed process. No credentials are copied into the broker state.

## Durable broker and process ownership

`createBroker({repoPath,stateDir,repoId,executors?})` provides `submit`, `run`, `getRun`, `listRuns`, `getRequest`, `claimHuman`, `executeHumanTool`, `completeHuman`, `cancel`, `failRun`, `reconcile`, and `close`.

- `submit({mode,requesterId,criticId?,reviewRequests?})` captures input, validates requirements, persists the Run, and returns its Handle. It does not start execution.
- `run(runId,{signal?,onStarted?})` claims that Run transactionally. One live worker owns a Run; different Runs execute concurrently. Ownership stores PID, process identity and a token. Opening or closing another client never claims or cancels it.
- CLI submission starts a detached worker with private IPC for startup only. It exposes no listening server. The worker exits after completion or a copy-mode Human wait once independent queued work and notifications have settled. `status --wait` polls stored state.
- Wait timeout returns exit 3 with the same Handle and leaves the worker running. `cancel` records ERROR and requests worker cancellation. Dead ownership is reconciled when records are inspected; there is no automatic retry or unseen background recovery service. `resume` can start persisted, unowned queued work.
- Normal termination cancels the worker's subprocess groups. Forced process/host termination cannot guarantee cleanup of every external side effect or descendant; unfinished work is never inferred to have passed.

Run scope is `{kind:'graph'}` or `{kind:'critic',criticId}`. Every new Run persists its full graph definition, including evaluators omitted by a selected-Critic run. Full runs gate on all evaluators of every dependency Artifact being GREEN in that Run; explicit bases require no verdict. Ready Agent/Runtime critics execute with a per-Run limit of four, while Human waiting never blocks independent work. RED/operational ERROR blocks dependents but leaves independent branches running. Active Run status takes precedence until independent work settles. Workspace/cancellation/owner failures invalidate all unfinished requests. Selected execution bypasses dependency gates and has one request; absent evaluators never contribute GREEN to Artifact aggregation. Run status is `QUEUED|RUNNING|WAITING_HUMAN|GREEN|RED|ERROR`; request status additionally includes `BLOCKED`. Old runs retain their stored chain semantics and optional predecessor IDs. Completed results are immutable, and subsequent review attempts receive new Handles.

## Human lifecycle

The worker persists WAITING_HUMAN, invokes registered alarms, and records confirmed delivery. A registered local inbox writes `stateDir/human-inbox.jsonl`. It is a local file alarm, not an email, push notification or delivery acknowledgement by a person. Alarm failure causes ERROR.

Copy-mode waiting and owner release are coordinated transactionally. After the worker exits, another CLI process can inspect Artifacts, claim the request, and submit `{reviewerId,result:{verdict,summary,evidence}}`. Only the claimant may complete it and only once. Input integrity is revalidated at completion. A result recomputes dependency readiness and the CLI starts a new request worker, reusing the originally saved execution configuration.

Human tool execution requires the active claimant and a WAITING_HUMAN request. The Broker reopens and validates the recorded workspace, matches stored Artifact definitions against its config, resolves registered tools, and validates workspace/claim again after execution. Only safe tool name, Artifact ID and operation metadata are persisted. Launch errors do not become RED or complete the review; input mutation invalidates the review with ERROR. Human result submission requires a nonempty summary and at least one nonblank evidence entry.

Lock-mode waiting keeps its worker and input monitoring alive. Human completion requires a live owner. Changes or owner death invalidate the review. Result files and notification output must be outside the locked workspace.

## Doctor

`diagnoseProject({repoPath,repoId,mode='copy',stateDir?,criticId?,executors,signal?,onEvent?})` returns `{ok,status:'READY'|'NOT_READY',repoId,mode,snapshotHash,scope,checkedAt,checks}`. It reads current definitions and validates actual project Viewer entry points. Exact Agent profiles are deduplicated; runtime path checks remain per Critic.

The Agent readiness probe uses the same Provider/model/reasoning and Pi Agent execution path with a random nonce Artifact in a private diagnostic workspace. It never writes into the original or shared review input. READY requires the correct nonce and audited tool read. Runtime diagnosis starts Node and checks paths, without executing project tests. Human diagnosis checks registration without sending notifications. No Run, semantic verdict or review history is created. READY describes the diagnostic moment, not future availability or Critic correctness.

## Compatibility

v0.3 removes `serve`, HTTP APIs, `--url`, `--commit`, and the browser/video recording implementation. Previous release assets remain historical. Use a fresh external state directory for new reviews; v0.1/v0.2 state located inside a repo is not automatically moved. An optional observer server can be added later without owning or being required for reviews.

In v0.4, read calls replace byte-based offset/limit with startLine/lineCount. Custom operation descriptions are optional. Fresh demos use demo-v4; existing demo directories are never rewritten automatically.


v0.5 replaces the bundled Codex CLI with Pi libraries and builds TypeScript into `dist/`. The installed bin remains `ccdd`; source checkout commands use `npm run build` then `node dist/src/cli.js`. `--codex` and `CCDD_CODEX_PATH` no longer configure Agent execution. Agent profiles must use Pi IDs and exact catalog-supported models; pre-v0.5 pending Agent requests retain their original profiles and fail explicitly if unsupported. Human and Runtime records retain their broker lifecycle. Fresh demos use demo-v5.

v0.5.1 updates Pi to 0.85.1 and creates fresh demos in demo-v5.1 using openai-codex / gpt-6-astra / medium. Existing demo directories and request profiles remain unchanged. Astra accepts exact low/medium/high/xhigh/max reasoning; off/minimal/ultra are rejected.

## Local monitor

`ccdd monitor` starts an optional loopback web server. It discovers existing stores under CCDD_STATE_HOME (or the standard local state home) and accepts explicitly selected stores. Project identity is based on the canonical state directory, so separate histories and projects sharing a repo label do not collide. Missing sources do not hide copied review history.

The observation store opens SQLite read-only and never calls Broker getters that reconcile ownership. Stored status and process-liveness observations remain separate. A dead worker can be shown as missing without rewriting a request to ERROR. Human copy waiting without a worker is normal. No reviews, diagnoses, notifications, claims, or provider calls start when viewing the monitor.

The Vue 3/TypeScript frontend is built with Vite and bundled in the npm package. A project picker scopes a four-column board: requested (QUEUED/BLOCKED/unclaimed Human), running (RUNNING/claimed Human), success (GREEN), failure (RED/ERROR). Blocked successors retain their own waiting state and a clear blocked-by-failure reason. Each column has independently bounded pagination and counts so recent completed requests cannot hide older active work. Card details show the instruction, result, existing lifecycle times, and scoped Artifact viewer.

The overview returns bounded, paginated request summaries and project/filter counts. Request detail projects only the instruction, execution profile, result summary/evidence, safe lifecycle times, and Artifact references; it excludes credentials, worker ownership tokens, raw provider logs, and snapshot metadata dumps. Existing timestamps describe post-workspace-preparation acceptance; no missing timing is inferred.

Artifact browsing reuses scoped Viewer tools and validates the recorded workspace before and after each read. Browser reads do not count as Agent or Human review observations. Changed lock inputs or missing copies fail explicitly instead of showing current source as the reviewed snapshot. File and directory pagination retain the Artifact contract.

The server listens on 127.0.0.1 and validates request Host/origin. It serves bundled local assets without CDN or CORS. Artifact and stored text are rendered as text. GET remains observational. Explicit JSON POST routes perform claim, registered Human tool calls, and GREEN/RED result submission through the Broker. Requests require the same origin, a browser-owned HttpOnly SameSite cookie, and a CSRF token. Reviewer identity is derived from that opaque cookie and cannot be supplied as a POST field; it survives server restarts. The same browser can continue its claim, while another browser cannot impersonate it. Clearing browser cookies loses that browser identity; this is a local workflow, not a multi-user login system.

Human completion shares the CLI's saved execution configuration and detached worker startup. A monitor shutdown waits for an in-flight result handoff and never owns or cancels successor reviews. Command tools are available only to the active claimant. Concurrent mutations on one request are serialized by the HTTP adapter; the Broker checks the authoritative status and claim as well.

## Artifact tool diagnostics

`ccdd tools check [--repo PATH] [--artifact ID] [--for agent|human] [--tool NAME]` lists and checks registered capabilities without a Provider call, review history, verdict, notification, or program launch. `--execute` requires a selected Artifact, audience and tool; `--args JSON` supplies that tool's schema-validated arguments. Both preparation and actual execution use the same scoped registries as reviews. Copy is the default workspace mode; lock is explicit. Failed checks return NOT_READY and a nonzero exit code.

Preparation confirms declarations, paths and launcher executable availability. Actual execution confirms the read/list response or registered launcher exit; a GUI app's rendered content and a person's reading are not inferred. A launcher copy is retained so an asynchronously opened desktop viewer keeps its input after the command exits. Copies are revalidated and normal immutable cache lifetime rules apply. `doctor` remains the whole-project readiness command, including Human tool preflight without launching applications.

v0.8 replaces Critic sequencing with Artifact target/deps, persists graph definitions, and adds GraphView alongside Kanban. Fresh demos use `demo-v8` with manifest version 8, explicit bases and audience tool maps. Existing demos and historic review snapshots are never rewritten automatically.

Graph APIs are read-only: `GET /api/runs?project=&limit=&offset=` lists persisted runs; `GET /api/graphs/:projectId/:runId` returns the same-Run graph projection and safe request headers. `GET /api/requests` accepts `run=ID` only with a project filter. Historical runs without graph metadata are explicitly unavailable in GraphView. Partial runs retain missing critics and cannot borrow results from another Run or snapshot.
