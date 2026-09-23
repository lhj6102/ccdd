# Context Map

## Contexts

- [Project Validation](src/project/CONTEXT.md): Determines whether current validation requirements are satisfied using Artifact identities and actual verdict history, and requests any validation still needed.
- [Broker](src/broker/CONTEXT.md): Owns review requests, progress, assignment, and the results returned to requesters.
- [Executors](src/executors/CONTEXT.md): Performs actual reviews through Runtime Critics, Agent Critics, and Human Critics.

## Relationships

- **CCDD definitions → Project Validation**: Supplies Artifact, Critic, and DAG relationships, stale strategies, and registered source/identity contracts. The definition package does not own project state or prepare material.
- **Project Validation ↔ Broker**: Reads actual verdicts and input identities and requests only the reviews needed. The Broker owns tickets, assignment, and execution lifecycles.
- **Requester → Broker**: Supplies the unchanged review workspace and constructs requests from the prepared input's Artifact references and review payloads.
- **Broker ↔ Executors**: The Broker assigns reviews; Executors return verdicts and evidence.
- **Artifact Runner → Executors**: Connects the registered tool definitions for Artifacts referenced in a payload, providing the observation entry points available to the reviewer. Generated data tools read only the saved material for their bound Artifact.
- **Tool libraries → Project configuration**: Supplies default or custom observation tool definitions. Only definitions explicitly registered by the project reach reviewers. A library does not own request or execution state.
- **Broker → Requester**: Returns request progress and results to the original requester.

The three contexts cooperate within `@ccdd/project`. `@ccdd/core` contains definitions only. The Artifact Runner is the boundary connecting requests to observation tools. The default tool library is an optional collection of implementations, not a separate business context or execution manager.

Project prepares generated Artifact data separately from config evaluation and stores its serializable snapshot with the request. Project Validation uses the declared versioned identity; the Broker and Artifact Runner reopen and verify the same captured material without preparing it again. Source implementations reconnect from the same workspace and manifests. See [generated Artifacts](docs/generated-artifacts.md) for preparation, equivalence, and data-tool contracts.

The local monitor is an optional interface. It displays stored review state across projects and forwards a Human Reviewer's explicit claim, tool execution, and verdict submission to the Broker. It does not own review execution or change review history when querying status.

The monitor delegates current-input inspection to Project Validation through an explicit POST. The computed result is displayed in the browser and is not stored as per-Artifact stale state. See the [command and query contracts](docs/project-validation.md).

Human preparation and tools run locally against the supplied workspace. The
worker stays alive throughout Human waiting and invalidates unfinished reviews
on input changes or owner death. Users may manage a separate worktree themselves;
CCDD does not create or transfer workspace copies.
