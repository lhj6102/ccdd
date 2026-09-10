> Historical verification of v0.1/v0.2. This file describes the previous commit/server demo; use README.md and contracts.md for v0.3.

# Actual demo verification

Executed on 2026-09-05 with Node.js 24.15.0, Codex CLI 0.153.4, and `gpt-6-astra`. Four requests were submitted directly in the browser; each request array included the commit, Artifact types and relative paths, payload, and Provider Profile.

| Snapshot | Spec → Why | Tests → Spec | Runtime → Implementation | Run result |
| --- | --- | --- | --- | --- |
| `530b86d3` baseline | GREEN | GREEN | GREEN | GREEN |
| `9491804a` Why changed | RED | BLOCKED | BLOCKED | RED |
| `1764e572` implementation mismatch | GREEN | GREEN | RED | RED |
| `b2dc464e` fixed | GREEN | GREEN | GREEN | GREEN |

- Confirmed request-scoped MCP Viewer calls in **7 actual Agent evaluations**. Recorded evidence of calls to `read_why`, `read_spec`, `list_tests`, and `read_tests`.
- Runtime executed actual Node tests. All six passed for baseline and fixed; the maximum-of-two test failed for the implementation mismatch.
- There were **0 browser JavaScript errors**.
- After normally stopping and restarting the Broker process, compared all four runs' IDs, commits, results, evidence, and events and confirmed exact agreement with the earlier records.
- **25 automated checks** passed, covering snapshot isolation, path scope, rejection of tampered explicit requests, actual Runtime execution, Provider failure and cancellation, persistence, Human notification failure, claim and result submission, and HTTP boundaries.
- A separate npm tarball installation also verified CLI and UI files, the Codex executable path, and generation of the same four commits. See [package verification](packaging-validation.md).

The video records actual browser interactions. Only Agent waiting sections were accelerated to 6×, as marked in the captions. Verdicts, test output, and evidence were neither substituted nor changed to success. The final scene shows the actual restored screen after a Broker restart. The historical recording has Korean captions and no audio.

The [v0.1.0-demo Release](https://github.com/lhj6102/ccdd/releases/tag/v0.1.0-demo), private at the time of this verification, contains an MP4, npm package, actual results in `verification.json`, and restart comparison in `restart-verification.json`. The JSON includes only final evaluations and tool-call evidence, without authentication data or private reasoning.
