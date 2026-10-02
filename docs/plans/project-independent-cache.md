# Project-independent identity cache

## Owner decision

CCDD behaves as a local computing resource. The reusable cache contract is `identity -> completed result`.

- No explicit identity function means execute and return without reading or populating a reusable cache. There must be no implicit file-hash fallback.
- Equal explicit identities reuse across repositories, paths, worktrees, Critic IDs and profiles, without registration or linking.
- The identity function defines result substitutability. Criteria, model/profile, schema and other distinctions belong in its output only when the owner requires them.
- Ownership, accounting, diagnostics and garbage-collection metadata must not become extra cache keys or hidden eligibility rules.
- Complete GREEN and RED results are equally cacheable. Operational failures and cancellation are not completed semantic results.
- CCDD owns admission, duplicate in-flight work, cleanup, bounded Provider recovery and cache GC. Authentication/account intervention and quota exhaustion may require the user; ordinary transient recovery must not require project-side retry code.

## Single implementation PR and separate Rust issue

PR #100 contains the current TypeScript work for #90, #92, #93, #94, #95, #97, #98 and #99. Rust migration is tracked separately in #101 and is not a prerequisite for these fixes.

The approved direction supersedes workspace linking in #99, a cache-layer workspace-update lease in #95-A, profile drift as an invalidation policy in #95-C, and unverified persistent identity-function memoization in #95-G. Execution safety and project graphs may remain in adapters, but they cannot partition the result cache.

## Current implementation status

This is a **Draft integration, not a completed implementation of the owner contract**. In particular, the legacy Project/Broker `verify` path still uses its existing snapshot/composite identity and project history. The new cache is implemented and publicly exposed, but switching all existing submission, planning, status and Human execution paths to it remains a merge blocker. Do not claim cross-repository `verify` reuse or no-default-identity behavior is complete merely because the cache module passes its own tests.

### Pushed implementation

- #90: bounded local identity workers, read-before-write admission prechecks with atomic revalidation, throttled dead-owner cleanup, short async SQLite BUSY waits and bounded retry. SQLITE_LOCKED is not blindly treated as BUSY.
- #93: large load-check scenarios transferred over IPC rather than argv; bounded initialization/disconnect; larger synthetic request range. The regression transports more than 1,000 result entries but selects one real Critic; this is not the full selected-catalog acceptance.
- #97: a deterministic first-wave barrier retains both reaching four concurrent executors and never exceeding four.
- #98: full original execution profiles in stored/compact requests; old incomplete headers recover from their own immutable envelopes, not current definitions. Tests now explicitly allow the public profile while still excluding audit payloads.
- #92: `--critics-file` and `--artifacts-file`, JSON arrays or line-delimited IDs, BOM/CRLF, bounded reads, stable deduplication and conflicting-selector rejection.
- Cache foundation: explicit identities only, uncached calls without identity, cross-process in-flight sharing, independent subscriber cancellation, dead-owner recovery, late-owner fencing, cache-owned JSON results, integrity checks, bounded GC and oversized-result non-retention.
- Cache CLI/API: `cache show`, paginated `cache list`, read-only `cache compare`, explicit `cache gc` and `cache delete`. Reads require no repository and do not create state or update access metadata. Original profile/result/provenance and unreported usage are exposed. These are not yet the replacement for all legacy status/history paths.
- #94: opt-in `graph --compact --json` without repeated view definitions; indexed graph projection; 100-member family pages and guarded graph expansion above 200 members. All instances remain accessible through pages.
- #95-H initial production integration: Pi turn recovery before any content or positive usage was delivered; bounded attempts and one review deadline; Retry-After handling; unchanged model, session and tools; quota distinguished from transient rate limits; retry events report usage as unreported. Completed tools and partially delivered turns are not replayed. Shared provider/account cooldown and run-level auth/quota suspension are still pending.

### Validation actually performed

Using the locked dependencies and Node 22.23.3, language checking and the complete build, including UI typing, passed locally. The latest full local suite reports **645 tests: 630 passed, 15 failed**. The remaining failures also reproduce on the unchanged source snapshot: permission-sensitive cleanup and child-process/cancellation checks. This comparison does not make the failing suite acceptable for merge.

Targeted checks include 98 passing Provider/Pi/Broker tests and 16 passing cache/query/process tests. Earlier graph/profile checks passed as well. These sets overlap with the full suite and must not be added as independent coverage counts. No live Provider/model review or completed packaged-install acceptance is claimed.

Remote builds caught a patch-transfer truncation in cache comparison; the missing closing delimiter was restored. The development workflow now checks the exact applied commit and explicitly fails on language, build, process exit or nonzero TAP failure counts. A workflow badge is not a substitute for reading the test result. Full passing CI is still required.

## Remaining merge blockers

- [ ] Integrate the explicit-identity cache with all existing submission, planning, status/history, dependency and Human review paths. Remove implicit reusable identities without weakening execution integrity.
- [ ] Separate shared computation lifetime/audit from any one caller Run; preserve cancellation, ownership, actual observations, budget admission and coalesced origin attribution end to end.
- [ ] Prepared identity/request flow and request-time profile selection without shared template rewrites.
- [ ] Terminal-result API iterator/NDJSON and complete attempt-aware request/Run summaries, including shared-execution attribution and missing usage.
- [ ] Shared provider/account cooldown and explicit auth/quota pause/resume policy without project-side retry layers.
- [ ] Multi-process full-catalog admission acceptance and more than 1,000 actually selected Critics in load-check.
- [ ] Browser/network/layout measurements for the large family monitor, not just pure projection/pagination tests.
- [ ] Cache fault/long-contention handling, bounded shutdown and GC review under production integration.
- [ ] Major-contract migration documentation, public package tests, full green CI and independent review.
- [ ] Remove the temporary workbench and development patch-transport workflows before merge.

## Migration boundary

This changes the cache contract, not merely its language or storage location. Existing implicit/composite keys must not be relabeled as explicit owner identities or silently imported. Preserve old audit records where supported, but do not claim their keys satisfy the new contract. Cache GC is storage management, not semantic staleness or guaranteed permanent audit retention.
