# Review from another computer

A remote Human reviewer downloads the complete fixed project and runs its
registered tools locally. Viewer executables can be included in the project.
The publisher hosts the input and the review's assignment/result actions; no
per-Artifact web viewer or remote desktop is required.

This workflow uses copy-mode Human requests from `ccdd.config.ts`. Both computers
need the same `@ccdd/project` version and Node.js 24 or later. The existing local
monitor remains a loopback interface. Remote lock-mode transfer and legacy JSON
tool manifests are not supported by the remote CLI.

## Prepare the project

Register a bundled viewer and, if needed, an environment check:

```ts
import { defineConfig } from '@ccdd/core';
import { human } from '@ccdd/default-tools';

export default defineConfig({
  artifacts: { model: { type: 'blend', path: 'assets/model.blend' } },
  artifactTypes: {
    blend: {
      humanTools: {
        open: human.project.open({ runtime: 'tools/blender', executable: 'blender' }),
      },
    },
  },
  envRequirements: {
    rust: {
      description: 'Install the project-required Rust toolchain and Cargo, then retry.',
      script: 'checks/rust.mjs',
      timeoutMs: 10000,
    },
  },
  critics: [{
    id: 'visual-review', title: 'Inspect the model', target: 'model', deps: [],
    profile: { kind: 'human' },
    payload: { instruction: 'Open {model} and review its shape and materials.' },
  }],
});
```

Include the portable viewer's complete runtime under `tools/blender`, using the
executable name for your supported platform (for example, `blender.exe` on
Windows). Required libraries, plugins, and default settings belong in that
directory too. The bundled application runs without searching the reviewer's
PATH and uses private writable configuration/output directories outside the
snapshot. It remains open after the launcher returns, until the reviewer closes it.
Opening the application produces only a launch receipt.

The optional `checks/rust.mjs` is ordinary Node code. It can invoke the required
runtime and explain a failure:

```js
import { spawnSync } from 'node:child_process';

const result = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
if (result.status !== 0) {
  console.error('Cargo is unavailable. Install the required Rust toolchain and add Cargo to PATH.');
  process.exitCode = 1;
} else {
  console.log(result.stdout.trim());
}
```

Check any required versions or platform features in your script as well. CCDD
does not install software as a side effect of a readiness check. Scripts run on
the reviewer's computer, with PATH and supported Rust home settings, excluding
Provider tokens and Node preload hooks. Use `CCDD_OUTPUT_DIR` and `CCDD_TMP_DIR`
for generated files. Declare script helper/data paths in `inputs`; those hashes
and the script itself become part of the Human review conditions.

## Start the project server

Submit a real Human review first:

```sh
ccdd-project verify model --copy --human-inbox --state-dir /outside/project-state
```

Create a credentials JSON file outside the project. It maps reviewer IDs to
distinct random base64url tokens with at least 32 characters. Generate tokens
with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
Give each reviewer only their token in a separate private file. Never place these
files in the source project, which is transferred in full.

```sh
ccdd-project review serve \
  --state-dir /outside/project-state \
  --credentials-file /outside/reviewer-credentials.json
```

The server prints its address and defaults to `127.0.0.1:4320`. For a remote
machine, forward that port through an authenticated tunnel, or explicitly select
`--host`/`--port` and provide an HTTPS endpoint. The server uses bearer credentials;
it does not supply a public multi-user login page or TLS termination.

## Claim and inspect

On the reviewer computer:

```sh
ccdd-project review list --server http://127.0.0.1:4320 --token-file /private/my-token
ccdd-project review claim REQUEST_ID --server http://127.0.0.1:4320 --token-file /private/my-token
ccdd-project review tool REQUEST_ID --tool open_model --server http://127.0.0.1:4320 --token-file /private/my-token
ccdd-project review submit REQUEST_ID --result-file /private/verdict.json --server http://127.0.0.1:4320 --token-file /private/my-token
```

The loopback URL above can be the local end of your tunnel. The result file uses
the usual `{ "verdict": "GREEN" | "RED", "summary": "...", "evidence": ["..."] }`
shape and contains the reviewer's actual judgment.

The claim action first enters **Try Claim**. It reserves the request, prepares
the snapshot, runs environment checks, and preflights the scoped tools. It then
confirms **Claim**. Failed preparation returns an error and makes the review
available again without recording an Artifact verdict or request ERROR. Closing
the client releases its attempt where possible; a disconnected attempt expires.
Another reviewer's newer reservation cannot be overwritten by a late response.

Use `--cache-dir` consistently across client commands to choose a cache location;
the default is `~/.local/state/ccdd-reviewer`. Only missing file content is
downloaded for later snapshots. Changed files transfer in full; earlier snapshots
are retained. Do not remove a snapshot while its viewer remains open. Repeating
claim recovers an already confirmed local session after a lost network response.

The central Broker owns the request and verdict. The client stores only its
verified input, local session, and outputs. It checks local input integrity before
tool execution and submission, and the server checks the confirmed assignment and
original input before accepting the result.
