# Implementation contracts — v0.3

One npm package, Node 24 ESM, local SQLite persistence. Broker and Executors remain separate bounded contexts. A request-scoped worker runs one Run; there is no daemon, HTTP transport, observer UI, global broker-owner lock, or automatic queue scanner. An observer server may be added later as an optional adapter.

## Workspace contract

`run` requires exactly one CLI flag: `--copy` (recommended) or `--lock`. `doctor` defaults to copy. Git and commits are not required. Every directory entry participates, including ignored/untracked files, `.git` and dependencies. No dependency manifest or implicit exclusion list is used.

- **Lock:** use the original source. Monitor filesystem events and metadata; verify the full content hash at boundaries. A detected change, including ordinary edit-and-restore or create-and-delete, invalidates the review with `ERROR`, never a semantic `RED`. Monitoring remains alive through Human waiting. A dead lock worker invalidates its unfinished Run when inspected.
- **Copy:** capture all current files in private staging; verify stable source and copied content before atomic publication. An unstable capture fails explicitly and can be retried. Same-hash inputs share one immutable cache directory, including concurrent submissions. Original edits after capture do not invalidate the copied review. No verdict caching occurs.

Snapshot hash is SHA-256 over sorted relative paths, entry types, file content hashes, executable permission bits, and relative symlink targets. Empty directories participate. Timestamps, inode numbers and write-permission bits are excluded from the content hash but metadata is separately tracked for mutation detection. Copies remove write permissions. Internal relative symlinks are supported; escaping, absolute, dangling symlinks and special files are rejected. Artifact definitions retain the stricter no-symlink policy.

CCDD state must be outside the source workspace, including through symlinks. Inputs live at `stateDir/workspaces/<hash>`; review output lives at `stateDir/runs/<runId>/<requestId>/`. Only one process publishes a hash at a time. Cache entries are revalidated before reuse and retained after review completion. Automatic cache eviction is not implemented; do not delete a cache while its reviews or Human requests still need it.

This is cooperative local execution, not an OS sandbox against a hostile process running as the same user. Event/metadata checks are conservative and cannot prove the absence of every adversarial transient write on every filesystem. Unsupported monitoring fails closed. Copy permissions do not isolate environment, network, external services or test side effects. Runtime output must use per-review paths rather than modify shared inputs. Lock results retain the input hash but do not preserve the old source after later edits.

`prepareWorkspace({repoPath,stateDir,mode,signal?})` and `reopenWorkspace(descriptor,{signal?})` return `{descriptor,signal,assertUnchanged(),close()}`. The serializable descriptor contains `{version:1,mode,sourcePath,path,hash,stateDir,baselineMetadataHash}`. It is stored with the Run and every request. Copy source need not remain present after capture.

## Repository configuration

`ccdd.config.json` is read from the prepared workspace. It declares `artifacts`, `artifactTypes` and an ordered, strictly linear `critics` array. Each Artifact has a type and safe relative path. Each type uses a `text` or `files` viewer. Each Critic has a unique ID, title, referenced Artifact IDs, profile, payload, and `dependsOn` pointing only to its immediate predecessor (the first uses null).

```json
{
  "artifacts": {"tests":{"type":"code","path":"tests"},"implementation":{"type":"code","path":"implementation"}},
  "artifactTypes": {"code":{"viewer":"files"}},
  "critics": [{
    "id":"runtime", "title":"테스트 런타임 통과", "dependsOn":null,
    "artifacts":["tests","implementation"],
    "profile":{"kind":"runtime","command":"node","args":["--test","tests/example.test.mjs"]},
    "payload":{"instruction":"Run the actual test suite against the implementation."}
  }]
}
```

Agent profile: `{kind:'agent',provider:'codex',model,reasoning,timeoutMs?}`. Human profile: `{kind:'human'}` with at least one registered alarm method. The demo Code Runner supports Node test paths. Configuration and payload are fixed with the input, including uncommitted edits.

## Request and execution

`prepareReviewRequests({repoPath,repoId,snapshotHash,criticId?})` creates explicit envelopes containing `{repoId,snapshotHash,criticId,title,artifacts:[{id,type,path}],artifactTypes,payload,profile,dependsOn}`. The broker validates supplied envelopes against the prepared input. `--critic` selects exactly one envelope and validates only its required executor.

The Artifact Runner creates scoped Viewer entry-point tools such as `read_why`, `read_spec`, `list_tests`, and `read_tests`. Having the entire repo available as execution input does not grant an Agent visibility into every Artifact. Agent review requires observed reads of every supplied Artifact, a real Provider response, and a valid structured result.

Executors receive the prepared input path, a distinct `runDir`, cancellation signal and event callback. Runtime environment sets `CCDD_OUTPUT_DIR`, `CCDD_TMP_DIR`, `TMPDIR`, `TMP`, `TEMP`, `HOME`, and `XDG_CACHE_HOME` to review-specific locations. Runtime cwd remains the input so relative imports work. A test failure is RED; an operational failure or detected input mutation is ERROR.

## Durable broker and process ownership

`createBroker({repoPath,stateDir,repoId,executors?})` provides `submit`, `run`, `getRun`, `listRuns`, `getRequest`, `claimHuman`, `completeHuman`, `cancel`, `failRun`, `reconcile`, and `close`.

- `submit({mode,requesterId,criticId?,reviewRequests?})` captures input, validates requirements, persists the Run, and returns its Handle. It does not start execution.
- `run(runId,{signal?,onStarted?})` claims that Run transactionally. One live worker owns a Run; different Runs execute concurrently. Ownership stores PID, process identity and a token. Opening or closing another client never claims or cancels it.
- CLI submission starts a detached worker with private IPC for startup only. It exposes no listening server. The worker exits after completion or a copy-mode Human wait. `status --wait` polls stored state.
- Wait timeout returns exit 3 with the same Handle and leaves the worker running. `cancel` records ERROR and requests worker cancellation. Dead ownership is reconciled when records are inspected; there is no automatic retry or unseen background recovery service. `resume` can start persisted, unowned queued work.
- Normal termination cancels the worker's subprocess groups. Forced process/host termination cannot guarantee cleanup of every external side effect or descendant; unfinished work is never inferred to have passed.

Run scope is `{kind:'chain'}` or `{kind:'critic',criticId}`. Selected execution has exactly one request with `predecessorId:null`; the definition's `dependsOn` remains metadata. In a chain, each GREEN unblocks only the next request; RED/ERROR blocks the remaining requests. Run status is `QUEUED|RUNNING|WAITING_HUMAN|GREEN|RED|ERROR`; request status additionally includes `BLOCKED`. Completed results are immutable, and subsequent review attempts receive new Handles.

## Human lifecycle

The worker persists WAITING_HUMAN, invokes registered alarms, and records confirmed delivery. A registered local inbox writes `stateDir/human-inbox.jsonl`. It is a local file alarm, not an email, push notification or delivery acknowledgement by a person. Alarm failure causes ERROR.

Copy-mode waiting and owner release are coordinated transactionally. After the worker exits, another CLI process can inspect Artifacts, claim the request, and submit `{reviewerId,result:{verdict,summary,evidence}}`. Only the claimant may complete it and only once. Input integrity is revalidated at completion. A successful result queues any successor and the CLI starts a new request worker, reusing the originally saved execution configuration.

Lock-mode waiting keeps its worker and input monitoring alive. Human completion requires a live owner. Changes or owner death invalidate the review. Result files and notification output must be outside the locked workspace.

## Doctor

`diagnoseProject({repoPath,repoId,mode='copy',stateDir?,criticId?,executors,signal?,onEvent?})` returns `{ok,status:'READY'|'NOT_READY',repoId,mode,snapshotHash,scope,checkedAt,checks}`. It reads current definitions and validates actual project Viewer entry points. Exact Agent profiles are deduplicated; runtime path checks remain per Critic.

The Agent readiness probe uses the same Provider/model/reasoning and MCP transport with a random nonce Artifact in a private diagnostic workspace. It never writes into the original or shared review input. READY requires the correct nonce and audited tool read. Runtime diagnosis starts Node and checks paths, without executing project tests. Human diagnosis checks registration without sending notifications. No Run, semantic verdict or review history is created. READY describes the diagnostic moment, not future availability or Critic correctness.

## Compatibility

v0.3 removes `serve`, HTTP APIs, `--url`, `--commit`, and the browser/video recording implementation. Previous release assets remain historical. Use a fresh external state directory for new reviews; v0.1/v0.2 state located inside a repo is not automatically moved. An optional observer server can be added later without owning or being required for reviews.
