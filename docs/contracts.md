# Implementation contracts — v0.2

One npm package, Node 24 ESM, SQLite persistence. Localhost HTTP UI; no external deployment or Docker required. The broker is the daemon/persistence bounded context. Executors are a separate context with code-runner, Agent provider, and Human implementations. Artifact Runner is the adapter that resolves request payload artifact references into scoped viewer entry-point tools.

## Repository config: ccdd.config.json (read from requested commit)

```json
{
  "artifacts": {
    "why": {"type":"markdown","path":"why.md"},
    "spec": {"type":"markdown","path":"spec.md"},
    "tests": {"type":"code","path":"tests"},
    "implementation": {"type":"code","path":"implementation"}
  },
  "artifactTypes": {"markdown":{"viewer":"text"},"code":{"viewer":"files"}},
  "critics": [
    {"id":"spec-why","title":"Spec이 Why에 부합하는가","dependsOn":null,"artifacts":["why","spec"],"profile":{"kind":"agent","provider":"codex","model":"gpt-6-astra","reasoning":"medium"},"payload":{"instruction":"Compare {why} and {spec} using the artifact tools. Return a Korean verdict and evidence."}},
    {"id":"tests-spec","title":"Tests가 Spec에 부합하는가","dependsOn":"spec-why","artifacts":["spec","tests"],"profile":{"kind":"agent","provider":"codex","model":"gpt-6-astra","reasoning":"medium"},"payload":{"instruction":"Compare {spec} and {tests} using the artifact tools. Return a Korean verdict and evidence."}},
    {"id":"implementation-tests","title":"테스트 런타임 통과","dependsOn":"tests-spec","artifacts":["tests","implementation"],"profile":{"kind":"runtime","command":"node","args":["--test","tests/rank.test.mjs"]},"payload":{"instruction":"Run the test suite against the implementation."}}
  ]
}
```

Broker validates config, linear dependency order, artifact relative paths and artifact types. Repo registered at daemon startup under id `demo`. Config AND artifact files are loaded from the requested commit, never the mutable checkout.

## Repo Requester

`prepareReviewRequests({repoPath,repoId,snapshotCommit,criticId?})` reads committed definitions and produces full ordered review envelopes. The browser submits these artifacts, types, paths, commit, payload and profile to the broker. The broker validates that the envelopes match the committed configuration before accepting them. [Full request contract](requester-contract.md).

## Executor-facing Request

```js
{
 id, runId, repoId, snapshotCommit, criticId, title,
 artifacts: [{id,type,path}],
 artifactTypes: {markdown:{viewer:'text'},code:{viewer:'files'}},
 payload: {instruction:'Compare {why} and {spec} ...'},
 profile: {kind:'agent',provider:'codex',model:'gpt-6-astra',reasoning:'medium'},
 predecessorId: null
}
```

## Adapter interfaces

`src/executors/index.mjs` exports `createExecutorRegistry({codexPath, alarmMethods=[]})` returning an object with:

- `canExecute(request)` => `{ok:boolean,reason?:string}` (sync or async)
- `execute(request, {worktreePath, runDir, signal, onEvent})` => Promise<Result>
- Human requests: broker leaves them `WAITING_HUMAN`, after requiring at least one alarm method. Registry exposes optional `notifyHuman(request)` to call configured alarm adapters. A local inbox file is one explicit configured alarm method; the UI displays the waiting review. A test may use a fake alarm callback; no external messages in this task.

`Result = { verdict:'GREEN'|'RED', summary:string, evidence:string[], provider?:string, model?:string, toolCalls?:Array<{name,arguments?}>, durationMs?:number, stdout?:string, stderr?:string, exitCode?:number }`.

Executor errors throw; broker records ERROR separately from RED. Runtime timeout and Agent timeout abort processes. Provider raw event streams are discarded, never sent to UI or GitHub. Only concise final result and artifact tool call provenance go into result.

## Readiness diagnostics

`diagnoseProject({repoPath,repoId,snapshotCommit,criticId?,executors,signal?})` returns `{ok,status:"READY"|"NOT_READY",scope,checkedAt,checks}`. It prepares a temporary snapshot worktree, validates Viewer operations and invokes `executors.probe`. Agent probes use the same Provider configuration and MCP transport as reviews, with a random diagnostic artifact nonce. Successful response plus audited nonce reading proves current model/auth/tool access. Agent profiles are deduplicated; runtime checks are per Critic. Runtime diagnosis starts Node and checks test paths without running project tests. Human diagnosis checks method registration without sending notifications. No Run or review verdict is created.

`POST /api/doctor` takes `{snapshotCommit,criticId?}` and returns the diagnostic report; `NOT_READY` is a successfully returned report (HTTP 200), with failed checks and suggested remedies. It runs only on explicit request, and aborts on client disconnect/server shutdown.

## Broker adapter

`src/broker/index.mjs` exports `createBroker({repoPath,stateDir,repoId='demo',executors})` returning:

- `submit({snapshotCommit,requesterId,reviewRequests?,criticId?})` => run record with `id` and `requests` (one request per critic)
- `listRuns()` => newest first run records with request summaries
- `getRun(id)` => run plus full requests/results and events
- `getRequest(id)` => full request with metadata/result/worktreePath
- `claimHuman(requestId, reviewerId)` then `completeHuman(requestId,{reviewerId,result})`
- `close()` => close workers/db safely (may be async)
- optional `onChange(callback)` subscription for transport

Run shape `{id,repoId,snapshotCommit,requesterId,scope,status,createdAt,requests,events}`. `scope` is `{kind:"chain"}` or `{kind:"critic",criticId}`. Omitted legacy scope is read as chain. A selected Critic runs independently with `predecessorId:null`; its committed `dependsOn` remains definition data. GREEN certifies only the requested scope. Status values `QUEUED|RUNNING|WAITING_HUMAN|GREEN|RED|ERROR`.
Request shape extends Executor Request with `{status,createdAt,startedAt,completedAt,result,error,worktreePath}`. Requests waiting for predecessors use `BLOCKED` with an explainable dependency; RED blocks downstream. No success reuse across snapshots in this small demo. Failed reviews never rewrite the registered repo. Restart marks interrupted executions as ERROR; explicit new submission retries. A run can never be GREEN while a request is missing, blocked, running or failed.

## HTTP transport owned by integration/root

- `GET /api/health` liveness + version; `readinessChecked:false`, `providerReady:null`
- `GET /api/demo` `{repoId,name,scenarios:[{id,label,description,commit,reviewRequests}],graph:[{id,artifact,title,criticTitle?}],provider}`. Scenario manifest `.ccdd/demo/manifest.json` created by prepare-demo.
- `GET /api/runs`, `GET /api/runs/:id`
- `POST /api/runs` `{snapshotCommit,requesterId:'web-demo',reviewRequests,criticId?}` -> run; API must return handle without waiting for evaluation.
- `GET /api/requests/:id/artifacts/:artifactId?file=...` -> `{path,content,type,snapshotCommit}`; scoped viewer uses the same Artifact Runner as Agent.
- `GET /api/requests/:id` -> request
- `POST /api/requests/:id/claim` `{reviewerId}`
- `POST /api/requests/:id/result` `{reviewerId,result}`
- Local only: validate Origin if present; bind 127.0.0.1; cap request body; no cross-origin writes.

UI polls. No React build needed: public/index.html, public/app.js, public/styles.css. Korean, professional light/dark editorial visual design, real persisted run status, request details (payload, snapshot, scoped tools/artifacts, result), 4 artifacts/3 links graph. User picks scenario and submits; can inspect earlier runs and compare the evidence.

## Demo repository separate from package source

`scripts/prepare-demo.mjs` creates an ignored local Git repo `.ccdd/demo/repo` with four committed snapshots: working baseline; a changed Why (top 2 instead of top 3) with old Spec, expected RED at first critic; aligned Spec/Tests plus intentionally old implementation, expected Runtime RED; final repaired implementation, expected all GREEN. Scenario IDs: baseline, why-change, runtime-failure, fixed. This is one linear graph throughout. Topic: a small pure JS task-priority selector; strict, deterministic and easily understood. Manifest records immutable commits and descriptions. Actual Agent reviews establish verdicts; expected outcomes are scenario descriptions, never substituted outputs.

Production claims out of scope: remote untrusted repository sandbox, distributed worker fleet, public multi-tenant service. Local demo executes repository test code with user's authorization. Snapshot paths and tools remain scope-checked, loopback APIs reject remote browser writes.
