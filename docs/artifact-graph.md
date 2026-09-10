# Artifact dependencies and monitor GraphView

A Critic declares one Artifact to evaluate as its `target` and other Artifacts it reads as evidence in its `deps` array. The order of the `critics` array is not the execution order. The `deps → target` relationships form an Artifact DAG, and multiple Critics can evaluate the same Artifact.

```ts
import { defineConfig } from '@ccdd/core';
import { agent, human } from '@ccdd/default-tools';

export default defineConfig(() => ({
  artifacts: {
    why: { type: 'markdown', path: 'why.md', basis: true },
    spec: { type: 'markdown', path: 'spec.md' },
  },
  artifactTypes: {
    markdown: {
      agentTools: { read: agent.text.read() },
      humanTools: { open: human.desktop.open() },
    },
  },
  critics: [
  {
    "id": "spec-why",
    "title": "Does Spec satisfy Why?",
    "target": "spec",
    "deps": [
      "why"
    ],
    "profile": {
      "kind": "agent",
      "provider": "openai-codex",
      "model": "gpt-6-astra",
      "reasoning": "medium"
    },
    "payload": {
      "instruction": "Evaluate whether Spec preserves the requirements in Why."
    }
  },
  {
    "id": "spec-readability",
    "title": "Can a person understand Spec?",
    "target": "spec",
    "deps": [],
    "profile": {
      "kind": "human"
    },
    "payload": {
      "instruction": "Evaluate whether an implementer can clearly understand the requirements."
    }
  }
],
}));
```

Register a Human alarm before running this example. The Agent observes Spec through a CLI reader, and the person uses a registered desktop application; only the first Critic also observes Why. Opening a program and submitting a Human verdict are separate actions. Agent/Human tool readiness checks apply to the entire `target` and `deps` scope. Runtime path restrictions use the same observation scope.

## Evaluation and execution rules

- Every Critic targeting an Artifact is required. The Artifact is GREEN when all of them are GREEN in the same Run.
- `basis: true` is an externally accepted starting point for validation. It is displayed as `BASIS`, separately from a GREEN verdict, and cannot also have a Critic targeting it.
- An ordinary Artifact with no Critic is unreviewed. To use it in `deps`, add a Critic or explicitly mark it as a basis Artifact.
- A full Graph Run executes each Critic once all its referenced Artifacts have passed or are BASIS. Independent Critics targeting the same Artifact may run in parallel. Agent/Runtime execution is limited to four per Run; Human notifications and waiting proceed separately.
- A Critic's RED or execution error leaves reviews that need its result BLOCKED. Independent branches continue. The Run determines its final RED/ERROR after independent work and Human reviews settle.
- Cancellation, worker termination, or input integrity failure ends every unfinished request in the Run with ERROR. Completed verdicts remain unchanged.
- `--critic ID` runs only that Critic as an individual diagnostic without waiting for referenced Artifacts to pass. Other Critics are shown as excluded from this execution. If other required Critics target the same Artifact, one GREEN does not make the entire Artifact GREEN.
- Self-references, duplicate deps, unknown Artifacts, and cycles are rejected before acceptance.

These same-Run and selected-Critic rules describe legacy `ccdd run`. The newer `ccdd-project verify --critic ID` always enforces dependencies and can reuse applicable actual evidence; see [Project Validation](project-validation.md#differences-from-the-legacy-cli).

## Artifact groups

Since v1.1.0, individual `ArtifactDefinition` entries and `ArtifactGroupDefinition` entries that group IDs are both supported. See the [image and group example](../examples/artifact-groups/README.md) for Release installation and execution steps. Existing individual Artifact configurations work unchanged.

```ts
const artifacts = {
  effect: { type: 'markdown', path: 'effect.md' },
  preview: { type: 'image', path: 'preview.png' },
  explosion: { kind: 'group', members: ['effect', 'preview'] },
};
```

Groups have no `type` or `path`, and members retain independent IDs. A group may also reference other groups as members. Empty lists, duplicate or unknown members, self-references, and recursive membership cycles are rejected. Membership validation and Critic dependency DAG validation are separate.

- `target: 'explosion'` evaluates the entire group; `target: 'preview'` evaluates one image. The same rules for `deps` and `basis: true` apply to groups and individual Artifacts.
- A group's verdict is determined by all Critics directly targeting that group. A passing group does not make its members pass, and passing members do not automatically make the group pass.
- `members` defines what is observed together. It does not require an execution order or prior verdict. To review the group after image validation, explicitly add `deps: ['preview']` to the group's Critic.
- Requests recursively expand target and dependency groups and bind only leaf Artifacts to tools. Shared members are supplied once, retaining their original IDs in names such as `read_effect` and `view_image_preview`. The observation scope does not expand to the `deps` of other Critics targeting those members.
- Agent/Human tools must be ready for every leaf. Agents must observe the content of every supplied leaf; observing one member cannot substitute for observing the entire group.

`tools check --artifact explosion --for agent` checks the group's member tools. Actual execution selects a leaf and tool, as in `--artifact preview --tool view_image --execute`. A group reference such as `{explosion}` gives Agents each member's actual tool list and gives Humans buttons for selecting member tools.

## Kanban and Graph

Kanban displays ReviewRequests as requested, running, success, or failure. Graph lets you select a project and validation execution to see the Artifact definitions and verdicts fixed to that Run's snapshot. Project and execution selections persist when switching views.

Graph nodes are Artifacts, with a line icon for each Critic. Agents share an Agent icon, Humans use a person, and Runtime uses a terminal; multiple Critics of the same kind each get an icon. Icon strokes are gray for requested/waiting, blue for review in progress, green for success, and red for failure. Human reviews become in progress after a claim. Hover or keyboard focus shows the Critic's name and exact status; clicking opens the existing request detail. Descriptions distinguish evaluation failure from execution errors, and Critics excluded from this execution appear dashed and disabled.

Pan, zoom, or fit the canvas to inspect Artifact relationships. Node positions and zoom persist during status refreshes. Identical Artifact edges are merged while retaining the list of Critics using each relationship. Selecting a node shows its evaluating Critics and their referenced Artifacts. Human claim, tool execution, and verdict submission use the same request detail as Kanban.

Group nodes show a group marker and member count. Selecting a group shows its members and their verdicts and lets you navigate to them; members also link to their containing groups. Membership is not drawn as a validation dependency edge. Groups and members each display their own verdicts.

The [GraphView development verification project](monitor-graph-demo.md) provides input demonstrating all three execution icons and multiple Critics.

An Artifact whose review could not start because a predecessor failed is not displayed as failed. Human waiting distinguishes unclaimed requests from those assigned to a reviewer. Successes from different Runs or snapshots are not combined. Even a selected-Critic run displays the full definition so omitted evaluations remain visible. Graph queries neither change state nor resume work.

## Migrating existing configuration

Remove the old Critic `dependsOn` and `artifacts` fields and declare `target` and `deps`. Old `dependsOn` values were Critic IDs; new `deps` values are Artifact IDs. The order of an old observation list does not identify targets and references, so conversion is not automatic. Determine both roles from the Critic's actual evaluation criteria.

The existing Why → Spec → Tests → Implementation demo maps as follows:

| Critic | target | deps |
| --- | --- | --- |
| spec-why | spec | [why] |
| tests-spec | tests | [spec] |
| implementation-tests | implementation | [tests] |

Declare Why with `basis: true`. New demos are created in `demo-v9` after preparing local core/default-tools tarballs. Existing demos, user configuration, copies, and review history are not overwritten.

Historical requests remain readable in Kanban and request detail. Runs without stored Artifact roles show an unavailable notice instead of an inferred Graph. Waiting historical Human requests continue under their existing snapshot's tool scope and execution contract.
