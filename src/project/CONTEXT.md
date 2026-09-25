# Project Validation

Project Validation answers whether the current required scope has matching actual review evidence. It discovers static `ccdd.json` files, derives typed relationships and finite identities, and requests missing selected evaluations through the Broker.

- **Artifact**: a named folder owning its view tools and Critics. Unmarked children are its material; marked children remain independent.
- **Artifact Identity**: the content/config/runtime/relation identity of material. Cycles are hashed as strongly connected components. Review IDs and times never affect it.
- **Validation Input**: the effective Critic conditions, target and explicit references, with the current identity version and execution policy.
- **Validation Evidence**: an actual semantic review result bound to its Validation Input. Reuse references that result; it is not another evaluation.
- **Validation Query**: a readonly comparison of current input with evidence and the finite required dependency closure. The comparison executes no scripts and stores no stale flags. Current-input preparation computes identities and validation inputs only for the selected dependency closure, executing explicitly configured owner identity scripts there; static discovery remains script-free. Query output uses that same scope, while snapshots retain the full static graph.
- **Individual Validation**: executes only selected Critics. Missing other required evidence makes the request INCOMPLETE, without discarding completed selected results.
- **Recursive Validation**: includes Critics throughout the required dependency closure. Dependency PASS never gates the start of a ready Critic.
- **Basis**: an explicit accepted Artifact with no Critics. An ordinary no-Critic Artifact is UNREVIEWED.

Folder containment, logical mounts and instruction references are equal-level dependencies. Final satisfaction requires actual matching PASS for all required non-basis Artifacts; a cycle itself proves nothing. History from previous identity versions is result-only.
