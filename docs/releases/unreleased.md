# Unreleased

## Recover invalid final Agent responses

- Pi now classifies invalid final responses as empty, non-JSON, wrapped JSON,
  schema mismatch, or over the 1 MiB UTF-8 limit, without retaining invalid text.
  Schema mismatch diagnostics use bounded schema paths and keywords only, never
  response values or response-derived property names.
- One format-only repair turn can continue the same Agent context, with tools
  disabled and no new evidence or verdict guidance. It shares the original
  timeout and cancellation. The repaired result must pass strict validation;
  another invalid result remains `PROVIDER_RESULT_INVALID`.
- Fenced JSON is not silently unwrapped: even a single JSON fence uses the one
  repair turn. Run audit events record the safe failure category and repair
  start/outcome. They follow existing best-effort telemetry guarantees and do not
  affect identity or semantic evidence.
- Human review and MCP tools are unchanged. Doctor shares Pi's format recovery
  without relaxing its actual nonce-observation check. Repaired semantic results
  follow ordinary reuse rules; failed repair creates no semantic evidence.
- ValidationInput remains version 2 with no database migration. The eventual
  coordinated release must use a new package version, which already participates
  in executor identity; this change does not republish or relabel version 4.1.0.

Verification uses the real Pi Agent loop with controlled transports, not recorded
live-model verdicts. Coverage includes formatting, schema and size failures,
failed repairs, disabled execution with Anthropic/Bedrock history, exact identity,
Unicode and persisted-envelope bounds, bounded schema diagnostics, redaction, deadline/cancellation,
Broker persistence and reuse, plus the full suite and packed-package smoke tests.
