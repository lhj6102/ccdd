# Project-independent identity cache

## Owner decision

CCDD behaves as a local computing resource. Its reusable result cache maps an explicit identity function's output to a completed result. It does not infer equivalence from projects, repositories, paths, worktrees, Critic IDs, profiles, runtime versions or file fingerprints.

- No identity function means execute and return, but do not read or populate the reusable cache. Do not invent a default file-hash identity.
- Equal explicit identities can reuse the same result across repositories and paths, without registration/linking.
- The identity function defines result substitutability. Include criteria, model/profile, schema or any other distinction in its output only when the owner requires that distinction.
- Metadata supports diagnostics, ownership, accounting and garbage collection; it must not silently become an additional cache key or hit eligibility rule.
- Complete GREEN and RED results are cacheable. Operational errors and cancellation are not completed semantic results.
- CCDD owns resource admission, duplicate in-flight work, cancellation cleanup, bounded Provider recovery and cache garbage collection. Authentication/account intervention and quota exhaustion may require the user; ordinary transient recovery must not require project-side retry code.

## One integrated implementation PR

This document tracks the single implementation PR for #90, #92, #93, #94, #95, #97, #98 and #99. Rust implementation is a separate follow-up issue, not a prerequisite or part of this PR.

The owner decision supersedes the proposed project/worktree cache-sharing and drift policies in the original issue descriptions. In particular, #99 is solved by a project-independent cache, not a workspace linking feature. #95-A is not a new cache-layer workspace-update lease; #95-C is not a new cache invalidation rule; #95-G is prepared-request reuse, not an unverified persistent identity-function cache. Project graphs and execution safety may remain in adapters; they must not partition the shared result cache.

## Delivery checklist

Unchecked items are pending implementation or verification, not completed claims.

- [ ] #90: bounded admission polling and SQLite contention recovery, with multi-process tests.
- [ ] #93: transfer load-check scenarios outside argv, including large-catalog regression.
- [ ] #97: deterministic concurrency test barriers, without weakening the bound.
- [ ] #98: original execution profile retained in compact and historical views.
- [ ] Project-independent explicit-identity cache; no implicit file-hash reuse.
- [ ] Cross-process in-flight sharing, ownership fencing, cancellation and crash recovery.
- [ ] Cache-owned results/provenance, readable after the source repository is removed.
- [ ] Bounded cache GC; no removal of active work or in-use results.
- [ ] #92: file-based Critic and Artifact selection with common validation.
- [ ] #94: compact graph projection and bounded/virtualized family presentation.
- [ ] #95-B/D/E/F/G/I: request profiles, result stream, attempt-aware summaries, public evidence queries, prepared submissions and read-only comparison as appropriate to the owner decision.
- [ ] #95-H: built-in bounded Provider recovery, with auth/quota distinguished from transient rejection.
- [ ] Updated contracts, migration guidance and public package entrypoints.
- [ ] Targeted tests, complete Node 22 suite and package/CI checks; exact limitations recorded.

## Acceptance priorities

Different repositories, paths, Critic IDs and profiles with the same explicit identity reuse one completed result. No identity means repeated execution and no cache pollution. Missing source repositories do not prevent reading cached results. Simultaneous matching requests share work; one subscriber cancellation does not cancel another subscriber's execution. Failed execution never publishes reusable success. A lost owner cannot overwrite a replacement owner's result. Cache GC is a storage policy, not semantic staleness. Provider retries remain bounded by cancellation, deadlines and execution budgets and never silently substitute another model.

This is a breaking cache contract. Existing implicit/composite input keys must not be relabeled as explicit owner identities or silently imported into the new cache. Keep old audit records readable where supported, but do not claim their keys satisfy the new contract.
