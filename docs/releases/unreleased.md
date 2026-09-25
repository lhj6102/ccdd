# Unreleased

## Actionable tool argument errors

Tool argument schema failures now identify up to five failing instance paths and
schema keywords with short, value-free reasons. Nested unknown properties, wrong
types and missing required properties are visible to reviewers through both the
Pi tool loop and MCP error results, allowing a corrected call instead of treating
a schema mismatch as an impossible inspection.

Diagnostics are bounded to 4 KiB of UTF-8 text. Property names are quoted and
bounded; omitted diagnostics are marked. Invalid arguments exceeding the 512-item
array or 2048-node diagnostic budget receive an explicit notice instead of running
potentially expensive exhaustive error collection. Valid arguments are unaffected.
Argument values, raw TypeBox messages
and arbitrary exception text are never forwarded. The safe diagnostic boundary
accepts only errors created by CCDD argument validation. The existing object and
64 KiB argument limit, script isolation, observation auditing and telemetry
contracts are unchanged.

No configuration, result or storage migration is required. See the
[implementation contract](../contracts.md#script-views).
