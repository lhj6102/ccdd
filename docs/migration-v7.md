# Migrating to CCDD 7

Version 7 changes the meaning of reusable identity. It is not a transparent
storage migration. Stop old workers before upgrading and use matching 7.x
packages. See the [7.0.0 release notes](releases/v7.0.0.md).

## What changes

Previously CCDD could derive composite keys from files, definitions, Critic IDs,
dependencies and project-local evidence. Now **only an explicit owner's output
is reusable**, and its meaning is global within the local user's state home.
Without a function, each submission executes normally and its result is not
reused by another submission. `status` can consequently report missing evidence
for an Artifact whose earlier noncached Run was GREEN; `run show` still shows
that Run's actual result.

Audit every identity function before enabling shared reuse. A constant such as
`v1` no longer means “v1 of this Critic in this repository”; it declares one
interchangeable result everywhere in that cache. Encode relevant input and
review-protocol distinctions in the returned value. Do not rely on CCDD to add
repo, path, Critic, profile, dependency or schema salts. Profile selection alone
does not guarantee a new model evaluation. `--force` bypasses caching for that
execution and does not replace another caller's shared cache value.

The Project schema retains `stale` for declaring identity scripts. `file-hash`
and `always` do not create a reusable key. Workspace integrity and dependency
GREEN gates remain execution/validation concerns, not cache eligibility rules.
Cycles remain finite and supported.

Dependency gates read the same current evidence. Without an identity function on
the dependency, an earlier GREEN Run no longer satisfies a later non-recursive
`verify` of a dependent Critic: it reports `WAIT_DEPENDENCY` with the dependency
`MISSING`. Declare identities on dependencies, verify with `--recursive`, or use
`--ignore-gates` deliberately.

## Existing state

There is no silent import of previous composite keys into the shared cache.
Old input-version records remain history-only where their state format is
readable; they cannot satisfy current v4 validation inputs or resume execution.
State formats already rejected by earlier major versions remain rejected.
Keep old state separately when needed and create fresh submissions under 7.x.
Do not manually relabel historical keys as owner identities.

The shared cache is separate from a project's Run state. Different repositories
can use different `--state-dir` values and still reuse the same identity without
linking. Set `CCDD_STATE_HOME` to a private test directory for isolated tests;
changing only `--state-dir` is no longer sufficient to isolate reusable results.
Diagnostic load-check uses isolated state and cannot populate production
semantic evidence.

## New interfaces

- `--critics-file` and `--artifacts-file` accept JSON arrays or one ID per line.
- `profileVariants` plus `--profile` or SDK `profile` select declared execution
  profiles without rewriting source files. Stored actual and requested profiles
  remain distinguishable on reuse.
- `prepareProject` / `broker.submitPrepared` reuse one session's prepared identity
  and envelopes. The supplied workspace is checked again; this is neither a
  persistent identity-function memo nor an execution reservation.
- `streamProjectResults`, `run stream`, `run summary`, `request summary` and
  `run diff` provide public cursor/result/attempt views. Stream cancellation
  does not cancel the review.
- `cache show/list/compare/gc/delete` operate without a repository.
- `provider status/resume` expose shared account recovery state.

See [the cache contract](identity-cache.md) and
[Project API examples](project-validation.md). Rust implementation is tracked
separately in issue #101 and is not required to use the new TypeScript runtime.
