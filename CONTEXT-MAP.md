# Context Map

- [Project Validation](src/project/CONTEXT.md) discovers static folder declarations, derives input identities and checks actual review evidence.
- [Broker](src/broker/CONTEXT.md) owns review tickets, worker ownership, Human claims and recorded results.
- [Executors](src/executors/CONTEXT.md) perform actual Runtime, Agent and Human evaluation.

`@ccdd/core` provides definitions and a pure scope resolver. `@ccdd/project` packages the three contexts. Optional `@ccdd/default-tools` supplies ordinary scripts; installing it registers no tool.

Each Artifact folder owns `ccdd.json`, its views and its Critics. Project Validation discovers markers and derives child, mount and instruction relations. Cycles are allowed. Strongly connected components provide finite content identities, and per-query traversal collects required actual evidence. Readiness to execute does not depend on another Critic's PASS.

The Requester builds immutable envelopes from static declarations. Artifact Runner reconnects script definitions from the same manifest and workspace, binds them to reviewer-specific tools, and validates JSON arguments/results. It creates no Artifact copies or generated material. Scripts receive canonical paths and logical connections; writable output belongs outside input.

The Broker asks Executors to evaluate missing selected evidence. Results return to Project Validation for final satisfaction queries. The Broker stores execution history; it never propagates stale flags. Missing required evidence produces INCOMPLETE while preserving completed selected results.

The optional local monitor displays stored records through readonly GETs, delegates explicit current-input inspection to Project Validation and Human actions to the Broker. It owns no worker. The supplied workspace remains unchanged throughout execution and Human waiting. Users can provide their own worktree; CCDD creates neither copies nor mount symlinks.

See [implementation contracts](docs/contracts.md) and [version 4 migration](docs/migration-v4.md).
