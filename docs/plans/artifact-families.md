# Artifact families

Status: implemented for review. The binding rules are in [contracts](../contracts.md#artifact-families); this note records why the feature exists, how it maps to CCDD's priorities, and how an existing many-folder project adopts it.

## Problem

An Artifact had to be one folder with one `ccdd.json`. Projects whose review units come from data rather than folder structure, such as one Artifact per catalog entry, had to materialize a folder per unit. One project evaluating game skills does exactly that: a lab tool writes about 850 folders into an external workspace, each with `ccdd.json`, `state.json`, and byte-identical copies of a 52 KB identity script and a result check script. Apart from the name, instance-specific input schemas, response schemas and instruction, every generated `ccdd.json` is the same. The lab also deletes folders that a batch did not select.

That is a custom CCDD usage layer. The goal is that such a project declares its Artifacts directly in the structure CCDD proposes.

## Priorities

1. **Clear Artifacts and visible relations.** The instance list is static JSON. `config check`, `graph` and the monitor see every instance and relation without running scripts. Each instance is an ordinary named Artifact with ordinary Critics, mounts and instruction references. The monitor groups a family into one node so a large family stays readable.
2. **Declarative use.** The author declares one template and one list. Instance differences are JSON values copied by `{"$param": "/pointer"}`; family defaults and named variants keep repeated values out of every entry. Nothing is evaluated or interpolated. Graph structure (names, mounts, stale strategy, basis) stays in the template.
3. **CCDD owns reuse.** Each instance's identity covers the shared material plus its own merged entry and listed material. Siblings never invalidate each other, so every instance can stay declared permanently and a request simply selects targets, or the whole family by its name; CCDD decides reuse from identities and Critic dependencies.

## Decisions

- **Static list, not an enumeration script.** An enumeration script would make graph discovery execute code, contradicting the first priority and the readonly monitor. An authoring tool can still generate `instances.json`; CCDD reads it like any declared file.
- **Copy, not compute.** A declaration script producing per-instance schemas was considered and rejected: `$param` copies give the same expressiveness for generated JSON while keeping discovery a pure read.
- **Shallow defaults and variants.** Parameters differ by whole values such as a schema or an instruction. A top-level merge (defaults, variant, instance) is predictable; deep merging would make arrays and `null` ambiguous. A nested difference is another variant.
- **Flat families.** Instance names such as `SkillArtifact_305_34040` already encode hierarchy; nested families are not needed.
- **No family evidence.** A family is not an Artifact, so it cannot be mounted or referenced and has no verdict. Its name in a selection is shorthand for its instances. The monitor's family status is a display summary of its instances.
- **Additive script contexts.** View scope entries, identity script stdin and result check stdin gain the instance name and its material. The script request version stays 1.
- **Existing identities are unchanged.** Only family instances use the new material rules; ordinary Artifacts hash exactly as before.

## Adopting a many-folder layout

| Before | With a family |
| --- | --- |
| One folder and `ccdd.json` per unit | One family folder: `ccdd.json` and `instances.json` |
| `state.json` per folder | One material file per instance, listed in `material` |
| Per-unit schemas and instruction written into each `ccdd.json` | Shared values in `family.params` or `family.variants`; per-unit values under the entry's `params`; all referenced with `$param` |
| Identity and result check scripts copied into every folder | One copy in the family folder; each run receives `artifactId` and `family.material` on stdin |
| Views reading `state.json` from cwd | Views reading `context.scope[context.artifactId].family.material` |
| Deleting unselected folders per batch | Keep every instance declared; select targets, or the family name, per request |

Instance names can stay exactly the same, for example `SkillArtifact_305_34040`.

- **Owner identity keeps evidence.** An Artifact whose `stale` is an identity script keeps its ValidationInput key when moved into a family, as long as its name, Critic local ID and relations are unchanged and the script returns the same value. The contract states this and a test asserts it. Changing the script bytes only costs one cold identity computation.
- **Default identity reviews once.** Artifacts that use default (file-hash) identity get new keys once, because their definition now records family membership and their material is computed differently.
- **A project lock is still needed while writing.** Families remove per-folder copies and pruning, not the project's own write coordination. A review running while the project rewrites the instance list, material, template or runtime still fails with `WORKSPACE_CHANGED`. Keep the session lock, or write between reviews.
- **Discovery is not faster.** With real declaration sizes (about 12 KB of schemas per instance), discovering 845 instances took about 1.5 s, the same as 845 ordinary folders. Schema validation is now memoized per distinct schema, and variants shrink the list itself; per-review reconnection expands only the recorded instances.

## Open questions for adopters

- Is one instance list file per family sufficient, or are very large lists better split?
- Should a family's views be able to share runtime files declared once in the family, beyond what `executionPaths` already allows?
- Is the family node's summary status (most urgent instance state) the right default in the monitor?
