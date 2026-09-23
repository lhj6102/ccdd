# GraphView development project

`test/fixtures/monitor-graph` is a synthetic folder-Artifact project for checking Agent, Human and Runtime icons, multiple owned Critics, branching and merging. It is a source-checkout fixture, not part of the npm package. Every Artifact owns `ccdd.json` and a small standard-protocol reader.

| Qualified Critic | Kind | Owner | Instruction references |
| --- | --- | --- | --- |
| `spec/spec-why` | Agent | spec | why |
| `spec/spec-human` | Human | spec | why |
| `tests/tests-spec` | Agent | tests | spec |
| `notes/notes-independent` | Runtime | notes | why |
| `implementation/implementation-tests` | Runtime | implementation | tests, notes, spec |

```sh
npm run build
node dist/src/cli.js verify --all --repo test/fixtures/monitor-graph --human-inbox --codex-auth-file "$HOME/.codex/auth.json"
node dist/src/cli.js monitor --repo test/fixtures/monitor-graph
```

These commands make actual Agent requests. Human verdicts are submitted explicitly. All ready reviews can start without waiting for other PASS results; final validation needs every required result. Folder locations, relation types and owned Critics appear in Graph. Automated tests additionally exercise cycles and self-loops without Provider calls.

Graph GETs use saved declarations and evidence, never current config or user scripts. Current-input inspection is a separate explicit POST. Historical graphs/results remain historical; they do not establish evidence under version 4.
