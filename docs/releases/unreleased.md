# Unreleased

## Execution diagnostics

- Request-scoped events record registered script-call start times, monotonic duration and outcomes, including ordinary failures.
- Pi assistant-message events retain only reported nonnegative token counters, with no cost estimates or raw model content. Readonly stored-run queries expose event data.
- Optional diagnostic failures use a bounded best-effort warning and never replace an evaluation verdict or successful observation.
- Telemetry remains outside input identities, reuse keys and semantic evidence. Existing stored state requires no migration; older runs have no fabricated metrics.

See [the implementation contracts](../contracts.md) for the precise result and diagnostic boundaries.
