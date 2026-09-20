# Review generated scenario data

This example captures two JSON scenarios as independent generated Artifacts. The scenario files are sample evidence for demonstrating review mechanics, not recorded product tests. Each Human Critic must inspect an overview and every listed detail, then make an actual judgment.

`scenarioSource.prepare` reads a file from the captured project through `context.resolvePath`. It returns structured data directly; CCDD persists the fixed value outside the reviewed workspace. The source does no generation, so it declares `preparation: 'read-only'` and supports `status` and `plan`.

The explicitly registered `overview` and `detail` tools use `context.readData()`. Each call receives a copy of the recorded value, including after worker restart. The full scenario determines identity even when a tool only returns one field. Initial prompts and monitor scope metadata do not contain that data.

## Run the example

Use Node 22 LTS, at least 22.19.0. These APIs require CCDD 3.2.0 or later. From the source repository, build and pack core and project:

```sh
npm ci
npm run build
CCDD_GENERATED_PACKAGES=$(mktemp -d /tmp/ccdd-generated-packages.XXXXXX)
npm pack --ignore-scripts --pack-destination "$CCDD_GENERATED_PACKAGES"
npm pack --ignore-scripts --workspace @ccdd/project --pack-destination "$CCDD_GENERATED_PACKAGES"

CCDD_GENERATED_EXAMPLE=$(mktemp -d /tmp/ccdd-generated-example.XXXXXX)
cp -R examples/generated-artifacts "$CCDD_GENERATED_EXAMPLE/project"
cd "$CCDD_GENERATED_EXAMPLE/project"
npm init -y
npm pkg set type=module
npm install --ignore-scripts "$CCDD_GENERATED_PACKAGES"/*.tgz
```

Inspect the current input and execute the two data tools without starting a review:

```sh
npx ccdd-project plan checkout
npx ccdd-project tools check --artifact checkout --for human --tool overview --execute
npx ccdd-project tools check --artifact checkout --for human --tool detail --execute --args '{"id":"summary"}'
```

These tool diagnostics prepare a new snapshot and report actual tool results. They do not create a verdict or demonstrate that the scenario passes its Critic.

Request both Human reviews and open the monitor:

```sh
npx ccdd-project verify --all --human-inbox
npx ccdd-project monitor
```

Open the printed local address, choose the project and a Human request, and claim it. Execute `overview`, then call `detail` for every returned detail ID. Submit your verdict with a summary and evidence citing those IDs. Repeat for the other scenario. See the [Human reviewer guide](../../docs/reviewers.md#ask-a-person-to-review) for the claim and submission workflow.

The tools are also registered for Agents. To use them, change the desired Critic to an explicitly supported Agent profile and supply credentials as described in the [reviewer guide](../../docs/reviewers.md). An Agent review makes actual Provider calls. Runtime Critics do not support generated Artifact scopes.

## Inspect reuse

After completing real reviews, run `npx ccdd-project status`. Edit a detail in `scenarios/checkout.json` and run `npx ccdd-project plan --all`. Checkout now has changed input; an applicable passing search review can remain reusable because its captured data and Critic definition are unchanged. Changing an unread detail also changes checkout identity. Restoring equivalent checkout data can reuse its applicable historical evidence, subject to the existing latest-verdict and dependency rules.

Changing whitespace or object-key order preserves canonical JSON identity. Array order remains significant. Keep changing scenario data in these source files rather than importing it into shared config: imported config module changes conservatively affect effective Critic definitions.

See [generated Artifact contracts](../../docs/generated-artifacts.md) for identity strategies, canonicalization, size limits, preparation policy, and reopening behavior.
