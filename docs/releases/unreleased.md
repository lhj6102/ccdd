# Unreleased

## Execution diagnostics

- Request-scoped events record registered script-call start times, monotonic duration and outcomes, including ordinary failures.
- Pi assistant-message events retain only reported nonnegative token counters, with no cost estimates or raw model content. Readonly stored-run queries expose event data.
- Optional diagnostic failures use a bounded best-effort warning and never replace an evaluation verdict or successful observation.
- Telemetry remains outside input identities, reuse keys and semantic evidence. Existing stored state requires no migration; older runs have no fabricated metrics.

## Author-controlled script errors

- Scripts can opt into bounded public domain errors with exit-zero stdout `isError: true` text results. Pi and MCP receive tool errors, never successful observations.
- Evaluation tool calls and audit events retain an error flag; Human tools and tool diagnostics distinguish domain errors. Nonzero exits and stray stderr remain credential-safe.
- Existing declarations, stdin, ValidationInput and SQLite storage need no migration. Script changes still invalidate their consumers through existing content identities.

See [the implementation contracts](../contracts.md) for the precise result and diagnostic boundaries.
