# Project-independent identity cache delivery

## Approved contract

CCDD is a local computing resource: explicit `identity -> completed result`,
independent of project, repo, path, worktree, Critic, profile and runtime. No
identity function means no reusable cache, including no automatic file-hash
fallback. Owner functions define substitutability; CCDD owns admission,
in-flight subscriptions, ownership fencing, Provider recovery and cache GC.

PR #100 implements the TypeScript changes for #90, #92, #93, #94, #95, #97, #98
and #99 together. Rust implementation is a separate follow-up in #101. The
owner decision replaces workspace linking (#99), cache-layer workspace-update
leases (#95-A), profile drift invalidation (#95-C), and unverified persistent
identity-function memoization (#95-G). It does not remove execution safety.

## Implementation map

| Issue / area | Implementation and regression evidence |
| --- | --- |
| #90 | Bounded identity workers, read-before-write admission with atomic revalidation, throttled owner cleanup and bounded SQLite BUSY retry. `local-resource-regressions`, `resources`, and the two-process scale acceptance cover contention and capacity. |
| #92 | Bounded JSON/line selector files with ordinary ID validation, stable deduplication and conflict rejection; `selection-file` tests. |
| #93 | Worker initialization via IPC rather than argv, with bounded startup/disconnect; scale acceptance actually selects and completes 1,101 Critics using a >128 KiB scenario. |
| #94 | Opt-in compact graph, indexed projection, default family grouping, 100-member pages and guarded large-family expansion. `compact-graph` tests measure transfer size; the real GraphView template/ELK host-render test traverses 1,101 members without rendering them all at once. |
| #97 | Deterministic concurrency barrier retains both reaching the configured concurrency and never exceeding it. |
| #98 | Full original profiles in stored/compact views; old incomplete headers use their own immutable envelope, never current definitions. Reused receipts distinguish actual and requested profile. |
| #99 / cache | Production Broker, Project planning/status/evidence and Human paths use the global explicit-identity cache. No linking or repo partitioning of the cache. `shared-cache-integration` tests cover unrelated repos, removed source repo/state, noncached calls, profiles and source cancellation. |
| #95-B/G | Validated declared profile variants plus session-only prepared submissions. A prepared handle is opaque, detaches caller data and verifies unchanged input without recalculating identity. |
| #95-D/E/F/I | Public cursor/result streams, NDJSON, request/Run attempt summaries, current cached-result queries and read-only comparisons; shared-source attribution and missing usage are explicit. |
| #95-H | Real Pi turn wrapper has bounded automatic recovery, one deadline, no partial-output/tool replay and no model substitution; shared account cooldown/auth-quota stops and explicit Provider resume. |
| GC / failures | Bounded incremental scans, independent subscribers, dead-owner recovery, late-owner fencing, result integrity, retired execution cleanup and oversized-result non-retention. Maintenance tests cover long writer contention and scanning past live owners. |

## Acceptance commands

Use the locked dependencies and supported Node 22 runtime:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run test:scale
npm run test:packages
```

The final PR validation runs the complete language/build/unit suite, offline
scale acceptance and actual tarball installations as separate read-only jobs.
Check the exact head commit and each job result rather than a badge on an earlier
patch-transport run. Installation tests exercise default/custom Project setups
and the umbrella package with npm and pnpm, including installed cache behavior.
They do not publish packages or modify credentials.

Observed scale fixture: 1,101 selected Critics, 235,658 serialized scenario
bytes, 1,101 completed guarded tool calls, configured concurrency 32. Two
processes each prepare 180 identities under the same capacity-100 resource
manager. Timing is measured at execution and is not a machine-independent SLA.
The graph fixture measures 2,000 Artifact definitions and compact payload bytes.
The UI test uses Vue's host renderer and real ELK layout with a replacement
third-party canvas host; it is not an interactive browser/GPU benchmark.

These diagnostics do not invoke live Providers and cannot supply production
semantic evidence. Live account access, remote billing and exactly-once external
Provider execution are not proven by offline tests. Automatic transient recovery
is bounded; auth/quota can require account intervention and explicit resume.

## Migration and boundaries

The coordinated package version is 7.0.0 because reuse semantics changed.
See [the cache contract](../identity-cache.md), [migration](../migration-v7.md)
and [Project interfaces](../project-validation.md). No release or merge is
performed by this PR's verification jobs.

Old composite keys are history-only, never relabeled/imported as owner identities.
Run history and cache retention are separate contracts. Cache JSON budgets are
not a hard cap on live execution scratch disk; cache audit is not a permanent
archive. Arbitrary file paths in owner JSON are not automatically made portable.
Workspace protection remains in the actual execution adapter, not hit eligibility.
