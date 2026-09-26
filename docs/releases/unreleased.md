# Unreleased

## Fixes

- Review requests and prepared templates now contain only their resolved Artifact scope, retaining the unchanged whole-config hash on the Run snapshot. Schema-heavy projects no longer copy the entire workspace manifest for every Critic.
- Tool and Human environment preparation reconnect only scoped declarations and runtime inputs, while preserving `WORKSPACE_ARTIFACT_MISMATCH` checks and whole-workspace execution monitoring. Human claim confirmation checks only admitted environment requirements, including older full-manifest requests.
- Broker scheduling shares immutable Run definitions, validates graphs without cloning tool schemas, and projects lifecycle/evidence fields instead of hydrating unrelated manifests. Compact project listings and monitor validation avoid full request/template hydration; worker IPC continues to carry only Run identifiers and execution settings.
- Existing 5.0 and 5.1 requests remain readable and executable. Configuration hashes, Artifact identities and validation/reuse keys are unchanged; no state migration is required.

## Verification

`scripts/benchmark-request-manifest.mjs` builds 300 schema-heavy Artifacts (about 49 KB each), submits 180 Critics, and reconnects real tool registries through a controlled fake executor at concurrency 60. It prints envelope size, persisted request bytes, sampled heap usage, peak concurrency and elapsed time. It makes no Provider calls. After building, run it with Node 22:

```sh
node --trace-gc --max-old-space-size=1024 scripts/benchmark-request-manifest.mjs
ARTIFACTS=600 node --trace-gc --max-old-space-size=1024 scripts/benchmark-request-manifest.mjs
```

The heap budget for this regression is 1 GiB. `--trace-gc` additionally exposes synchronous allocation peaks between the script's timer samples. `SIZE_ONLY=1` measures envelope size without submitting; `ARTIFACTS` and `CRITICS` select smaller diagnostic cases.
