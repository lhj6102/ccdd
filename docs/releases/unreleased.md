# Unreleased

## Plan active request coalescing

- Fix #56: current-input inspection and CLI `plan`/`status` report `COALESCE`
  instead of `EXECUTE` when submission would adopt an identical active request.
  `counts.coalesce` counts adopted work; `counts.execute` counts only new
  executions. The existing item `requestId` identifies the source. Unowned
  leased sources also expose `leaseExpiresAt` as an ISO UTC deadline.
- Inspection and submission share candidate matching and eligibility, including
  live-owner checks and fail-closed submission lease bounds. Inspection remains
  readonly: dead owners are treated as ineligible without persisting terminal
  status, deleting ownership or emitting events. Submission retains durable
  reconciliation. Force bypasses coalescing.
- Plans are point-in-time quotes, not reservations. Expiry or owner exit before
  submission can require execution. A previously observing Broker can have an
  earlier monotonic expiry after clock rollback; readonly inspection does not
  share another Broker's private lease observations.
- Compact requester output remains reference-only. CLI and monitor show the new
  action and counter without adding source envelopes or audit payloads.
- Regression coverage compares plan/submission across ownership, request status,
  lease boundaries, invalid metadata, input identity and force, and inspects a
  real running owner in another process before and after its termination.

## Release classification

Target **5.1.0**, not 5.0.1: the new public plan action, counter and optional
lease deadline are additive API changes, even though the motivating mismatch
is a bug. Package versions remain unchanged here; the release commit updates
all coordinated package versions.
