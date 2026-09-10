# Repo Requester → Broker

The Requester specifies the current repo and workspace policy. After the Broker prepares input, explicit review requests are constructed from that input's `ccdd.config.ts` (or transitional legacy `ccdd.config.json`). A Git commit is not required.

```js
const broker = createBroker({repoPath, stateDir, repoId: 'local', executors});
const run = await broker.submit({mode: 'copy', requesterId: 'builder-feature-a', criticId: 'tests-spec'});
// Separate request worker:
await broker.run(run.id);
```

`stateDir` is outside the repo. Submission and execution are separate; the CLI starts a worker for each request. A status-query client does not own the Executor.

Once input is prepared, `prepareReviewRequests({repoPath: workspace.path, repoId, snapshotHash: workspace.hash, criticId})` creates requests with these fields:

```js
{
  repoId, snapshotHash, criticId, title,
  artifacts: [{id, type, path}],
  artifactGroups: [{id, members}], // Present only for a scope containing groups.
  artifactTypes, configManifest, payload, profile, target, deps
}
```

`target` identifies the evaluation target, and `deps` is an array of referenced Artifact IDs. Both individual Artifact and group IDs are allowed. Configuration declares groups as `{kind:'group',members:[ID,...],basis?}`, with no type or path. Members reference independent definitions and may include other groups. Empty lists, duplicate or unknown members, and membership cycles are rejected.

`artifacts` is the deduplicated leaf list obtained by recursively expanding `[target, ...deps]` in member order. Reached groups are serialized in optional `artifactGroups: [{id,members}]`. Requests without groups omit this field to preserve their existing shape. Expansion does not follow `deps` from members' Critics. Even if a copy contains other files, the Artifact Runner provides only tools within the request's scope. Acceptance and tool reconnection compare leaf and group information against definitions from the same snapshot.

Group membership is not a prerequisite evaluation condition. A group's verdict aggregates only Critics directly targeting that group, without propagation between group and member verdicts. `deps`, `basis`, and execution waiting rules apply independently to groups. Groups and image tools were included in v1.1.0; existing individual Artifact configuration and request contracts are preserved.

`payload.instruction` remains a string whose original text is preserved in configuration, envelopes, stored records, and HTTP responses. Only Agent prompt construction expands in-scope `{ID}` references into actual supplied tool lists. Tools are joined by their registered `artifactId`, without guessing names.

```text
Source: Review whether {spec} satisfies the requirements in {why}.
Agent: Review whether {"artifact":"spec","tools":["read_spec"]} satisfies the requirements in {"artifact":"why","tools":["read_why"]}.
```

A group reference such as `{explosion}` associates actual tool names with each supplied leaf. Nested and shared members are included only once.

```json
{"artifactGroup":"explosion","members":[{"artifact":"effect","tools":["read_effect"]},{"artifact":"preview","tools":["view_image_preview"]}]}
```

The Human interface displays the same references as buttons leading to that Artifact's Human tool selection area. Group references allow tool selection for each member. Clicking a reference only selects or focuses; tool execution follows the existing claim and explicit execution process. The monitor validates stored leaf and group information and supplies only safe display data. Viewing the screen or resolving a reference does not evaluate configuration code, read Artifact bodies, or launch programs.

Only exact Artifact IDs are referenced. Brace-delimited sections such as JSON objects, nested or doubled braces, escaped references such as `\{spec}`, `{unknown}` or out-of-scope IDs, and expressions such as `{spec.path}` remain literal and do not introduce new acceptance errors. Instructions are not parsed as general JSON documents, so `{ID}` within quotes or arrays outside those brace sections is still a reference; escape it to preserve it literally. The observation scope defined by `target` and `deps` remains unchanged. This rule is separate from `{artifactName}` substitution in tool descriptions and adds neither reserved instruction variables nor a stored rendered-result field. Other payload fields are unchanged.

A selected-Critic request creates one envelope and does not require referenced Artifacts to have passed first. A full Graph Run executes a Critic when every required Critic of its referenced Artifacts is GREEN or the reference is an explicit basis Artifact. Independent Critics execute in parallel, and Human waiting does not stop independent branches. Requesting another review after edits creates a new Handle and input hash. Identical-hash copies can be shared, but results are evaluated separately. These rules describe the Broker's legacy execution contract; [Project Validation](project-validation.md) adds prerequisite enforcement and evidence reuse for `ccdd-project verify`.

Human waiting in copy mode is durable and requires no resident process. Result submission continues subsequent execution. Human waiting in lock mode requires a live input-monitoring worker.

TS types explicitly register `{ metadata, execute, preflight? }` definitions in `agentTools` and `humanTools`. Storage excludes functions and fixes descriptions, input schemas, result/observation contracts, and implementation identities in `configManifest`. `artifactTypes` carries only serializable type identities. Historical JSON requests have no `configManifest` and execute under the legacy Viewer contract. The Artifact Runner replaces `{artifactName}` in descriptions with the actual Artifact ID and builds tools such as `read_spec`, `list_tests`, and `open_spec`. New Agent/Human requests require tools for that audience on every supplied Artifact; empty or omitted maps are rejected before submission. With `--critic`, only the selected Critic is checked. Tool arguments are validated against each metadata JSON Schema; arbitrary operation names and text, JSON, image, and app-launch results are supported. Default Agent Readers use line-based `startLine` and `lineCount`, plus an internal `path` for directories. Default Human tools open registered desktop applications. The Artifact Runner binds the snapshot path, output and temporary directories, and cancellation signal, checking the recorded manifest against its implementation at execution and Human resume. Installing or importing the default tool library does not register it.

Tool registration and required-observation checks apply to every leaf in group requests as well. `tools check --artifact GROUP` expands member tools and checks readiness; `--execute` requires an explicit leaf. Register the default image tool as `agentTools: {view_image: agent.image.view()}` to provide `view_image_<ID>`. It uses Pi's read implementation to return actual PNG/JPEG/WebP image blocks up to 4MiB, without a separate LLM call. Pass `{}` for files or an internal `path` for directories. Text, GIF, BMP, and APNG fail; images are neither automatically resized nor converted.

Agent requests go to the Pi Executor. Common request/result types live in `src/contracts.ts`; Pi library types are not exposed as Broker contracts. The default image tool's internal Pi read adapter also owns no Agent session or Broker state. Credential-file paths are execution environment settings; credentials do not belong in repo payloads or Artifact definitions.
