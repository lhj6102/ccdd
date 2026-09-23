# Migrating to CCDD 4

Version 4 is a breaking API and input-identity transition. There is no compatibility loader. Upgrade Core, Project and optional default-tools together. Node remains 22 LTS, at least 22.19.0.

| Previous model | Version 4 |
| --- | --- |
| Global `ccdd.config.ts/js/json`, `defineConfig`, config factories | One static `ccdd.json` per Artifact folder. |
| Global Artifact dictionary and type registry | Unique `name` and owner-local `views` in each folder. |
| Critic `target` and `deps` | Owner is the target; instruction references derive dependencies. |
| Globally unique Critic ID | Local ID, qualified as `artifact/id` for CLI/history. |
| Tool functions registered from imported config | Fixed `script.command`/`args`, JSON stdin and ToolResult stdout. |
| `group` and members | Physical Artifact containment or logical mounts. |
| `generated`, `source`, prepared/frozen JSON, data tools | Real material folders and on-demand view scripts. |
| PASS gates and DAG-only execution | Ready Critics execute through cycles; final evidence is checked separately. |
| Legacy `ccdd run`, `--demo`, old Human routes | Project commands through `ccdd-project` or its `ccdd` alias. |

1. Create an Artifact folder for each independently reviewed unit and put its material there. Root is an Artifact only if it also has `ccdd.json`.
2. Move each target's Critics into that folder's `critics` array. Remove `target` and `deps`; use the existing `{name}` instruction syntax for required references. Preserve intentional escaped braces.
3. Put tools under `views.agentTools` and `views.humanTools`. Move executable implementation into scripts. Use [the standard request/result protocol](contracts.md#script-views).
4. Replace groups with folder structure or `mounts`. Nested markers retain their own configuration and add automatic dependencies. Mount aliases point to existing names and share their identities/evidence.
5. Replace generated sources with view scripts that compute from declared material at call time. Write output only into the provided external directories. Parameter-product Artifact generation is deferred.
6. Make stale/environment paths owner-relative. Keep shared `metadata.executionPaths` workspace-relative and include imported runtime material. Validate with `config check`, explicit `tools check --execute`, and a new verification.

Old records are retained for stored-result inspection. Their input versions cannot satisfy new queries and their Runs cannot resume or accept Human execution actions. Do not relabel old evidence as version 2. New actual reviews must establish evidence for the new model.

Use a supplied unchanged workspace, optionally a user-created worktree. No copy/lock selector, remote workspace transfer, group expansion or symlink mount materialization remains. The [custom reader](../examples/custom-text-reader/README.md), [folder/mount example](../examples/artifact-folders/README.md) and [computed views](../examples/computed-views/README.md) demonstrate the replacements.
