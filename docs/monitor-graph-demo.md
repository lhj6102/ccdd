# GraphView development verification project

`test/fixtures/monitor-graph` is a small synthetic project for checking Agent, Human, and Runtime icons, multiple Critics, branching, and merging. It is verification input for source checkouts and is not included in the npm package. The input retains legacy JSON Viewer registration to check the existing monitor and historical-record compatibility. To demonstrate new TS configuration and default Human desktop tools, use the [v9 CLI demo](demo.md). Default `prepare-demo` keeps the linear Why → Spec → Tests → Implementation flow.

| Critic | Kind | Target | Dependencies |
| --- | --- | --- | --- |
| spec-why | Agent | spec | why |
| spec-human | Human | spec | why |
| tests-spec | Agent | tests | spec |
| notes-independent | Runtime | notes | why |
| implementation-tests | Runtime | implementation | tests, notes, spec |

Icons follow the stored execution's `profile.kind`. The semantic reviews of Spec and Tests use an `openai-codex / gpt-6-astra / medium` Agent, while implementation validation executes actual Node tests. A Critic is not inferred to be Runtime merely because a file contains test code.

Build and run from the repository root. The authentication option below bridges existing Codex credentials read-only; Agent calls consume usage. Keep credentials and review state outside reviewed input.

```sh
npm run build
node dist/src/cli.js run --repo test/fixtures/monitor-graph --copy --human-inbox --codex-auth-file "$HOME/.codex/auth.json"
node dist/src/cli.js monitor --repo test/fixtures/monitor-graph
```

Select the new execution in Graph. Spec's Agent and Human icons each open their request detail. For this legacy input, the Human reviewer must read Why and Spec on screen, claim the review, and submit a verdict before all Spec Critics are complete. Once both are GREEN, the Tests Agent review starts; after every required Artifact passes, implementation tests execute. Human verdicts are not automatically submitted, and Agent verdicts are not fixed in advance.

A configuration change requires a new execution. Previously recorded Runtime requests retain the kind and verdict from their historical snapshots.

Local verification on 2026-09-06: this input's Spec Critic returned GREEN after an actual Astra call and Artifact tool reads, and the Agent icon/request-detail connection was verified. That execution's Human verdict remained pending, and the Tests review had not started.
