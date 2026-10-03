# Context Map

- [Project Validation](src/project/CONTEXT.md) discovers static Artifact declarations,
  prepares explicit owner identities and requests missing actual results.
- [Broker](src/broker/CONTEXT.md) owns Run receipts, execution lifecycle, admission
  and Human claims. Cache-owned executions are independent of one caller Run.
- [Executors](src/executors/CONTEXT.md) perform real Runtime, Agent and Human work,
  with built-in bounded Provider/account recovery.
- [Identity cache](docs/identity-cache.md) maps an explicit identity to a completed
  result across projects. It owns in-flight subscriptions, publication fencing
  and capacity-based GC, not input equivalence or workspace policy.

`@ccdd/ccdd` is the single-install facade with exact coordinated dependencies.
`@ccdd/core` provides pure definitions/scope resolution; `@ccdd/project` packages
the runtime and public cache/Project APIs. `@ccdd/default-tools` supplies optional
scripts. Installing a library never registers tools or creates state.

Static folder/family `ccdd.json` discovery never runs scripts. Child, mount and
instruction relations define a finite graph. SCCs support cycles and execution
gates, not hidden cache-key salts. The owner function alone defines reuse; no
function means no reusable cache. Same identities are shared without repo or
worktree registration. Project receipts retain their actual historical results.

Artifact Runner reconnects the pinned manifest and supplied workspace into
scoped reviewer tools. It validates arguments, content and observations; outputs
remain outside input. Workspace integrity remains an execution boundary, not a
cache hit filter. The optional monitor is observational on GET and delegates
explicit current inspection and Human actions to their owning contexts.

See [contracts](docs/contracts.md), [Project APIs](docs/project-validation.md)
and [7.x migration](docs/migration-v7.md).
