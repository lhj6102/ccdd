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
