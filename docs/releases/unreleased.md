# Unreleased

## Author-controlled script errors

- Scripts can opt into bounded public domain errors with exit-zero stdout `isError: true` text results. Pi and MCP receive tool errors, never successful observations.
- Evaluation tool calls and audit events retain an error flag; Human tools and tool diagnostics distinguish domain errors. Nonzero exits and stray stderr remain credential-safe.
- Existing declarations, stdin, ValidationInput and SQLite storage need no migration. Script changes still invalidate their consumers through existing content identities.

See [the implementation contracts](../contracts.md) for the precise result and diagnostic boundaries.
