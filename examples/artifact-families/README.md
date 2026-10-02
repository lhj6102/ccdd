# Artifact families

`scenarios/ccdd.json` declares the family `scenarios`: one folder, one view script and one Critic shared by the Artifacts listed in `scenarios/instances.json`. Each listed name, `checkout` and `search`, is an ordinary Artifact with its own Critic `checkout/review` or `search/review`, its own evidence and its own place in the graph.

An instance entry has two optional parts:

- `params` fill every `{"$param": "/json/pointer"}` value in the shared views and Critics. Here each instance gets its own `detail` input enum and its own instruction. Parameters are copied as JSON; nothing is evaluated.
- `material` lists the files that belong to that instance alone. The view script finds them in `context.scope[context.artifactId].family.material`.

Editing `checkout.json` or the `checkout` entry invalidates only `checkout`'s review. Adding a new instance with its own material leaves existing reviews current. Editing the shared `ccdd.json`, `view.mjs` or any unlisted file invalidates every instance. Discovery only reads `instances.json`; an authoring tool may write that file, but CCDD never runs code to produce it.

Run these commands from this directory after installing `@ccdd/ccdd`:

```sh
ccdd-project config check
ccdd-project tools check --artifact checkout --for agent --tool detail --execute --args '{"id":"summary"}'
ccdd-project verify --all --human-inbox
ccdd-project monitor
```

The monitor shows the family as one node; select it to list its instances and their Critics, or expand it into instance nodes. Submit the Human verdicts explicitly through the monitor. See [the Artifact family contract](../../docs/contracts.md#artifact-families).
