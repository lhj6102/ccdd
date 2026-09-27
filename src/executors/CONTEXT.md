# Executors

Executors perform actual evaluation and return evidence. The Broker owns assignment and lifecycle; Project Validation owns reuse and final satisfaction.

- **Runtime Critic** executes the fixed Node test profile against resolved Artifact paths.
- **Agent Critic** uses the requested Provider, model and reasoning profile with scoped observation tools.
- **Human Critic** notifies a registered alarm, then requires a person to observe and submit an explicit result.
- **Artifact Runner** binds each admitted folder's declared scripts to reviewer-specific tools. It validates arguments, the standard JSON protocol, result content and observations.
- **Instruction Artifact Reference** resolves a local mount alias or unique name to canonical tools. It is neither content interpolation nor an observation.
- **View** is an owner-defined operation with metadata and a fixed command/argv. Agent and Human tool maps are separate.
- **Scope** contains the target, explicit references and their child/mount closure. Logical paths resolve to existing physical paths; no copy or symlink is created.
- **Content Observation** records successful inspection of content or a truly empty input. Listings and desktop launch receipts do not prove observation.
- **Readiness** checks execution prerequisites. It never substitutes for a semantic verdict.
- **Environment Requirement** is an Artifact-owned local check performed during explicit Human preparation, not discovery or GET.

Scripts run in the owner's folder and receive external output/temp directories on stdin. Timeouts, cancellation, child cleanup and workspace integrity boundaries protect the review lifecycle. Tool libraries are optional and register nothing by installation. Computed views and blind A/B procedures are ordinary user scripts, without a separate source or presentation Executor.


## Provider identity visibility

CCDD resolves the exact requested Provider/model/reasoning from Pi's catalog and
never requests a model fallback. It rejects mismatching Provider, model or
`responseModel` metadata that Pi exposes before accepting a verdict or executing
that response's tools.

The Pi Codex Responses parser in both 0.85.1 and 0.87.1 drops the server's
`response.model`: even an explicit different model in a response event does not
reach `AssistantMessage.responseModel`. This pre-existing upstream observability
limitation means absent response identity is **unknown**, not proof that the
server honored the request. CCDD does not infer it from response text, implement
a second SSE parser, or reject replies solely because Pi omitted it. The Go
Completions adapter does preserve an explicit mismatch, covered by a real-adapter
fake-HTTP rejection test. Offline wire tests do not establish live model access.
