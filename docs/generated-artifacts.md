# Generated Artifact data

An Artifact can be structured data prepared from project files, a generated scenario, or an immutable external revision. Register an Artifact source and tools for reading its captured data in `ccdd.config.ts`. CCDD owns the saved data; you do not need to create temporary files or invent stable temporary paths.

Start with the [complete example](../examples/generated-artifacts/README.md). It reads two independent scenario files and gives Human reviewers an overview tool and a tool for selecting individual details. The same data tools can be registered for Agent reviewers.

## Define the source and Artifact

```ts
import { readFile } from 'node:fs/promises';
import { defineArtifactSource, defineConfig } from '@ccdd/core';

const scenario = defineArtifactSource({
  metadata: {
    preparation: 'read-only',
    identity: { kind: 'canonical-data', namespace: 'example/scenario', version: '1' },
  },
  async prepare(context) {
    if (typeof context.params !== 'string') throw new Error('Expected a scenario path.');
    const file = await context.resolvePath(context.params);
    return { data: JSON.parse(await readFile(file, 'utf8')) };
  },
});

export default defineConfig({
  artifactSources: { scenario },
  artifacts: {
    checkout: {
      kind: 'generated',
      type: 'scenario',
      source: 'scenario',
      params: 'scenarios/checkout.json',
    },
  },
  artifactTypes: { /* Register scenario tools here; see the complete example. */ },
  critics: [],
});
```

The fragment above illustrates the source contract; the complete example includes the required type registration and Critics. Calling `defineArtifactSource` defines the callback without invoking it. Importing a source library does not register or prepare any Artifact. Registration is explicit in `artifactSources`.

A generated definition has `kind: 'generated'`, `type`, and the registered `source` ID. Optional `params` is a JSON value and defaults to `null` in the callback. `basis: true` and `stale: { kind: 'always' }` are supported. Generated definitions have no `path` and do not accept `file-hash` overrides. Existing file/directory definitions and groups retain their interfaces. A group may combine generated and file Artifacts; ordered member identities compose its identity, and membership still adds no dependency gate.

`prepare(context)` receives `{ artifactId, params, signal, resolvePath }`. Use `resolvePath` to read safe project-relative paths from the captured workspace. In copy mode these are the captured files, even if the original project subsequently changes. The callback returns `{ data }` or `{ data, revision }`, never a temporary-file handle. A source timeout may be declared as `metadata.timeoutMs` from 1 to 900000 milliseconds; the default is 120000.

## Preparation and reopening

Configuration evaluation, source preparation, and tool execution are separate operations. Keep preparation inside `prepare`, and keep tool observations inside `execute`. Do not generate material at module import time or in the config factory: those run again when CCDD reconnects implementations from the same captured configuration.

Each source must declare its preparation policy:

| Policy | When it is suitable | Current-input queries |
| --- | --- | --- |
| `read-only` | Reading existing evidence or inspecting fixed input without generation, Provider calls, or tool execution. | `status` and `plan` may invoke preparation. |
| `explicit` | Preparation that generates material or otherwise requires an explicit execution action. | `status` and `plan` fail explicitly; verification or tool diagnostics must prepare it. |

These declarations are a contract for trusted project code, not a sandbox that can prove a callback is read-only. Querying stored history and monitor GET routes invokes neither preparation nor registered tools. The monitor's explicit current-input inspection uses the same query policy as the CLI. A previous verification does not make a later current-input query silently reuse its old prepared material.

CCDD canonicalizes and copies the returned data once, binds its identity to that captured value, and persists a serializable snapshot with the Run/request. The snapshot includes a version, identity strategy and fingerprint, canonical content integrity hash, and the data itself. Its contents are bounded to 4 MiB of canonical UTF-8 JSON per Artifact and at most 64 nested object/array containers. Split larger material into separate Artifacts and selective tools.

Reopening verifies the recorded snapshot and reconnects source/tool definitions from the recorded workspace and serializable manifests. It does not call `prepare` or a custom fingerprint callback, fetch a current external revision, or regenerate missing material. Missing data, corrupted data, or incompatible strategy metadata fails explicitly. Worker restart and later Human tool calls therefore observe the recorded data. State and outputs remain outside the reviewed workspace.

Remote Human preparation transfers this recorded JSON with the reserved review and downloads the configuration workspace through the existing snapshot transfer. Tools on the reviewer's machine receive the same captured value. Remote metadata GET responses omit generated data; the explicit Try Claim response supplies it for preparation.

The snapshot is an inline, bounded data contract. It is not an arbitrary blob store, streaming source, or caller-managed path adapter. Agent and Human review scopes support generated Artifacts. Runtime Critics containing generated Artifacts, including through a group or dependency, are rejected explicitly; their existing Node filesystem execution contract remains separate.

## Choose an identity strategy

All strategies declare `{ kind, namespace, version }`. The namespace identifies the meaning of an identity; the version must change when its equivalence rules change. Artifact identity includes the logical Artifact definition and this strategy's fingerprint. Request IDs, preparation times, temporary paths, and the workspace cache location do not become generated-data equivalence keys.

| Kind | Source result/callback | Equivalence assertion |
| --- | --- | --- |
| `canonical-data` | Return `{ data }`. | The complete canonical JSON data is equal. CCDD hashes that data. |
| `immutable-revision` | Return `{ data, revision }`. | The same source-scoped immutable revision always denotes equivalent complete data. CCDD hashes the revision. |
| `custom` | Return `{ data }` and implement `fingerprint(data)`. | The returned fingerprint string covers the complete observable data. CCDD hashes that string. |

Namespaces and versions must be nonblank strings of at most 200 characters. Revisions and custom fingerprints must be nonblank strings of at most 4096 characters. Only a custom strategy accepts `fingerprint(data)`. It receives a copy of the captured data and cannot change the recorded value.

For an external revision, scope the namespace to the actual source or collection: for example, `example/catalog/products`, not a generic `revision`. Two independent services can both issue revision `42`; the number alone does not identify equivalent material. A mutable label such as `latest` is not an immutable revision. The stored content hash separately detects corruption; it does not repair an incorrect equivalence assertion by a custom source.

Every value any bound tool can expose is part of the evidence. A timestamp may be left out only by removing it from the captured data before identity is calculated and keeping it unavailable to review tools. A custom fingerprint that hashes only a summary while a detail tool can return changing detail creates unsound reuse. Tools must read material through `context.readData()`; live-source reads, uncaptured closure values, and mutable external responses must not determine their observations.

`stale: { kind: 'always' }` disables reuse across validation requests and propagates through consuming groups and Critics. Same-request evidence can still satisfy gates. It still requires a fixed captured value: it does not permit mutable tool observations or missing snapshots.

### Canonical JSON rules

The canonical-data contract is deliberately strict:

- Supported values are `null`, booleans, strings, finite numbers, dense arrays, and plain objects with the ordinary or null prototype.
- Object keys are ordered by UTF-16 code units, independent of locale. Array element order is preserved.
- Strings retain their exact values. There is no Unicode normalization, trimming, or case folding. JSON string escaping follows `JSON.stringify`.
- Finite numbers use JSON number serialization. `-0` becomes `0`; non-finite numbers are rejected.
- Cycles, sparse arrays, array properties beyond indexed elements and `length`, accessors, non-enumerable object properties, symbols, `undefined`, functions, bigint, class instances, Dates, Maps, and Sets are rejected. Values are never silently dropped or converted with `toJSON`.

Equivalent object-key ordering or JSON whitespace can therefore produce the same identity. Reordering an array changes identity. Nonsemantic fields should be removed during preparation under an explicit, versioned normalization contract, before any tool can observe them.

## Expose selective data tools

Use `defineDataTool` for a generated Artifact. Its metadata sets `artifactKind: 'data'` automatically; default file and directory tools cannot bind to generated data.

```ts
import { defineDataTool } from '@ccdd/core';

const overview = defineDataTool({
  metadata: {
    description: 'Read the objective of {artifactName}.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    resultKinds: ['json'],
    observation: 'content',
  },
  execute(context) {
    const data = context.readData();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Expected scenario data.');
    }
    return {
      content: [{ type: 'json', data: { objective: data.objective ?? null } }],
      observation: { kind: 'content' },
    };
  },
});
```

Register it explicitly as `artifactTypes.scenario.agentTools.overview`, `humanTools.overview`, or both. The generated tool name retains the Artifact ID, such as `overview_checkout`. The context supplies `{ artifactId, outputDir, tmpDir, signal, readData, resolveExecutionPath }`. Every `readData()` call returns a fresh copy of the same captured value. No filesystem Artifact path or cross-Artifact selector is exposed. `resolveExecutionPath` remains limited to declared tool implementation inputs; it is not an alternative source of live review evidence.

Each tool registry registers its captured generated inputs once with its own host.
Registration checks the snapshot definition, source identity and complete content
hash before keeping a private copy. Later tool calls carry the bound Artifact ID
and arguments, without retransmitting or rehashing that data. A tool that does not
call `readData()` does not copy it; each `readData()` still returns an independent
clone. Closing the host discards these bindings. A fresh registry validates and
registers its own input again, including changed data under the same logical ID.
This is observation reuse within one fixed input, not source preparation or
verdict reuse across reviews. See the [tool overhead benchmark](generated-tool-performance.md).

Data stays behind these tools. The initial Agent prompt, instruction references, and monitor scope metadata contain Artifact references and registered tool metadata, not the captured data or snapshot descriptors. A tool can return an overview, one detail, a rendered image, or another schema-validated result. Existing per-result size limits and Agent observation requirements apply. A successful selective read does not prove the reviewer inspected every detail; the Critic instruction defines the necessary investigation, and the complete captured value still participates in identity.

## Reuse across scenarios

This changes Artifact identity and observation without changing review caching policy. Project Validation still requires actual matching GREEN evidence for the effective Critic definition, target, and direct dependencies, with satisfied dependency gates. An unread detail changing the canonical data invalidates the input. Returning from data A to equivalent data A after reviewing B can reuse applicable historical A evidence; a later RED for that same input still takes precedence over an earlier GREEN.

Keep independent scenarios in separate generated Artifacts. Prepare their evidence from files through `context.resolvePath` instead of importing scenario data into shared TS config. Config modules, source code, and scoped tool implementation inputs retain conservative definition hashing: changing shared config code may invalidate unrelated Critics even when their material is unchanged. There is no source-result memoization across requests, persistent stale flag, or push invalidation mechanism. See [Project Validation](project-validation.md) for readiness and evidence rules.
