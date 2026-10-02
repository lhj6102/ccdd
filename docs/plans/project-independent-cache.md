# Project-independent identity cache

## Owner decision

CCDD behaves as a local computing resource. Its reusable result cache maps an explicit identity function's output to a completed result. It does not infer equivalence from projects, repositories, paths, worktrees, Critic IDs, profiles, runtime versions or file fingerprints.

The cache contract is `identity -> result`.

- No identity function means execute and return, but do not read or populate the reusable cache. Do not invent a default file-hash identity.
- Equal explicit identities can reuse the same result across repositories and paths, without registration/linking.
- The identity function defines result substitutability. Include criteria, model/profile, schema or any other distinction in its output only when the owner requires that distinction.
- Metadata supports diagnostics, ownership, accounting and garbage collection; it must not silently become an additional cache key or hit eligibility rule.
- Complete GREEN and RED results are cacheable. Operational errors and cancellation are not completed semantic results.
- CCDD owns resource admission, duplicate in-flight work, cancellation cleanup, bounded Provider recovery and cache garbage collection. Authentication/account intervention and quota exhaustion may require the user; ordinary transient recovery must not require project-side retry code.

## One integrated implementation PR

PR #100 handles #90, #92, #93, #94, #95, #97, #98 and #99 in one branch. Rust implementation is tracked separately in #101; it is not a prerequisite or part of this PR.

The owner decision supersedes the proposed project/worktree cache-sharing and drift policies in the original issue descriptions. In particular, #99 is solved by a project-independent cache, not a workspace linking feature. #95-A is not a new cache-layer workspace-update lease; #95-C is not a new cache invalidation rule; #95-G is prepared-request reuse, not an unverified persistent identity-function cache. Project graphs and execution safety may remain in adapters; they must not partition the shared result cache.

## Progress and verification

This is an in-progress implementation, not a completed release contract. Implementation and full acceptance are distinct.

- #90: bounded local identity preparation, read-before-write admission checks with atomic revalidation, throttled cleanup and bounded BUSY retry have been pushed. Multi-process load acceptance remains pending.
- #93: worker initialization moved from argv to IPC. A large serialized scenario regression passes; more than 1,000 actually selected Critics still needs acceptance testing.
- #97: the timing-based concurrency test now uses a barrier and retains both utilization and upper-bound checks.
- #98: request headers and compact results retain the original execution profile; legacy compact headers recover from their own immutable envelope.
- #92: JSON/line-based Critic and Artifact selector files and conflict validation have been pushed.
- The independent cache module has local tests, but integration with existing Broker, planning, status and Human paths is not yet complete.
- Local targeted checks passed. The complete local suite reported 610 passed and 19 failed out of 629; failures are under investigation and are not declared pre-existing without comparison. CI stopped at language checking before implementation tests, so no full CI pass is claimed.

## Remaining acceptance checklist

- [ ] Project-independent explicit-identity cache integrated end to end; no implicit file-hash reuse.
- [ ] Cross-process in-flight sharing, ownership fencing, cancellation and crash recovery through production execution paths.
- [ ] Cache-owned results/provenance, readable after the source repository is removed.
- [ ] Bounded cache GC; no removal of active work or in-use results.
- [ ] #90 multi-process contention and cleanup acceptance.
- [ ] #93 large selected-catalog acceptance.
- [ ] #94 compact graph projection and bounded family presentation.
- [ ] #95-B/D/E/F/G/I request profiles, result stream, attempt-aware summaries, public evidence queries, prepared submissions and read-only comparison as appropriate to the owner decision.
- [ ] #95-H built-in bounded Provider recovery, with auth/quota distinguished from transient rejection.
- [ ] Updated contracts, migration guidance and public package entrypoints.
- [ ] Complete Node 22 suite, package checks and CI; exact limitations recorded.
- [ ] Remove temporary workbench/development patch-transport workflows before merge.

## Acceptance priorities

Different repositories, paths, Critic IDs and profiles with the same explicit identity reuse one completed result. No identity means repeated execution and no cache pollution. Missing source repositories do not prevent reading cached results. Simultaneous matching requests share work; one subscriber cancellation does not cancel another subscriber's execution. Failed execution never publishes reusable success. A lost owner cannot overwrite a replacement owner's result. Cache GC is a storage policy, not semantic staleness. Provider retries remain bounded by cancellation, deadlines and execution budgets and never silently substitute another model.

This is a breaking cache contract. Existing implicit/composite input keys must not be relabeled as explicit owner identities or silently imported into the new cache. Keep old audit records readable where supported, but do not claim their keys satisfy the new contract.
