# Remote Human review

## User requirements

Human reviewers can review from another computer by receiving the complete fixed
project snapshot and running its existing registered Human tools locally. The
project can contain its viewer executables and their runtime files. The reviewer
does not need a separately hosted viewer for each Artifact type.

The reviewer caches files by content hash. Later snapshots download only content
missing from that cache and retain earlier immutable snapshots. The first version
transfers whole changed files; byte-range or chunk deduplication is deferred.

A project may declare `envRequirements` with scripts that check external runtime
requirements, such as a Rust toolchain. Claim preparation runs the actual scripts
on the reviewer's computer against the fixed snapshot. A failed download,
integrity check, or environment check releases the temporary reservation and
returns an actionable preparation error to that reviewer. It does not record an
Artifact verdict or fail the entire review request.

The assignment lifecycle is **unclaimed → Try Claim → Claim**. Try Claim is an
exclusive temporary reservation while the input and environment are prepared.
Only successful preparation can confirm Claim. Failed, canceled, and abandoned
attempts must not indefinitely reserve a request or overwrite a later attempt.

## Implementation scope

- Start from main `12bf0d089d3f207b2f230d92a8b010b0cc89cf11`.
- Keep one authoritative Broker for requests, assignment, and verdicts. A remote
  client stores its own input cache and prepared review session, not a replicated
  Broker database. The server does not run a remote reviewer's desktop tools.
- Provide an authenticated project review server and CLI client with list, claim,
  tool, and result actions. A server serves one explicitly selected existing state
  directory. Reviewer credentials live outside reviewed input.
- Support remote transfer of copy-mode requests. Local lock-mode reviews retain
  their monitoring contract. Import paths and metadata are local to the client;
  absolute paths from the publisher are not reused as local workspace paths.
- Download the complete snapshot, including dependencies, executable bits, empty
  directories, and supported internal symlinks. Verify manifests, blobs, and the
  reconstructed workspace identity. Never patch an earlier reviewed snapshot.
- Store only serializable requirements/tool metadata; reconnect implementations
  from the same snapshot. Hash bundled executable inputs and environment scripts
  into the effective review conditions that depend on them.
- Keep all generated files, temporary state, and mutable program configuration
  outside reviewed input. Environment checks diagnose rather than install tools.
- Preserve GET as read-only: no user configuration evaluation, tool or check
  execution, claim expiry reconciliation, or review-state mutation.
- Apply Try Claim preparation to existing local CLI and monitor claims as well.
  Display preparation separately from confirmed assignment and semantic results.
- Persist attempt identity and expiry. Renew only a current, unexpired attempt;
  confirmation/release must compare its identity. Expired attempts are available
  in read projections without a GET writing the store; a later explicit action
  may retire them.
- Check supported project package/runtime versions when preparing remote input.
  Host OS, CPU, GPU, and driver requirements remain the project's explicit
  compatibility conditions. Full OS virtualization is outside this change.

## Verification

Use Node's built-in test runner. Exercise actual file transfer, a second review
with cache reuse, corruption/traversal/symlink rejection, actual check scripts and
bundled tools, Try Claim races/failure/cancellation/expiry, read-only HTTP GETs,
authenticated remote claim and tool execution, and central result submission.
Run repository language, type/build, test, and package checks. Independent agents
review standards and these requirements separately; fix actionable findings and
recheck affected behavior before completion.
