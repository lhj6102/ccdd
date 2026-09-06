# Implementation contracts

Core package `@lhj6102/ccdd`, optional library `@lhj6102/ccdd-default-tools`, strict TypeScript compiled to Node 24 ESM, and local SQLite persistence. The core does not depend on or re-export the default library. Broker and Executors remain separate bounded contexts. A request-scoped worker runs one Run; no daemon, global broker-owner lock, or automatic queue scanner is required. The optional local monitor observes persisted requests and delegates explicit Human actions to the Broker. It does not own review execution.

Artifact groups and the default image tool described here are available in the current source build; the published v1.0.0 assets do not include them.

## Workspace contract

`run` requires exactly one CLI flag: `--copy` (recommended) or `--lock`. `doctor` defaults to copy. Git and commits are not required. Every directory entry participates, including ignored/untracked files, `.git` and dependencies. No dependency manifest or implicit exclusion list is used.

- **Lock:** use the original source. Monitor filesystem events and metadata; verify the full content hash at boundaries. A detected change, including ordinary edit-and-restore or create-and-delete, invalidates the review with `ERROR`, never a semantic `RED`. Monitoring remains alive through Human waiting. A dead lock worker invalidates its unfinished Run when inspected.
- **Copy:** capture all current files in private staging; verify stable source and copied content before atomic publication. An unstable capture fails explicitly and can be retried. Same-hash inputs share one immutable cache directory, including concurrent submissions. Original edits after capture do not invalidate the copied review. No verdict caching occurs.

Snapshot hash is SHA-256 over sorted relative paths, entry types, file content hashes, executable permission bits, and relative symlink targets. Empty directories participate. Timestamps, inode numbers and write-permission bits are excluded from the content hash but metadata is separately tracked for mutation detection. Copies remove write permissions. Internal relative symlinks are supported; escaping, absolute, dangling symlinks and special files are rejected. Artifact definitions retain the stricter no-symlink policy.

CCDD state must be outside the source workspace, including through symlinks. Inputs live at `stateDir/workspaces/<hash>`; review output lives at `stateDir/runs/<runId>/<requestId>/`. Only one process publishes a hash at a time. Cache entries are revalidated before reuse and retained after review completion. Automatic cache eviction is not implemented; do not delete a cache while its reviews or Human requests still need it.

This is cooperative local execution, not an OS sandbox against a hostile process running as the same user. Event/metadata checks are conservative and cannot prove the absence of every adversarial transient write on every filesystem. Unsupported monitoring fails closed. Copy permissions do not isolate environment, network, external services or test side effects. Runtime output must use per-review paths rather than modify shared inputs. Lock results retain the input hash but do not preserve the old source after later edits.

`prepareWorkspace({repoPath,stateDir,mode,signal?})` and `reopenWorkspace(descriptor,{signal?})` return `{descriptor,signal,assertUnchanged(),close()}`. The serializable descriptor contains `{version:1,mode,sourcePath,path,hash,stateDir,baselineMetadataHash}`. It is stored with the Run and every request. Copy source need not remain present after capture.

## Repository configuration

`ccdd.config.ts` is read from the prepared workspace. It default-exports a configuration object or a synchronous/asynchronous zero-argument factory. `defineConfig` is a lightweight identity helper; `defineTool` derives common argument types from a literal input schema. The SDK import starts no Broker, Provider, monitor or desktop process.

The config declares `artifacts`, `artifactTypes`, and a `critics` array whose order does not prescribe execution. An entry is `ArtifactDefinition | ArtifactGroupDefinition`: a leaf has a type and safe relative path; a group has `{kind:'group',members:['effect','preview']}` with no type or path. Both accept optional `basis: true`. Members reference independently defined IDs, may include other groups, and must be nonempty, unique, known and acyclic. Each Critic has a unique ID, title, one `target` ID, a `deps` array, profile and payload. The `deps → target` relations must form a DAG. Dependencies require evaluators or an explicit basis; a basis cannot also be a target. Critic `dependsOn` and `artifacts` fields remain rejected. See [Artifact graph](artifact-graph.md).

Groups are independent review targets and dependencies. Their required Critics determine their verdict, without propagating it to members or inheriting member verdicts. Membership grants observation scope but adds no dependency edge or scheduling gate. A group Critic must explicitly declare member IDs in `deps` if their evaluations must pass first.

```ts
import { defineConfig } from '@lhj6102/ccdd';
import { agent, human } from '@lhj6102/ccdd-default-tools';

export default defineConfig(() => ({
  artifacts: {
    tests: { type: 'code', path: 'tests', basis: true },
    implementation: { type: 'code', path: 'implementation' },
  },
  artifactTypes: {
    code: {
      agentTools: { list: agent.files.list(), read: agent.files.read() },
      humanTools: { open: human.desktop.open() },
    },
  },
  critics: [{
    id: 'runtime', title: '테스트 런타임 통과', target: 'implementation', deps: ['tests'],
    profile: { kind: 'runtime', command: 'node', args: ['--test', 'tests/example.test.mjs'] },
    payload: { instruction: 'Run the actual test suite against the implementation.' },
  }],
}));
```

Agent profile is `{kind:'agent',provider,model,reasoning,timeoutMs?}`. Human profile is `{kind:'human'}` with a registered alarm method. Runtime supports Node test paths. Config and payload are fixed with the snapshot, including uncommitted edits.

TS config is trusted repository code evaluated in a separate host with an allowlisted environment. It uses Node's native supported TypeScript syntax, not a project build step. Imports resolve inside the snapshot; an applicable `.js` relative source import can resolve to `.ts`. Dependencies must be physically installed inside the reviewed project. Parent/global packages and escaping links are rejected, and hooks remain active for deferred imports. This isolation is not an OS sandbox against trusted repo code acting as the local user.

The requester evaluates configuration and derives serializable request/graph definitions. `configManifest` version 1 records `configHash`, imported module paths and content hashes, and per-type/audience/tool metadata. Functions are never serialized. Each tool registry opens a fresh host, reloads the same snapshot config and checks its manifest, types, and Artifact references against the recorded values. A mismatch fails rather than loading current-source code or silently substituting a newer library. Mutable imported closure state is not shared between registries. Output/cache files remain outside the input.

A transitional `ccdd.config.json` path retains the existing text/files Viewer and read/list/registered Human command implementation. It still requires explicit audience maps for new submissions. Legacy `viewer`/`tools` fallback remains historical-read compatibility. JSON cannot contain a TS manifest or custom type marker. If both config files exist, admission fails with an explicit conflict. Old records are not rewritten.

## Registered Artifact tools

A TS type declares only `agentTools` and `humanTools`. Empty or omitted maps provide no capabilities to that audience. Targets and dependencies expand recursively into leaf Artifacts in stable order, deduplicating shared members. Every supplied leaf must have usable tools for the selected Agent/Human audience; Runtime has its own contract. Groups have no tools of their own. Names retain each leaf ID as `<toolName>_<artifactName>`, with collisions rejected. Tool keys can describe arbitrary operations such as `frame`, `inspectClip`, or `preview`; there is no built-in read/list restriction or required Viewer name.

A tool factory returns `{metadata, execute(context,args), preflight?}`. Calling the factory defines an effect; invoking `execute` performs it. The core accepts user-written functions without the default-tools library.

`metadata` fields:

- `description`: nonblank text up to 4000 characters; `{artifactName}` is replaced literally with the bound Artifact ID.
- `inputSchema`: a JSON Schema whose root is an object. Call arguments are JSON objects up to 64KiB, checked without string/number/boolean coercion or implicit default insertion.
- `resultKinds`: nonempty subset of `text`, `json`, `image`, `launch`.
- `observation`: `content` allows validated result observation receipts; `none` does not.
- `artifactKind?`: `file`, `directory`, or `any`.
- `timeoutMs?`: integer 1–900000; host execution defaults to 120000.

Supported schema keywords are `type`, `description`, `title`, `default`, `examples`, `enum`, `const`, `properties`, `required`, `additionalProperties`, `items`, item/string/numeric bounds, `uniqueItems`, `pattern`, `multipleOf`, `anyOf`, `oneOf`, `allOf`, and `not`. `$ref`, remote schemas and unrecognized keywords are rejected. Types are object, array, string, integer, number, boolean and null; use schema composition for unions. Schema nesting is limited to 20. Runtime schema validation remains authoritative; TypeScript inference covers the common literal forms rather than every JSON Schema composition.

The runner supplies `{artifactId, artifactPath, artifactDirectory, outputDir, tmpDir, signal, resolvePath}`. `artifactPath` is the bound snapshot root. `resolvePath(internalPath?)` rejects traversal, symlinks and paths outside that Artifact; file Artifacts reject a nonempty internal path. Output and temporary paths are review-owned, outside the snapshot. Reviewer arguments never choose another Artifact binding.

`ToolResult` contains 1–32 typed content blocks and optional `{observation:{kind:'content'|'empty',detail?}}`:

```ts
{ content: [{ type: 'text', text: 'Observed content' }], observation: { kind: 'content' } }
{ content: [{ type: 'json', data: { frames: 24 } }] }
{ content: [{ type: 'image', path: '/review-output/frame.png', mimeType: 'image/png' }], observation: { kind: 'content', detail: 'frame 2' } }
{ content: [{ type: 'launch', launched: true }] }
```

Text is bounded to 64KiB per block, JSON to 512KiB, and image bytes to 4MiB. The JSON bound accommodates escaped text from a complete 64KiB reader response. PNG/JPEG/WebP bytes are checked against their declared MIME. Images use a file inside the tool output directory or bounded base64 `data`; verified images are converted to base64 before Pi/MCP/browser delivery and are not stringified as filenames. A requested model that does not accept images fails explicitly. The host JSON message limit is 8MiB. Invalid arguments, results or output paths do not count as successful observations.

Common auditing records only safe successful tool name, arguments, time, bound Artifact ID, operation, and optional observation kind/detail. Required Agent inspection uses a validated `content` or `empty` receipt for every supplied Artifact, not a special `read_` name. Metadata-only operations and application launches do not imply content observation; launching alone cannot assert a content receipt. Quality remains the Critic's verdict, never the tool result. Legacy reviews retain their recorded line-read observation rules.

## Default tool library

`@lhj6102/ccdd-default-tools` is a separate optional package with a compatible core peer dependency and type-only SDK imports. Importing it or calling a factory performs no I/O and registers nothing. Projects explicitly import and register the definitions they want. Both packages can be installed from local tarballs without private npm publication.

Agent defaults use packaged Node CLIs with fixed operation arguments; no general shell tool or global executable is installed. `agent.text.read()` supports a file Artifact. `agent.files.read()` and `agent.files.list()` support directory Artifacts. Read args are `startLine` (default 1) and `lineCount` (default 80, maximum 500); directory read also requires an internal file `path`. List args keep optional internal `path`, zero-based `offset`, and `limit` up to 200.

Reads preserve UTF-8, LF/CRLF, complete lines and final-newline semantics. They return original text, line range/count, `truncated`, `nextStartLine` and `totalLines` when known. A trailing newline does not create an extra empty line. Reads stream rather than load an entire unbounded file; a requested single line above 64KiB fails. Invalid UTF-8/binary input fails. Content observation requires returned text or a truly empty file; listing and past-EOF reads of a nonempty file do not qualify.

`agent.image.view()` is explicitly registered as `agentTools: { view_image: agent.image.view() }`, producing `view_image_<artifactId>`. Its packaged CLI reuses Pi's `createReadTool()` through an adapter exposing only the bound image file. This makes no LLM call and starts no Agent session. File Artifacts accept `{}`; directory Artifacts require an internal file `path`. Only an actual PNG/JPEG/WebP image block up to 4MiB succeeds and produces a leaf content receipt. File contents determine the image type. Text-only Pi results, GIF, BMP and animated PNG fail; the tool does not resize, convert, or offer Pi's general file-reading interface. Preflight checks availability and shape without rendering the image. A model accepting image input is required for an Agent review using the result.

Human defaults use `human.desktop.open()` to open a snapshot file/folder with a desktop application and return a launch receipt. It does not duplicate Agent read/list behavior. macOS defaults to `/usr/bin/open`; an `app` option selects an application, or `command`/fixed `args` connect another executable. Other platforms require an explicit command. Reviewers cannot choose the executable, argv, or environment. The launcher environment excludes Provider tokens and preload hooks. App launch success is separate from Human claim, observation and final submission, and the snapshot copy remains available after the launcher returns.

Factories accept description/timeout overrides. A launcher should return after opening the app, not wait for the user's editing session to end. `preflight` verifies shape/executable readiness without launching an app or rendering content. Custom tools may use functions, SDKs or commands under the same contract.

For legacy JSON requests only, CLI passive inspection remains `artifact REQUEST_ID ARTIFACT_ID --start-line N --line-count N`, with `--file INTERNAL_PATH` for a directory. TS requests do not use this legacy CLI Viewer. Invoke their registered Human tools through the monitor after claim. `tools check --execute` diagnoses a newly prepared workspace, not an existing request snapshot. Passive browsing is separate from registered Human tools and does not satisfy a reviewer observation.

## Request and execution

`prepareReviewRequests({repoPath,repoId,snapshotHash,criticId?})` creates explicit envelopes containing `{repoId,snapshotHash,criticId,title,artifacts:[{id,type,path}],artifactGroups?:[{id,members}],artifactTypes,configManifest?,payload,profile,target,deps}`. Expanding `[target, ...deps]` through group members yields the deduplicated leaf `artifacts` and reachable `artifactGroups`. It never follows members' Critic dependencies to grant additional access. Leaf-only scopes omit `artifactGroups`, preserving their existing shape. The broker validates supplied envelopes against the prepared input; tool reconnection also verifies recorded leaf and group scope against the snapshot. `--critic` selects exactly one envelope and validates only its required executor.

The Artifact Runner creates scoped Viewer entry-point tools such as `read_why`, `read_spec`, `list_tests`, and `read_tests`. Having the entire repo available as execution input does not grant an Agent visibility into every Artifact. Agent review requires validated content observations of every supplied Artifact, a real Provider response, and a valid structured result.

Executors receive the prepared input path, a distinct `runDir`, cancellation signal and event callback. Runtime environment sets `CCDD_OUTPUT_DIR`, `CCDD_TMP_DIR`, `TMPDIR`, `TMP`, `TEMP`, `HOME`, and `XDG_CACHE_HOME` to review-specific locations. Runtime cwd remains the input so relative imports work. A test failure is RED; an operational failure or detected input mutation is ERROR.

### Instruction Artifact references

`payload.instruction` remains a string. Configuration, prepared envelopes, stored payloads and monitor HTTP responses retain its original value; other payload fields are unchanged. Reference rendering is derived at presentation time from the supplied leaves, optional group metadata and actual tools; the rendered text is not stored as a second instruction.

An exact `{ID}` in that instruction refers to a leaf or group already supplied to the request. IDs use the existing identifier grammar: one ASCII letter or digit followed by up to 63 ASCII letters, digits, underscores or hyphens. When constructing the Agent prompt, CCDD renders the reference as inline JSON containing the Artifact ID and names from its actual Agent tool registry, joined by each tool's `artifactId`. It does not invent names or require default tools. For example, with `read_spec`, `grep_spec` and `read_why` actually registered:

```text
Source: {spec}이 {why}의 요구사항을 충족하는지 검토하세요.
Agent: {"artifact":"spec","tools":["read_spec","grep_spec"]}이 {"artifact":"why","tools":["read_why"]}의 요구사항을 충족하는지 검토하세요.
```

A group reference expands to its deduplicated supplied leaf members and their actual tools:

```text
{explosion} → {"artifactGroup":"explosion","members":[{"artifact":"effect","tools":["read_effect"]},{"artifact":"preview","tools":["view_image_preview"]}]}
```

Unknown or out-of-scope IDs remain literal text rather than making a previously valid request fail. Brace-delimited groups such as JSON objects, nested or doubled braces, escaped references such as `\{spec}`, and expressions such as `{spec.path}` also remain unchanged. The instruction is natural-language text, not a parsed JSON document: quotes and array brackets outside those brace groups do not suppress references. Escape `{ID}` when it should remain literal there. This is reference rendering, not expression evaluation, Artifact-body interpolation, permission granting or tool execution. The existing `target`/`deps` scope and required-observation checks remain authoritative. The `{artifactName}` placeholder in tool metadata descriptions continues its separate bound-Artifact substitution; instruction rendering introduces no reserved variable with that name.

The Human frontend parses the same original instruction and presents recognized references as Artifact buttons associated with that request's Human tools. A group button offers its members' Human tools, retaining each leaf binding. A reference click selects or focuses the corresponding tool choices; it never invokes a tool. Execution remains an explicit action under the existing active-claim and WAITING_HUMAN checks. No configuration import, Artifact read or tool execution is needed to render a reference.

## Pi Agent execution

Pi Agent sessions and Provider calls belong to `src/executors`. `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` are pinned to 0.85.1, reused as dependencies. The optional default-tools package also pins Pi Agent Core to reuse its read tool inside the packaged image CLI; that adapter owns no session, Provider call or Broker state. Pi types are not part of the public tool contract. The Broker delegates the common `ExecutorRegistry` contract (`src/contracts.ts`); it does not own LLM sessions. Human remains a durable broker workflow, and Runtime remains actual Node execution.

Pi receives only the request's Artifact tools. No coding harness, shell, write, network-browsing or general filesystem tools are added. `createReviewTools` is the common execution wrapper; Pi's `prepareArguments` invokes strict schema validation before Pi can coerce numeric strings or strip nulls. The runner binds each registered tool to its Artifact and validates results and observations. Historical requests use the legacy Viewer adapter.

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

`diagnoseProject({repoPath,repoId,mode='copy',stateDir?,criticId?,executors,signal?,onEvent?})` returns `{ok,status:'READY'|'NOT_READY',repoId,mode,snapshotHash,scope,checkedAt,checks}`. It reads current definitions and validates registered project tool preflight without calling their execute functions. Legacy JSON retains its original built-in Viewer readiness checks. Exact Agent profiles are deduplicated; runtime path checks remain per Critic.

The Agent readiness probe uses the same Provider/model/reasoning and Pi Agent execution path with a random nonce Artifact in a private diagnostic workspace. It never writes into the original or shared review input. READY requires the correct nonce and audited tool read. This private diagnostic tool is not a project registration and does not require the default library. The report separately records diagnostic-only Artifact verification and `projectToolsExecuted: false`; use `tools check --execute` to exercise a project tool. Runtime diagnosis starts Node and checks paths, without executing project tests. Human diagnosis checks registration without sending notifications. No Run, semantic verdict or review history is created. READY describes the diagnostic moment, not future availability or Critic correctness.

## Compatibility

v0.3 removes `serve`, HTTP APIs, `--url`, `--commit`, and the browser/video recording implementation. Previous release assets remain historical. Use a fresh external state directory for new reviews; v0.1/v0.2 state located inside a repo is not automatically moved. An optional observer server can be added later without owning or being required for reviews.

In v0.4, read calls replace byte-based offset/limit with startLine/lineCount. Custom operation descriptions are optional. Fresh demos use demo-v4; existing demo directories are never rewritten automatically.


v0.5 replaces the bundled Codex CLI with Pi libraries and builds TypeScript into `dist/`. The installed bin remains `ccdd`; source checkout commands use `npm run build` then `node dist/src/cli.js`. `--codex` and `CCDD_CODEX_PATH` no longer configure Agent execution. Agent profiles must use Pi IDs and exact catalog-supported models; pre-v0.5 pending Agent requests retain their original profiles and fail explicitly if unsupported. Human and Runtime records retain their broker lifecycle. Fresh demos use demo-v5.

v0.5.1 updates Pi to 0.85.1 and creates fresh demos in demo-v5.1 using openai-codex / gpt-6-astra / medium. Existing demo directories and request profiles remain unchanged. Astra accepts exact low/medium/high/xhigh/max reasoning; off/minimal/ultra are rejected.

## Local monitor

`ccdd monitor` starts an optional loopback web server. It discovers existing stores under CCDD_STATE_HOME (or the standard local state home) and accepts explicitly selected stores. Project identity is based on the canonical state directory, so separate histories and projects sharing a repo label do not collide. Missing sources do not hide copied review history.

The observation store opens SQLite read-only and never calls Broker getters that reconcile ownership. Stored status and process-liveness observations remain separate. A dead worker can be shown as missing without rewriting a request to ERROR. Human copy waiting without a worker is normal. No reviews, diagnoses, notifications, claims, Provider calls, user config imports or registered tool functions start when viewing the monitor. Human tool buttons and forms come from stored metadata.

The Vue 3/TypeScript frontend is built with Vite and bundled in the npm package. A project picker scopes a four-column board: requested (QUEUED/BLOCKED/unclaimed Human), running (RUNNING/claimed Human), success (GREEN), failure (RED/ERROR). Blocked successors retain their own waiting state and a clear blocked-by-failure reason. Each column has independently bounded pagination and counts so recent completed requests cannot hide older active work. Card details show the instruction, result, existing lifecycle times, and scoped Artifact viewer.

The overview returns bounded, paginated request summaries and project/filter counts. Request detail projects only the instruction, execution profile, result summary/evidence, safe lifecycle times, and Artifact references with validated optional group composition; it excludes credentials, worker ownership tokens, raw provider logs, and snapshot metadata dumps. The monitor derives this safe projection from persisted metadata without evaluating config. Graph group nodes show their own Critics and offer member navigation; membership is displayed separately from the dependency edges. Existing timestamps describe post-workspace-preparation acceptance; no missing timing is inferred.

Artifact browsing reuses scoped Viewer tools and validates the recorded workspace before and after each read. Browser reads do not count as Agent or Human review observations. Changed lock inputs or missing copies fail explicitly instead of showing current source as the reviewed snapshot. File and directory pagination retain the Artifact contract.

The server listens on 127.0.0.1 and validates request Host/origin. It serves bundled local assets without CDN or CORS. Artifact and stored text are rendered as text. GET remains observational. Explicit JSON POST routes perform claim, registered Human tool calls, and GREEN/RED result submission through the Broker. Requests require the same origin, a browser-owned HttpOnly SameSite cookie, and a CSRF token. Reviewer identity is derived from that opaque cookie and cannot be supplied as a POST field; it survives server restarts. The same browser can continue its claim, while another browser cannot impersonate it. Clearing browser cookies loses that browser identity; this is a local workflow, not a multi-user login system.

Human completion shares the CLI's saved execution configuration and detached worker startup. A monitor shutdown waits for an in-flight result handoff and never owns or cancels successor reviews. Command tools are available only to the active claimant. Concurrent mutations on one request are serialized by the HTTP adapter; the Broker checks the authoritative status and claim as well.

## Artifact tool diagnostics

`ccdd tools check [--repo PATH] [--artifact ID] [--for agent|human] [--tool NAME]` lists and checks registered capabilities without a Provider call, review history, verdict, notification, or program launch. `--execute` requires a selected Artifact, audience and tool; `--args JSON` supplies that tool's schema-validated arguments. Both preparation and actual execution use the same scoped registries as reviews. Copy is the default workspace mode; lock is explicit. Failed checks return NOT_READY and a nonzero exit code.

Selecting a group with `--artifact` lists and preflights its deduplicated leaf tools. Actual `--execute` requires a leaf Artifact ID so one bound tool is selected explicitly; a group itself is not executable.

Preparation confirms declarations, paths and registered preflight results. A missing custom preflight is labeled as registration confirmed but execution unverified. Actual execution confirms a schema-validated tool result; a GUI app's rendered content and a person's reading are not inferred. A launcher copy is retained so an asynchronously opened desktop viewer keeps its input after the command exits. Copies are revalidated and normal immutable cache lifetime rules apply. `doctor` remains the whole-project readiness command, including Human tool preflight without launching applications.

v0.8 replaces Critic sequencing with Artifact target/deps, persists graph definitions, and adds GraphView alongside Kanban. Fresh demos use `demo-v8` with manifest version 8, explicit bases and audience tool maps. Existing demos and historic review snapshots are never rewritten automatically.

Graph APIs are read-only: `GET /api/runs?project=&limit=&offset=` lists persisted runs; `GET /api/graphs/:projectId/:runId` returns the same-Run graph projection and safe request headers. `GET /api/requests` accepts `run=ID` only with a project filter. Historical runs without graph metadata are explicitly unavailable in GraphView. Partial runs retain missing critics and cannot borrow results from another Run or snapshot.


v0.9 adds `ccdd.config.ts`, serializable tool manifests, per-registry implementation hosts, generic results and observations, and the optional default-tools library. New demos use `demo-v9` / manifest version 9. Preparation requires explicit local core/default-tools tarballs, installs public transitive dependencies once with lifecycle scripts disabled, and physically copies dependencies into four independent scenario projects. Existing demos are preserved. JSON admission remains transitional compatibility; there is no implicit conversion of saved requests or automatic default registration in TS.
