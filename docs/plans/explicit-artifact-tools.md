# Plan for explicitly registered Artifact tools and TS configuration

Status: approved plan implemented in v0.9.0. Written on 2026-09-06 against main after PR #9 was merged. The finalized APIs and constraints are documented in the [current contracts](../contracts.md), and results in the [v0.9.0 verification record](../v0.9.0-validation.md). Historical review snapshots and verdicts remain unchanged.

## Goals and scope

Users create and register tools in `ccdd.config.ts`. Tool factories return definitions containing metadata and an execution function. When a registered tool is called, it binds to the Artifact in that snapshot and executes.

- Default tools are imported from a separate library and explicitly registered. Installation, import, and tool construction alone neither register tools nor execute observations.
- Default Agent tools connect structured calls to a CLI and return observation results. Default Human tools open desktop applications for a person to observe.
- A CLI approach is the recommended implementation for default tools. Custom tools may use functions, SDK calls, or CLI adapters under the same contract. The baseline plan does not force every custom function through a CLI.
- Remove extension limits currently restricted to text/files and read/list. Custom animation/VFX tools must be able to register new metadata, arguments, and results.
- Preserve Broker/Executors boundaries, Pi Provider integration, the Artifact DAG, copy/lock, individual Critic selection, and Human notifications, claims, and verdict submission.
- The initial default tools cover Agent text reading/file listing and Human file/folder opening. A Viewer for a specific animation engine is separate follow-up work. The common contract supporting image results and custom tools is included in this migration.

## Package structure

| Location / package | Responsibility |
| --- | --- |
| Existing root / `@lhj6102/ccdd` | Broker, Artifact Runner, Executors, monitor, and lightweight public configuration/tool APIs |
| `packages/default-tools` / `@lhj6102/ccdd-default-tools` | Optional default tool definitions, Agent CLI implementations, and Human desktop launch implementations |

The main package does not automatically couple to the default tool library through a runtime dependency or re-export. The default tool library uses type imports from the main package's public tool contract and declares a compatible peerDependency. Development and tests use workspaces in the same repository. No new protocol-only package is added initially.

Add `exports` and a type declaration entry point to the main package. Importing the SDK from configuration must not start a Broker database, Provider, monitor, or application. Verify installation of each package as a separate tarball; public npm publication is outside this plan.

```ts
import { defineConfig } from '@lhj6102/ccdd';
import { agent, human } from '@lhj6102/ccdd-default-tools';
import { sampleFrame } from './tools/animation.js';

export default defineConfig(() => ({
  artifactTypes: {
    markdown: {
      agentTools: { read: agent.text.read() },
      humanTools: { open: human.desktop.open() },
    },
    code: {
      agentTools: {
        list: agent.files.list(),
        read: agent.files.read(),
      },
      humanTools: { open: human.desktop.open() },
    },
    animation: {
      agentTools: { frame: sampleFrame() },
      humanTools: { open: human.desktop.open() },
    },
  },
  // Declare artifacts and critics using the existing target/deps structure.
}));
```

Remove `viewer: 'text' | 'files'` as a required field in new configuration. Each tool validates its supported input conditions, such as file or directory. Public names such as `read_spec` and `frame_walk` retain the existing `<toolName>_<artifactName>` convention. Empty audience tool lists cannot serve Critics of that kind.

## Tool and storage contracts

A tool definition has the basic form `{ metadata, execute(context, args) }`. Metadata contains a description, actual input schema, result contract, and observation mode. Support optional `preflight` checks for execution readiness when needed. Preserve `{artifactName}` substitution in descriptions.

Define the input schema once and share it among execution function types, Agent tool specifications, Human input forms, validation before execution, and `tools check`. TypeScript types do not replace runtime validation. Specify the supported JSON Schema subset and explicit errors for unsupported features.

The execution context provides the bound Artifact, its snapshot path, a way to resolve allowed internal paths, per-review output and temporary directories, and a cancellation signal. Distinguish tool-call errors from review request state. An ordinary Human app-launch failure displays an error while preserving WAITING_HUMAN for retry. Input integrity violations or errors preventing Critic completion cause request ERROR. Do not turn tool results into Critic GREEN verdicts. Tool definitions own external app/command configuration; reviewer call arguments accept only registered inputs.

Do not put functions into JSON or the database. Evaluate configuration once at submission and separate:

1. Stored manifest: version, snapshot, audience, Artifact type, tool key, descriptions, schemas, result contracts, and identities of implementations and execution dependencies.
2. Execution registry: in-process values connecting tool identifiers to actual functions.

Generate the Graph and request envelopes from the same configuration evaluation. When a worker or Human review resumes, reload configuration and tool implementations from the recorded snapshot and check agreement with the stored manifest and compatible version. Report a mismatch instead of substituting newer tools. Do not share mutable user closure or import-cache state between reviews.

Resolve configuration, default-tool versions, and custom modules inside the snapshot. Do not silently fall back to the original repo, parent monorepo, or global installation. Keep loader and build caches outside input. Project dependencies must be physically installed before execution, and demos must state this requirement. TS configuration is trusted repo code; do not describe this architecture itself as an OS sandbox.

## Default Agent and Human behavior

Agent `text.read()` wraps a packaged reading CLI. The tool implementation chooses the executable and fixed arguments, then passes validated arguments and the Artifact path. Default Node CLIs use the current Node executable and packaged distribution files without requiring global command installation. CCDD adds no general-purpose shell tool. Preserve the existing Reader's UTF-8, CRLF, empty-file, EOF, partial line-read, and response-limit behavior.

Default Human text viewing opens a registered desktop app or OS-associated program. Do not duplicate Agent read/list as default Human tools. Monitor buttons open programs for the person and report launch results. Opening a program is separate from completed reading or a completed verdict. Retain input copies so applications can stay open, and put execution output and caches in per-review directories. Desktop integration runs on the Executor host; the initial actual verification target is the current macOS environment. State the adapters and verification status for other operating systems.

## Generalizing results and observations

ToolResult distinguishes text, structured data, images, and application-launch results. Update Pi and MCP content adapters together so images are not delivered only as JSON strings. Return an explicit error when the model does not support a result format. Validate and read images and generated files in the review output area outside input.

Separate required observation from the combination of `read_<artifactId>` and line counts. The Runner records observations of the actual bound Artifact according to the registered tool's observation contract and validated successful result. Listing and application launch alone do not count as content observation. A frame extraction tool must be able to record the observed scope when it returns a valid frame. Existing text tools retain empty-file and EOF semantics. Records provide evidence of successful observation; the Critic judges Artifact quality.

## Monitor and diagnostics

- Monitor GETs build the interface from stored tool manifests. They do not import configuration, evaluate user functions, or launch apps. The existing detail-query path that creates a registry must also change.
- Connect snapshot implementations and call tools only on explicit POSTs after a Human claim. The default UI centers on application-launch buttons, with user input derived from schemas. Do not incorrectly coerce booleans, enums, numbers, arrays, or objects into strings or integers. Provide validated JSON input for complex arguments.
- Default `tools check` inspects manifests, Artifact access, and execution readiness. Explicit `--execute` with Artifact, audience, tool, and arguments performs actual execution. When custom preflight is absent, distinguish confirmed registration from unverified execution.
- `doctor` uses the ordinary registry. Verify Provider round trips through an internal diagnostic nonce tool without registering it in the project or requiring default-tools. Report actual checks of registered project tool behavior separately. Default checks do not open Human apps.

## Implementation sequence and completion criteria

| Stage | Main changes | Completion criteria |
| --- | --- | --- |
| 1. Public contracts | `src/contracts.ts`, `src/artifacts/types.ts`, SDK exports, schema/result/observation contracts | One custom tool can be registered, validated, and executed without the default tool package |
| 2. TS configuration and reproducibility | Config loader, requester, Broker manifest storage, Worker/Human reconnection | Stored manifests contain no functions; resume uses the same snapshot; manifest mismatches and missing dependencies are rejected |
| 3. Default tool library | `packages/default-tools`, reading CLI, desktop launcher, separate packaging | Imports and factories execute no operations; only explicitly registered tools are exposed; Agent/Human defaults remain distinct |
| 4. Integrated execution | Artifact Runner, Pi/MCP, observation checks, tools check, doctor | Arbitrary names, schemas, and image results use the same execution path; read/list-only branches are removed |
| 5. Human monitor | Stored manifest queries, schema input, launch results, legacy viewing | GETs execute nothing; tools require claim; app launch and verdict submission stay separate; resume works after restart |
| 6. Migration and distribution verification | TS demos, custom Reader example, documentation, package installation regressions | Actual installation of both tarballs, copy/lock, and real Agent/Human/Runtime flows are verified |

Connect the default text Agent and desktop Human paths during stages 1–3, then implement the remaining adapters and migration. Completion means custom tools work throughout the review flow, beyond merely splitting packages.

## Migration policy

New default configuration and demos use TS with explicit imports. During v0.9 migration, new requests from existing JSON are also accepted; historical records and waiting Human resumes retain legacy adapters. Do not apply JSON defaults to empty TS objects. If both configuration files exist, report a conflict instead of hiding precedence.

Do not automatically modify historical snapshots or results or reinterpret historical Human reads as new desktop opens. Distinguish existing passive Artifact source viewing from executable tools registered for Humans. Update the "one npm package" wording in `AGENTS.md` and current contracts when package separation is implemented. Preserve the canonical Why → Spec → Tests → Implementation DAG.

## Verification and acceptance criteria

1. A project without the default library can register a custom Reader and non-text tools. With no registered tools, requests for that audience are rejected.
2. The default Agent Reader satisfies the existing line-read contract through an actual CLI. Default Human tools open snapshot files in actual desktop applications and are not replaced by text-returning tools.
3. Verify schema validation, image delivery, and observation records for custom tools that do not assume text. Also cover arbitrary tool names, invalid arguments/results, and models without image support.
4. Preserve cancellation, timeouts, subprocess cleanup, Artifact internal-path restrictions, copy/lock integrity, and output separation during execution.
5. Repeated monitor GETs run no user code, CLI, or application. Preserve claims, CSRF, verdict submission, and durable Human waiting.
6. Pack both packages separately and install them in a new project without development dependencies. After snapshot copying, execution and Human resume still use the same tools and versions even when the original is unavailable. Function state does not leak between separate projects.
7. Distinguish actual Provider diagnostics in `doctor` from whether `tools check` executes a tool. Verify actual Agent results, Runtime tests, and Human app launches without fixing verdicts in advance.

Implementation decision: use Node 24 native TypeScript and separate processes, resolving imports only inside the snapshot. Current contracts and tests specify metadata, observation results, and supported JSON Schema features. New JSON requests remain a transitional compatibility path in v0.9; a later version will decide their removal.
