# Your first review

This walkthrough reviews a tiny implementation by running one real Node test. It needs no AI account or desktop application. Afterward, you can add Agent or Human Critics and Artifact tools to the same project.

## 1. Install CCDD

Use Node.js 22 LTS (22.19.0 or later), preferably the latest LTS patch. Check with `node --version`. Node 22 support starts with CCDD 3.1.0. For an unpublished source version, use [Install from local packages](#install-from-local-packages).

Create a new folder outside the CCDD source checkout, or use a small existing project:

```sh
mkdir my-ccdd-project
cd my-ccdd-project
npm init -y
npm pkg set type=module
npm install --ignore-scripts @ccdd/core @ccdd/project
```

These commands require published versions of the packages. If you are working with an unpublished source version, follow [Install from local packages](#install-from-local-packages) below instead of the last command. A declaration of a version in this repository is not a claim that it is published.

The project must contain the packages imported by its configuration. CCDD captures those dependencies with the review input. Parent-folder or global installations do not supply missing configuration imports.

## 2. Add two small files

Create `implementation/add.mjs`:

```js
export function add(a, b) {
  return a + b;
}
```

Create `tests/add.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../implementation/add.mjs';

test('adds two numbers', () => {
  assert.equal(add(2, 3), 5);
});
```

## 3. Describe the review

Create `ccdd.config.ts` in the project root:

```ts
import { defineConfig } from '@ccdd/core';

export default defineConfig({
  artifactTypes: {
    code: {},
  },
  artifacts: {
    tests: { type: 'code', path: 'tests', basis: true },
    implementation: { type: 'code', path: 'implementation' },
  },
  critics: [{
    id: 'implementation-tests',
    title: 'Implementation passes the tests',
    target: 'implementation',
    deps: ['tests'],
    profile: {
      kind: 'runtime',
      command: 'node',
      args: ['--test', 'tests/add.test.mjs'],
    },
    payload: {
      instruction: 'Run the tests against the implementation.',
    },
  }],
});
```

Here, `implementation` is the **target** being judged. `tests` is a **dependency** used to judge it. `basis: true` explicitly accepts the test suite as the starting point for this example; it does not claim that the tests have themselves passed a review. You can later add a separate Critic to assess test quality, replacing that acceptance with a real review.

The `code` type has no Agent or Human tools because this first Critic runs tests directly. Agent and Human Critics need their own explicitly registered observation tools.

## 4. Check and run

```sh
npx ccdd-project config check
npx ccdd-project plan implementation
npx ccdd-project verify implementation --wait
npx ccdd-project status implementation
npx ccdd-project history implementation
```

The configuration check validates your declarations. The plan shows what can run. Verification runs the Node test and records its real result and evidence. With the files above, the test should pass and the current validation should be satisfied.

Run `verify implementation --wait` again without changing any input. CCDD should reference the original passing review instead of creating another review ticket.

Now change `return a + b` to `return a - b` and verify again. The changed implementation needs a new review, and the real test should fail with RED. Restore the correct implementation and request verification again. These are expected outcomes for you to observe, not pre-recorded review results.

Records live outside your project, by default under `~/.local/state/ccdd/`. `--state-dir` chooses another external location. Verification captures a copy of the entire project, including installed dependencies, so preparing a large project can take time. CCDD does not add exclusions to that input on your behalf.

## 5. Add reviewers and tools

For ready-made tools, install the optional package in the project:

```sh
npm install --ignore-scripts @ccdd/default-tools
```

Register tools for each audience in your configuration:

```ts
import { agent, human } from '@ccdd/default-tools';

// Inside artifactTypes:
code: {
  agentTools: {
    list: agent.files.list(),
    read: agent.files.read(),
  },
  humanTools: {
    open: human.desktop.open(),
  },
}
```

This fragment replaces the earlier `code: {}` entry. It defines access for future Agent and Human Critics; the existing Runtime Critic still runs the configured test.

- **Agent:** choose a Provider, model, reasoning level, and review instruction. Supply the Provider's credentials outside the reviewed input. CCDD starts a review Agent and supplies only its registered Artifact tools. See [the reviewer guide](reviewers.md).
- **Human:** add a Human Critic and register an alarm, such as the CLI's `--human-inbox` option. The person claims the review, opens its materials, and submits a verdict, summary, and evidence. See [Human actions](project-validation.md#execution-history-and-human-actions).
- **Custom tools:** implement `metadata` and `execute(context, args)` using the same contract. See [the custom reader](../examples/custom-text-reader/README.md).

The default desktop opener uses macOS's application association. On other platforms, configure a suitable executable with `human.desktop.open({ command: '/path/to/viewer' })`. See [desktop opening](../packages/default-tools/README.md#desktop-opening).

## Install from local packages

If a package version is not yet published, build tarballs from the CCDD source checkout with Node 22 LTS (22.19.0 or later):

```sh
npm ci
npm run build
```

Create an empty package-output directory **outside** both the source checkout and your review project. Replace `/absolute/path/to/ccdd-packages` below with its actual path:

```sh
npm pack --ignore-scripts --pack-destination /absolute/path/to/ccdd-packages
npm pack --ignore-scripts --workspace @ccdd/project --pack-destination /absolute/path/to/ccdd-packages
```

In your new project, install the actual tarballs produced by those commands together. For the current version:

```sh
npm install --ignore-scripts \
  /absolute/path/to/ccdd-packages/ccdd-core-3.1.1.tgz \
  /absolute/path/to/ccdd-packages/ccdd-project-3.1.1.tgz
```

To use default tools too, pack `@ccdd/default-tools` and include its tarball in the same install command. Package versions must be compatible. These commands build and install locally; they do not publish a release.
