# Choose a reviewer

A Critic says what to check. Its `profile.kind` chooses who performs the review: an Agent, a Human, or a Runtime. All three review the input captured for that request.

Start with [Your first review](getting-started.md) to try Runtime tests. This guide adds the two other review methods.

## Let an Agent compare two documents

Install `@ccdd/core`, `@ccdd/project`, and `@ccdd/default-tools` in your project, using published packages or the [local package instructions](getting-started.md#install-from-local-packages).

Create `why.md` with your requirements and `spec.md` with your proposed design. For a small example, put “Show at most two unfinished tasks.” in `why.md`, and describe how your design meets that rule in `spec.md`.

Create `ccdd.config.ts`:

```ts
import { defineConfig } from '@ccdd/core';
import { agent, human } from '@ccdd/default-tools';

export default defineConfig({
  artifactTypes: {
    document: {
      agentTools: { read: agent.text.read() },
      humanTools: { open: human.desktop.open() },
    },
  },
  artifacts: {
    why: { type: 'document', path: 'why.md', basis: true },
    spec: { type: 'document', path: 'spec.md' },
  },
  critics: [{
    id: 'spec-why',
    title: 'Design meets the requirements',
    target: 'spec',
    deps: ['why'],
    profile: {
      kind: 'agent',
      provider: 'openai-codex',
      model: 'gpt-6-astra',
      reasoning: 'medium',
    },
    payload: {
      instruction: 'Read {spec} and {why}. Check whether the design meets every stated requirement. Cite the relevant passages.',
    },
  }],
});
```

The model above is the profile used by this repository's examples. CCDD requires the exact Provider, model, and reasoning level to be supported by its installed catalog and accessible to your account. You can choose another supported profile explicitly.

Supply credentials through a supported Provider environment variable or an explicit credential file. For `openai-codex`, you can connect an existing, unexpired Codex credential file with `--codex-auth-file`. Keep that file outside your project. The login tool that issued it handles renewal.

```sh
npx ccdd-project tools check --artifact spec --for agent --tool read --execute
npx ccdd-project verify spec --wait --codex-auth-file /absolute/path/outside/project/auth.json
```

The tool check actually reads the file but does not call an AI Provider. The verification does call the configured Provider and uses your account's usage. See [credential and Provider contracts](contracts.md#pi-agent-execution) for other credential options and diagnostics.

CCDD gives its review Agent `read_spec` and `read_why`, including each tool's description and argument schema. References such as `{spec}` become the corresponding Artifact ID and tool names in the review prompt. The file contents arrive when the Agent calls the tools. The Agent returns a verdict, summary, and evidence; CCDD checks that all supplied Artifacts were actually observed.

To support a new material format, replace or extend the tools in `artifactTypes`. A [custom reader](../examples/custom-text-reader/README.md) uses the same `metadata` and `execute(context, args)` contract. The Agent session and tool-call routing remain CCDD's responsibility.

## Ask a person to review

In the configuration above, change the Critic's profile to:

```ts
profile: { kind: 'human' },
```

The same target, references, and instruction now go to a person. The `humanTools` map supplies their tools. The default desktop opener uses macOS's application association; on another platform, configure an explicit viewer command as described in [desktop opening](../packages/default-tools/README.md#desktop-opening).

Request the review with a local inbox notification, then open the monitor:

```sh
npx ccdd-project verify spec --human-inbox
npx ccdd-project monitor
```

Open the local address printed by the monitor. Choose the project, switch to Kanban, and open the Human review card. Select **Claim review**. The request enters **Try Claim** while its input and environment are prepared; successful preparation confirms the assignment. Use the provided tools to inspect the materials, then enter a verdict, a summary, and at least one item of evidence before selecting **Submit result**.

During Claim, the card shows the current preparation phase, elapsed time, last
heartbeat, and available scan progress. Expand **Phase timings** to see which
completed checks took time. Each attempt has an ID; a retry identifies the attempt
it replaces. A released or expired attempt stops preparing and shows the next
action. The fixed input is still checked before assignment, and preparation does
not launch a viewer or establish that its rendered content is ready.

Artifact references in the instruction are buttons that take you to the relevant tool choices. Selecting a reference does not itself execute a tool. Opening an application does not automatically approve the review.

For a terminal-only workflow, use `request claim`, `request tool`, and `request submit`. See [Human actions and review history](project-validation.md#execution-history-and-human-actions).

For teammates on another computer, use [remote Human review](remote-human-review.md)
to download the fixed project, check their environment, run the same tools
locally, and submit the result to the original Broker. Cached files are reused
across reviews. Projects can include their own portable viewer executables.

## Combine reviewers

Add separate Critics when one Artifact needs multiple checks, such as an Agent comparison and a Human design review. All required Critics for a dependency must pass before a dependent check can proceed. Choose `verify ARTIFACT --recursive` to include the needed earlier checks.

Use a Runtime Critic for actual Node test execution, as shown in [Your first review](getting-started.md). Runtime uses its configured test command and fixed input; it does not use the Agent or Human observation-tool maps.
