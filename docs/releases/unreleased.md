# Unreleased: 5.0 contract and reuse

These breaking changes target 5.0. Package metadata stays at 4.3.0 pending the coordinated release. Nothing in this change publishes or tags a release. See [migration](../migration-v5.md) and [contracts](../contracts.md).

- **Fresh state required:** 5.0 rejects 4.x/unmarked state directories on opening. No legacy reads or migrations are provided. Use a new external state directory.
- **Identity:** version 3 validation keys depend only on Critic ID and target/dependency Artifact identities. Owner identity uses only Artifact ID plus the owner's value; scripts, definitions and runtime settings are the owner's responsibility to encode. Default identity keeps material/configuration/owned-Critic/execution/environment/integrity coverage. Package/Node version, platform and architecture are no longer automatic key salts.
- **Owner responses:** remove mandatory summary/evidence and their fixed length/count limits. Optional Critic `passSchema`/`failSchema` govern extra top-level result fields. Verdict-only is the default. Agent has one format-only repair; Human submissions use the same schema and are never silently truncated.
- **Compact results:** default requester payload is `{verdict, ...ownerFields, reference, reusedFrom?}`. Each Run/query/plan emits each result once; request/Critic/item entries reference it by request ID. CLI `--full`, API `detail: "full"`, and full stored Run lookup retain audit access.
- **Reuse:** reuse matching GREEN and RED; RED remains unsatisfied. `--force` executes again. Identical active requests across Runs in the same state directory coalesce without duplicate tickets and retain original audit references.
- **Complete audit:** remove the silent 100-tool-call truncation. Tool arguments, observations, criteria, snapshots and telemetry remain stored; the overall size limit fails explicitly rather than dropping calls.

Controlled transport tests exercise actual Pi Agent/tool execution and required-observation checks without real Provider calls. Full audit content is unchanged by projection. Payload-size measurements are reported by `test/result-view.test.ts`; they are fixture measurements, not Provider performance benchmarks.

The normalized 12-call audit fixture measures **51,528 bytes full → 691 bytes compact (98.66% smaller)** for a standalone request. Its Run and standalone plan each contain owner result text exactly once; full stored request JSON remains byte-identical before and after requester reads.

Coalescing uses a bounded submission grace lease for unowned QUEUED sources
(default 15 seconds; SDK `coalescingGraceMs` configures newly submitted Runs).
Expiry atomically replans into a follower-owned ticket or another active source;
workers never host another Run. Abandoned source records remain unchanged, and
reviving such a source may execute its original queued ticket again. Actual
worker-entry-point tests cover close/cancellation isolation, A+B versus A scopes,
and two-process lease-expiry races.

## Critic efficiency and operations

- R5: Critic prompts include only Artifact ids, paths, target/dependency/basis roles,
  included folders and mounts. Tool descriptions and schemas appear only in the
  provider tool channel; all review security and observation instructions remain.
- R6: Each Pi request uses its review request id as the stable provider session
  cache key, including tool continuations and the one format-only repair turn.
- R7: Tool completion diagnostics include total and per-kind response payload
  bytes, without retaining response content or changing identity/reuse/verdicts.
- R8: Closing or aborting an Artifact tool registry removes its owned temporary
  root and output tree, including construction failures. Caller-supplied roots
  are retained. Explicit SDK `pruneProject(stateDir)` and CLI `ccdd-project prune`
  remove only known scratch directories of completed, unowned runs; automatic
  pruning remains off and all audit evidence stays intact.
- R9: Scheduling and ownership polling read small status rows instead of full
  run/request JSON. Durable request-state revisions trigger replanning only on
  state changes, including changes committed by another process.
- Review hardening: explicit prune is Linux-only and fails closed elsewhere.
  Descriptor-anchored traversal and verified private quarantine moves prevent
  parent-symlink substitution from redirecting deletion. Bulk deletion no longer
  holds the SQLite writer lock; owned temporary-root cleanup remains portable.
