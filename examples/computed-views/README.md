# Computed views

Each scenario is an actual Artifact folder with its own `ccdd.json`. `view.mjs` computes an overview or selects one detail when the reviewer calls its registered tool. CCDD does not generate or freeze JSON data during discovery.

```sh
ccdd-project config check
ccdd-project tools check --artifact checkout --for human --tool overview --execute
ccdd-project verify checkout --human-inbox
ccdd-project monitor
```

Run these commands from this directory after installing `@ccdd/core` and `@ccdd/project`. Submit the Human verdict explicitly through the monitor. Scenario files, the manifest and the shared script determine input identity. Output belongs in `context.outputDir`, outside the supplied workspace. Parameter combinations that generate Artifact declarations are not supported in version 4.
