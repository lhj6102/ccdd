# Custom text reader

`why/ccdd.json` declares an explicit basis. `spec/ccdd.json` owns its alignment Critic and reader. The instruction `{why}` derives the dependency; no `target`, `deps`, type registry or config factory is needed.

Install `@ccdd/core` and `@ccdd/project` in this example directory. The custom `view.mjs` requires only Node; default tools are optional.

```sh
ccdd-project config check
ccdd-project tools check --artifact spec --for agent --tool read --execute --args '{"startLine":1,"lineCount":20}'
ccdd-project verify spec --recursive --wait
```

The last command makes a real Agent request and needs configured Provider credentials outside this workspace. `view.mjs` receives the standard JSON request on stdin and returns one `ToolResult` on stdout. The fixed filename is an argv value from each Artifact's declaration. The shared script is explicitly fingerprinted by `executionPaths`.
