# Getting started

Use Node 22 LTS, at least 22.19.0. Create an empty project and install the version 4 packages (or install the corresponding local tarballs while developing an unpublished release).

```sh
mkdir my-ccdd-project
cd my-ccdd-project
npm init -y
npm install --ignore-scripts @ccdd/core@^4 @ccdd/project@^4
mkdir implementation
```

Create `implementation/add.mjs`:

```js
export const add = (a, b) => a + b;
```

Create `implementation/check.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './add.mjs';
test('add two integers', () => assert.equal(add(2, 3), 5));
```

Create `implementation/ccdd.json`:

```json
{
  "name": "implementation",
  "critics": [{
    "id": "tests",
    "title": "Pass the addition tests",
    "profile": { "kind": "runtime", "command": "node", "args": ["--test", "check.test.mjs"] },
    "payload": { "instruction": "Run the actual tests for {implementation}." }
  }]
}
```

The marker makes this folder an Artifact. The target is implicit; its full Critic ID is `implementation/tests`. Runtime needs no view tools or Provider credentials.

```sh
npx ccdd-project config check
npx ccdd-project plan implementation
npx ccdd-project verify implementation --wait
npx ccdd-project status implementation
npx ccdd-project history implementation
```

The first verify executes real tests. A second unchanged verify reuses its evidence without executing another review. Change addition to subtraction to produce a real RED result. Restoring the exact earlier input can reuse the earlier matching PASS. A failed process or broken configuration is an operational error, not a semantic failure.

State defaults to `~/.local/state/ccdd/<workspace-path-hash>`. Use `--state-dir /absolute/external/path` to choose another location. Output, caches, result files and state must remain outside the workspace. Do not edit input while a review is active. A user-created worktree passed with `--repo` lets development continue elsewhere.

## Add observation tools

Agent and Human Critics need their own registered views. Install `@ccdd/default-tools@^4` and copy/adapt its [JSON example](../packages/default-tools/examples/document/ccdd.json). A tool declares metadata and a fixed script, such as `{"command":"ccdd-view","args":["read"]}`. Reviewer arguments are validated and supplied as JSON stdin. Installing the library alone does not register it.

For a custom implementation, see [the standalone reader](../examples/custom-text-reader/README.md). It uses only Node and standard JSON, with no TypeScript config or mandatory tool library. Other languages can implement the same protocol.

## Connect Artifacts

Move independently reviewed material into another marked folder. Refer to its unique name in a Critic instruction, or add a logical mount such as `"mounts":{"suite":"tests"}`. A Runtime profile in `implementation` can then run `suite/check.test.mjs` without creating a physical `suite` directory. Nearest nested Artifacts are dependencies automatically.

`verify implementation` executes its own Critics. `verify implementation --recursive` also evaluates the required dependency scope. Mutual references are supported and run without waiting for each other's PASS, while the final answer still requires both evaluations.

An Artifact without Critics is UNREVIEWED. Use `basis: true` only for an explicitly accepted starting point. The [demo](demo.md) illustrates a complete linear project; the [folder example](../examples/artifact-folders/README.md) shows code-style and image criteria.
