# Getting started

Use Node 22 LTS, at least 22.19.0. Create an empty project and install matching CCDD packages (or install the corresponding local tarballs while developing an unpublished release).

```sh
mkdir my-ccdd-project
cd my-ccdd-project
npm init -y
npm install --ignore-scripts @ccdd/core@6.1.0 @ccdd/project@6.1.0
mkdir implementation
```

## Installation choices

`@ccdd/core` supplies definitions; `@ccdd/project` supplies the CLI and review runtime. The command above installs both in one step. npm and pnpm install their regular `dependencies` transitively; consumers do not install their development-only dependencies.

Project and default-tools declare core `>=6.1.0 <7` as a non-optional `peerDependency`. npm 7+ and pnpm 10 with its default `autoInstallPeers` setting install missing non-optional peers when resolvable. Disabled peer installation or conflicting ranges can prevent that, and the range does not select the same patch version as Project. Declare core explicitly, as shown above, for a predictable matching installation and direct imports.

Project does **not** depend on `@ccdd/default-tools`. When you want common view scripts, install all three together:

```sh
npm install --ignore-scripts @ccdd/core@6.1.0 @ccdd/project@6.1.0 @ccdd/default-tools@6.1.0
```

With pnpm 10, the equivalent is:

```sh
pnpm add --ignore-scripts @ccdd/core@6.1.0 @ccdd/project@6.1.0 @ccdd/default-tools@6.1.0
```

Omit default-tools when using only custom tools or Runtime Critics. Installation never registers tools; declare views in `ccdd.json`. One installation command is enough; these remain separate packages, not a bundled monolith. Node.js is still a prerequisite.

See the package managers' [peer dependency](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#peerdependencies) and [automatic peer installation](https://pnpm.io/10.x/settings#auto-install-peers) documentation.

## Resource settings and upgrades

Use the matching 6.1 package set. Core adds owner identity weights, root review
policy and pinned script execution-path declarations; mixed 6.0 core with 6.1
Project/default-tools is not a supported installation. For upgrades, stop all
old workers first and follow [the upgrade steps](releases.md#upgrading-to-61).

All processes share the machine resource authority when using the same local
configuration and state root. Defaults are identity capacity 100 and provider
capacity 4. Use `--state-dir` for separate repository history, not a different
`CCDD_STATE_HOME` per repository. `--max-executions N` caps new starts in one
submission; `0` permits reuse/coalescing only. See [review management](review-management.md)
for weighted identities, repository caps, runtime provenance and offline checks.

## Run a runtime check

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

Agent and Human Critics need their own registered views. Install `@ccdd/default-tools@6.1.0` and copy/adapt its [JSON example](../packages/default-tools/examples/document/ccdd.json). A tool declares metadata and a fixed script, such as `{"command":"ccdd-view","args":["read"]}`. Reviewer arguments are validated and supplied as JSON stdin. Installing the library alone does not register it.

For a custom implementation, see [the standalone reader](../examples/custom-text-reader/README.md). It uses only Node and standard JSON, with no TypeScript config or mandatory tool library. Other languages can implement the same protocol.

## Connect Artifacts

Move independently reviewed material into another marked folder. Refer to its unique name in a Critic instruction, or add a logical mount such as `"mounts":{"suite":"tests"}`. A Runtime profile in `implementation` can then run `suite/check.test.mjs` without creating a physical `suite` directory. Nearest nested Artifacts are dependencies automatically.

`verify implementation` executes its own Critics. `verify implementation --recursive` also evaluates the required dependency scope. By default, Critics wait for current GREEN evidence from dependencies outside their strongly connected component (SCC). Mutual references are supported: SCC peers can execute together once external gates pass. The final answer still requires all matching evaluations. A RED dependency leaves descendants `BLOCKED`; an operational ERROR leaves them `WAIT_DEPENDENCY` without a fabricated verdict. Basis and no-Critic inputs do not add gates. `--ignore-gates` explicitly bypasses dependency gates, not workspace integrity checks. See the [dependency gate guide](migration-v6.md#account-for-dependency-green-gates) for blocked work and explicit ungated execution.

An Artifact without Critics is UNREVIEWED. Use `basis: true` only for an explicitly accepted starting point. The [demo](demo.md) illustrates a complete linear project; the [folder example](../examples/artifact-folders/README.md) shows code-style and image criteria.
