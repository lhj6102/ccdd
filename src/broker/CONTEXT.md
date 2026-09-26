# Broker

The Broker owns review requests, process ownership, Human assignment and results. It receives a frozen Project validation scope and issues executable selected tickets. Project Validation owns current-input identities and final satisfaction.

- **Requester** supplies a workspace and receives progress and evidence.
- **Run** groups selected evaluations against one coherent input and captures the required validation scope.
- **Review Request** assigns one qualified, Artifact-owned Critic with fixed input, criteria and execution conditions.
- **Snapshot** identifies the complete supplied workspace. The workspace remains unchanged while its worker monitors it.
- **Target Artifact** is the Critic's owner. Referenced Artifacts and composition connections extend allowed input, with dependency-GREEN gates outside the same SCC unless explicitly ignored.
- **Verdict** is an actual GREEN/RED judgment. Execution failure is ERROR; missing required evidence is INCOMPLETE.
- **Human Try Claim** reserves a request while checking fixed input and the admitted Artifacts' environment requirements.
- **Human Claim** confirms a reviewer's responsibility after preparation. Only that claimant may execute Human tools or submit a result.
- **Review Workspace** is the user-supplied folder, optionally a user-managed worktree. Output and state are external.

A request-scoped worker executes ready Critics concurrently within the limit, including cycles. It stays alive during Human waiting. Input mutation or owner death invalidates unfinished execution. It never creates workspace copies, symlinks for mounts, fabricated dependency results or persistent stale state. Historical review records are readable but cannot execute under the new model.

Normalized immutable definition nodes are content-addressed. Small request/Run rows hold lifecycle fields and references. Indexed memberships, counters and reverse gate edges update only affected work. Requesters consume `broker.changes(runId, {after, limit})`; telemetry does not advance that lifecycle cursor. Full compact snapshots are explicit O(returned members) views, not per-event polling APIs.
