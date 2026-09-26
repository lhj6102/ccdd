# Migrating to 5.0

This is an unreleased major contract change. Package metadata remains 4.3.0 until the coordinated release; do not publish these changes as 4.x.

## Start with fresh state

Use a **new external state directory** for 5.0. CCDD neither reads nor migrates 4.x state. Opening an unmarked/earlier-major database fails closed with an instruction to use a new state directory. Do not modify its SQLite format marker to bypass this check. If old audit records are needed, keep their original state and use the corresponding old installation separately.

ValidationInput moves once to version 3. Subsequent CCDD/Node version upgrades alone do not change reuse keys. No re-review is caused solely by package version, Node version, platform or architecture.

## Move response requirements into Critic schemas

There is no mandatory summary or evidence field and no automatic summary-to-reason conversion. Without response schemas, Agent and Human submit only a verdict:

```json
{"verdict":"GREEN"}
```

Declare optional `passSchema`/`failSchema` on each Critic to require extra fields. They describe additional top-level properties; CCDD supplies the verdict discriminator. For example:

```json
{
  "failSchema": {
    "type": "object",
    "properties": {
      "reasons": {
        "type": "array",
        "items": {"type":"string"},
        "description": "Specific unmet criteria, with useful locations."
      }
    },
    "required": ["reasons"],
    "additionalProperties": false
  }
}
```

RED then requires `{"verdict":"RED","reasons":["..."]}`; GREEN remains verdict-only. Agent gets one format-only repair turn on invalid final output. Human must correct rejected input. The monitor accepts owner fields as JSON. Owner text is not truncated; explicit overall transport/envelope limits still apply. Built-in Runtime produces only a verdict and process audit, so do not require additional Runtime response fields.

## Update requester consumers

- Compact result: `{verdict, ...ownerFields, reference, reusedFrom?}`.
- Reference: `{runId, requestId, stateDir}` identifying the original stored audit.
- A Run/query/plan has a top-level `results` array with each result once. Request, Critic and plan-item entries use `result: {requestId}`. A standalone request has its result directly.
- Identity essentials remain on wrappers (`criticId`, `target`, `inputKey`). Full ValidationInput/config/tool calls/timestamps/telemetry do not appear in default results.
- Use CLI `--full` or API `detail: "full"` when full detail is necessary. `ccdd-project run show RUN_ID --state-dir STATE_DIR` and `projectRun(stateDir, runId)` always return full audit. Find the referenced request in `requests`.
- `createBroker`, `inspectProject`, `projectRuns`, `projectRequests` and `projectHistory` default compact. Pure `queryProject`/`planProject` now require `stateDir` for references; pass full history to those algorithms.

Stored tool audits retain every call rather than only the first 100. Required-observation checks still run before any result is projected.

## Review owner identity responsibilities

The validation key uses only Critic ID and target/dependency Artifact identities. Default identity retains configuration, owned Critic definitions, material, declared execution/environment inputs and integrity policy coverage.

For `stale.kind: "identity"`, the local identity uses only Artifact ID and the script's output value. CCDD does **not** additionally hash scripts, declared inputs, criteria, schemas, tool/profile definitions, environment, integrity policy or versions. Encode every distinction that should invalidate review in the output. Declared paths are still scoped and checked. Dependency identities and cycle connectivity still propagate; all execution safety checks remain active.

## Plan for RED reuse and coalescing

Matching GREEN **and RED** results are reused without evaluation. RED still does not satisfy validation. `--force` requests a fresh selected review and retains prior audit history. `stale.kind: "always"` requires current-request evidence rather than prior completed results.

Identical active Critic/input requests across Runs within one state directory share one original ticket. The follower waits and adopts that result, with an original audit reference and `reusedFrom`. Force opts out. Cancelling a follower does not cancel the source; cancelling/failing the source ends followers without manufacturing a semantic result. Separate state directories do not coalesce.


Coalescing never hosts another Run in the follower worker. Unowned QUEUED sources
are eligible only during a submission grace lease (default 15 seconds, aligned
with worker startup timeout). SDK `createBroker({coalescingGraceMs})` configures
new Runs' leases from 0 to 300000 milliseconds. Eligibility uses the persisted
source submission time; later followers cannot renew it. At expiry a follower
atomically replans, joins another matching active owner if present, or creates
its own ticket. Competing followers share one execution. The abandoned source is
not modified. Reviving that source later may execute its original queued ticket
again; new submissions instead use normal matching-verdict reuse.
